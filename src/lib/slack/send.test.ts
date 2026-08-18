import { describe, it, expect } from "vitest";
import { stripMention } from "./send";

describe("stripMention", () => {
  it("removes the bot mention so the agent sees the request", () => {
    expect(stripMention("<@U08ABC> book me 30 minutes Friday")).toBe("book me 30 minutes Friday");
  });

  it("handles a mention mid-sentence and collapses the gap", () => {
    expect(stripMention("hey <@U08ABC> what's on Thursday?")).toBe("hey what's on Thursday?");
  });

  it("leaves ordinary text untouched", () => {
    expect(stripMention("cancel my 3pm")).toBe("cancel my 3pm");
  });

  it("does not strip an email or a stray @", () => {
    expect(stripMention("email me at a@b.com")).toBe("email me at a@b.com");
  });
});
