import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The owner reported hearing nothing — on any channel — when visitors booked.
// Two causes stacked: the WhatsApp sender lost its Meta registration (Twilio
// 63112, guarded by the smoke check "owner WhatsApp alerts are deliverable"),
// and no email channel existed at all, so with both Twilio channels down the
// alert fan-out was a fan-out to nowhere. These lock in the email channel and
// its independence from the Twilio ones.
vi.mock("@/lib/notify/email", () => ({
  sendEmail: vi.fn(),
  isUnroutable: vi.fn(() => false),
}));
vi.mock("@/lib/notify/contact", () => ({
  ownerEmailAddress: vi.fn(),
}));
vi.mock("@/lib/sms/send", () => ({
  sendTwilioMessage: vi.fn(),
  sendWhatsAppTemplate: vi.fn(),
  whatsappAddress: (n: string) => (n.startsWith("whatsapp:") ? n : `whatsapp:${n}`),
}));
vi.mock("@/lib/notify/sms", () => ({ sendSms: vi.fn() }));

import { alertHost, newBookingSummary, bookingMechanismLabel } from "./service";
import { CreatedVia, type Booking } from "@prisma/client";
import { sendEmail } from "@/lib/notify/email";
import { ownerEmailAddress } from "@/lib/notify/contact";
import { sendWhatsAppTemplate } from "@/lib/sms/send";

beforeEach(() => {
  vi.mocked(sendEmail).mockReset().mockResolvedValue();
  vi.mocked(sendWhatsAppTemplate).mockReset().mockResolvedValue();
  vi.mocked(ownerEmailAddress).mockReset().mockResolvedValue("owner@real-domain.com");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// The owner asked (2026-08-18) for every new-booking alert to say which of the
// two visitor mechanisms was used: the booking-page UI or chatting with the
// agent. These pin the wording so the label can't silently drop out.
describe("new-booking alert names the booking mechanism", () => {
  const booking = (createdVia: CreatedVia): Booking =>
    ({
      attendeeName: "Jane",
      attendeeEmail: "j@x.com",
      title: "Jane <> Hunter",
      startTime: new Date("2026-08-20T17:00:00Z"),
      createdVia,
    }) as Booking;

  it("a slot picked on the page reads 'via the booking page UI'", () => {
    const s = newBookingSummary(booking(CreatedVia.public_link));
    expect(s).toContain('Jane (j@x.com) booked "Jane <> Hunter"');
    expect(s).toContain("— booked via the booking page UI.");
  });

  it("an agent-made booking reads 'by chatting with the agent'", () => {
    expect(newBookingSummary(booking(CreatedVia.public_agent))).toContain(
      "— booked by chatting with the agent."
    );
  });

  it("every CreatedVia value has a label (no unlabeled alerts possible)", () => {
    for (const via of Object.values(CreatedVia)) {
      expect(bookingMechanismLabel(via)).toBeTruthy();
    }
  });

  it("stays template-safe: single line, no tabs, no 4+ space runs", () => {
    for (const via of Object.values(CreatedVia)) {
      const s = newBookingSummary(booking(via));
      expect(s).not.toMatch(/[\n\t]| {4,}/);
    }
  });
});

describe("alertHost email channel", () => {
  it("emails the owner's resolved address with the alert text", async () => {
    await alertHost("🔔 New booking — Jane (j@x.com) booked for Tue 10 AM.", "summary");
    expect(sendEmail).toHaveBeenCalledWith(
      "owner@real-domain.com",
      "🔔 New booking — Jane (j@x.com) booked for Tue 10 AM.",
      "🔔 New booking — Jane (j@x.com) booked for Tue 10 AM."
    );
  });

  it("still emails when the WhatsApp channel throws (channels are independent)", async () => {
    vi.stubEnv("OWNER_WHATSAPP_NUMBER", "+15550001111");
    vi.stubEnv("TWILIO_WHATSAPP_FROM", "+15552223333");
    vi.stubEnv("TWILIO_BOOKING_ALERT_CONTENT_SID", "HX0");
    vi.mocked(sendWhatsAppTemplate).mockRejectedValue(new Error("63112 sender not registered"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(alertHost("alert", "alert")).resolves.toBeUndefined();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it("an unresolvable owner address fails loudly instead of mailing nobody", async () => {
    vi.mocked(ownerEmailAddress).mockResolvedValue(null);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await alertHost("alert", "alert");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("no-ops without failing when email itself is unconfigured (local dev)", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await alertHost("alert", "alert");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
