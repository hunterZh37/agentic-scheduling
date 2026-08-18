// A2A v1 — two agents talking in a Slack channel people are also reading.
//
// Slack is the transport. The protocol carries no sender, recipient or
// conversation id, because Slack already has all three: the message author, the
// mention, and the thread. What it adds is the two things Slack cannot say —
// what kind of message this is, and how many hops the exchange has left.
//
// The parser is deliberately strict and the policy deliberately paranoid. Two
// agents in a shared channel can spend money and annoy people at machine speed,
// and every rule below exists because of that.

export const A2A_VERSION = 1;

/// A fresh exchange starts here: enough for question, answer, follow-up,
/// answer, conclusion, acknowledgement — and small enough that a runaway costs
/// six model calls.
export const FRESH_TTL = 6;

/// Consecutive agent messages allowed in one thread, counted locally. This is
/// the only guard that survives the other agent being broken or hostile: `ttl`
/// is cooperative, and a peer that ignores it would otherwise loop forever.
export const MAX_CONSECUTIVE_AGENT_MESSAGES = 6;

export type A2AKind = "hello" | "ask" | "reply" | "done" | "decline";

const KINDS: readonly A2AKind[] = ["hello", "ask", "reply", "done", "decline"];

export interface A2AMessage {
  version: number;
  kind: A2AKind;
  ttl: number;
  /// Everything after the first line. Ordinary prose, on purpose — people read
  /// this channel, and a protocol they cannot follow over a colleague's
  /// shoulder is one that gets switched off.
  body: string;
}

/// Header on the FIRST line only. A mention may precede it. Unknown keys are
/// tolerated and skipped, so a later 1.x can add one without breaking agents
/// already deployed.
const HEADER = /\[a2a\/(\d+)\s+([a-z]+)((?:\s+[a-z_]+=[^\s\]]+)*)\s*\]/i;

/// Parse an A2A message, or null if this is not one.
///
/// Null covers three different situations on purpose, because the caller treats
/// them identically — do not answer as an agent:
///   - no header at all (an ordinary message)
///   - a header this version does not understand (a later version could change
///     what today's fields mean, so it is ignored rather than guessed at)
///   - something malformed. `a[0]` in a person's message must never be read as
///     a protocol frame.
export function parseA2A(text: string): A2AMessage | null {
  if (!text) return null;
  const firstLine = text.split("\n", 1)[0];
  const m = HEADER.exec(firstLine);
  if (!m) return null;

  const version = Number(m[1]);
  if (!Number.isInteger(version) || version !== A2A_VERSION) return null;

  const kind = m[2].toLowerCase() as A2AKind;
  if (!KINDS.includes(kind)) return null;

  // Attributes: ttl is required in v1; anything else is skipped.
  const attrs = new Map<string, string>();
  for (const pair of m[3].trim().split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq > 0) attrs.set(pair.slice(0, eq).toLowerCase(), pair.slice(eq + 1));
  }
  const rawTtl = attrs.get("ttl");
  if (rawTtl === undefined) return null;
  const ttl = Number(rawTtl);
  if (!Number.isInteger(ttl) || ttl < 0) return null;

  const newline = text.indexOf("\n");
  const body = newline === -1 ? "" : text.slice(newline + 1).trim();

  return { version, kind, ttl, body };
}

/// Render a message. The mention goes before the header, matching the examples
/// and keeping the thread readable for people.
export function formatA2A(args: {
  toUserId: string;
  kind: A2AKind;
  ttl: number;
  body: string;
}): string {
  const ttl = Math.max(0, args.ttl);
  return `<@${args.toUserId}> [a2a/${A2A_VERSION} ${args.kind} ttl=${ttl}]\n${args.body}`;
}

export type A2APlan =
  | { action: "ignore"; reason: string }
  | { action: "respond"; kind: A2AKind; ttl: number; needsModel: boolean };

/// What to do about an incoming A2A message.
///
/// `done` and `decline` are never answered — that is what gives an exchange an
/// ending. `reply` needs no answer either, so a plain question and answer is
/// two messages and stops; continuing means sending a fresh `ask`.
export function planResponse(msg: A2AMessage, consecutiveAgentMessages: number): A2APlan {
  if (consecutiveAgentMessages >= MAX_CONSECUTIVE_AGENT_MESSAGES) {
    // The hard stop. Deliberately silent rather than sending `done`: at this
    // point the peer has already ignored ttl, and anything we send hands them
    // another turn. Differs from ttl exhaustion below, where the peer is
    // cooperating and silence would look like a crash and invite a retry.
    return { action: "ignore", reason: "local consecutive-agent limit reached" };
  }

  if (msg.kind === "done" || msg.kind === "decline") {
    return { action: "ignore", reason: `${msg.kind} is terminal` };
  }
  if (msg.kind === "reply") {
    return { action: "ignore", reason: "a reply needs no answer" };
  }

  const ttl = msg.ttl - 1;
  if (msg.ttl <= 0) {
    // Out of hops. Say so rather than going quiet — silence looks like a crash
    // and invites the other side to retry, which is the loop with extra steps.
    return { action: "respond", kind: "done", ttl: 0, needsModel: false };
  }

  // hello is answered deterministically: it asks who you are, which needs no
  // model call and should not cost one.
  if (msg.kind === "hello") {
    return { action: "respond", kind: "hello", ttl, needsModel: false };
  }
  return { action: "respond", kind: "reply", ttl, needsModel: true };
}

/// Count the agent messages at the END of a thread, stopping at the first
/// human. A person in the conversation is what makes it a conversation rather
/// than a loop, so their message resets the count.
export function countTrailingAgentMessages(
  messages: Array<{ bot_id?: string; subtype?: string; user?: string }>
): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const isAgent = !!m.bot_id || m.subtype === "bot_message";
    if (!isAgent) break;
    n++;
  }
  return n;
}

/// Is this message addressed to us?
///
/// Slack only creates a real mention (`<@U123>`) when the sender picks the user
/// from autocomplete. Another agent posting programmatically often writes the
/// handle as ordinary text — Carl's first message said "@Alex" verbatim, which
/// Slack rendered as plain text and never turned into a mention, so no
/// app_mention event fired at all. Accept both forms, or A2A only works between
/// agents that happen to construct mentions correctly.
///
/// This matters more once the app listens to whole channels: without it, every
/// agent in the room would answer every frame.
export function isAddressedToUs(
  text: string,
  identity: { userId: string | null; handle: string | null }
): boolean {
  if (identity.userId && text.includes(`<@${identity.userId}>`)) return true;
  if (identity.handle) {
    // Word-boundaried so "@alexandra" does not match "@alex".
    const re = new RegExp(`@${identity.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}
