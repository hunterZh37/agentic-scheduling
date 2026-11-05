import { NextRequest, NextResponse } from "next/server";
import { Prisma, Provider } from "@prisma/client";
import { randomUUID } from "crypto";
import { OAUTH_BASE_URL } from "@/lib/env";
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
  verifySessionToken,
} from "@/lib/auth/session";
import { optionalEnv } from "@/lib/env";
import { OAUTH_FLOW_MAX_AGE } from "./flowCookie";

const STATE_COOKIE = "oauth_state";
// "Sign in with Google" reuses this same redirect URI (so no second callback
// has to be registered with the provider). The two flows are told apart by
// which state cookie is present, and a login callback must NEVER fall through
// into the account-connect path: they grant very different things.
const LOGIN_STATE_COOKIE = "oauth_login_state";

// Where to land after a connect callback: the dashboard (owner) or /cohost,
// with a status both pages read and show (see connectResult.ts). Always on the
// sign-in host. This used to be APP_BASE_URL, the Twilio-webhook host, where
// the owner has no session: the result landed on a public page and was lost.
function resultRedirect(params: Record<string, string>, path = "/"): NextResponse {
  const url = new URL(path, OAUTH_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/// Whose calendar a connect is for, or null when the caller may not connect
/// one at all. `/api/oauth/` is public in the proxy (the provider's redirect
/// arrives with no way to add a header), so this is the only gate on it.
///
/// It did not exist until 2026-11-04. The callback treated "no co-host
/// session" as "the owner", so anyone who opened the start URL and consented
/// with their own Google account had that calendar stored as the OWNER's: its
/// busy time then counted against the public booking page.
///
/// With no PRIVATE_AUTH_SECRET (local dev) the whole app is open and the
/// caller is the owner, exactly as the proxy treats every other route.
async function connectSubject(req: NextRequest): Promise<{ coHostId: string | null } | null> {
  const secret = optionalEnv("PRIVATE_AUTH_SECRET");
  if (!secret) return { coHostId: null };
  const token = req.cookies.get(COOKIE_NAME)?.value;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (await verifySessionToken(secret, token, nowSeconds)) return { coHostId: null };
  const coHostId = await verifyCoHostSession(secret, token, nowSeconds);
  return coHostId ? { coHostId } : null;
}

/// GET handler that kicks off consent for a provider.
export function makeStartHandler(provider: Provider) {
  return async function GET(req: NextRequest): Promise<NextResponse> {
    // The state cookie set below and the session cookie the callback reads are
    // both host-only, and the callback is on the sign-in host (redirect.ts). A
    // flow started anywhere else could never complete, so start it there.
    if (req.nextUrl.host !== new URL(OAUTH_BASE_URL).host) {
      return NextResponse.redirect(new URL(`/api/oauth/${provider}/start`, OAUTH_BASE_URL));
    }
    // Only the owner or a co-host connects a calendar. Anyone else is sent to
    // sign in rather than on to the provider.
    if (!(await connectSubject(req))) {
      return NextResponse.redirect(new URL("/login", OAUTH_BASE_URL));
    }
    try {
      const state = randomUUID();
      const authUrl = getOAuthProvider(provider).buildAuthUrl(state);
      const res = NextResponse.redirect(authUrl);
      // The callback is shared with sign-in and decides which flow it is in by
      // whether the sign-in state cookie is present. One left over from an
      // abandoned Google sign-in (kept for OAUTH_FLOW_MAX_AGE) would send this connect
      // down the sign-in branch, where its state cannot match. Whoever is here
      // is already signed in, so those cookies have no further use.
      res.cookies.delete(LOGIN_STATE_COOKIE);
      res.cookies.delete("oauth_login_redirect");
      res.cookies.set(STATE_COOKIE, state, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: OAUTH_FLOW_MAX_AGE,
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
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const loginState = req.cookies.get(LOGIN_STATE_COOKIE)?.value;

    // A refused or cancelled SIGN-IN: nobody is signed in, so there is no
    // dashboard to report to. Unchanged behaviour for that flow.
    if (providerError && loginState) {
      return resultRedirect({ oauth: provider, status: "error", reason: providerError });
    }

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
    // them apart. An owner session stores the Account as the owner's (null); a
    // co-host session scopes it to that co-host and returns them to their own
    // page. No session at all is nobody's calendar: refuse before the code is
    // exchanged (see connectSubject).
    const subject = await connectSubject(req);
    if (!subject) {
      // A provider redirect (it carries a state) with neither flow's cookie and
      // no session: the person took longer than OAUTH_FLOW_MAX_AGE, so every
      // cookie had expired. A provider refusal (?error=) is not that. Say so; a bare /login told them nothing. A stranger
      // hitting this URL sees the same line, which reveals nothing.
      const expired = state && !cookieState && !providerError;
      const res = NextResponse.redirect(new URL(expired ? "/login?error=expired" : "/login", OAUTH_BASE_URL));
      res.cookies.delete(STATE_COOKIE);
      return res;
    }
    const { coHostId } = subject;
    const landing = coHostId ? "/cohost" : "/";

    // The provider's own refusal (the user cancelled, or their administrator
    // blocks the app). Reported to whoever was connecting, on their own page.
    if (providerError) {
      const res = resultRedirect({ oauth: provider, status: "error", reason: providerError }, landing);
      res.cookies.delete(STATE_COOKIE);
      return res;
    }

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
      // Account.email is unique across the whole table, while a connect matches
      // within one subject. So an address the owner has cannot also be a
      // co-host's, and the other way round: the insert fails. Say that, rather
      // than the "try again" that will fail the same way every time.
      const alreadyConnected =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      const reason = alreadyConnected
        ? "already_connected"
        : err instanceof AccountNotFoundError
          ? "unknown_account"
          : "exchange_failed";
      const res = resultRedirect({ oauth: provider, status: "error", reason }, landing);
      res.cookies.delete(STATE_COOKIE);
      return res;
    }
  };
}
