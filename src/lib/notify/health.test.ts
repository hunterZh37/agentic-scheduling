import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/env", () => ({ optionalEnv: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { reminder: { count: vi.fn() } } }));
vi.mock("./contact", () => ({ ownerEmailAddress: vi.fn() }));

import { checkMessaging, messagingProblems } from "./health";
import { optionalEnv } from "@/lib/env";
import { prisma } from "@/lib/db";
import { ownerEmailAddress } from "./contact";

const env = (map: Record<string, string>) =>
  vi.mocked(optionalEnv).mockImplementation((k: string) => map[k]);

const state = (h: Awaited<ReturnType<typeof checkMessaging>>, name: string) =>
  h.checks.find((c) => c.name === name)?.state;

beforeEach(() => {
  vi.mocked(optionalEnv).mockReset().mockReturnValue(undefined);
  vi.mocked(prisma.reminder.count).mockReset().mockResolvedValue(0 as never);
  vi.mocked(ownerEmailAddress).mockReset().mockResolvedValue("owner@myrealmail.com");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "active" }) })));
});

// Every fault this checks for has actually happened here: mail addressed to a
// placeholder, a reminder template that was never configured, and reminders
// that failed to deliver while the app reported success.
describe("checkMessaging", () => {
  it("fails when the owner has no email address", async () => {
    vi.mocked(ownerEmailAddress).mockResolvedValue(null);
    const h = await checkMessaging();
    expect(state(h, "email.owner_recipient")).toBe("fail");
    expect(h.ok).toBe(false);
  });

  it("fails when the WhatsApp reminder template is missing", async () => {
    // Without it a reminder sends freeform and WhatsApp rejects it outside the
    // 24h window — the 63016 we saw in production.
    env({ RESEND_API_KEY: "k", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t", OWNER_WHATSAPP_NUMBER: "+1" });
    const h = await checkMessaging();
    expect(state(h, "whatsapp.reminder_template")).toBe("fail");
  });

  it("warns — but does not fail — when a reminder failed to deliver in 24h", async () => {
    env({
      RESEND_API_KEY: "k", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t",
      TWILIO_WHATSAPP_FROM: "+1", TWILIO_REMINDER_CONTENT_SID: "HX", OWNER_WHATSAPP_NUMBER: "+1",
    });
    vi.mocked(prisma.reminder.count).mockResolvedValue(2 as never);
    const h = await checkMessaging();
    expect(state(h, "reminders.recent_failures")).toBe("warn");
    // Worth alerting about...
    expect(h.hasWarnings).toBe(true);
    expect(messagingProblems(h).join(" ")).toMatch(/2 reminder\(s\) failed/);
    // ...but NOT a reason to 503 the health endpoint and block every push for
    // 24h, including the push that fixes it. It describes the past; `ok` is
    // about whether we can send now.
    expect(h.ok).toBe(true);
  });

  it("fails on a rejected Resend key", async () => {
    env({ RESEND_API_KEY: "dead", TWILIO_REMINDER_CONTENT_SID: "HX" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    const h = await checkMessaging();
    expect(state(h, "email.credentials")).toBe("fail");
  });

  it("fails on a suspended Twilio account, not just a bad request", async () => {
    env({ RESEND_API_KEY: "k", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t", TWILIO_REMINDER_CONTENT_SID: "HX", OWNER_WHATSAPP_NUMBER: "+1", TWILIO_WHATSAPP_FROM: "+1" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ status: "suspended" }) })));
    const h = await checkMessaging();
    expect(state(h, "twilio.credentials")).toBe("fail");
  });

  it("passes when everything is configured and nothing has failed", async () => {
    env({
      RESEND_API_KEY: "k", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t",
      TWILIO_WHATSAPP_FROM: "+1", TWILIO_REMINDER_CONTENT_SID: "HX", OWNER_WHATSAPP_NUMBER: "+1",
    });
    const h = await checkMessaging();
    expect(h.ok).toBe(true);
    expect(messagingProblems(h)).toEqual([]);
  });

  it("treats an unconfigured optional channel as not a failure", async () => {
    // No WhatsApp sender at all is a legitimate install; a CONFIGURED channel
    // that cannot send is not.
    env({ RESEND_API_KEY: "k", TWILIO_REMINDER_CONTENT_SID: "HX", OWNER_SMS_NUMBER: "+1" });
    const h = await checkMessaging();
    expect(state(h, "whatsapp.sender")).toBe("not_configured");
  });
});

// 63049: Meta declines to deliver a MARKETING-categorised template to a US
// number. No retry and no code change fixes it — the template has to be
// recategorised as Utility. A booking reminder is a Utility message; approved
// as Marketing it silently never arrives, which is what happened here.
describe("WhatsApp template category", () => {
  const configured = {
    RESEND_API_KEY: "k", TWILIO_ACCOUNT_SID: "AC", TWILIO_AUTH_TOKEN: "t",
    TWILIO_WHATSAPP_FROM: "+1", TWILIO_REMINDER_CONTENT_SID: "HX", OWNER_WHATSAPP_NUMBER: "+1",
  };

  it("warns when the reminder template is approved as marketing", async () => {
    env(configured);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("content.twilio.com")
        ? { ok: true, json: async () => ({ whatsapp: { category: "MARKETING", status: "approved" } }) }
        : { ok: true, json: async () => ({ status: "active" }) }
    ));
    const h = await checkMessaging();
    expect(state(h, "whatsapp.template_category")).toBe("warn");
    expect(messagingProblems(h).join(" ")).toMatch(/63049/);
    // Alerts, but does not gate a deploy: WhatsApp is one channel of two, email
    // still delivers, and the remedy is a Twilio console change rather than a
    // push.
    expect(h.ok).toBe(true);
    expect(h.hasWarnings).toBe(true);
  });

  it("passes for a utility template", async () => {
    env(configured);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("content.twilio.com")
        ? { ok: true, json: async () => ({ whatsapp: { category: "UTILITY", status: "approved" } }) }
        : { ok: true, json: async () => ({ status: "active" }) }
    ));
    const h = await checkMessaging();
    expect(state(h, "whatsapp.template_category")).toBe("ok");
  });

  it("only warns when the category cannot be read", async () => {
    env(configured);
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("content.twilio.com")
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, json: async () => ({ status: "active" }) }
    ));
    const h = await checkMessaging();
    // Not knowing is not the same as knowing it is wrong.
    expect(state(h, "whatsapp.template_category")).toBe("warn");
    expect(h.ok).toBe(true);
  });
});
