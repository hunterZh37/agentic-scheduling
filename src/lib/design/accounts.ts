// Account -> color identity. Color is the STABLE identity for an account across
// every view (calendar tiles, legend, calendars manager). Sourced from
// tokens.json; the CSS var resolves to the correct light/dark value per theme.
//
// Colors are assigned deterministically by hashing the account's email into a
// fixed palette — NOT from a hardcoded list of "known" emails. A self-hosted
// deployment can connect any accounts it wants (not just some example set),
// and each one still gets a stable, distinct color with zero configuration.

export interface AccountColor {
  /// Normalized (lowercased) email this color was derived from.
  id: string;
  email: string;
  light: string;
  dark: string;
  /// CSS custom property holding the theme-correct color, e.g. "--acct-1".
  cssVar: string;
}

interface PaletteEntry {
  light: string;
  dark: string;
  cssVar: string;
}

/// Fixed, ordered palette of visually distinct hues (defined in tokens.css).
/// Order doesn't matter for correctness — only that it's stable across builds
/// so a given email always hashes to the same slot.
const PALETTE: readonly PaletteEntry[] = [
  { light: "#0071E3", dark: "#0A84FF", cssVar: "--acct-1" },
  { light: "#5E5CE6", dark: "#5E5CE6", cssVar: "--acct-2" },
  { light: "#FF2D92", dark: "#FF375F", cssVar: "--acct-3" },
  { light: "#FF9500", dark: "#FF9F0A", cssVar: "--acct-4" },
  { light: "#AF52DE", dark: "#BF5AF2", cssVar: "--acct-5" },
  { light: "#30B0C7", dark: "#40C8E0", cssVar: "--acct-6" },
];

/// Simple, stable string hash (Java's String.hashCode algorithm) — good enough
/// for spreading emails across a small fixed palette; not cryptographic.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0; // unsigned
}

/// Deterministic color for any account email — always returns a value, never
/// undefined, so every connected account (however many, whatever addresses)
/// renders with a stable, distinct color.
export function colorForEmail(email: string): AccountColor {
  const id = email.trim().toLowerCase();
  const p = PALETTE[hashString(id) % PALETTE.length];
  return { id, email: id, light: p.light, dark: p.dark, cssVar: p.cssVar };
}

export function accountVar(email: string): string {
  return colorForEmail(email).cssVar;
}

/// Fallback CSS var for the (now rare — colorForEmail always resolves) case of
/// an empty/missing email, e.g. a synced event with no account attached.
export const FALLBACK_ACCOUNT_VAR = "--state-busy";
