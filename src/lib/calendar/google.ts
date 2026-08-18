import { Interval } from "@/lib/availability/interval";

const FREEBUSY_ENDPOINT = "https://www.googleapis.com/calendar/v3/freeBusy";

interface FreeBusyResponse {
  calendars: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }>;
}

/// Query Google free/busy for one or more calendars on a single account.
/// freebusy.query accepts multiple calendars per call.
export async function googleFreeBusy(
  accessToken: string,
  calendarIds: string[],
  timeMin: Date,
  timeMax: Date
): Promise<Interval[]> {
  const res = await fetch(FREEBUSY_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      items: calendarIds.map((id) => ({ id })),
    }),
  });
  if (!res.ok) {
    throw new Error(`Google freeBusy failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as FreeBusyResponse;
  const intervals: Interval[] = [];
  for (const cal of Object.values(data.calendars ?? {})) {
    if (cal.errors && cal.errors.length > 0) {
      throw new Error("Google freeBusy calendar error: " + JSON.stringify(cal.errors));
    }
    for (const b of cal.busy ?? []) {
      intervals.push({ start: new Date(b.start), end: new Date(b.end) });
    }
  }
  return intervals;
}
