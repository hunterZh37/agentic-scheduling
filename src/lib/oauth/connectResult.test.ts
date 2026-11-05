import { describe, it, expect } from "vitest";
import { readConnectResult } from "./connectResult";

// The connect callback reports back through the query string. Until
// 2026-11-04 only the co-host page read it, and only as "it failed": the
// owner's dashboard ignored it entirely, so a failed connect looked like
// nothing had happened.

describe("readConnectResult", () => {
  it("is null on an ordinary page load", () => {
    expect(readConnectResult("")).toBeNull();
    expect(readConnectResult("?date=2026-11-04")).toBeNull();
    expect(readConnectResult("?status=connected")).toBeNull();
  });

  it("names the calendar that connected", () => {
    expect(readConnectResult("?oauth=google&status=connected&email=a%40b.com")).toEqual({
      kind: "connected",
      message: "Connected a@b.com.",
    });
    expect(readConnectResult("?oauth=google&status=connected")?.message).toBe("Calendar connected.");
  });

  it("says why a connect failed, per reason", () => {
    const msg = (reason: string, oauth = "google") =>
      readConnectResult(`?oauth=${oauth}&status=error&reason=${reason}`);
    expect(msg("invalid_state")?.message).toBe("That connection expired. Try again.");
    expect(msg("access_denied")?.message).toMatch(/^Google access was declined\. .*admin/);
    expect(msg("access_denied", "microsoft")?.message).toMatch(/^Microsoft/);
    expect(msg("already_connected")?.message).toMatch(/already connected/);
    expect(msg("unknown_account")?.message).toMatch(/another provider/);
    expect(msg("exchange_failed")?.message).toBe("Google rejected the connection. Try again.");
    expect(msg("invalid_state")?.kind).toBe("error");
  });

  // A failure that will repeat must not tell the person to try again.
  it("only says 'Try again' where trying again can work", () => {
    const msg = (reason: string) => readConnectResult(`?oauth=google&status=error&reason=${reason}`)!.message;
    for (const r of ["access_denied", "already_connected", "unknown_account"]) {
      expect(msg(r)).not.toMatch(/try again/i);
    }
  });

  it("falls back to a plain message for a reason it has never seen", () => {
    expect(readConnectResult("?oauth=google&status=error&reason=%3Cscript%3E")).toEqual({
      kind: "error",
      message: "Couldn't connect that calendar. Try again.",
    });
    expect(readConnectResult("?oauth=google&status=error")?.kind).toBe("error");
  });

  // The query string is anyone's to craft and send the owner. Nothing in it is
  // shown unless it is what it claims to be.
  it("does not echo a crafted link", () => {
    // `oauth=constructor` used to index a plain object and print a function.
    for (const oauth of ["constructor", "__proto__", "toString", "evil"]) {
      const m = readConnectResult(`?oauth=${oauth}&status=error&reason=exchange_failed`)!.message;
      expect(m).toBe("The provider rejected the connection. Try again.");
    }
    const notAnAddress = encodeURIComponent("your account was suspended, call 555 0100");
    expect(readConnectResult(`?oauth=google&status=connected&email=${notAnAddress}`)?.message).toBe(
      "Calendar connected."
    );
    const huge = `${"a".repeat(300)}@b.com`;
    expect(readConnectResult(`?oauth=google&status=connected&email=${huge}`)?.message).toBe("Calendar connected.");
    expect(readConnectResult("?oauth=google&status=connected&email=%3Cb%3E@x.com")?.message).toBe(
      "Calendar connected."
    );
  });

  it("uses no em dashes", () => {
    for (const r of ["invalid_state", "access_denied", "already_connected", "unknown_account", "exchange_failed", "x"]) {
      expect(readConnectResult(`?oauth=google&status=error&reason=${r}`)?.message).not.toMatch(/—/);
    }
  });
});
