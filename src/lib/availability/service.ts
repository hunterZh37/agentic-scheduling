import { prisma } from "@/lib/db";
import { fanOutBusy } from "@/lib/calendar/aggregate";
import { actionableBusy } from "./actionableBusy";
import { computeAvailability, resolveBookableRange, type Interval } from "./index";

export interface GetAvailabilityArgs {
  requestedStart: Date;
  requestedEnd: Date;
  /// Override the event duration (e.g. future event types). Defaults to
  /// Settings.defaultEventDurationMinutes.
  durationMinutes?: number;
  now?: Date;
}

export interface AvailabilityResult {
  slots: Interval[];
  /// Accounts that failed to report free/busy. Non-empty means conflicts may be
  /// under-counted — callers should warn.
  warnings: Array<{ email: string; message: string }>;
}

const DEFAULT_SETTINGS = {
  bookingHorizonDays: 60,
  minNoticeHours: 0,
  bufferMinutes: 0,
  defaultEventDurationMinutes: 30,
};

/// Full availability pipeline: load config + blocks, fan out live free/busy,
/// and compute bookable slots (UTC). Shared by the public page and both agents.
export async function getAvailability(
  args: GetAvailabilityArgs
): Promise<AvailabilityResult> {
  const now = args.now ?? new Date();

  const [settingsRow, blocks] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" } }),
    // Owner blocks only (coHostId=null). A co-host's reserved blocks must not
    // subtract from the owner's public booking page — same scoping rule as
    // fanOutBusy. See docs/REGRESSIONS.md.
    prisma.personalBlock.findMany({ where: { coHostId: null } }),
  ]);
  const settings = settingsRow ?? DEFAULT_SETTINGS;

  const effectiveSettings = {
    bookingHorizonDays: settings.bookingHorizonDays,
    minNoticeHours: settings.minNoticeHours,
    bufferMinutes: settings.bufferMinutes,
    defaultEventDurationMinutes:
      args.durationMinutes ?? settings.defaultEventDurationMinutes,
  };

  // Fan out free/busy over the CLAMPED window, not the raw request. Providers
  // reject over-wide ranges (Google caps free/busy queries), and a failed
  // account contributes NO busy intervals — so passing a raw multi-month range
  // made every account fail and the response advertised real meetings as free
  // (verified in prod: a 1-year query offered 15 slots on a day that the 7-day
  // query correctly showed as busy). computeAvailability clamps to the same
  // window anyway, so nothing outside it could ever be booked.
  const bookable = resolveBookableRange(
    now,
    args.requestedStart,
    args.requestedEnd,
    effectiveSettings
  );
  // Wholly outside the bookable window (all past, or beyond the horizon):
  // no slots, and no provider calls to make.
  if (!bookable) return { slots: [], warnings: [] };

  const [{ busy, errors }, todoBusy] = await Promise.all([
    fanOutBusy(bookable.start, bookable.end),
    // Timed actionables occupy the owner's time exactly like an event does.
    actionableBusy(bookable.start, bookable.end),
  ]);

  const slots = computeAvailability({
    now,
    requestedStart: args.requestedStart,
    requestedEnd: args.requestedEnd,
    settings: {
      bookingHorizonDays: settings.bookingHorizonDays,
      minNoticeHours: settings.minNoticeHours,
      bufferMinutes: settings.bufferMinutes,
      defaultEventDurationMinutes:
        args.durationMinutes ?? settings.defaultEventDurationMinutes,
    },
    providerBusy: [...busy, ...todoBusy],
    blocks: blocks.map((b) => ({
      startTime: b.startTime,
      endTime: b.endTime,
      timezone: b.timezone,
      recurrenceRule: b.recurrenceRule,
    })),
  });

  return { slots, warnings: errors };
}
