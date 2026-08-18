import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { account: { findFirst: vi.fn() } } }));
vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn(),
  requireEnv: vi.fn(() => "key"),
  DEFAULT_DESTINATION_EMAIL: "owner@example.com",
}));

import { ownerEmailAddress } from "./contact";
import { isUnroutable, sendEmail } from "./email";
import { prisma } from "@/lib/db";
import { optionalEnv } from "@/lib/env";

beforeEach(() => {
  vi.mocked(optionalEnv).mockReset().mockReturnValue(undefined);
  vi.mocked(prisma.account.findFirst).mockReset().mockResolvedValue(null as never);
});

// Production had NO recipient env var set, so every owner-facing email resolved
// through the fallback chain to the literal "owner@example.com" — a reserved
// documentation domain. Resend accepted it, the cron logged 200, and the daily
// reputation audit reached nobody. Silence looked exactly like "no news".
describe("isUnroutable", () => {
  it("catches reserved documentation domains", () => {
    expect(isUnroutable("owner@example.com")).toBe(true);
    expect(isUnroutable("reminders@example.org")).toBe(true);
    expect(isUnroutable("a@thing.invalid")).toBe(true);
    expect(isUnroutable("Owner@EXAMPLE.com")).toBe(true);
  });

  it("passes real addresses through", () => {
    expect(isUnroutable("owner@myrealmail.com")).toBe(false);
    expect(isUnroutable("someone@gmail.com")).toBe(false);
    // A domain that merely CONTAINS the word is fine.
    expect(isUnroutable("a@example.company.com")).toBe(false);
  });
});

describe("sendEmail refuses unroutable recipients", () => {
  it("throws instead of reporting a successful send to nowhere", async () => {
    await expect(sendEmail("owner@example.com", "Audit", "body")).rejects.toThrow(
      /reserved example domain/i
    );
  });
});

describe("ownerEmailAddress", () => {
  it("prefers an explicitly configured address", async () => {
    vi.mocked(optionalEnv).mockImplementation((k) =>
      k === "OWNER_EMAIL" ? "me@real.com" : undefined
    );
    expect(await ownerEmailAddress()).toBe("me@real.com");
  });

  it("falls back to the destination calendar account, not a placeholder", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({
      email: "owner@myrealmail.com",
    } as never);
    expect(await ownerEmailAddress()).toBe("owner@myrealmail.com");
  });

  it("ignores a placeholder even when it is configured", async () => {
    vi.mocked(optionalEnv).mockImplementation((k) =>
      k === "DEFAULT_DESTINATION_EMAIL" ? "owner@example.com" : undefined
    );
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ email: "real@outlook.com" } as never);
    expect(await ownerEmailAddress()).toBe("real@outlook.com");
  });

  it("returns null rather than an address that cannot receive mail", async () => {
    expect(await ownerEmailAddress()).toBeNull();
  });
});

// Reminders resolved the owner's address through the same chain that ended at
// "owner@example.com". Three reminders for one booking reported success while
// nothing arrived, because a placeholder recipient is accepted by the provider
// and delivered nowhere.
describe("reminder contact resolution", () => {
  it("uses the destination calendar account when no env var is set", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({
      email: "owner@myrealmail.com",
    } as never);
    const { resolveContact } = await import("./contact");
    const c = await resolveContact("hunter" as never, {
      attendeeName: "A",
      attendeeEmail: "a@b.com",
      attendeeTimezone: "America/Los_Angeles",
    });
    expect(c.email).toBe("owner@myrealmail.com");
  });

  it("returns no address rather than a placeholder, so the worker dead-letters it", async () => {
    const { resolveContact } = await import("./contact");
    const c = await resolveContact("hunter" as never, {
      attendeeName: "A",
      attendeeEmail: "a@b.com",
      attendeeTimezone: "America/Los_Angeles",
    });
    // Nothing configured and no destination account → undefined, never
    // "owner@example.com".
    expect(c.email).toBeUndefined();
  });

  it("still uses the booking's own address for the attendee", async () => {
    const { resolveContact } = await import("./contact");
    const c = await resolveContact("attendee" as never, {
      attendeeName: "Abraham",
      attendeeEmail: "abraham.behar@summitcp.com",
      attendeeTimezone: "America/Los_Angeles",
    });
    expect(c.email).toBe("abraham.behar@summitcp.com");
  });
});
