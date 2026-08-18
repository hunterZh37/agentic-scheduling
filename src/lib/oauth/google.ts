import { Provider } from "@prisma/client";
import { optionalEnv, requireEnv } from "@/lib/env";
import { decodeJwtPayload } from "./jwt";
import type { OAuthProvider, TokenSet, ResolvedIdentity } from "./types";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Full calendar scope so any connected account can serve free/busy AND, if it
// becomes the destination, receive booking writes — swapping the destination
// then needs no re-consent. openid+email let us resolve which Account this is.
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar",
];

function clientId() {
  return requireEnv("GOOGLE_OAUTH_CLIENT_ID");
}
function clientSecret() {
  return requireEnv("GOOGLE_OAUTH_CLIENT_SECRET");
}
function redirectUri() {
  return (
    optionalEnv("GOOGLE_OAUTH_REDIRECT_URI") ??
    "http://localhost:3000/api/oauth/google/callback"
  );
}

function expiryFromSeconds(expiresIn: number): Date {
  return new Date(Date.now() + expiresIn * 1000);
}

/// Auth URL for SIGNING IN (not connecting a calendar). Deliberately different
/// from buildAuthUrl: identity scopes only — no calendar access, and no
/// offline/refresh token, because logging in needs neither. Reuses the same
/// client and redirect URI so no extra callback has to be registered with
/// Google; the two flows are told apart by their own state cookies.
export function buildGoogleLoginUrl(state: string, loginRedirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: loginRedirectUri,
    response_type: "code",
    scope: "openid email",
    // Let the owner pick which Google account, rather than silently reusing
    // whichever one the browser happens to be signed into.
    prompt: "select_account",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/// Exchange a sign-in code. Separate from the provider's exchangeCode because
/// the redirect_uri sent here must byte-match the one used to start the flow,
/// and login pins that to the ORIGIN THE OWNER IS ON. The env-configured URI
/// points at the vercel.app deployment domain; a session cookie set there
/// would not exist on bookwithhunter.com, so login would silently bounce back
/// to the form. Returns the Google-verified email only — no tokens are kept,
/// because signing in needs no ongoing access.
export async function exchangeGoogleLoginCode(
  code: string,
  loginRedirectUri: string
): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId(),
      client_secret: clientSecret(),
      redirect_uri: loginRedirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google login exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { id_token?: string };
  if (!data.id_token) throw new Error("Google login response missing id_token");
  const claims = decodeJwtPayload(data.id_token);
  const email = typeof claims.email === "string" ? claims.email : undefined;
  // Google sets email_verified; an unverified address must not authenticate.
  const verified = claims.email_verified === true || claims.email_verified === "true";
  if (!email || !verified) throw new Error("Google id_token missing a verified email");
  return email;
}

export const googleProvider: OAuthProvider = {
  provider: Provider.google,

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES.join(" "),
      // offline + consent guarantees a refresh_token every time.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  },

  async exchangeCode(
    code: string
  ): Promise<{ tokens: TokenSet; identity: ResolvedIdentity }> {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      id_token: string;
    };
    const claims = decodeJwtPayload(data.id_token);
    const email = typeof claims.email === "string" ? claims.email : undefined;
    if (!email) throw new Error("Google id_token missing email claim");
    return {
      tokens: {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiry: expiryFromSeconds(data.expires_in),
      },
      identity: { email },
    };
  },

  async refresh(refreshToken: string): Promise<TokenSet> {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
    return {
      accessToken: data.access_token,
      // Google usually omits refresh_token on refresh; caller keeps the old one.
      refreshToken: data.refresh_token,
      expiry: expiryFromSeconds(data.expires_in),
    };
  },
};
