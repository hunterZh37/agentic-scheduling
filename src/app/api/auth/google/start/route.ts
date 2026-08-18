import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { buildGoogleLoginUrl } from "@/lib/oauth/google";
import { allowedLoginEmails } from "@/lib/auth/ownerLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Begin "Sign in with Google". Separate from /api/oauth/google/start, which
/// CONNECTS a calendar: this one only proves who you are (identity scopes, no
/// calendar access, no refresh token) and then issues the session cookie.
export async function GET(req: NextRequest): Promise<NextResponse> {
  // Refuse to start a flow that could never succeed, so a misconfigured deploy
  // fails visibly here rather than after a confusing round trip to Google.
  if ((await allowedLoginEmails()).length === 0) {
    return NextResponse.json(
      {
        error: "login_allowlist_empty",
        message:
          "No owner address is configured. Set OWNER_LOGIN_EMAILS, or connect a destination calendar.",
      },
      { status: 503 }
    );
  }

  try {
    const state = randomUUID();
    // Pin the callback to the origin the owner is actually on, so the session
    // cookie is set on that same host. Using the env-configured URI would land
    // the callback on the vercel.app deployment domain and set the cookie
    // there, where bookwithhunter.com can't see it.
    const loginRedirectUri = new URL("/api/oauth/google/callback", req.nextUrl.origin).toString();
    const res = NextResponse.redirect(buildGoogleLoginUrl(state, loginRedirectUri));
    // Remember it: the token exchange must present a byte-identical value.
    res.cookies.set("oauth_login_redirect", loginRedirectUri, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    res.cookies.set("oauth_login_state", state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: "oauth_not_configured", message: err instanceof Error ? err.message : "Unknown error" },
      { status: 503 }
    );
  }
}
