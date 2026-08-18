import { Provider, type Account } from "@prisma/client";
import { getValidAccessToken } from "@/lib/oauth/store";

export type AttendeeStatus = "accepted" | "declined" | "tentative" | "needsAction";

export interface EventAttendee {
  email: string;
  name?: string;
  responseStatus?: AttendeeStatus;
  organizer?: boolean;
}

/// A calendar event with full detail. PRIVATE use only (titles/attendees) —
/// never returned from the public availability endpoint.
export interface CalendarEvent {
  id: string;
  accountEmail: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location?: string;
  description?: string;
  /// Best-effort video-conference join link (Meet / Zoom / Teams).
  videoLink?: string;
  organizer?: { email: string; name?: string };
  attendees: EventAttendee[];
  /// Reminder lead times in minutes before the event.
  reminders?: number[];
  /// Link to open the event in the provider's web UI.
  htmlLink?: string;
}

// Best-effort fallback: pull a Zoom/Meet/Teams link out of free-form event
// text when the provider's native conferencing field is empty (e.g. the
// organizer pasted a Zoom invite into the description instead of using
// Google's "Add conferencing" or a native Teams meeting). Excludes Google's
// "www.google.com/url?q=..." click-tracking wrapper so we prefer the clean
// direct link that's usually sitting right next to it as the anchor text.
const ZOOM_JOIN_RE = /https?:\/\/(?!www\.google\.com\/url)[^\s"'<>]*zoom\.us\/j\/[^\s"'<>]*/i;
const VIDEO_LINK_RE = /https?:\/\/(?!www\.google\.com\/url)[^\s"'<>]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com)[^\s"'<>]*/i;

// Un-escape the handful of HTML entities that show up in calendar HTML
// bodies, so extractVideoLink doesn't (a) treat a literal "&amp;" as part of
// a query string or (b) glue a link to trailing text separated only by
// "&nbsp;" instead of a real whitespace character.
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function extractVideoLink(text?: string): string | undefined {
  if (!text) return undefined;
  const decoded = decodeHtmlEntities(text);
  return decoded.match(ZOOM_JOIN_RE)?.[0] ?? decoded.match(VIDEO_LINK_RE)?.[0];
}

export async function listEvents(account: Account, start: Date, end: Date): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken(account);
  return account.provider === Provider.google
    ? listGoogleEvents(account.email, token, start, end)
    : listMicrosoftEvents(account.email, token, start, end);
}

function mapGoogleStatus(s?: string): AttendeeStatus | undefined {
  switch (s) {
    case "accepted":
      return "accepted";
    case "declined":
      return "declined";
    case "tentative":
      return "tentative";
    case "needsAction":
      return "needsAction";
    default:
      return undefined;
  }
}

async function listGoogleEvents(
  email: string,
  token: string,
  start: Date,
  end: Date
): Promise<CalendarEvent[]> {
  type GoogleEventsResponse = {
    nextPageToken?: string;
    items?: Array<{
      id: string;
      summary?: string;
      status?: string;
      location?: string;
      description?: string;
      hangoutLink?: string;
      htmlLink?: string;
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      organizer?: { email?: string; displayName?: string };
      attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string; organizer?: boolean }>;
      reminders?: { useDefault?: boolean; overrides?: Array<{ method?: string; minutes?: number }> };
    }>;
  };
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;
  const MAX_PAGES = 10; // safety cap against unbounded pagination
  do {
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true", // expand recurring events into instances
      orderBy: "startTime",
      maxResults: "250",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) throw new Error(`Google events.list failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as GoogleEventsResponse;
    for (const it of data.items ?? []) {
      if (it.status === "cancelled" || !it.start || !it.end) continue;
      const allDay = Boolean(it.start.date && !it.start.dateTime);
      const startStr = it.start.dateTime ?? `${it.start.date}T00:00:00Z`;
      const endStr = it.end.dateTime ?? `${it.end.date}T00:00:00Z`;
      const videoEntry = it.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video");
      events.push({
        id: it.id,
        accountEmail: email,
        title: it.summary ?? "(no title)",
        start: new Date(startStr),
        end: new Date(endStr),
        allDay,
        location: it.location,
        description: it.description,
        videoLink: it.hangoutLink ?? videoEntry?.uri ?? extractVideoLink(it.description),
        htmlLink: it.htmlLink,
        organizer: it.organizer?.email ? { email: it.organizer.email, name: it.organizer.displayName } : undefined,
        attendees: (it.attendees ?? []).flatMap((a) =>
          a.email
            ? [{ email: a.email, name: a.displayName, responseStatus: mapGoogleStatus(a.responseStatus), organizer: a.organizer }]
            : []
        ),
        reminders: it.reminders?.overrides?.map((o) => o.minutes ?? 0),
      });
    }
    pageToken = data.nextPageToken;
    pageCount++;
  } while (pageToken && pageCount < MAX_PAGES);
  return events;
}

function mapMsStatus(s?: string): AttendeeStatus | undefined {
  switch (s) {
    case "accepted":
    case "organizer":
      return "accepted";
    case "declined":
      return "declined";
    case "tentativelyAccepted":
      return "tentative";
    case "notResponded":
    case "none":
      return "needsAction";
    default:
      return undefined;
  }
}

async function listMicrosoftEvents(
  email: string,
  token: string,
  start: Date,
  end: Date
): Promise<CalendarEvent[]> {
  type MsCalendarViewResponse = {
    "@odata.nextLink"?: string;
    value?: Array<{
      id: string;
      subject?: string;
      isAllDay?: boolean;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
      location?: { displayName?: string };
      onlineMeeting?: { joinUrl?: string };
      bodyPreview?: string;
      // Full body content — bodyPreview is truncated to ~255 chars, which can
      // cut off a Zoom link pasted further down in the invite before we ever
      // see it, so prefer the full body when scanning for a video link.
      body?: { contentType?: string; content?: string };
      webLink?: string;
      isReminderOn?: boolean;
      reminderMinutesBeforeStart?: number;
      organizer?: { emailAddress?: { address?: string; name?: string } };
      attendees?: Array<{ emailAddress?: { address?: string; name?: string }; status?: { response?: string } }>;
    }>;
  };
  const parseUtc = (s: string) => new Date(s.endsWith("Z") ? s : `${s}Z`);
  const params = new URLSearchParams({
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    $orderby: "start/dateTime",
    $top: "250",
    $select:
      "id,subject,isAllDay,start,end,location,onlineMeeting,organizer,attendees,bodyPreview,body,webLink,reminderMinutesBeforeStart,isReminderOn",
  });
  let url: string | undefined = `https://graph.microsoft.com/v1.0/me/calendarView?${params}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    // Ask Graph to return times in UTC so we can parse them as such.
    Prefer: 'outlook.timezone="UTC"',
  };
  const events: CalendarEvent[] = [];
  let pageCount = 0;
  const MAX_PAGES = 10; // safety cap against unbounded pagination
  while (url && pageCount < MAX_PAGES) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Microsoft calendarView failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as MsCalendarViewResponse;
    for (const ev of data.value ?? []) {
      events.push({
        id: ev.id,
        accountEmail: email,
        title: ev.subject ?? "(no title)",
        start: parseUtc(ev.start.dateTime),
        end: parseUtc(ev.end.dateTime),
        allDay: Boolean(ev.isAllDay),
        location: ev.location?.displayName || undefined,
        description: ev.body?.content || ev.bodyPreview || undefined,
        videoLink: ev.onlineMeeting?.joinUrl || extractVideoLink(ev.body?.content) || undefined,
        htmlLink: ev.webLink || undefined,
        organizer: ev.organizer?.emailAddress?.address
          ? { email: ev.organizer.emailAddress.address, name: ev.organizer.emailAddress.name }
          : undefined,
        attendees: (ev.attendees ?? []).flatMap((a) =>
          a.emailAddress?.address
            ? [{ email: a.emailAddress.address, name: a.emailAddress.name, responseStatus: mapMsStatus(a.status?.response) }]
            : []
        ),
        reminders: ev.isReminderOn && ev.reminderMinutesBeforeStart != null ? [ev.reminderMinutesBeforeStart] : undefined,
      });
    }
    url = data["@odata.nextLink"];
    pageCount++;
  }
  return events;
}
