import type { Provider } from "@prisma/client";

/// A normalized token set stored per account, regardless of provider or the
/// path (OAuth vs delegation) by which it was obtained. The aggregator never
/// needs to know which path produced these.
export interface TokenSet {
  accessToken: string;
  // Refresh token may be absent on a re-consent that didn't return one; callers
  // must preserve any previously-stored refresh token in that case.
  refreshToken?: string;
  // Absolute expiry instant of the access token.
  expiry: Date;
}

/// The identity resolved from a completed consent, used to match the token set
/// to exactly one configured Account row (we only manage the 7 known accounts).
export interface ResolvedIdentity {
  email: string;
}

/// Provider-specific OAuth operations. One implementation per Provider.
export interface OAuthProvider {
  provider: Provider;
  /// Build the consent URL to redirect the user to. `state` is an opaque
  /// CSRF token echoed back to the callback.
  buildAuthUrl(state: string): string;
  /// Exchange an authorization code for tokens + the authenticated identity.
  exchangeCode(code: string): Promise<{ tokens: TokenSet; identity: ResolvedIdentity }>;
  /// Refresh an access token using a stored refresh token.
  refresh(refreshToken: string): Promise<TokenSet>;
}
