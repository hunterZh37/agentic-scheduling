import { NextRequest, NextResponse } from "next/server";
import { optionalEnv } from "@/lib/env";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";
import { verifyLoginPassword, setLoginPassword, hasCustomPassword } from "@/lib/auth/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PASSWORD_LENGTH = 8;

// Defense in depth: the proxy already gates this path, but re-check the session
// here since changing the password is sensitive. In local dev (no secret) it's
// open, matching the rest of the app.
async function requireSession(req: NextRequest): Promise<boolean> {
  const secret = optionalEnv("PRIVATE_AUTH_SECRET");
  if (!secret) return true;
  const token = req.cookies.get(COOKIE_NAME)?.value;
  return verifySessionToken(secret, token, Math.floor(Date.now() / 1000));
}

// GET → { hasCustomPassword } so the UI can label the form.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!(await requireSession(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ hasCustomPassword: await hasCustomPassword() });
}

// POST { currentPassword, newPassword } → stores a new hashed login password.
export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(await requireSession(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { currentPassword?: unknown; newPassword?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json(
      { error: "weak_password", message: `Use at least ${MIN_PASSWORD_LENGTH} characters.` },
      { status: 400 }
    );
  }
  // Require the current password so a hijacked open session can't silently
  // lock the owner out by rotating the password.
  if (!(await verifyLoginPassword(currentPassword))) {
    return NextResponse.json({ error: "wrong_current_password" }, { status: 403 });
  }

  await setLoginPassword(newPassword);
  return NextResponse.json({ ok: true });
}
