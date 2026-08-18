#!/usr/bin/env node
// Live smoke checks against a running deployment.
//
// These cover the failures that unit tests structurally CANNOT catch: wrong
// environment variables, a proxy matcher that lets a request past the auth
// gate, a stale deploy, or data that makes the booking page useless. Every one
// of these shipped green unit tests and still broke in production.
//
// Strictly read-only: it never creates a booking, block, or event.
//
//   npm run smoke                      # against production
//   BASE=http://localhost:3000 npm run smoke
//
// Exit code 0 = all passed, 1 = at least one failure.

const BASE = process.env.BASE || "https://bookwithhunter.com";
const results = [];

const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}${detail ? `\n          ${detail}` : ""}`);
};

const check = async (name, fn) => {
  try {
    const { ok, detail } = await fn();
    record(name, ok, detail);
  } catch (err) {
    record(name, false, `threw: ${String(err).slice(0, 160)}`);
  }
};

const get = (path, opts) => fetch(BASE + path, { redirect: "manual", ...opts });

const isoDay = (offsetDays) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

console.log(`\nSmoke checks against ${BASE}\n`);

// --- Availability -----------------------------------------------------------
// The Aug 2026 outage: a repeating block stored as a 21-day span covered every
// minute of every day, so /book offered nothing, on every date, indefinitely.
await check("booking page has open times in the next 14 days", async () => {
  const days = [2, 5, 9, 13];
  const counts = [];
  for (const off of days) {
    const start = `${isoDay(off)}T07:00:00.000Z`;
    const end = `${isoDay(off + 1)}T07:00:00.000Z`;
    const r = await fetch(`${BASE}/api/availability?start=${start}&end=${end}&duration=30`);
    const j = await r.json();
    counts.push(`${isoDay(off)}:${j.slots?.length ?? "err"}`);
  }
  const empty = counts.filter((c) => c.endsWith(":0"));
  return {
    ok: empty.length === 0,
    detail:
      counts.join("  ") +
      (empty.length ? `  <- ${empty.length} day(s) with ZERO slots; a block may span too far` : ""),
  };
});

await check("availability rejects a nonsense duration", async () => {
  const r = await fetch(
    `${BASE}/api/availability?start=${isoDay(2)}T07:00:00.000Z&end=${isoDay(3)}T07:00:00.000Z&duration=0`
  );
  return { ok: r.status === 400, detail: `status=${r.status} (want 400)` };
});

// --- Health -----------------------------------------------------------------
await check("database, api, agent and messaging are healthy", async () => {
  const r = await fetch(`${BASE}/api/health`);
  const j = await r.json().catch(() => ({}));
  const c = j.checks || {};
  const bad = Object.entries(c).filter(([, v]) => v !== "ok").map(([k]) => k);
  return {
    ok: r.status === 200 && bad.length === 0,
    detail:
      `HTTP ${r.status}  database=${c.database} api=${c.api} agent=${c.agent} messaging=${c.messaging}` +
      (bad.length ? `  <- ${bad.join(", ")} failing` : "") +
      // Which messaging check failed — the endpoint reports names only, never
      // a credential.
      (j.messagingProblems?.length ? `  [${j.messagingProblems.join(", ")}]` : ""),
  };
});

// The agent route must be alive and reject a malformed body cleanly. A 500 here
// means the handler itself is broken; polling it costs nothing because it never
// reaches the model.
await check("agent endpoint is alive", async () => {
  const r = await fetch(`${BASE}/api/agent/public`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return { ok: r.status < 500, detail: `status=${r.status} (any non-5xx means the route is up)` };
});

// --- Auth gate --------------------------------------------------------------
// A static-asset exemption in the proxy matcher once let `/api/todos/<id>.js`
// reach the route handler with no session at all.
await check("private API requires a session", async () => {
  const r = await get("/api/todos/abc123");
  return { ok: r.status === 401, detail: `status=${r.status} (want 401)` };
});

await check("a static-asset suffix does NOT bypass the auth gate", async () => {
  const bad = [];
  for (const suffix of [".js", ".css", ".png", ".txt"]) {
    const r = await get(`/api/todos/abc123${suffix}`);
    if (r.status !== 401) bad.push(`${suffix}=${r.status}`);
  }
  return { ok: bad.length === 0, detail: bad.length ? `leaked: ${bad.join(", ")}` : "all 401" };
});

// The root must send anonymous visitors to the PUBLIC page, never to sign-in.
// `/` is the URL every crawler and reputation scanner fetches first, and while
// it answered "307 -> /login" the public face of this domain was a password
// prompt — which is what FortiGuard rated as Phishing, twice.
await check("anonymous visitors to / land on the public page, not sign-in", async () => {
  const r = await get("/");
  const loc = r.headers.get("location") || "";
  if (r.status !== 307) return { ok: false, detail: `status=${r.status} (want 307)` };
  if (loc.includes("/login")) {
    return { ok: false, detail: `-> ${loc} — the front door is a login page again` };
  }
  return { ok: loc.includes("/book"), detail: `status=${r.status} -> ${loc}` };
});

// The dashboard itself still has to be gated; the redirect target changing must
// not turn into "anonymous users can see it".
await check("dashboard content is not served to anonymous visitors", async () => {
  const r = await get("/");
  const body = r.status === 200 ? await r.text() : "";
  return {
    ok: r.status === 307 && !body,
    detail: r.status === 307 ? "gated (307)" : `status=${r.status} — dashboard may be exposed`,
  };
});

// --- Public pages -----------------------------------------------------------
// Visitor-facing routes must stay reachable WITHOUT a session. Adding a page
// and forgetting PUBLIC_PREFIXES has bitten this app before.
await check("public pages load without a session", async () => {
  const bad = [];
  for (const p of ["/book", "/login", "/privacy", "/terms", "/assistant", "/sitemap.xml"]) {
    const r = await get(p);
    if (r.status !== 200) bad.push(`${p}=${r.status}`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join(", ") : "all 200" };
});

// --- Sign-in ----------------------------------------------------------------
// The button must be in the HTML as sent: /login is a server component now,
// precisely so a visitor (or a reputation crawler) sees a real page without
// running JS. This check used to search only the JS chunks — which passed while
// the served body was empty, and then failed the moment the page started
// rendering properly. Look at the HTML first, and keep the chunk search as a
// fallback so a future client-side render is reported, not silently accepted.
await check("login page ships the Google button", async () => {
  const html = await (await fetch(`${BASE}/login`)).text();
  if (html.includes("Sign in with Google") && html.includes("/api/auth/google/start")) {
    return { ok: true, detail: "in the server-rendered HTML" };
  }
  const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[\w.-]+\.js/g) || [])];
  for (const c of chunks) {
    if ((await (await fetch(BASE + c)).text()).includes("Sign in with Google")) {
      return { ok: false, detail: `only in a JS chunk (${c}) — a crawler sees no sign-in path` };
    }
  }
  return { ok: false, detail: `not in the HTML nor any of ${chunks.length} chunks` };
});

await check("Google sign-in points back at THIS host", async () => {
  const r = await get("/api/auth/google/start");
  if (r.status === 503) return { ok: false, detail: "503 - owner allowlist is empty" };
  const loc = r.headers.get("location") || "";
  const redirectUri = decodeURIComponent((loc.match(/redirect_uri=([^&]+)/) || [])[1] || "");
  const wantHost = new URL(BASE).host;
  const gotHost = redirectUri ? new URL(redirectUri).host : "";
  // A cookie set on a different host than the one the user is on is invisible
  // to that host, so sign-in silently bounces back to the form.
  return {
    ok: gotHost === wantHost,
    detail: `redirect_uri host=${gotHost || "(none)"} want=${wantHost}`,
  };
});

await check("Google sign-in asks for identity scopes only", async () => {
  const r = await get("/api/auth/google/start");
  const loc = r.headers.get("location") || "";
  // In a query string "+" means space, and decodeURIComponent does not do that.
  const scope = decodeURIComponent(((loc.match(/scope=([^&]+)/) || [])[1] || "").replace(/\+/g, " "));
  return {
    ok: scope.trim() === "openid email",
    detail: `scope="${scope}" (must not request calendar access)`,
  };
});

await check("Google accepts our redirect URI", async () => {
  const r = await get("/api/auth/google/start");
  const loc = r.headers.get("location");
  if (!loc) return { ok: false, detail: "no redirect issued" };
  const body = await (await fetch(loc)).text();
  const mismatch = /redirect_uri_mismatch/i.test(body);
  return {
    ok: !mismatch,
    detail: mismatch ? "redirect_uri_mismatch - register the URI in Google Cloud Console" : "accepted",
  };
});

// --- Identity ---------------------------------------------------------------
// The bare unbranded password box is what got the domain classified as
// phishing; the booking page identity is the remedy and must not regress.
await check("booking page states who it belongs to", async () => {
  const html = await (await fetch(`${BASE}/book`)).text();
  const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[\w.-]+\.js/g) || [])];
  for (const c of chunks) {
    if ((await (await fetch(BASE + c)).text()).includes("Built by")) {
      return { ok: true, detail: `credit present (${c})` };
    }
  }
  return { ok: false, detail: "no 'Built by' credit found" };
});

// The checks above pass on content inside a JS BUNDLE. A reputation crawler
// does not run JS, and for weeks every public page served a body whose only
// text was its own <title> — so the identity we kept citing in dispute
// submissions was invisible to the people reviewing them, and the rating stood.
// These assert on the HTML as SENT.
const textOf = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

await check("/book says what it is in server-rendered HTML", async () => {
  const html = await (await fetch(`${BASE}/book`)).text();
  // <noscript> is the no-JS fallback a crawler reads; strip tags but keep it.
  const text = textOf(html);
  const missing = [];
  // What the site IS, in the words the page now uses. This is the sentence a
  // reputation reviewer reads, so the check follows the copy rather than the
  // copy quietly drifting away from the check.
  if (!/consulting practice/i.test(text)) missing.push("what the site is");
  if (!/hunterzhangconsulting\.com/i.test(text)) missing.push("the practice domain");
  if (!/\/privacy/.test(html)) missing.push("privacy link");
  if (!/\/terms/.test(html)) missing.push("terms link");
  return {
    ok: missing.length === 0,
    detail: missing.length ? `missing from HTML: ${missing.join(", ")}` : `${text.length} chars of real text`,
  };
});

await check("/login identifies the owner in server-rendered HTML", async () => {
  const html = await (await fetch(`${BASE}/login`)).text();
  const text = textOf(html);
  // An anonymous password box with no stated owner is the exact shape that got
  // this domain classified as phishing.
  const hasOwner = /owner sign-in/i.test(text);
  const hasWayOut = /\/book/.test(html);
  return {
    ok: hasOwner && hasWayOut,
    detail:
      hasOwner && hasWayOut
        ? "owner and public-page link present"
        : `missing: ${[!hasOwner && "owner identity", !hasWayOut && "link to /book"].filter(Boolean).join(", ")}`,
  };
});

await check("security.txt and robots.txt are served", async () => {
  const bad = [];
  for (const p of ["/.well-known/security.txt", "/robots.txt"]) {
    const r = await fetch(BASE + p);
    if (!r.ok) bad.push(`${p}=${r.status}`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join(", ") : "both served" };
});

// --- Owner alert channels ----------------------------------------------------
// Aug 2026: the WhatsApp sender silently lost its Meta registration (Twilio
// error 63112). Twilio's Senders API still said ONLINE, every send "queued"
// fine, and then failed in transit — so booking alerts, the morning brief and
// even the monitor's own failure alerts all died on the same channel and the
// owner heard nothing for days. Unit tests cannot see Meta's registration
// state; only the delivery record knows. This reads the most recent outbound
// WhatsApp message (crons send several a day, so it is a fresh canary) and
// fails if it did not deliver. Read-only: Twilio credentials come from the
// environment or .env; without them the check reports itself skipped rather
// than pretending coverage.
await check("owner WhatsApp alerts are deliverable", async () => {
  let sid = process.env.TWILIO_ACCOUNT_SID;
  let token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    try {
      const { readFileSync } = await import("node:fs");
      const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
      sid ??= env.match(/^TWILIO_ACCOUNT_SID="?([^"\n]+)"?$/m)?.[1];
      token ??= env.match(/^TWILIO_AUTH_TOKEN="?([^"\n]+)"?$/m)?.[1];
    } catch {
      /* no .env — fall through to the skip below */
    }
  }
  if (!sid || !token) {
    return { ok: true, detail: "SKIPPED — no Twilio credentials here; check did not run" };
  }
  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?PageSize=50`,
    { headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` } }
  );
  if (!r.ok) return { ok: false, detail: `Twilio API ${r.status}` };
  const { messages = [] } = await r.json();
  const outbound = messages.filter(
    (m) => m.direction?.startsWith("outbound") && m.to?.startsWith("whatsapp:")
  );
  // Judge TEMPLATE sends (booking alerts, reminders) — the channel this check
  // guards. Freeform sends (the monitor's pings) legitimately die with 63016
  // whenever no 24h session is open, have their own email backstop, and were
  // re-tripping this check every 4h with nothing actually broken.
  const isTemplate = (m) =>
    /here's a scheduling update|upcoming appointment/i.test(m.body || "");
  const latest = outbound.find(isTemplate) ?? outbound[0];
  if (!latest) return { ok: true, detail: "no recent outbound WhatsApp to judge" };
  const bad = ["failed", "undelivered"].includes(latest.status);
  const windowNote =
    outbound[0] !== latest && outbound[0]?.error_code === 63016
      ? " (note: latest freeform ping hit the 24h window — expected, email backstop covers it)"
      : "";
  return {
    ok: !bad,
    detail: bad
      ? `latest template WhatsApp send ${latest.status} (error ${latest.error_code}) at ${latest.date_created} — sender or template registration broken`
      : `latest template WhatsApp send ${latest.status} at ${latest.date_created}${windowNote}`,
  };
});

// --- Summary ----------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `  \x1b[31m${failed.length} FAILED\x1b[0m` : "  \x1b[32mall good\x1b[0m") +
    "\n"
);
process.exit(failed.length ? 1 : 0);
