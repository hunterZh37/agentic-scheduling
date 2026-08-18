import { NextRequest, NextResponse } from "next/server";
import { Provider } from "@prisma/client";
import { randomUUID } from "crypto";
import { APP_BASE_URL } from "@/lib/env";
import { getOAuthProvider } from "./index";
import { connectFromCallback, AccountNotFoundError } from "./store";
import { isOwnerEmail, allowedLoginEmails } from "@/lib/auth/ownerLogin";
import { coHostForEmail } from "@/lib/auth/coHostLogin";
import { exchangeGoogleLoginCode } from "./google";
import {
  COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  makeSessionToken,
  makeCoHostSessionToken,
  verifyCoHostSession,
} from "@/lib/auth/session";
import { optionalEnv } from "@/lib/env";

const STATE_COOKIE = "oauth_state";
// "Sign in with Google" reuses this same redirect URI (so no second callback
// has to be registered with the provider). The two flows are told apart by
// which state cookie is present, and a login callback must NEVER fall through
// into the account-connect path: they grant very different things.
const LOGIN_STATE_COOKIE = "oauth_login_state";

// Where to land after a callback. UI arrives in phase 6; for now bounce to the
// home page with a status the eventual accounts screen can surface.
function resultRedirect(params: Record<string, string>, path = "/"): NextResponse {
  const url = new URL(path, APP_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/// GET handler that kicks off consent for a provider.
export function makeStartHandler(provider: Provider) {
  return async function GET(): Promise<NextResponse> {
    try {
      const state = randomUUID();
      const authUrl = getOAuthProvider(provider).buildAuthUrl(state);
      const res = NextResponse.redirect(authUrl);
      res.cookies.set(STATE_COOKIE, state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 600, // 10 min to complete consent
      });
      return res;
    } catch (err) {
      // Almost always: provider client credentials not configured yet.
      return NextResponse.json(
        {
          error: "oauth_not_configured",
          provider,
          message: err instanceof Error ? err.message : "Unknown error",
        },
        { status: 503 }
      );
    }
  };
}

/// GET handler for the provider redirect back to us.
export function makeCallbackHandler(provider: Provider) {
  return async function GET(req: NextRequest): Promise<NextResponse> {
    const url = new URL(req.url);
    const providerError = url.searchParams.get("error");
    if (providerError) {
      return resultRedirect({ oauth: provider, status: "error", reason: providerError });
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const loginState = req.cookies.get(LOGIN_STATE_COOKIE)?.value;

    // --- Sign-in flow ---------------------------------------------------
    if (loginState) {
      const bad = (reason: string) => {
        const r = NextResponse.redirect(new URL(`/login?error=${reason}`, req.nextUrl.origin));
        r.cookies.delete(LOGIN_STATE_COOKIE);
        r.cookies.delete("oauth_login_redirect");
        return r;
      };
      if (!code || !state || state !== loginState) return bad("invalid_state");
      const secret = optionalEnv("PRIVATE_AUTH_SECRET");
      if (!secret) return bad("auth_not_configured");
      const pinnedRedirect = req.cookies.get("oauth_login_redirect")?.value;
      if (!pinnedRedirect) return bad("invalid_state");
      try {
        const email = await exchangeGoogleLoginCode(code, pinnedRedirect);
        const nowSeconds = Math.floor(Date.now() / 1000);
        // The provider vouches for this address; we decide whether it's ours.
        if (await isOwnerEmail(email)) {
          // Owner: full dashboard session, land on the private home. Stay on the
          // origin the flow started on, so the cookie we just set is the one the
          // next request sends.
          const res = NextResponse.redirect(new URL("/", req.nextUrl.origin));
          res.cookies.set(
            COOKIE_NAME,
            await makeSessionToken(secret, nowSeconds),
            SESSION_COOKIE_OPTIONS
          );
          res.cookies.delete(LOGIN_STATE_COOKIE);
          res.cookies.delete("oauth_login_redirect");
          return res;
        }
        // Not the owner — maybe a co-host the owner invited. A co-host gets a
        // scoped session (owner-only routes still reject it) and lands on their
        // own co-host home, not the dashboard.
        const coHost = await coHostForEmail(email);
        if (coHost) {
          const res = NextResponse.redirect(new URL("/cohost", req.nextUrl.origin));
          res.cookies.set(
            COOKIE_NAME,
            await makeCoHostSessionToken(secret, nowSeconds, coHost.id),
            SESSION_COOKIE_OPTIONS
          );
          res.cookies.delete(LOGIN_STATE_COOKIE);
          res.cookies.delete("oauth_login_redirect");
          return res;
        }
        // Say WHICH address was refused. The browser is told only
        // "not_authorized" (revealing the allowlist to a stranger would hand
        // them a target), but the owner reading their own server logs has no
        // other way to tell "wrong account" from "allowlist misconfigured" —
        // the two look identical from the login screen.
        console.warn(
          `[oauth login] refused ${email}; allowed: ${(await allowedLoginEmails()).join(", ") || "(none)"}`
        );
        return bad("not_authorized");
      } catch (err) {
        console.error(`[oauth login] ${provider} sign-in failed:`, err);
        return bad("exchange_failed");
      }
    }

    // --- Calendar-connect flow ------------------------------------------
    const cookieState = req.cookies.get(STATE_COOKIE)?.value;

    // Whose calendar is this? The same connect endpoint serves the owner and
    // co-hosts; the session cookie riding along on this top-level callback tells
    // them apart. A valid co-host session scopes the new Account to that co-host
    // and returns them to their own page; anything else is the owner (null).
    const secret = optionalEnv("PRIVATE_AUTH_SECRET");
    const coHostId = secret
      ? await verifyCoHostSession(
          secret,
          req.cookies.get(COOKIE_NAME)?.value,
          Math.floor(Date.now() / 1000)
        )
      : null;
    const landing = coHostId ? "/cohost" : "/";

    if (!code || !state || !cookieState || state !== cookieState) {
      return resultRedirect({ oauth: provider, status: "error", reason: "invalid_state" }, landing);
    }

    try {
      const account = await connectFromCallback(provider, code, coHostId);
      const res = resultRedirect(
        { oauth: provider, status: "connected", email: account.email },
        landing
      );
      res.cookies.delete(STATE_COOKIE);
      return res;
    } catch (err) {
      console.error(`[oauth callback] ${provider} connect failed:`, err);
      const reason =
        err instanceof AccountNotFoundError ? "unknown_account" : "exchange_failed";
      const res = resultRedirect({ oauth: provider, status: "error", reason }, landing);
      res.cookies.delete(STATE_COOKIE);
      return res;
    }
  };
}
