import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

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

  it("lets the sign-in page itself through", async () => {
    const res = await proxy(request("/login"));

    expect(res.status).toBe(200);
  });
});
