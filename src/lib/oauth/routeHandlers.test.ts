import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { Prisma, Provider } from "@prisma/client";

// Connecting a calendar is a round trip: our start route sets a CSRF cookie and
// sends the browser to the provider, which sends it back to a callback URL we
// name. The cookie only comes back if the callback is on the SAME HOST the flow
// started on. From 2026-10-07 to 2026-11-04 it was not: the dashboard lived on
// the sign-in host while the callback was still an env var naming the
// vercel.app deployment domain, so every new calendar ended in `invalid_state`
// on a host where the owner had no session, with nothing shown. These tests pin
// the whole trip to the sign-in host, and pin WHO may make it.

const connectFromCallback = vi.fn();
vi.mock("./store", () => ({
  connectFromCallback: (...a: unknown[]) => connectFromCallback(...a),
  AccountNotFoundError: class AccountNotFoundError extends Error {},
}));
vi.mock("@/lib/env", () => ({
  OAUTH_BASE_URL: "https://bookwithhunter.com",
  // The Twilio-webhook host. Nothing in a connect may land here: the owner has
  // no session on it.
  APP_BASE_URL: "https://agentic-scheduling-abc.vercel.app",
  optionalEnv: (k: string) => process.env[k] || undefined,
  requireEnv: (k: string) => process.env[k] ?? "",
}));
vi.mock("@/lib/auth/ownerLogin", () => ({ isOwnerEmail: vi.fn(), allowedLoginEmails: vi.fn(async () => []) }));
vi.mock("@/lib/auth/coHostLogin", () => ({ coHostForEmail: vi.fn() }));

import { makeStartHandler, makeCallbackHandler } from "./routeHandlers";
import { COOKIE_NAME, makeSessionToken, makeCoHostSessionToken } from "@/lib/auth/session";

const SECRET = "test-secret";
const HOST = "https://bookwithhunter.com";
const now = () => Math.floor(Date.now() / 1000);

function request(url: string, cookies: Record<string, string> = {}): NextRequest {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(url, cookie ? { headers: { cookie } } : undefined);
}
const ownerCookie = async () => ({ [COOKIE_NAME]: await makeSessionToken(SECRET, now()) });
const coHostCookie = async (id: string) => ({ [COOKIE_NAME]: await makeCoHostSessionToken(SECRET, now(), id) });
const location = (res: Response) => new URL(res.headers.get("location")!);

beforeEach(() => {
  connectFromCallback.mockReset();
  vi.stubEnv("PRIVATE_AUTH_SECRET", SECRET);
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "g-client");
  vi.stubEnv("MS_OAUTH_CLIENT_ID", "ms-client");
  // What production still has set. It must no longer decide anything.
  vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://agentic-scheduling-abc.vercel.app/api/oauth/google/callback");
  vi.stubEnv("MS_OAUTH_REDIRECT_URI", "https://agentic-scheduling-abc.vercel.app/api/oauth/microsoft/callback");
});
afterEach(() => vi.unstubAllEnvs());

describe("calendar connect: start", () => {
  const start = makeStartHandler(Provider.google);

  it("sends the owner to Google with a callback on the host the flow started on", async () => {
    const res = await start(request(`${HOST}/api/oauth/google/start`, await ownerCookie()));
    expect(res.status).toBe(307);
    const loc = location(res);
    expect(loc.hostname).toBe("accounts.google.com");
    // Same host as the request, so the state cookie set below comes back.
    expect(loc.searchParams.get("redirect_uri")).toBe(`${HOST}/api/oauth/google/callback`);
    expect(res.cookies.get("oauth_state")?.value).toBe(loc.searchParams.get("state"));
  });

  it("Microsoft returns to the same host too", async () => {
    const res = await makeStartHandler(Provider.microsoft)(
      request(`${HOST}/api/oauth/microsoft/start`, await ownerCookie())
    );
    expect(location(res).searchParams.get("redirect_uri")).toBe(`${HOST}/api/oauth/microsoft/callback`);
  });

  it("a co-host may start a connect", async () => {
    const res = await start(request(`${HOST}/api/oauth/google/start`, await coHostCookie("ck1")));
    expect(location(res).hostname).toBe("accounts.google.com");
  });

  it("started on the public booking host: hops to the sign-in host first, sets no cookie", async () => {
    const res = await start(request("https://book.hunterzhangconsulting.com/api/oauth/google/start"));
    expect(res.headers.get("location")).toBe(`${HOST}/api/oauth/google/start`);
    expect(res.cookies.get("oauth_state")).toBeUndefined();
  });

  it("started on a deployment domain: the same hop", async () => {
    const res = await start(request("https://agentic-scheduling-abc.vercel.app/api/oauth/google/start"));
    expect(res.headers.get("location")).toBe(`${HOST}/api/oauth/google/start`);
  });

  it("a stranger is sent to sign in, never to the provider", async () => {
    const res = await start(request(`${HOST}/api/oauth/google/start`));
    expect(res.headers.get("location")).toBe(`${HOST}/login`);
    expect(res.cookies.get("oauth_state")).toBeUndefined();
  });

  it("an expired or forged session is a stranger", async () => {
    const expired = await makeSessionToken(SECRET, now() - 60 * 60 * 24 * 365);
    const forged = await makeSessionToken("some-other-secret", now());
    const forgedCoHost = await makeCoHostSessionToken("some-other-secret", now(), "ck1");
    for (const token of [expired, forged, forgedCoHost, "garbage", ""]) {
      const res = await start(request(`${HOST}/api/oauth/google/start`, { [COOKIE_NAME]: token }));
      expect(res.headers.get("location")).toBe(`${HOST}/login`);
    }
  });

  // The callback is shared with sign-in and picks its branch by the sign-in
  // state cookie. One left over from an abandoned Google sign-in (10 minutes)
  // would drag this connect into the sign-in branch, where it fails.
  it("drops a leftover sign-in cookie so it cannot hijack the connect", async () => {
    const res = await start(
      request(`${HOST}/api/oauth/google/start`, {
        ...(await ownerCookie()),
        oauth_login_state: "abandoned",
        oauth_login_redirect: `${HOST}/api/oauth/google/callback`,
      })
    );
    const cleared = res.headers.getSetCookie().filter((c) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c));
    expect(cleared.some((c) => c.startsWith("oauth_login_state="))).toBe(true);
    expect(cleared.some((c) => c.startsWith("oauth_login_redirect="))).toBe(true);
    expect(res.cookies.get("oauth_state")?.value).toBeTruthy();
  });

  it("with no auth secret (local dev) the app is open, as everywhere else", async () => {
    vi.stubEnv("PRIVATE_AUTH_SECRET", "");
    const res = await start(request(`${HOST}/api/oauth/google/start`));
    expect(location(res).hostname).toBe("accounts.google.com");
  });
});

describe("calendar connect: callback", () => {
  const callback = makeCallbackHandler(Provider.google);
  const back = (cookies: Record<string, string>, query = "code=abc&state=s1") =>
    callback(request(`${HOST}/api/oauth/google/callback?${query}`, cookies));

  it("owner: stores the calendar as the owner's and lands on the dashboard, on this host", async () => {
    connectFromCallback.mockResolvedValue({ email: "new@example.com" });
    const res = await back({ oauth_state: "s1", ...(await ownerCookie()) });
    expect(connectFromCallback).toHaveBeenCalledWith(Provider.google, "abc", null);
    const loc = location(res);
    expect(loc.origin).toBe(HOST);
    expect(loc.pathname).toBe("/");
    expect(Object.fromEntries(loc.searchParams)).toEqual({
      oauth: "google",
      status: "connected",
      email: "new@example.com",
    });
  });

  it("co-host: stores the calendar under that co-host and lands on /cohost", async () => {
    connectFromCallback.mockResolvedValue({ email: "ben@example.com" });
    const res = await back({ oauth_state: "s1", ...(await coHostCookie("ck1")) });
    expect(connectFromCallback).toHaveBeenCalledWith(Provider.google, "abc", "ck1");
    expect(location(res).pathname).toBe("/cohost");
    expect(location(res).origin).toBe(HOST);
  });

  it("a stranger's consent is never stored as the owner's calendar", async () => {
    const res = await back({ oauth_state: "s1" });
    expect(connectFromCallback).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toBe(`${HOST}/login`);
  });

  it("a missing state cookie is refused on THIS host, where the dashboard can say so", async () => {
    const res = await back(await ownerCookie());
    expect(connectFromCallback).not.toHaveBeenCalled();
    const loc = location(res);
    expect(loc.origin).toBe(HOST);
    expect(loc.searchParams.get("reason")).toBe("invalid_state");
  });

  it("a state that does not match the cookie is refused", async () => {
    const res = await back({ oauth_state: "other", ...(await ownerCookie()) });
    expect(connectFromCallback).not.toHaveBeenCalled();
    expect(location(res).searchParams.get("reason")).toBe("invalid_state");
  });

  it("the provider's own refusal reaches the co-host's page, not the owner's", async () => {
    const res = await back(await coHostCookie("ck1"), "error=access_denied&state=s1");
    const loc = location(res);
    expect(loc.pathname).toBe("/cohost");
    expect(loc.searchParams.get("reason")).toBe("access_denied");
  });

  it("an address someone else already connected says so", async () => {
    connectFromCallback.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "x" })
    );
    const res = await back({ oauth_state: "s1", ...(await ownerCookie()) });
    expect(location(res).searchParams.get("reason")).toBe("already_connected");
  });

  it("any other failure is exchange_failed", async () => {
    connectFromCallback.mockRejectedValue(new Error("Google token exchange failed: 400"));
    const res = await back({ oauth_state: "s1", ...(await ownerCookie()) });
    expect(location(res).searchParams.get("reason")).toBe("exchange_failed");
  });

  it("an expired or forged session stores nothing", async () => {
    const expired = await makeSessionToken(SECRET, now() - 60 * 60 * 24 * 365);
    const forged = await makeSessionToken("some-other-secret", now());
    for (const token of [expired, forged]) {
      const res = await back({ oauth_state: "s1", [COOKIE_NAME]: token });
      expect(res.headers.get("location")).toBe(`${HOST}/login`);
    }
    expect(connectFromCallback).not.toHaveBeenCalled();
  });

  it("with no auth secret (local dev) the connect is the owner's", async () => {
    vi.stubEnv("PRIVATE_AUTH_SECRET", "");
    connectFromCallback.mockResolvedValue({ email: "new@example.com" });
    await back({ oauth_state: "s1" });
    expect(connectFromCallback).toHaveBeenCalledWith(Provider.google, "abc", null);
  });
});

// Sign-in shares this callback. A connect fix must not move it.
describe("sign-in through the shared callback", () => {
  const callback = makeCallbackHandler(Provider.google);
  const loginCookies = { oauth_login_state: "L1", oauth_login_redirect: `${HOST}/api/oauth/google/callback` };

  it("a sign-in whose state does not match goes back to the form, and never connects", async () => {
    const res = await callback(request(`${HOST}/api/oauth/google/callback?code=abc&state=WRONG`, loginCookies));
    expect(res.headers.get("location")).toBe(`${HOST}/login?error=invalid_state`);
    expect(connectFromCallback).not.toHaveBeenCalled();
  });

  it("a cancelled sign-in stays on the sign-in host and never connects", async () => {
    const res = await callback(
      request(`${HOST}/api/oauth/google/callback?error=access_denied&state=L1`, loginCookies)
    );
    const loc = location(res);
    expect(loc.origin).toBe(HOST);
    expect(loc.pathname).toBe("/");
    expect(loc.searchParams.get("reason")).toBe("access_denied");
    expect(connectFromCallback).not.toHaveBeenCalled();
  });
});
