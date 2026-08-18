import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safeNext";

// Security-audit finding (2026-08-18): `next.startsWith("/")` accepted
// protocol-relative URLs, so /login?next=//evil.com bounced a freshly
// signed-in owner to an attacker page. These pin the sanitizer.
describe("safeNextPath", () => {
  it("keeps ordinary same-site paths", () => {
    expect(safeNextPath("/")).toBe("/");
    expect(safeNextPath("/manage/abc?t=x")).toBe("/manage/abc?t=x");
  });

  it("rejects protocol-relative URLs (//evil.com)", () => {
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("//evil.com/phish")).toBe("/");
  });

  it("rejects backslash variants some parsers treat as //", () => {
    expect(safeNextPath("/\\evil.com")).toBe("/");
  });

  it("rejects absolute URLs and garbage", () => {
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});
