import { getAvailability } from "@/lib/availability/service";
import { Interval } from "@/lib/availability/interval";
import { findMutualSlots } from "./negotiate";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

export interface MutualSlotsInput {
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  requesterFree: Interval[];
  now?: Date;
}

export interface MutualSlotsResult {
  mutualSlots: Interval[];
  /// Sanitized — a non-empty list means some calendar couldn't be fully read
  /// (overlap may be over-counted). Never carries account emails or raw errors.
  warnings: { code: string }[];
}

/// Shared agent-to-agent core: fetch the owner's live bookable slots for the
/// window, intersect with the requester's free windows, and sanitize warnings.
/// Used by both the /api/agent/negotiate route and the find_mutual_times tool.
export async function computeMutualSlots(
  input: MutualSlotsInput
): Promise<MutualSlotsResult> {
  const { slots, warnings } = await getAvailability({
    requestedStart: input.windowStart,
    requestedEnd: input.windowEnd,
    durationMinutes: input.durationMinutes,
    now: input.now,
  });
  return {
    mutualSlots: findMutualSlots(slots, input.requesterFree),
    warnings: warnings.map(() => ({ code: "account_unavailable" })),
  };
}

export interface FindMutualTimesArgs {
  durationMinutes: number;
  windowStartISO: string;
  windowEndISO: string;
  requesterFreeSlots: Array<{ startISO: string; endISO: string }>;
  requesterTimezone: string;
}

/// Tool-facing wrapper: parse the model's ISO inputs, run the shared core, and
/// return a compact JSON payload (UTC ISO slots + the owner's timezone). Malformed
/// requester slots are dropped rather than throwing.
export async function runFindMutualTimes(args: FindMutualTimesArgs): Promise<string> {
  const requesterFree: Interval[] = (args.requesterFreeSlots ?? [])
    .map((s) => ({ start: new Date(s.startISO), end: new Date(s.endISO) }))
    .filter(
      (iv) =>
        !isNaN(iv.start.getTime()) &&
        !isNaN(iv.end.getTime()) &&
        iv.end.getTime() > iv.start.getTime()
    );

  const { mutualSlots, warnings } = await computeMutualSlots({
    windowStart: new Date(args.windowStartISO),
    windowEnd: new Date(args.windowEndISO),
    durationMinutes: args.durationMinutes,
    requesterFree,
  });

  return JSON.stringify({
    mutualSlots: mutualSlots.map((s) => ({
      startISO: s.start.toISOString(),
      endISO: s.end.toISOString(),
    })),
    hostTimezone: OWNER_TIMEZONE,
    partial: warnings.length > 0,
  });
}
