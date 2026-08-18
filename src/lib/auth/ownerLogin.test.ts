import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: { account: { findFirst: vi.fn() } } }));
vi.mock("@/lib/env", () => ({ optionalEnv: vi.fn() }));

import { allowedLoginEmails, isOwnerEmail } from "./ownerLogin";
import { prisma } from "@/lib/db";
import { optionalEnv } from "@/lib/env";

beforeEach(() => {
  vi.mocked(optionalEnv).mockReset().mockReturnValue(undefined);
  vi.mocked(prisma.account.findFirst).mockReset().mockResolvedValue(null as never);
});

describe("allowedLoginEmails", () => {
  it("parses the explicit allowlist", async () => {
    vi.mocked(optionalEnv).mockReturnValue("Me@Example.com, other@example.com");
    expect(await allowedLoginEmails()).toEqual(["me@example.com", "other@example.com"]);
  });

  it("falls back to the destination account when unset", async () => {
    vi.mocked(prisma.account.findFirst).mockResolvedValue({ email: "Owner@Example.com" } as never);
    expect(await allowedLoginEmails()).toEqual(["owner@example.com"]);
  });

  it("returns nothing when neither source is available", async () => {
    expect(await allowedLoginEmails()).toEqual([]);
  });
});

describe("isOwnerEmail", () => {
  // The security property: an unset allowlist must deny, never allow-all.
  it("denies everyone when no allowlist can be resolved", async () => {
    expect(await isOwnerEmail("anyone@example.com")).toBe(false);
    expect(await isOwnerEmail("")).toBe(false);
  });

  it("accepts the owner regardless of case", async () => {
    vi.mocked(optionalEnv).mockReturnValue("owner@example.com");
    expect(await isOwnerEmail("OWNER@Example.com")).toBe(true);
    expect(await isOwnerEmail("  owner@example.com  ")).toBe(true);
  });

  it("rejects anyone not on the list", async () => {
    vi.mocked(optionalEnv).mockReturnValue("owner@example.com");
    expect(await isOwnerEmail("attacker@example.com")).toBe(false);
    // Not fooled by a lookalike that merely contains the owner address.
    expect(await isOwnerEmail("owner@example.com.evil.com")).toBe(false);
  });
});
