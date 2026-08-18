import { Interval } from "@/lib/availability/interval";

const GET_SCHEDULE_ENDPOINT =
  "https://graph.microsoft.com/v1.0/me/calendar/getSchedule";

interface ScheduleResponse {
  value?: Array<{
    scheduleItems?: Array<{
      status?: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
    }>;
    error?: { message?: string; responseCode?: string };
  }>;
}

// Graph returns naive datetimes tagged with a timeZone. We request UTC, so we
// parse the string as UTC.
function parseUtc(dateTime: string): Date {
  // Graph omits the trailing Z; append it so Date parses as UTC.
  const iso = dateTime.endsWith("Z") ? dateTime : `${dateTime}Z`;
  return new Date(iso);
}

/// Query Microsoft Graph getSchedule for busy intervals on an account.
/// Microsoft getSchedule rejects a request whose window (endTime - startTime)
/// is SHORTER than its availabilityViewInterval — so a 30-minute booking slot
/// with a fixed 60-minute interval errors, which failed booking revalidation
/// against the exact slot (day-wide availability queries were long enough to
/// slip past it). The coarse availabilityView is unused here — exact busy comes
/// from scheduleItems — so size the interval to fit the window, clamped to
/// Microsoft's supported 5..1440 minute range.
export function availabilityViewIntervalFor(start: Date, end: Date): number {
  const windowMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
  return Math.min(60, Math.max(5, windowMinutes));
}

export async function microsoftGetSchedule(
  accessToken: string,
  scheduleEmails: string[],
  start: Date,
  end: Date
): Promise<Interval[]> {
  const res = await fetch(GET_SCHEDULE_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schedules: scheduleEmails,
      startTime: { dateTime: start.toISOString(), timeZone: "UTC" },
      endTime: { dateTime: end.toISOString(), timeZone: "UTC" },
      availabilityViewInterval: availabilityViewIntervalFor(start, end),
    }),
  });
  if (!res.ok) {
    throw new Error(`Microsoft getSchedule failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as ScheduleResponse;
  const intervals: Interval[] = [];
  for (const entry of data.value ?? []) {
    if (entry.error) {
      throw new Error("Microsoft getSchedule error: " + entry.error.message);
    }
    for (const item of entry.scheduleItems ?? []) {
      // Anything not explicitly free counts as busy (busy/tentative/oof/etc.).
      if (item.status && item.status.toLowerCase() === "free") continue;
      intervals.push({ start: parseUtc(item.start.dateTime), end: parseUtc(item.end.dateTime) });
    }
  }
  return intervals;
}
