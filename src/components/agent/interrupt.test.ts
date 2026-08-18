import { describe, it, expect } from "vitest";
import { interruptedComposerState } from "./interrupt";
import type { Message } from "./AgentPane";

// Owner request (2026-08-18): pressing Esc while the agent is thinking should
// take the message back — the just-sent text returns to the composer, editable,
// and the optimistic user bubble leaves the thread (Claude-Code-style).
describe("interruptedComposerState", () => {
  const welcome: Message = { id: "welcome", role: "agent", text: "hi" };

  it("returns the sent text to the draft verbatim", () => {
    const { draft } = interruptedComposerState([welcome], "book luch with sam");
    expect(draft).toBe("book luch with sam");
  });

  it("reverts the thread to the snapshot taken before the send", () => {
    const snapshot: Message[] = [welcome, { id: "a-1", role: "agent", text: "done" }];
    const { messages } = interruptedComposerState(snapshot, "next one");
    // Exactly the pre-send thread — no optimistic user bubble, no error reply.
    expect(messages).toEqual(snapshot);
    expect(messages.some((m) => m.role === "user")).toBe(false);
  });

  it("preserves leading/trailing content of the sent text as-is", () => {
    const { draft } = interruptedComposerState([welcome], "move the 3pm to 4");
    expect(draft).toBe("move the 3pm to 4");
  });
});
