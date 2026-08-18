import { describe, it, expect } from "vitest";
import {
  parseA2A,
  formatA2A,
  planResponse,
  countTrailingAgentMessages,
  isAddressedToUs,
  MAX_CONSECUTIVE_AGENT_MESSAGES,
  FRESH_TTL,
} from "./a2a";

const msg = (kind: string, ttl: number, body = "hi") =>
  parseA2A(`<@U0ALEX> [a2a/1 ${kind} ttl=${ttl}]\n${body}`)!;

describe("parsing", () => {
  it("reads a frame with the mention before the header", () => {
    const m = parseA2A("<@U0ALEX> [a2a/1 ask ttl=5]\nHow do you handle memory?")!;
    expect(m).toMatchObject({ version: 1, kind: "ask", ttl: 5 });
    expect(m.body).toBe("How do you handle memory?");
  });

  it("keeps a multi-line body intact", () => {
    const m = parseA2A("[a2a/1 reply ttl=3]\nline one\n\nline two")!;
    expect(m.body).toBe("line one\n\nline two");
  });

  it("skips unknown header keys, so a 1.x can add one", () => {
    const m = parseA2A("[a2a/1 ask ttl=4 trace=abc priority=high]\nbody")!;
    expect(m.kind).toBe("ask");
    expect(m.ttl).toBe(4);
  });

  // Rule 3: anything unparseable is NOT A2A. A person writing a[0] must never
  // be read as an agent.
  it.each([
    ["ordinary prose", "hey Alex, can you book me in?"],
    ["array indexing", "the value is a[0] and b[1]"],
    ["header not on the first line", "hello\n[a2a/1 ask ttl=3]\nbody"],
    ["unknown kind", "[a2a/1 shout ttl=3]\nbody"],
    ["missing ttl", "[a2a/1 ask]\nbody"],
    ["non-numeric ttl", "[a2a/1 ask ttl=soon]\nbody"],
    ["negative ttl", "[a2a/1 ask ttl=-1]\nbody"],
    ["empty", ""],
  ])("is not A2A: %s", (_label, text) => {
    expect(parseA2A(text)).toBeNull();
  });

  // Rule 4: an unknown version is ignored, not guessed at — a later version
  // could change what today's fields mean.
  it("ignores a version it does not know", () => {
    expect(parseA2A("[a2a/2 ask ttl=5]\nbody")).toBeNull();
    expect(parseA2A("[a2a/99 ask ttl=5]\nbody")).toBeNull();
  });
});

describe("formatting", () => {
  it("puts the mention before the header", () => {
    const out = formatA2A({ toUserId: "U0CARL", kind: "reply", ttl: 3, body: "A notes file." });
    expect(out).toBe("<@U0CARL> [a2a/1 reply ttl=3]\nA notes file.");
    // And round-trips.
    expect(parseA2A(out)).toMatchObject({ kind: "reply", ttl: 3, body: "A notes file." });
  });

  it("never emits a negative ttl", () => {
    expect(formatA2A({ toUserId: "U", kind: "done", ttl: -3, body: "x" })).toContain("ttl=0");
  });
});

describe("what gets answered", () => {
  it("answers hello with hello, without a model call", () => {
    expect(planResponse(msg("hello", 6), 0)).toEqual({
      action: "respond", kind: "hello", ttl: 5, needsModel: false,
    });
  });

  it("answers ask with reply, decrementing the ttl", () => {
    expect(planResponse(msg("ask", 4), 0)).toEqual({
      action: "respond", kind: "reply", ttl: 3, needsModel: true,
    });
  });

  // These are what give an exchange an ending. Answering a thank you with
  // "you're welcome" is how a polite conversation becomes an infinite one.
  it.each(["done", "decline"])("never answers %s", (kind) => {
    expect(planResponse(msg(kind, 5), 0).action).toBe("ignore");
  });

  it("does not answer a reply — a Q&A is two messages and stops", () => {
    expect(planResponse(msg("reply", 5), 0).action).toBe("ignore");
  });
});

describe("ttl", () => {
  it("sends done at zero rather than going quiet", () => {
    // Silence looks like a crash and invites a retry, which is the loop with
    // extra steps.
    expect(planResponse(msg("ask", 0), 0)).toEqual({
      action: "respond", kind: "done", ttl: 0, needsModel: false,
    });
  });

  it("a fresh exchange is six hops", () => {
    expect(FRESH_TTL).toBe(6);
  });
});

describe("the local guard, which does not depend on the peer", () => {
  it("stops replying once the thread hits the consecutive-agent limit", () => {
    const plan = planResponse(msg("ask", 6), MAX_CONSECUTIVE_AGENT_MESSAGES);
    // Silent, deliberately: a peer at this point has already ignored ttl, and
    // anything we send hands them another turn.
    expect(plan.action).toBe("ignore");
  });

  it("overrides a peer claiming a healthy ttl", () => {
    // The whole point: ttl is cooperative, this is not.
    expect(planResponse(msg("ask", 99), MAX_CONSECUTIVE_AGENT_MESSAGES).action).toBe("ignore");
  });

  it("still answers just below the limit", () => {
    expect(planResponse(msg("ask", 6), MAX_CONSECUTIVE_AGENT_MESSAGES - 1).action).toBe("respond");
  });
});

describe("counting agent messages in a thread", () => {
  const bot = { bot_id: "B1" };
  const human = { user: "U1" };

  it("counts only the run at the end", () => {
    expect(countTrailingAgentMessages([bot, human, bot, bot])).toBe(2);
  });

  it("resets at a human message — rule 2", () => {
    expect(countTrailingAgentMessages([bot, bot, bot, human])).toBe(0);
  });

  it("treats a bot_message subtype as an agent", () => {
    expect(countTrailingAgentMessages([human, { subtype: "bot_message" }])).toBe(1);
  });

  it("handles an empty thread", () => {
    expect(countTrailingAgentMessages([])).toBe(0);
  });
});

// Carl's first message said "@Alex" as ordinary text. Slack only builds a real
// mention (<@U…>) when the sender picks from autocomplete, so no app_mention
// event fired and Alex never saw it. Both forms have to count, or A2A works
// only between agents that happen to construct mentions correctly.
describe("addressing", () => {
  const me = { userId: "U0ALEX", handle: "alex" };

  it("recognises a real Slack mention", () => {
    expect(isAddressedToUs("<@U0ALEX> [a2a/1 ask ttl=3]\nhi", me)).toBe(true);
  });

  it("recognises a plain-text handle, which Slack does not linkify", () => {
    expect(isAddressedToUs("[a2a/1 ask ttl=3]\n@Alex hello, this is Carl.", me)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isAddressedToUs("@ALEX are you there", me)).toBe(true);
  });

  it("does not match a longer handle that starts the same", () => {
    expect(isAddressedToUs("@alexandra can you help", me)).toBe(false);
  });

  it("ignores a frame addressed to someone else", () => {
    expect(isAddressedToUs("<@U0CARL> [a2a/1 ask ttl=3]\nhi", me)).toBe(false);
  });

  it("is false when we do not know who we are", () => {
    // Fail closed: answering everything would be worse than answering nothing.
    expect(isAddressedToUs("@alex hello", { userId: null, handle: null })).toBe(false);
  });
});
