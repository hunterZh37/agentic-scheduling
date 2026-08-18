import { Interval, mergeIntervals } from "@/lib/availability/interval";

/// Keep the host's bookable slots that fall entirely inside one of the
/// requester's free windows. `hostSlots` are already duration-sized and
/// min-notice/horizon-filtered (from getAvailability); `requesterFree` are the
/// requester's continuous free windows. Pure and order-preserving.
export function findMutualSlots(
  hostSlots: Interval[],
  requesterFree: Interval[]
): Interval[] {
  const windows = mergeIntervals(requesterFree);
  return hostSlots.filter((slot) =>
    windows.some(
      (w) =>
        w.start.getTime() <= slot.start.getTime() &&
        slot.end.getTime() <= w.end.getTime()
    )
  );
}

const MAX_FREE_SLOTS = 100;
const MAX_WINDOW_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export interface NegotiateInput {
  requesterName: string;
  requesterEmail: string;
  durationMinutes: number;
  windowStart: Date;
  windowEnd: Date;
  requesterFree: Interval[];
  timezone: string;
}

export type ParseResult =
  | { ok: true; value: NegotiateInput }
  | { ok: false; error: string };

function parseISO(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/// Validate the negotiate request body into typed input, or a stable error
/// code. Pure: no I/O. Error codes are the strings returned to the client.
export function parseNegotiateBody(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid_json" };
  const b = raw as Record<string, unknown>;

  const requesterName =
    typeof b.requesterName === "string" ? b.requesterName.trim() : "";
  if (!requesterName) return { ok: false, error: "invalid_name" };

  const requesterEmail =
    typeof b.requesterEmail === "string" ? b.requesterEmail.trim() : "";
  if (!isEmail(requesterEmail)) return { ok: false, error: "invalid_email" };

  const durationMinutes = Number(b.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1440) {
    return { ok: false, error: "invalid_duration" };
  }

  const timezone =
    typeof b.timezone === "string" && b.timezone.trim() ? b.timezone.trim() : "";
  if (!timezone) return { ok: false, error: "invalid_timezone" };

  const window = (b.window ?? {}) as Record<string, unknown>;
  const windowStart = parseISO(window.startISO);
  const windowEnd = parseISO(window.endISO);
  if (!windowStart || !windowEnd || windowEnd.getTime() <= windowStart.getTime()) {
    return { ok: false, error: "invalid_window" };
  }
  if (windowEnd.getTime() - windowStart.getTime() > MAX_WINDOW_MS) {
    return { ok: false, error: "range_too_large" };
  }

  if (!Array.isArray(b.requesterFreeSlots)) {
    return { ok: false, error: "invalid_free_slots" };
  }
  if (b.requesterFreeSlots.length > MAX_FREE_SLOTS) {
    return { ok: false, error: "range_too_large" };
  }
  const requesterFree: Interval[] = [];
  for (const s of b.requesterFreeSlots) {
    const rec = (s ?? {}) as Record<string, unknown>;
    const start = parseISO(rec.startISO);
    const end = parseISO(rec.endISO);
    if (!start || !end || end.getTime() <= start.getTime()) {
      return { ok: false, error: "invalid_free_slots" };
    }
    requesterFree.push({ start, end });
  }

  return {
    ok: true,
    value: {
      requesterName,
      requesterEmail,
      durationMinutes,
      windowStart,
      windowEnd,
      requesterFree,
      timezone,
    },
  };
}
