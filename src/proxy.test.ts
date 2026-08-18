import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { makeSessionToken, makeCoHostSessionToken } from "@/lib/auth/session";

// The auth gate's redirect behaviour.
//
// The root is the case that matters beyond auth: `/` is the URL every crawler,
// link preview and web-reputation scanner fetches first. While an anonymous GET
// of `/` answered "307 -> /login", the entire public face of this domain was a
// password prompt on a four-week-old domain — FortiGuard rated it Phishing and
// upheld that on re-review. Anonymous visitors must be sent to the public
// booking page instead, WITHOUT the dashboard becoming reachable.

const SECRET = "test-secret-value";

const request = (path: string) => new NextRequest(new URL(path, "https://bookwithhunter.com"));

// A request carrying a session cookie, for the authenticated paths.
const requestWithCookie = (path: string, token: string) =>
  new NextRequest(new URL(path, "https://bookwithhunter.com"), {
    headers: { cookie: `session=${token}` },
  });

const NOW = () => Math.floor(Date.now() / 1000);

describe("proxy redirects", () => {
  beforeEach(() => {
    // Production always sets this, which is what activates the gate.
    process.env.PRIVATE_AUTH_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.PRIVATE_AUTH_SECRET;
  });

  it("sends an anonymous visitor from / to the public booking page", async () => {
    const res = await proxy(request("/"));

    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/book");
    // Never the sign-in form: that is the shape that got the domain flagged.
    expect(location.pathname).not.toBe("/login");
  });

  it("does not carry a ?next= back to the dashboard on the public redirect", async () => {
    const res = await proxy(request("/?utm_source=somewhere"));

    const location = new URL(res.headers.get("location")!);
    expect(location.search).toBe("");
  });

  it("still gates the dashboard rather than serving it", async () => {
    const res = await proxy(request("/"));

    // A redirect, not a 200 — the change moves where anonymous users are sent,
    // it does not open the dashboard up.
    expect(res.status).toBe(307);
  });

  it("sends other private pages to sign-in, remembering where they were going", async () => {
    const res = await proxy(request("/settings"));

    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/settings");
  });

  it("answers private APIs with 401 rather than a redirect", async () => {
    const res = await proxy(request("/api/todos"));

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("lets the public booking page through untouched", async () => {
    const res = await proxy(request("/book"));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  // The joint booking flow adds three public routes; each must be in the proxy
  // allowlist or an anonymous visitor gets gated (regression #10). A team page
  // and its APIs are just as public as the owner's own /book.
  it("lets the joint (team) booking routes through without a session", async () => {
    for (const path of [
      "/book/hunter-and-ben",
      "/api/availability/team/hunter-and-ben?start=1&end=2",
      "/api/public/teams/hunter-and-ben/bookings",
      "/api/agent/public/team/hunter-and-ben",
    ]) {
      const res = await proxy(request(path));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
    }
  });

  it("lets the sign-in page itself through", async () => {
    const res = await proxy(request("/login"));

    expect(res.status).toBe(200);
  });
});

describe("co-host session gating", () => {
  const CO_ID = "clco0host0id0cuid";
  beforeEach(() => {
    process.env.PRIVATE_AUTH_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.PRIVATE_AUTH_SECRET;
  });

  it("lets a co-host reach their own /cohost home", async () => {
    const token = await makeCoHostSessionToken(SECRET, NOW(), CO_ID);
    const res = await proxy(requestWithCookie("/cohost", token));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("lets a co-host reach a co-host API", async () => {
    const token = await makeCoHostSessionToken(SECRET, NOW(), CO_ID);
    const res = await proxy(requestWithCookie("/api/cohost/hours", token));

    expect(res.status).toBe(200);
  });

  it("keeps a co-host OUT of the owner dashboard, sending them home", async () => {
    const token = await makeCoHostSessionToken(SECRET, NOW(), CO_ID);
    const res = await proxy(requestWithCookie("/", token));

    // Redirected to their own home, not the sign-in form (they ARE logged in).
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/cohost");
  });

  it("answers owner-only APIs with 403 for a co-host, not 401", async () => {
    const token = await makeCoHostSessionToken(SECRET, NOW(), CO_ID);
    const res = await proxy(requestWithCookie("/api/todos", token));

    // Authenticated but not permitted — distinct from the anonymous 401.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  it("still lets the OWNER reach the dashboard (co-host layer is additive)", async () => {
    const token = await makeSessionToken(SECRET, NOW());
    const res = await proxy(requestWithCookie("/", token));

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not let an anonymous visitor into a co-host route", async () => {
    const res = await proxy(request("/cohost"));

    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });
});
