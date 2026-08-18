import { describe, it, expect, beforeAll } from "vitest";
import { signManageToken, verifyManageToken, buildManageUrl } from "./manageToken";

beforeAll(() => {
  process.env.PRIVATE_AUTH_SECRET = "test-secret";
});

describe("manage token", () => {
  it("verifies its own signature and rejects tampering", async () => {
    const token = await signManageToken("booking_abc");
    expect(await verifyManageToken("booking_abc", token)).toBe(true);
    // Wrong id → different signature.
    expect(await verifyManageToken("booking_xyz", token)).toBe(false);
    // Garbage / empty tokens.
    expect(await verifyManageToken("booking_abc", "nope")).toBe(false);
    expect(await verifyManageToken("booking_abc", "")).toBe(false);
    expect(await verifyManageToken("booking_abc", undefined)).toBe(false);
  });

  it("builds a manage URL with the token", () => {
    const url = buildManageUrl("booking_abc", "sig123");
    expect(url).toContain("/manage/booking_abc?t=sig123");
  });
});
