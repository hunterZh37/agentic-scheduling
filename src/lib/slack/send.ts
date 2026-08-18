import { optionalEnv } from "@/lib/env";

/// Post a message back into Slack. Replies in-thread when `threadTs` is given
/// so a channel doesn't fill with loose messages.
///
/// Errors are logged, not thrown: this always runs AFTER the 3-second ack has
/// been sent, so throwing would only produce an unhandled rejection in a
/// background task nobody sees.
export async function postSlackMessage(args: {
  channel: string;
  text: string;
  threadTs?: string;
}): Promise<void> {
  const token = optionalEnv("SLACK_BOT_TOKEN");
  if (!token) {
    console.error("[slack] SLACK_BOT_TOKEN is unset — cannot reply");
    return;
  }
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: args.channel,
      text: args.text,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    }),
  });
  // Slack answers 200 with {ok:false,error:"..."} on failure, so the HTTP
  // status alone tells you nothing.
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!body?.ok) {
    console.error(`[slack] chat.postMessage failed: ${body?.error ?? `HTTP ${res.status}`}`);
  }
}

/// Strip the bot's own @mention out of the text so the agent sees the request
/// rather than "<@U123> book me 30 minutes".
export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/gi, " ").replace(/\s+/g, " ").trim();
}

/// Our own bot user id, so we never answer ourselves. Cached for the life of
/// the instance: it never changes for a given install, and auth.test is a
/// round trip we do not want on every event.
let cachedIdentity: { userId: string | null; handle: string | null } | undefined;

/// Our bot's user id AND its handle. The id is how Slack writes a real mention
/// (`<@U123>`); the handle is what another agent may type as plain text, which
/// Slack does not turn into a mention at all. Both are needed to tell whether a
/// message is addressed to us.
export async function slackBotIdentity(): Promise<{ userId: string | null; handle: string | null }> {
  if (cachedIdentity !== undefined) return cachedIdentity;
  const token = optionalEnv("SLACK_BOT_TOKEN");
  if (!token) return (cachedIdentity = { userId: null, handle: null });
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { ok?: boolean; user_id?: string; user?: string };
    return (cachedIdentity = body.ok
      ? { userId: body.user_id ?? null, handle: body.user ?? null }
      : { userId: null, handle: null });
  } catch {
    return (cachedIdentity = { userId: null, handle: null });
  }
}

export async function slackBotUserId(): Promise<string | null> {
  return (await slackBotIdentity()).userId;
}

/// The last messages in a thread, oldest first. Used to count how many agent
/// messages have run consecutively — the guard that does not depend on the
/// other agent honouring anything.
export async function fetchThreadMessages(
  channel: string,
  threadTs: string,
  limit = 20
): Promise<Array<{ bot_id?: string; subtype?: string; user?: string; text?: string }> | null> {
  const token = optionalEnv("SLACK_BOT_TOKEN");
  if (!token) return null;
  const url = new URL("https://slack.com/api/conversations.replies");
  url.searchParams.set("channel", channel);
  url.searchParams.set("ts", threadTs);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json().catch(() => null)) as
    | { ok?: boolean; messages?: Array<Record<string, unknown>> }
    | null;
  if (!body?.ok || !Array.isArray(body.messages)) return null;
  return body.messages as Array<{ bot_id?: string; subtype?: string; user?: string; text?: string }>;
}
