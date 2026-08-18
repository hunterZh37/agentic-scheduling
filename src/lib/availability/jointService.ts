import { prisma } from "@/lib/db";
import { fanOutBusy } from "@/lib/calendar/aggregate";
import { actionableBusy } from "./actionableBusy";
import { computeAvailability, resolveBookableRange, type Interval } from "./index";
import type { AvailabilityResult } from "./service";

// Collective ("both of us are free") availability. A slot is jointly bookable
// only when EVERY team member is free in it — which is exactly the free time
// left over the UNION of all members' busy intervals. So rather than intersect
// each member's free ranges, we merge every member's busy time into one set and
// compute free slots once against it: same result, and it reuses the identical
// owner-side pipeline (computeAvailability).
//
// Members are the owner (coHostId=null) plus zero or more co-hosts. The owner
// contributes calendar busy + reserved blocks + timed actionables; a co-host
// contributes calendar busy + reserved blocks (co-hosts have no actionables).

const DEFAULT_SETTINGS = {
  bookingHorizonDays: 60,
  minNoticeHours: 0,
  bufferMinutes: 0,
  defaultEventDurationMinutes: 30,
};

export interface GetJointAvailabilityArgs {
  /// The co-hosts on the team, besides the owner. Empty is allowed (degrades to
  /// owner-only availability).
  coHostIds: string[];
  requestedStart: Date;
  requestedEnd: Date;
  /// Event duration; defaults to Settings.defaultEventDurationMinutes.
  durationMinutes?: number;
  now?: Date;
}

export async function getJointAvailability(
  args: GetJointAvailabilityArgs
): Promise<AvailabilityResult> {
  const now = args.now ?? new Date();
  const coHostIds = [...new Set(args.coHostIds)];

  const [settingsRow, blocks] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" } }),
    // Owner blocks (coHostId=null) AND every listed co-host's blocks. Anyone
    // else's blocks stay out — a slot is only blocked by a member of THIS team.
    prisma.personalBlock.findMany({
      where: { OR: [{ coHostId: null }, { coHostId: { in: coHostIds } }] },
    }),
  ]);
  const settings = settingsRow ?? DEFAULT_SETTINGS;

  const effectiveSettings = {
    bookingHorizonDays: settings.bookingHorizonDays,
    minNoticeHours: settings.minNoticeHours,
    bufferMinutes: settings.bufferMinutes,
    defaultEventDurationMinutes:
      args.durationMinutes ?? settings.defaultEventDurationMinutes,
  };

  const bookable = resolveBookableRange(
    now,
    args.requestedStart,
    args.requestedEnd,
    effectiveSettings
  );
  if (!bookable) return { slots: [], warnings: [] };

  // One fan-out per subject (owner=null, then each co-host). fanOutBusy filters
  // accounts by coHostId, so calling it per member keeps each member's calendars
  // correctly scoped. Owner actionables occupy the owner's time like an event.
  const subjects: Array<string | null> = [null, ...coHostIds];
  const [fanResults, todoBusy] = await Promise.all([
    Promise.all(subjects.map((id) => fanOutBusy(bookable.start, bookable.end, id))),
    actionableBusy(bookable.start, bookable.end),
  ]);

  const providerBusy: Interval[] = [];
  const warnings: AvailabilityResult["warnings"] = [];
  for (const r of fanResults) {
    providerBusy.push(...r.busy);
    warnings.push(...r.errors);
  }
  providerBusy.push(...todoBusy);

  const slots = computeAvailability({
    now,
    requestedStart: args.requestedStart,
    requestedEnd: args.requestedEnd,
    settings: effectiveSettings,
    providerBusy,
    blocks: blocks.map((b) => ({
      startTime: b.startTime,
      endTime: b.endTime,
      timezone: b.timezone,
      recurrenceRule: b.recurrenceRule,
    })),
  });

  return { slots, warnings };
}
