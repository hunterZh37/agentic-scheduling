import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReminderChannel, ReminderRecipient, BookingStatus } from "@prisma/client";

vi.mock("@/lib/db", () => ({
  prisma: { reminder: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() } },
}));
vi.mock("./contact", () => ({ resolveContact: vi.fn() }));

import { processDueReminders, type Senders } from "./worker";
import { prisma } from "@/lib/db";
import { resolveContact } from "./contact";

const NOW = new Date("2026-07-20T19:15:00Z");
const booking = {
  id: "b1",
  title: "Torrey <> Alex",
  startTime: new Date("2026-07-20T20:00:00Z"),
  attendeeName: "Torrey",
  status: BookingStatus.confirmed,
};
const base = {
  id: "r1",
  recipient: ReminderRecipient.hunter,
  channel: ReminderChannel.whatsapp,
  fireAt: NOW,
  attempts: 0,
  booking,
};

function senders(): Senders {
  return {
    email: vi.fn().mockResolvedValue(undefined),
    sms: vi.fn().mockResolvedValue(undefined),
    whatsapp: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.mocked(prisma.reminder.findMany).mockReset();
  vi.mocked(prisma.reminder.updateMany).mockReset().mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.reminder.update).mockReset().mockResolvedValue({} as never);
  vi.mocked(resolveContact).mockReset();
});

describe("processDueReminders — whatsapp channel", () => {
  it("sends via senders.whatsapp with the rendered detail line (no 'Reminder:' prefix)", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([{ ...base }] as never);
    vi.mocked(resolveContact).mockResolvedValue({
      name: "Alex",
      email: "alex@example.com",
      whatsappPhone: "+15551234567",
      timezone: "America/Los_Angeles",
    });
    const s = senders();
    const res = await processDueReminders({ now: NOW, senders: s });

    expect(s.whatsapp).toHaveBeenCalledOnce();
    const [to, detail] = vi.mocked(s.whatsapp).mock.calls[0];
    expect(to).toBe("+15551234567");
    expect(detail).not.toMatch(/^Reminder:/);
    expect(detail).toContain('"Torrey <> Alex" with Torrey on');
    expect(s.email).not.toHaveBeenCalled();
    expect(s.sms).not.toHaveBeenCalled();
    expect(res.sent).toBe(1);
    expect(res.deadLettered).toBe(0);
  });

  it("dead-letters (terminal) when the recipient has no whatsapp number", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([{ ...base }] as never);
    vi.mocked(resolveContact).mockResolvedValue({
      name: "Alex",
      email: "alex@example.com",
      timezone: "America/Los_Angeles",
      // whatsappPhone intentionally omitted
    });
    const s = senders();
    const res = await processDueReminders({ now: NOW, senders: s });

    expect(s.whatsapp).not.toHaveBeenCalled();
    expect(res.deadLettered).toBe(1);
    expect(res.sent).toBe(0);
    expect(res.errors[0].message).toBe("no whatsapp number for recipient");
    const upd = vi.mocked(prisma.reminder.update).mock.calls[0][0] as { data: { failedAt: Date } };
    expect(upd.data.failedAt).toEqual(NOW);
  });

  it("retries (not dead-lettered) on a transient whatsapp send failure below the attempt cap", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([{ ...base, attempts: 0 }] as never);
    vi.mocked(resolveContact).mockResolvedValue({
      name: "Alex",
      email: "alex@example.com",
      whatsappPhone: "+15551234567",
      timezone: "America/Los_Angeles",
    });
    const s = senders();
    vi.mocked(s.whatsapp).mockRejectedValue(new Error("twilio down"));
    const res = await processDueReminders({ now: NOW, senders: s });

    expect(res.deadLettered).toBe(0);
    expect(res.failed).toBe(1);
    const upd = vi.mocked(prisma.reminder.update).mock.calls[0][0] as { data: { sentAt: null } };
    expect(upd.data.sentAt).toBeNull();
  });
});
