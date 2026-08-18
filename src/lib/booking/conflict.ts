import { Interval } from "@/lib/availability/interval";
import { AvailabilitySettings } from "@/lib/availability/index";
import { MAX_DURATION_MINUTES } from "@/lib/validation";

export type BookingRejection =
  | "in_past"
  | "too_soon" // violates minNoticeHours
  | "beyond_horizon" // violates bookingHorizonDays
  | "too_long" // exceeds MAX_DURATION_MINUTES
  | "conflict"; // overlaps a busy interval

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/// Validate a requested slot at write time (defense in depth — the slot was
/// offered from availability, but state may have changed since). Returns null
/// if bookable, otherwise the reason.
export function checkSlotBookable(
  slot: Interval,
  busy: Interval[],
  now: Date,
  settings: AvailabilitySettings
): BookingRejection | null {
  if (slot.start.getTime() <= now.getTime()) return "in_past";
  // Cap the slot length HERE, on the shared write path, so every caller (the
  // public booking route, the public agent, MCP create_booking, reschedule) is
  // covered at once. Without this, one anonymous request for a weeks-long
  // "meeting" writes a real calendar event that blocks all future availability
  // — the attacker-triggered version of the reserved-block outage in
  // docs/REGRESSIONS.md. The availability READ path has capped duration since
  // that class of bug was first found (see MAX_DURATION_MINUTES); the write
  // path must be at least as strict.
  if (slot.end.getTime() - slot.start.getTime() > MAX_DURATION_MINUTES * 60 * 1000) {
    return "too_long";
  }
  const floor = now.getTime() + settings.minNoticeHours * HOUR_MS;
  if (slot.start.getTime() < floor) return "too_soon";
  const ceil = now.getTime() + settings.bookingHorizonDays * DAY_MS;
  if (slot.end.getTime() > ceil) return "beyond_horizon";
  if (busy.some((b) => overlaps(slot, b))) return "conflict";
  return null;
}
