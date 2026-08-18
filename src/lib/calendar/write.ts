import { randomUUID } from "crypto";
import { Provider, type Account } from "@prisma/client";
import { DateTime } from "luxon";
import { optionalEnv } from "@/lib/env";
import { getValidAccessToken } from "@/lib/oauth/store";
import { rruleToGraphRecurrence } from "@/lib/calendar/recurrence";

/// True on a staging/e2e deploy: every real provider calendar write (create /
/// update / delete) is short-circuited so the full booking → DB → email flow
/// can be exercised end-to-end without ever touching a real Google/Microsoft
/// calendar (and without needing a connected account). Never set in production.
function calendarStubbed(): boolean {
  return optionalEnv("E2E_STUB_CALENDAR") === "true";
}

// Provider APIs — especially Microsoft Graph on consumer outlook.com mailboxes —
// intermittently return 429/5xx (notably 503) that succeed on a quick retry.
// Without this, a transient blip surfaces to the owner/agent as a failed event
// update/delete. Retry a few times with short backoff (honoring Retry-After when
// present, capped so we stay well within the request budget).
//
// ONLY for IDEMPOTENT requests (update = PATCH by event id, delete by id). Do
// NOT use for CREATE (POST): Graph can create the event and still return a 429/
// 5xx, so retrying the POST duplicates the event (the owner saw 3 copies of one
// event). Creates therefore use a plain fetch and fail loudly instead.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry(url: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const isLast = i === attempts - 1;
    try {
      const res = await fetch(url, init);
      if (!RETRYABLE_STATUS.has(res.status) || isLast) return res;
      const retryAfterS = Number(res.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfterS) && retryAfterS > 0 ? Math.min(retryAfterS * 1000, 2000) : 300 * (i + 1);
      await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      // Network-level failure (DNS/reset/timeout) — also transient; retry.
      lastErr = err;
      if (isLast) throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("fetchWithRetry: retries exhausted");
}

export interface EventDraft {
  title: string;
  start: Date;
  end: Date;
  description?: string;
  /// Rich HTML body for the event/invite. When set it's preferred over the
  /// plain `description` on create (both providers accept HTML); `description`
  /// stays the plain-text fallback.
  descriptionHtml?: string;
  location?: string;
  /// iCal RRULE body (no "RRULE:" prefix), e.g. "FREQ=WEEKLY;BYDAY=SU". Present
  /// for recurring events; omit for a one-off. Requires `timezone` so the series
  /// anchors to local wall-clock (DST-correct) rather than a drifting UTC time.
  recurrenceRule?: string;
  /// IANA timezone the event is authored in (e.g. "America/Los_Angeles"). Used
  /// for recurring events; a one-off is sent in UTC and ignores this.
  timezone?: string;
  /// All-day event: `start`/`end` are day boundaries (the day's local midnight
  /// and the next day's local midnight) and `timezone` names the zone whose
  /// calendar date is used. Google gets a {date} pair; Microsoft gets isAllDay.
  /// Used to mirror an untimed actionable onto a calendar.
  allDay?: boolean;
  /// Attendee is only present for bookings — a plain calendar event (create_event)
  /// omits both and no attendees are sent to the provider.
  attendeeName?: string;
  attendeeEmail?: string;
  /// Extra invitees beyond the primary attendee — the co-hosts on a JOINT
  /// booking. Adding them as attendees is how the event lands on their calendars
  /// too (a single write on the owner's destination, everyone on the invite),
  /// so there is no second write and no use of a co-host's tokens at book time.
  /// Ignored when there is no primary attendee (plain events send no attendees).
  additionalAttendeeEmails?: string[];
  /// Ask the provider to mint a real conference link for THIS event: Google
  /// Meet, or Teams on a Microsoft account. Without it an event has no way to
  /// join — the create call carried title, time, location and attendees and
  /// nothing else, so an invite went out with no link on it.
  ///
  /// A per-event room, unlike the single static NEXT_PUBLIC_OWNER_VIDEO_LINK
  /// that bookings reuse, so two meetings can't collide in one room.
  conference?: boolean;
}

/// The extra co-host invitees for a booking draft, cleaned up: de-duplicated,
/// and never repeating the primary attendee (who is added separately). Returns
/// [] when there are none, so the single-attendee path is byte-for-byte the
/// same as before.
function coHostAttendeeEmails(draft: EventDraft): string[] {
  const extra = draft.additionalAttendeeEmails ?? [];
  const primary = draft.attendeeEmail?.trim().toLowerCase();
  const seen = new Set<string>(primary ? [primary] : []);
  const out: string[] = [];
  for (const raw of extra) {
    const email = raw.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/// What a create returns. `videoLink` is present only when `conference` was
/// requested AND the provider actually minted one — asking is not the same as
/// getting, so callers must handle its absence rather than assume.
export interface CreatedEvent {
  id: string;
  videoLink?: string;
}

/// A recurring event must anchor to local wall-clock in its own timezone (so
/// "8am every Sunday" stays 8am across DST), not a fixed UTC instant. Returns
/// the provider dateTimeTimeZone pair for a given UTC instant + IANA zone.
function localDateTime(instant: Date, timezone: string): { dateTime: string; timeZone: string } {
  const local = DateTime.fromJSDate(instant, { zone: "utc" }).setZone(timezone);
  return { dateTime: local.toISO({ includeOffset: false, suppressMilliseconds: true })!, timeZone: timezone };
}

/// Write a booking event to a destination account's primary calendar and
/// return the provider-side event id. Times are sent in UTC.
export async function createDestinationEvent(
  account: Account,
  draft: EventDraft
): Promise<CreatedEvent> {
  if (calendarStubbed()) {
    return { id: `e2e-stub-${Date.now()}-${Math.floor(Math.random() * 1e6)}` };
  }
  const token = await getValidAccessToken(account);
  return account.provider === Provider.google
    ? createGoogleEvent(token, draft)
    : createMicrosoftEvent(token, draft);
}

/// Update an existing event on the account it lives on and return nothing on
/// success (throws with the provider's message on failure). `notify` controls
/// whether guests are emailed about the change — honored on Google via
/// sendUpdates; Microsoft Graph decides notification on its own for meetings,
/// so `notify: false` is best-effort there.
export async function updateDestinationEvent(
  account: Account,
  externalEventId: string,
  draft: Partial<EventDraft>,
  opts: { notify: boolean }
): Promise<void> {
  if (calendarStubbed()) return;
  const token = await getValidAccessToken(account);
  // Only send fields the caller actually provided — a PATCH omitting a key
  // leaves the provider's value untouched, so an unedited (possibly HTML)
  // description or location is never flattened.
  if (account.provider === Provider.google) {
    const res = await fetchWithRetry(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(externalEventId)}?sendUpdates=${opts.notify ? "all" : "none"}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(draft.title !== undefined ? { summary: draft.title } : {}),
          ...(draft.description !== undefined ? { description: draft.description } : {}),
          ...(draft.location !== undefined ? { location: draft.location } : {}),
          ...(draft.start ? { start: { dateTime: draft.start.toISOString(), timeZone: "UTC" } } : {}),
          ...(draft.end ? { end: { dateTime: draft.end.toISOString(), timeZone: "UTC" } } : {}),
        }),
      }
    );
    if (!res.ok) throw new Error(`Google event update failed: ${res.status} ${await res.text()}`);
    return;
  }
  const res = await fetchWithRetry(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalEventId)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(draft.title !== undefined ? { subject: draft.title } : {}),
      ...(draft.description !== undefined ? { body: { contentType: "text", content: draft.description ?? "" } } : {}),
      ...(draft.location !== undefined ? { location: { displayName: draft.location ?? "" } } : {}),
      ...(draft.start ? { start: { dateTime: draft.start.toISOString(), timeZone: "UTC" } } : {}),
      ...(draft.end ? { end: { dateTime: draft.end.toISOString(), timeZone: "UTC" } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Microsoft event update failed: ${res.status} ${await res.text()}`);
}

/// Delete an event on the account it lives on. Used both to compensate for a
/// failed booking insert (orphan cleanup) and for a user-initiated delete from
/// the event modal. `notify` controls guest emails on Google (sendUpdates);
/// Microsoft decides on its own. When `throwOnError` is false (the default,
/// used by orphan cleanup) failures are logged and swallowed; the event modal
/// passes true so it can surface the error.
export async function deleteDestinationEvent(
  account: Account,
  externalEventId: string,
  opts: { notify?: boolean; throwOnError?: boolean } = {}
): Promise<void> {
  if (calendarStubbed()) return;
  const { notify = true, throwOnError = false } = opts;
  try {
    const token = await getValidAccessToken(account);
    const url =
      account.provider === Provider.google
        ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(externalEventId)}?sendUpdates=${notify ? "all" : "none"}`
        : `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalEventId)}`;
    const res = await fetchWithRetry(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) {
      const msg = `event delete failed: ${res.status} ${await res.text()}`;
      if (throwOnError) throw new Error(msg);
      console.error(`[booking] failed to clean up orphaned event ${externalEventId}: ${msg}`);
    }
  } catch (err) {
    if (throwOnError) throw err;
    console.error(`[booking] error cleaning up orphaned event ${externalEventId}:`, err);
  }
}

/// Owner-local calendar date (YYYY-MM-DD) of a UTC instant, for all-day events.
function localDate(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: "utc" }).setZone(timezone).toISODate()!;
}

async function createGoogleEvent(token: string, draft: EventDraft): Promise<CreatedEvent> {
  // Recurring events anchor to local wall-clock; one-offs stay UTC. Google takes
  // the iCal RRULE directly as a `recurrence` array entry. All-day events use a
  // {date} pair (end date is exclusive, so it's the next day's date).
  const recurring = draft.recurrenceRule && draft.timezone;
  const start = draft.allDay
    ? { date: localDate(draft.start, draft.timezone ?? "UTC") }
    : recurring
      ? localDateTime(draft.start, draft.timezone!)
      : { dateTime: draft.start.toISOString(), timeZone: "UTC" };
  const end = draft.allDay
    ? { date: localDate(draft.end, draft.timezone ?? "UTC") }
    : recurring
      ? localDateTime(draft.end, draft.timezone!)
      : { dateTime: draft.end.toISOString(), timeZone: "UTC" };
  // Plain fetch, NOT fetchWithRetry: a create is not idempotent, so retrying a
  // POST that already succeeded server-side would duplicate the event.
  // conferenceDataVersion=1 is REQUIRED for Google to act on conferenceData;
  // without it the field is silently ignored and you get an event with no link
  // and no error.
  const url =
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all" +
    (draft.conference ? "&conferenceDataVersion=1" : "");
  const res = await fetch(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: draft.title,
        // Google renders a limited HTML subset (<strong>, <a>, <br>) in the
        // description; fall back to plain text when no HTML was supplied.
        description: draft.descriptionHtml ?? draft.description,
        location: draft.location,
        start,
        end,
        recurrence: recurring ? [`RRULE:${draft.recurrenceRule}`] : undefined,
        attendees: draft.attendeeEmail
          ? [
              { email: draft.attendeeEmail, displayName: draft.attendeeName },
              ...coHostAttendeeEmails(draft).map((email) => ({ email })),
            ]
          : undefined,
        conferenceData: draft.conference
          ? {
              createRequest: {
                // Google requires a caller-supplied id it can dedupe on, so a
                // retried create cannot mint a second room.
                requestId: randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            }
          : undefined,
      }),
    }
  );
  if (!res.ok) throw new Error(`Google event insert failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    id: string;
    hangoutLink?: string;
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  };
  const videoEntry = data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video");
  return { id: data.id, videoLink: data.hangoutLink ?? videoEntry?.uri };
}

async function createMicrosoftEvent(token: string, draft: EventDraft): Promise<CreatedEvent> {
  // Graph won't take an RRULE string — a recurring event needs a structured
  // { pattern, range } object, and its start/end must be in the recurrence's own
  // timezone (local wall-clock), not UTC. One-offs stay UTC as before.
  const recurring = draft.recurrenceRule && draft.timezone;
  // All-day events send local midnight boundaries in the owner's zone with
  // isAllDay set; Graph requires both ends at 00:00 in that zone.
  const start = draft.allDay
    ? { dateTime: localDateTime(draft.start, draft.timezone ?? "UTC").dateTime, timeZone: draft.timezone ?? "UTC" }
    : recurring
      ? localDateTime(draft.start, draft.timezone!)
      : { dateTime: draft.start.toISOString(), timeZone: "UTC" };
  const end = draft.allDay
    ? { dateTime: localDateTime(draft.end, draft.timezone ?? "UTC").dateTime, timeZone: draft.timezone ?? "UTC" }
    : recurring
      ? localDateTime(draft.end, draft.timezone!)
      : { dateTime: draft.end.toISOString(), timeZone: "UTC" };
  const recurrence = recurring
    ? rruleToGraphRecurrence(
        draft.recurrenceRule!,
        DateTime.fromJSDate(draft.start, { zone: "utc" }).setZone(draft.timezone!),
        draft.timezone!
      )
    : undefined;
  // Plain fetch, NOT fetchWithRetry: a create is not idempotent, so retrying a
  // POST that already succeeded server-side would duplicate the event.
  const res = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      subject: draft.title,
      // Graph's equivalent of Meet. teamsForBusiness is the only provider a
      // normal work/school account can create.
      ...(draft.conference
        ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" }
        : {}),
      // Prefer the rich HTML body (bold labels etc.); Graph strips it to plain
      // text for the .ics DESCRIPTION automatically. Fall back to plain text.
      body: draft.descriptionHtml
        ? { contentType: "html", content: draft.descriptionHtml }
        : draft.description
          ? { contentType: "text", content: draft.description }
          : undefined,
      location: draft.location ? { displayName: draft.location } : undefined,
      isAllDay: draft.allDay || undefined,
      start,
      end,
      recurrence,
      attendees: draft.attendeeEmail
        ? [
            {
              emailAddress: { address: draft.attendeeEmail, name: draft.attendeeName },
              type: "required",
            },
            ...coHostAttendeeEmails(draft).map((address) => ({
              emailAddress: { address },
              type: "required" as const,
            })),
          ]
        : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Microsoft event create failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { id: string; onlineMeeting?: { joinUrl?: string } };
  return { id: data.id, videoLink: data.onlineMeeting?.joinUrl };
}
