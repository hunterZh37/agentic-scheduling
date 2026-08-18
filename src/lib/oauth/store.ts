import { AuthMethod, Provider, type Account } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getOAuthProvider } from "./index";
import type { TokenSet } from "./types";

// Refresh a token this many ms before its real expiry, to avoid racing a
// call against the boundary.
const EXPIRY_SKEW_MS = 60_000;

/// Persist a token set onto an Account. A refresh that returns no refresh_token
/// (common for Google) must NOT clobber the stored one.
export async function persistTokenSet(
  accountId: string,
  tokens: TokenSet
): Promise<void> {
  await prisma.account.update({
    where: { id: accountId },
    data: {
      accessToken: tokens.accessToken,
      expiry: tokens.expiry,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    },
  });
}

export class AccountNotFoundError extends Error {}
export class AccountNotConnectedError extends Error {}

/// Complete a consent callback: exchange the code, resolve the authenticated
/// identity, and store the tokens on the matching Account — creating the row on
/// first connect so a brand-new calendar added from the Calendars manager
/// persists. Only a provider mismatch on an existing row is rejected.
export async function connectFromCallback(
  provider: Provider,
  code: string,
  coHostId: string | null = null
): Promise<Account> {
  const impl = getOAuthProvider(provider);
  const { tokens, identity } = await impl.exchangeCode(code);

  // Match within the SAME subject (owner=null, or one co-host). The same person
  // may legitimately connect a calendar the owner already has; scoping the match
  // by coHostId keeps a co-host's connect from attaching to (and overwriting the
  // tokens on) the owner's row, and vice versa. Match case-insensitively:
  // providers may return the email in display case (e.g. Microsoft returns
  // "JaneDoe@outlook.com") while accounts are seeded lowercase.
  const existing = await prisma.account.findFirst({
    where: { email: { equals: identity.email, mode: "insensitive" }, coHostId },
  });

  // An email already configured for a DIFFERENT provider is a genuine mismatch
  // — refuse rather than silently repurpose the existing row's tokens.
  if (existing && existing.provider !== provider) {
    throw new AccountNotFoundError(
      `${identity.email} is already configured as a ${existing.provider} account.`
    );
  }

  // First time we've seen this identity: create the account so a calendar added
  // through the Calendars manager's "+" (which sends the user straight to
  // consent, without pre-seeding a row) actually persists and shows up. Stored
  // lowercase to match the rest of the app's seeding convention. coHostId scopes
  // the new row to whoever connected it (null = the owner).
  const account =
    existing ??
    (await prisma.account.create({
      data: {
        email: identity.email.toLowerCase(),
        provider,
        authMethod: AuthMethod.oauth,
        coHostId,
      },
    }));

  await persistTokenSet(account.id, tokens);
  return prisma.account.findUniqueOrThrow({ where: { id: account.id } });
}

/// The refresh helper. Call before EVERY provider API call to obtain a valid
/// access token, transparently refreshing (and persisting) when near expiry.
export async function getValidAccessToken(account: Account): Promise<string> {
  if (account.authMethod === AuthMethod.delegation) {
    // Seam for a future domain-wide-delegation token minter. Not used today
    // (all accounts are OAuth), but kept so the aggregator stays agnostic.
    throw new Error(
      `Delegation token minting is not implemented; account ${account.email} ` +
        `must use OAuth for now.`
    );
  }

  if (!account.refreshToken && !account.accessToken) {
    throw new AccountNotConnectedError(
      `Account ${account.email} is not connected. Authorize it first.`
    );
  }

  const stillValid =
    account.accessToken &&
    account.expiry &&
    account.expiry.getTime() - EXPIRY_SKEW_MS > Date.now();
  if (stillValid) return account.accessToken!;

  if (!account.refreshToken) {
    throw new AccountNotConnectedError(
      `Account ${account.email} has an expired access token and no refresh ` +
        `token. Re-authorize it.`
    );
  }

  const impl = getOAuthProvider(account.provider);
  const refreshed = await impl.refresh(account.refreshToken);
  await persistTokenSet(account.id, refreshed);
  return refreshed.accessToken;
}
