import { describe, it, expect } from "vitest";
import { hashPassword, verifyPasswordHash } from "./password";

describe("password hashing", () => {
  it("verifies a correct password against its hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPasswordHash("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("hunter2-and-then-some");
    expect(await verifyPasswordHash("wrong-password", hash)).toBe(false);
  });

  it("uses the documented encoded form", async () => {
    const hash = await hashPassword("whatever-goes-here");
    expect(hash).toMatch(/^pbkdf2\$\d+\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  it("salts: the same password hashes differently each time", async () => {
    const a = await hashPassword("same-password-123");
    const b = await hashPassword("same-password-123");
    expect(a).not.toBe(b);
    // ...but both still verify.
    expect(await verifyPasswordHash("same-password-123", a)).toBe(true);
    expect(await verifyPasswordHash("same-password-123", b)).toBe(true);
  });

  it("returns false for malformed stored values instead of throwing", async () => {
    expect(await verifyPasswordHash("x", "")).toBe(false);
    expect(await verifyPasswordHash("x", "not-the-format")).toBe(false);
    expect(await verifyPasswordHash("x", "pbkdf2$abc$deadbeef$cafe")).toBe(false);
    expect(await verifyPasswordHash("x", "pbkdf2$210000$nothex$nothex")).toBe(false);
    expect(await verifyPasswordHash("x", "bcrypt$210000$aa$bb")).toBe(false);
  });
});
