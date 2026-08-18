export type LeadPreset = "at" | "m10" | "h1" | "d1" | "custom";

const LEAD_MS: Record<Exclude<LeadPreset, "custom">, number> = {
  at: 0,
  m10: 10 * 60_000,
  h1: 60 * 60_000,
  d1: 24 * 60 * 60_000,
};

/// The fire instant (ISO) for a reminder: `customISO` for the "custom" preset,
/// otherwise `startISO − lead`. Returns null if it can't be computed.
export function leadTimeFireAt(startISO: string | null, preset: LeadPreset, customISO?: string): string | null {
  if (preset === "custom") {
    if (!customISO) return null;
    const d = new Date(customISO);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (!startISO) return null;
  const start = new Date(startISO);
  if (isNaN(start.getTime())) return null;
  return new Date(start.getTime() - LEAD_MS[preset]).toISOString();
}
