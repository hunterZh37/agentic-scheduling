import { optionalEnv, PUBLIC_BASE_URL } from "@/lib/env";

// The booking page answers on more than one host: the primary domain and any
// alias in PUBLIC_ALIAS_HOSTS (comma-separated). A visitor who booked on an
// alias did so because the primary host is unreachable for them (a corporate
// web filter still rates the young domain "Phishing"), so every link we send
// them back must stay on the host they used. The request's Host header picks
// it, but only from this allowlist: a forged header can never put a stranger's
// domain in an email we sign.
function aliasHosts(): Set<string> {
  return new Set(
    (optionalEnv("PUBLIC_ALIAS_HOSTS") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/// The public origin links for this visitor should use: the request host when
/// it is the primary domain or a configured alias, otherwise PUBLIC_BASE_URL.
export function publicOrigin(requestHost: string | null | undefined): string {
  const host = requestHost?.trim().toLowerCase();
  if (!host) return PUBLIC_BASE_URL;
  if (host === hostOf(PUBLIC_BASE_URL)) return PUBLIC_BASE_URL;
  if (aliasHosts().has(host)) return `https://${host}`;
  return PUBLIC_BASE_URL;
}
