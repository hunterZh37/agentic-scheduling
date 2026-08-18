import { NextRequest, NextResponse } from "next/server";
import { optionalEnv } from "@/lib/env";
import { COOKIE_NAME, SESSION_COOKIE_OPTIONS, makeSessionToken } from "@/lib/auth/session";
import { verifyLoginPassword } from "@/lib/auth/password";
import { checkLoginAllowed, recordLoginFailure, clearLoginFailures } from "@/lib/agent/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { password } → sets the signed session cookie on success.
// The login password is, in priority order: a custom password set in-app
// (DB-stored, hashed), else the APP_PASSWORD env var, else PRIVATE_AUTH_SECRET.
// Cookie signing always uses PRIVATE_AUTH_SECRET, which must be present.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = optionalEnv("PRIVATE_AUTH_SECRET");
  if (!secret) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 500 });
  }

  // Throttle before doing any work: an unlimited guess rate was the one
  // concrete way in past a single shared password.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const gate = checkLoginAllowed(ip);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "too_many_attempts", message: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSec ?? 900) } }
    );
  }

  let body: { password?: unknown };
  try {
    body = (await req.json()) as { password?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body.password !== "string" || !(await verifyLoginPassword(body.password))) {
    recordLoginFailure(ip);
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }
  clearLoginFailures(ip);

  const token = await makeSessionToken(secret, Math.floor(Date.now() / 1000));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  return res;
}
