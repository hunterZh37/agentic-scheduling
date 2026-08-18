import { Provider } from "@prisma/client";
import { optionalEnv, requireEnv } from "@/lib/env";
import { decodeJwtPayload } from "./jwt";
import type { OAuthProvider, TokenSet, ResolvedIdentity } from "./types";

function tenant() {
  return optionalEnv("MS_OAUTH_TENANT_ID") ?? "common";
}
function authEndpoint() {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`;
}
function tokenEndpoint() {
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;
}

// offline_access -> refresh token; Calendars.ReadWrite covers getSchedule
// (free/busy) and event creation for the destination account.
const SCOPES = [
  "openid",
  "email",
  "offline_access",
  "https://graph.microsoft.com/Calendars.ReadWrite",
];

function clientId() {
  return requireEnv("MS_OAUTH_CLIENT_ID");
}
function clientSecret() {
  return requireEnv("MS_OAUTH_CLIENT_SECRET");
}
function redirectUri() {
  return (
    optionalEnv("MS_OAUTH_REDIRECT_URI") ??
    "http://localhost:3000/api/oauth/microsoft/callback"
  );
}

function expiryFromSeconds(expiresIn: number): Date {
  return new Date(Date.now() + expiresIn * 1000);
}

function emailFromClaims(claims: Record<string, unknown>): string | undefined {
  // Microsoft may present the address as `email`, `preferred_username`, or `upn`.
  for (const k of ["email", "preferred_username", "upn"]) {
    const v = claims[k];
    if (typeof v === "string" && v.includes("@")) return v;
  }
  return undefined;
}

export const microsoftProvider: OAuthProvider = {
  provider: Provider.microsoft,

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES.join(" "),
      response_mode: "query",
      // No forced prompt: offline_access already yields a refresh token, and
      // re-forcing consent makes reconnects require a manual approval each time.
      // Microsoft still shows consent automatically on the first authorization.
      state,
    });
    return `${authEndpoint()}?${params.toString()}`;
  },

  async exchangeCode(
    code: string
  ): Promise<{ tokens: TokenSet; identity: ResolvedIdentity }> {
    const res = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUri(),
        grant_type: "authorization_code",
        scope: SCOPES.join(" "),
      }),
    });
    if (!res.ok) {
      throw new Error(`Microsoft token exchange failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      id_token?: string;
    };
    const email = data.id_token
      ? emailFromClaims(decodeJwtPayload(data.id_token))
      : undefined;
    if (!email) throw new Error("Microsoft id_token missing email/upn claim");
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
    const res = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: "refresh_token",
        scope: SCOPES.join(" "),
      }),
    });
    if (!res.ok) {
      throw new Error(`Microsoft token refresh failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiry: expiryFromSeconds(data.expires_in),
    };
  },
};
