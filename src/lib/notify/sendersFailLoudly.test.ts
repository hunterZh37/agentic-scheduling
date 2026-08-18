import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The bug behind three "sent" reminders that nobody received: a send path that
// logs a problem and RETURNS reads as success to its caller. The reminder
// worker sets sentAt when the sender resolves, so a silent return marks a
// message delivered that was never attempted.
//
// Source-level because the failure is structural — a behavioural test only
// covers the paths someone remembered to write, and this is about the ones
// nobody thought about.
const read = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");

describe("send paths fail loudly, never silently", () => {
  it("Twilio sends throw on a missing auth token", () => {
    const src = read("lib/sms/send.ts");
    // The old shape: console.error(...) immediately followed by a bare return.
    expect(src).not.toMatch(/TWILIO_AUTH_TOKEN is unset[\s\S]{0,120}\n\s*return;/);
    expect(src).toMatch(/throw new Error\(\s*"TWILIO_AUTH_TOKEN is unset/);
  });

  it("a non-OK Twilio response throws rather than being logged and swallowed", () => {
    const src = read("lib/sms/send.ts");
    expect(src).toMatch(/throw new Error\(`Twilio send failed/);
  });

  it("email refuses an unroutable recipient instead of reporting success", () => {
    const src = read("lib/notify/email.ts");
    expect(src).toMatch(/isUnroutable\(to\)/);
    expect(src).toMatch(/throw new Error\(/);
  });

  it("the reminder worker treats a resolved send as sent — which is why the above matters", () => {
    const src = read("lib/notify/worker.ts");
    // sentAt is claimed BEFORE dispatch and only cleared on a throw.
    expect(src).toMatch(/data: \{ sentAt: now, attempts: \{ increment: 1 \} \}/);
    expect(src).toMatch(/data: \{ sentAt: null, failedAt: now \}/);
  });
});
