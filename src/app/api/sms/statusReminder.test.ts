import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { reminder: { updateMany: vi.fn() } } }));
vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn((k: string) => (k === "SMS_SKIP_SIGNATURE_CHECK" ? "true" : undefined)),
  requireEnv: vi.fn(() => "token"),
  APP_BASE_URL: "https://bookwithhunter.com",
}));
vi.mock("@/lib/sms/verify", () => ({ verifyTwilioSignature: vi.fn(() => true) }));
vi.mock("@/lib/sms/send", () => ({
  sendTwilioMessage: vi.fn(),
  getTwilioMessageBody: vi.fn(async () => null),
}));

import { POST } from "./status/route";
import { prisma } from "@/lib/db";

// A reminder's sentAt only ever meant "Twilio accepted it". WhatsApp failures
// arrive minutes later on this webhook (63016 and 63049 have both been seen),
// so a reminder that never reached anyone still read as delivered — the owner
// had no way to know one had been missed.
const post = (status: string, opts: { reminderId?: string; from?: string } = {}) => {
  const body = new URLSearchParams({
    MessageStatus: status,
    From: opts.from ?? "whatsapp:+15550001111",
    To: "whatsapp:+15550002222",
    MessageSid: "SM123",
    ErrorCode: "63049",
  });
  const url = opts.reminderId
    ? `https://bookwithhunter.com/api/sms/status?reminderId=${opts.reminderId}`
    : "https://bookwithhunter.com/api/sms/status";
  return POST(new Request(url, { method: "POST", body }) as never);
};

beforeEach(() => {
  vi.mocked(prisma.reminder.updateMany).mockReset().mockResolvedValue({ count: 1 } as never);
});

describe("status webhook marks the reminder", () => {
  it("clears sentAt and sets failedAt on an undelivered message", async () => {
    await post("undelivered", { reminderId: "rem_1" });
    const call = vi.mocked(prisma.reminder.updateMany).mock.calls[0][0] as {
      where: { id: string; failedAt: null };
      data: { sentAt: null; failedAt: Date };
    };
    expect(call.where.id).toBe("rem_1");
    expect(call.data.sentAt).toBeNull();
    expect(call.data.failedAt).toBeInstanceOf(Date);
  });

  it("only touches a row that has not already been dead-lettered", async () => {
    await post("failed", { reminderId: "rem_1" });
    const call = vi.mocked(prisma.reminder.updateMany).mock.calls[0][0] as {
      where: { failedAt: null };
    };
    // Without this guard a late callback could resurrect a reminder that has
    // since been re-sent or already failed.
    expect(call.where.failedAt).toBeNull();
  });

  it("leaves the reminder alone on a successful delivery", async () => {
    await post("delivered", { reminderId: "rem_1" });
    expect(prisma.reminder.updateMany).not.toHaveBeenCalled();
  });

  it("marks an SMS failure too, not just WhatsApp", async () => {
    await post("failed", { reminderId: "rem_1", from: "+15550001111" });
    expect(prisma.reminder.updateMany).toHaveBeenCalled();
  });

  it("does nothing when the callback carries no reminder id", async () => {
    await post("failed");
    expect(prisma.reminder.updateMany).not.toHaveBeenCalled();
  });
});
