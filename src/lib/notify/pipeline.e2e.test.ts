import { describe, it, expect, vi, beforeEach } from "vitest";

// End-to-end for the reminder pipeline, stubbed only at the HTTP boundary.
//
// Everything between a due Reminder row and the outbound request is the REAL
// code: the worker's claim/dispatch/dead-letter logic, resolveContact (including
// the database lookup for the owner's address), the message renderer,
// sendEmail's unroutable-recipient guard, sendWhatsAppReminder's template
// lookup, and sendWhatsAppTemplate's payload and StatusCallback construction.
// Only `fetch` is faked, so what we assert is the exact request that would have
// gone to Resend or Twilio.
//
// This exists because every reminder failure so far has been in the seams
// rather than in any one unit: the right worker calling a correct sender with
// an address that goes nowhere; a template send that silently became freeform;
// a callback URL with no way to identify the reminder it belonged to.

vi.mock("@/lib/db", () => ({
  prisma: {
    reminder: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    account: { findFirst: vi.fn() },
  },
}));

const ENV: Record<string, string | undefined> = {
  RESEND_API_KEY: "re_test",
  REMINDER_FROM_EMAIL: "reminders@bookwithhunter.com",
  TWILIO_ACCOUNT_SID: "AC_test",
  TWILIO_AUTH_TOKEN: "tok_test",
  TWILIO_WHATSAPP_FROM: "+15559915614",
  TWILIO_REMINDER_CONTENT_SID: "HX_reminder",
  OWNER_WHATSAPP_NUMBER: "+15550004242",
  OWNER_TIMEZONE: "America/Los_Angeles",
};
vi.mock("@/lib/env", () => ({
  optionalEnv: (k: string) => ENV[k],
  requireEnv: (k: string) => {
    const v = ENV[k];
    if (!v) throw new Error(`Missing required environment variable ${k}`);
    return v;
  },
  APP_BASE_URL: "https://bookwithhunter.com",
  DEFAULT_DESTINATION_EMAIL: "owner@example.com",
}));

import { processDueReminders } from "./worker";
import { prisma } from "@/lib/db";
import { ReminderChannel, ReminderRecipient } from "@prisma/client";

const NOW = new Date("2026-08-08T18:00:00Z");
const booking = {
  id: "bk_1",
  title: "Abraham & Camilo <> Hunter",
  startTime: new Date("2026-08-08T19:00:00Z"),
  endTime: new Date("2026-08-08T19:30:00Z"),
  attendeeName: "Abraham & Camilo",
  attendeeEmail: "abraham.behar@summitcp.com",
  attendeeTimezone: "America/Los_Angeles",
  status: "confirmed",
};

const reminder = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "rem_1",
  bookingId: "bk_1",
  recipient: ReminderRecipient.hunter,
  channel: ReminderChannel.email,
  fireAt: new Date("2026-08-08T18:00:00Z"),
  sentAt: null,
  failedAt: null,
  attempts: 0,
  booking,
  ...over,
});

/// Every outbound request the run made.
let calls: Array<{ url: string; body: string; headers: Record<string, string> }>;

const stubFetch = (respond: (url: string) => { ok: boolean; status: number } = () => ({ ok: true, status: 200 })) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      calls.push({ url: String(url), body: String(init?.body ?? ""), headers: init?.headers ?? {} });
      const r = respond(String(url));
      return { ...r, text: async () => "", json: async () => ({ id: "msg_1" }) };
    })
  );
};

beforeEach(() => {
  calls = [];
  vi.mocked(prisma.reminder.updateMany).mockReset().mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.reminder.update).mockReset().mockResolvedValue({} as never);
  // The owner has no OWNER_EMAIL set — the address must come from the
  // destination calendar account, which is the fix for reminders addressed to
  // a placeholder.
  vi.mocked(prisma.account.findFirst).mockReset().mockResolvedValue({
    email: "owner@myrealmail.com",
  } as never);
  stubFetch();
});

describe("reminder pipeline end to end", () => {
  it("emails the owner at the address from the destination calendar", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([reminder()] as never);

    const res = await processDueReminders({ now: NOW });

    expect(res.sent).toBe(1);
    expect(res.failed).toBe(0);
    const call = calls.find((c) => c.url.includes("api.resend.com"))!;
    expect(call).toBeTruthy();
    const payload = JSON.parse(call.body);
    expect(payload.to).toBe("owner@myrealmail.com");
    // Never the placeholder the old fallback chain ended at.
    expect(payload.to).not.toContain("example.com");
    expect(payload.subject).toBeTruthy();
    expect(payload.text).toContain("Abraham & Camilo");
  });

  it("emails the attendee at their own address, not the owner's", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([
      reminder({ id: "rem_2", recipient: ReminderRecipient.attendee }),
    ] as never);

    await processDueReminders({ now: NOW });

    const payload = JSON.parse(calls.find((c) => c.url.includes("resend"))!.body);
    expect(payload.to).toBe("abraham.behar@summitcp.com");
  });

  it("sends WhatsApp as an approved TEMPLATE, never freeform", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([
      reminder({ id: "rem_3", channel: ReminderChannel.whatsapp }),
    ] as never);

    await processDueReminders({ now: NOW });

    const call = calls.find((c) => c.url.includes("api.twilio.com"))!;
    const body = new URLSearchParams(call.body);
    // A freeform Body outside the 24h window is rejected with 63016 — the
    // template is the whole reason the reminder path works at all.
    expect(body.get("ContentSid")).toBe("HX_reminder");
    expect(body.get("Body")).toBeNull();
    expect(body.get("To")).toBe("whatsapp:+15550004242");
    expect(body.get("From")).toBe("whatsapp:+15559915614");
    expect(JSON.parse(body.get("ContentVariables")!)["1"]).toContain("Abraham & Camilo");
  });

  it("tells Twilio which reminder to report back about", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([
      reminder({ id: "rem_4", channel: ReminderChannel.whatsapp }),
    ] as never);

    await processDueReminders({ now: NOW });

    const body = new URLSearchParams(calls.find((c) => c.url.includes("twilio"))!.body);
    const cb = new URL(body.get("StatusCallback")!);
    // Without this the status webhook knows a message failed but not which
    // reminder to mark, and a failed reminder keeps reading as sent.
    expect(cb.pathname).toBe("/api/sms/status");
    expect(cb.searchParams.get("reminderId")).toBe("rem_4");
  });

  it("dead-letters instead of reporting success when the provider rejects it", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([
      reminder({ id: "rem_5", channel: ReminderChannel.whatsapp }),
    ] as never);
    stubFetch(() => ({ ok: false, status: 400 }));

    const res = await processDueReminders({ now: NOW });

    expect(res.sent).toBe(0);
    expect(res.failed).toBe(1);
    // sentAt cleared so it does not masquerade as delivered.
    const update = vi.mocked(prisma.reminder.update).mock.calls.at(-1)![0] as unknown as {
      data: { sentAt: null };
    };
    expect(update.data.sentAt).toBeNull();
  });

  it("dead-letters when the owner has no address at all", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([reminder({ id: "rem_6" })] as never);

    const res = await processDueReminders({ now: NOW });

    expect(res.sent).toBe(0);
    expect(res.deadLettered).toBe(1);
    // And crucially: nothing was sent to a placeholder.
    expect(calls.filter((c) => c.url.includes("resend"))).toHaveLength(0);
  });

  it("does not send for a cancelled booking", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([
      reminder({ id: "rem_7", booking: { ...booking, status: "cancelled" } }),
    ] as never);

    const res = await processDueReminders({ now: NOW });

    expect(res.skipped).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("runs the whole set for one booking: owner email, owner WhatsApp, attendee email", async () => {
    vi.mocked(prisma.reminder.findMany).mockResolvedValue([
      reminder({ id: "a" }),
      reminder({ id: "b", channel: ReminderChannel.whatsapp }),
      reminder({ id: "c", recipient: ReminderRecipient.attendee }),
    ] as never);

    const res = await processDueReminders({ now: NOW });

    expect(res.sent).toBe(3);
    const recipients = calls.map((c) =>
      c.url.includes("resend")
        ? JSON.parse(c.body).to
        : new URLSearchParams(c.body).get("To")
    );
    expect(recipients).toEqual([
      "owner@myrealmail.com",
      "whatsapp:+15550004242",
      "abraham.behar@summitcp.com",
    ]);
  });
});
