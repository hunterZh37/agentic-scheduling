import { describe, it, expect } from "vitest";
import { loginMessage } from "./loginMessage";

describe("the sign-in form's message for ?error=", () => {
  it("nothing when there is no error", () => expect(loginMessage(undefined)).toBeNull());
  it("a refused account", () => expect(loginMessage("not_authorized")).toBe("That Google account isn't the owner of this site."));
  it("sign-in not configured", () => {
    expect(loginMessage("auth_not_configured")).toBe("Google sign-in isn't configured yet.");
    expect(loginMessage("login_allowlist_empty")).toBe("Google sign-in isn't configured yet.");
  });
  // 2026-11-05: an approval screen left open past the cookie's lifetime landed
  // on a bare /login with nothing said.
  it("a flow that took too long says so", () =>
    expect(loginMessage("expired")).toBe("That took too long. Start again and finish within 30 minutes."));
  it("anything else is a generic retry", () => expect(loginMessage("whatever")).toBe("Google sign-in didn't complete. Try again."));
});
