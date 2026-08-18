import { Provider } from "@prisma/client";
import type { OAuthProvider } from "./types";
import { googleProvider } from "./google";
import { microsoftProvider } from "./microsoft";

const PROVIDERS: Record<Provider, OAuthProvider> = {
  [Provider.google]: googleProvider,
  [Provider.microsoft]: microsoftProvider,
};

export function getOAuthProvider(provider: Provider): OAuthProvider {
  return PROVIDERS[provider];
}

export type { OAuthProvider, TokenSet } from "./types";
