import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { optionalEnv } from "@/lib/env";
import { verifySlackSignature, isOwnerSlackUser } from "@/lib/slack/verify";
import {
  postSlackMessage,
  stripMention,
  slackBotIdentity,
  fetchThreadMessages,
} from "@/lib/slack/send";
import {
  parseA2A,
  planResponse,
  formatA2A,
  countTrailingAgentMessages,
  isAddressedToUs,
} from "@/lib/slack/a2a";
import {
  runPrivateAgent,
  runPublicAgent,
  runPeerAgent,
  type ChatMessage,
} from "@/lib/agent/run";
import { checkMessageAllowed, tryReserveBooking, releaseBooking } from "@/lib/agent/rateLimit";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Slack Events API endpoint.
//
// Access model — this is the part that differs from the WhatsApp channel and is
// the reason the route exists at all. On WhatsApp the sender is one phone number
// the owner controls, so the private agent is safe. A Slack CHANNEL is
// multi-user: anyone in it can address the bot. So the sender's Slack user id
// decides which agent answers:
//
//   owner (OWNER_SLACK_USER_IDS) -> private agent: full calendar, can create,
//                                   move and cancel anything
//   everyone else                -> public agent: free slots and booking only,
//                                   never event titles, attendees or details
//
// isOwnerSlackUser fails closed, so a missing allowlist means nobody gets the
// private agent — never everybody.

/// Slack retries a delivery it thinks failed. The work is already running in
/// `after()` by then, so a retry would run the agent a second time and post a
/// duplicate reply.
const RETRY_HEADER = "x-slack-retry-num";

interface SlackEvent {
  type?: string;
  user?: string;
  text?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  subtype?: string;
}

/// Who Alex says it is when another agent says hello. Deterministic: `hello`
/// asks who you are, which needs no model call and should not cost one.
const HELLO_BODY =
  `I am Alex, ${OWNER_FIRST_NAME}'s scheduling assistant. I speak a2a/1. I can say when ` +
  `${OWNER_FIRST_NAME} is free and book a time; I will not discuss what is on their calendar.`;

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Verify against the RAW body — re-serialising parsed JSON changes the bytes
  // and the signature would never match.
  const rawBody = await req.text();

  const signingSecret = optionalEnv("SLACK_SIGNING_SECRET");
  if (!signingSecret) {
    console.error("[slack] SLACK_SIGNING_SECRET is unset — refusing all events");
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  const ok = verifySlackSignature({
    signingSecret,
    signature: req.headers.get("x-slack-signature"),
    timestamp: req.headers.get("x-slack-request-timestamp"),
    rawBody,
  });
  if (!ok) {
    // Diagnostic, deliberately not logging the secret or a full signature.
    // Distinguishes the three ways this fails:
    //   secretLen  32 is the expected shape of a Slack signing secret; a
    //              different length means the wrong field was copied, and a
    //              length that is 33/34 means a trailing space or newline
    //   sigPrefix  "v0=" confirms Slack's header actually arrived
    //   bodyStart  "{" confirms we are hashing the raw JSON, not a re-encode
    //   skewSec    a large value means clock skew, not a bad secret
    const rawSig = req.headers.get("x-slack-signature") ?? "";
    const rawTs = req.headers.get("x-slack-request-timestamp") ?? "";
    const skew = Number(rawTs) ? Math.abs(Math.floor(Date.now() / 1000) - Number(rawTs)) : null;
    console.warn(
      "[slack] rejected event with an invalid signature " +
        JSON.stringify({
          secretLen: signingSecret.length,
          secretTrimmedLen: signingSecret.trim().length,
          sigPrefix: rawSig.slice(0, 3),
          sigLen: rawSig.length,
          bodyLen: rawBody.length,
          bodyStart: rawBody.slice(0, 1),
          skewSec: skew,
        })
    );
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let body: { type?: string; challenge?: string; event?: SlackEvent; event_id?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // One-time handshake when the Request URL is saved in the Slack app config.
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  if (req.headers.get(RETRY_HEADER)) {
    // Ack without re-running: the original is still in flight.
    return NextResponse.json({ ok: true, skipped: "retry" });
  }

  const event = body.event;
  if (!event || (event.type !== "app_mention" && event.type !== "message")) {
    return NextResponse.json({ ok: true });
  }

  // Subscribing to message.channels made Slack deliver a mention TWICE: once as
  // app_mention and once as message. Alex answered both, which reads as a loop
  // — Carl said so in the thread before giving up.
  //
  // Deduplicate by source rather than by remembering event ids, which would
  // need shared state this has none of:
  //   app_mention                -> handled (it is the canonical mention event)
  //   message containing <@self> -> dropped, app_mention already covered it
  //   message without <@self>    -> handled; this is the plain-text handle case
  //                                 that fires no app_mention at all
  if (event.type === "message") {
    const self = await slackBotIdentity();
    if (self.userId && (event.text ?? "").includes(`<@${self.userId}>`)) {
      return NextResponse.json({ ok: true, skipped: "duplicate_of_app_mention" });
    }
  }
  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  const rawText = event.text ?? "";

  // --- Agent-to-agent (A2A v1) ---------------------------------------------
  // A message from a bot is only ever answered when it is a well-formed A2A
  // frame addressed to us. Everything else from a bot is ignored exactly as
  // before — including anything unparseable, which is NOT treated as a broken
  // A2A message.
  const fromAgent = !!event.bot_id || event.subtype === "bot_message";
  if (fromAgent) {
    const a2a = parseA2A(rawText);
    if (!a2a || !channel || !threadTs) return NextResponse.json({ ok: true });

    // Rule 1: never answer ourselves. Our own posts come back as events.
    const identity = await slackBotIdentity();
    if (identity.userId && event.user === identity.userId) {
      return NextResponse.json({ ok: true, skipped: "self" });
    }

    // Only answer frames aimed at us. A real Slack mention is the normal case,
    // but an agent posting programmatically often writes the handle as plain
    // text, which Slack never turns into a mention — so both count. Without
    // this, once the app listens to whole channels, every agent in the room
    // would answer every frame.
    if (!isAddressedToUs(rawText, identity)) {
      return NextResponse.json({ ok: true, skipped: "not_addressed" });
    }

    // Rule 2 + the third guard: count agent messages at the end of the thread.
    // A human message resets it, because a person in the conversation is what
    // makes it a conversation rather than a loop. This is the only guard that
    // survives the other agent ignoring ttl, so failing to read the thread
    // means declining to speak, not speaking anyway.
    const thread = await fetchThreadMessages(channel, threadTs);
    if (!thread) {
      console.warn("[a2a] could not read the thread — staying silent rather than risking a loop");
      return NextResponse.json({ ok: true, skipped: "thread_unreadable" });
    }
    const consecutive = countTrailingAgentMessages(thread);
    const plan = planResponse(a2a, consecutive);
    if (plan.action === "ignore") {
      console.log(`[a2a] ${a2a.kind} ttl=${a2a.ttl} — no reply (${plan.reason})`);
      return NextResponse.json({ ok: true, skipped: plan.reason });
    }

    const peer = event.user;
    after(async () => {
      let body = HELLO_BODY;
      if (plan.needsModel) {
        try {
          // The PEER agent: same fenced capability as the public one — a peer
          // is not the owner — but it knows it is Alex. The public agent
          // introduced itself as "a scheduling assistant", denied being Alex,
          // and answered a plain question with a booking prompt.
          body = await runPeerAgent([{ role: "user", content: a2a.body || rawText }], {
            tryReserveBooking: () => tryReserveBooking(`slack-a2a:${peer ?? "unknown"}`),
            releaseBooking: () => releaseBooking(`slack-a2a:${peer ?? "unknown"}`),
          });
        } catch (err) {
          console.error("[a2a] agent run failed:", err);
          body = "Something went wrong on my end.";
        }
      } else if (plan.kind === "done") {
        body = "Out of turns for this exchange. Start a new one if it matters.";
      }
      await postSlackMessage({
        channel,
        threadTs,
        text: peer
          ? formatA2A({ toUserId: peer, kind: plan.kind, ttl: plan.ttl, body })
          : body,
      });
    });
    return NextResponse.json({ ok: true, a2a: plan.kind });
  }

  // Edited/joined/left system messages are still ignored.
  if (event.subtype) return NextResponse.json({ ok: true });

  const text = stripMention(rawText);
  if (!text || !channel) return NextResponse.json({ ok: true });

  const owner = isOwnerSlackUser(event.user);
  // Rate-limit key is the Slack user id: server-supplied and not spoofable by
  // message content.
  const rateKey = `slack:${event.user ?? "unknown"}`;
  if (!owner) {
    const decision = checkMessageAllowed(rateKey, Date.now(), rateKey);
    if (!decision.ok) {
      after(async () => {
        await postSlackMessage({
          channel,
          threadTs,
          text: "That's a lot of requests in a short time — try again a bit later.",
        });
      });
      return NextResponse.json({ ok: true, rateLimited: true });
    }
  }

  // Slack demands a response within 3 seconds; an agent turn takes far longer.
  // Ack now and reply out of band — on Vercel `after` is backed by waitUntil,
  // which keeps the function alive past the response.
  after(async () => {
    const messages: ChatMessage[] = [{ role: "user", content: text }];
    let reply: string;
    try {
      reply = owner
        ? await runPrivateAgent(messages, { concise: true })
        : await runPublicAgent(messages, {
            tryReserveBooking: () => tryReserveBooking(rateKey),
            releaseBooking: () => releaseBooking(rateKey),
          });
    } catch (err) {
      console.error("[slack] agent run failed:", err);
      reply = "Sorry, something went wrong on my end. Please try again.";
    }
    await postSlackMessage({ channel, threadTs, text: reply });
  });

  return NextResponse.json({ ok: true });
}
