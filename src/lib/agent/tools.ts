import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { DateTime } from "luxon";
import { CreatedVia, type Account } from "@prisma/client";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { getAvailability } from "@/lib/availability/service";
import { getJointAvailability } from "@/lib/availability/jointService";
import { getScheduleView } from "@/lib/schedule/service";
import { createBooking, cancelBooking, BookingError, rescheduleBooking } from "@/lib/booking/service";
import { createDestinationEvent, updateDestinationEvent, deleteDestinationEvent } from "@/lib/calendar/write";
import { isValidTimezone } from "@/lib/validation";
import { diffItems, progress, withItems } from "@/lib/todos/items";
import { createNudge, listUpcomingNudges, cancelNudge } from "@/lib/nudge/service";
import { nextOccurrence, createRecurringActionable } from "@/lib/todos/recurring";
import { runFindMutualTimes, type FindMutualTimesArgs } from "./mutualSlots";
import { renderInviteDescription, renderInviteDescriptionHtml, type InviteInput } from "@/lib/notify/invite";
import { HOST } from "@/lib/booking/publicConfig";

// ---------------------------------------------------------------------------
// Shared read tool — free/busy ONLY. Safe for the public agent: never returns
// event titles, attendees, or which account an interval belongs to.
// ---------------------------------------------------------------------------
/// A joint-booking (team) context for the public tools. When present, the tools
/// operate on times EVERY member is free and book onto the team link, putting
/// each co-host on the invite. Absent = the owner's own single-host flow.
export interface TeamBookingContext {
  id: string;
  coHostIds: string[];
  coHostEmails: string[];
  /// Team display name + every host (for the confirmation email / invite).
  name: string;
  hosts: { name: string; linkedin?: string | null }[];
}

export function getAvailabilityTool(team?: TeamBookingContext) {
  return betaTool({
    name: "get_availability",
    description: team
      ? "Get the free slots that work for EVERYONE on this booking (all hosts free). Pass the window the visitor " +
        "asked for; the whole day is searched regardless. Returns `matching` (slots starting inside that window) " +
        "and `alsoFreeSameDay` (everything else jointly free on those days), both UTC — never event details."
      : "Get the owner's free booking slots. Pass the window the visitor asked for; the whole day is searched " +
        "regardless. Returns `matching` (slots starting inside that window) and `alsoFreeSameDay` (everything " +
        "else free on those days), both UTC — never event details. Offer `matching` first, and when it is short, " +
        "say what else is free rather than implying the day is full.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startISO: { type: "string", description: "Range start, ISO 8601 UTC." },
        endISO: { type: "string", description: "Range end, ISO 8601 UTC." },
        durationMinutes: { type: "number", description: "Slot length; defaults to the configured event duration." },
      },
      required: ["startISO", "endISO"],
    },
    run: async ({ startISO, endISO, durationMinutes }) => {
      const windowStart = new Date(startISO as string);
      const windowEnd = new Date(endISO as string);
      if (isNaN(windowStart.getTime()) || isNaN(windowEnd.getTime())) {
        return JSON.stringify({ error: "invalid_range", message: "startISO and endISO must be ISO 8601." });
      }

      // Always compute over the WHOLE owner-local days the window touches, then
      // split. Asked for "Thursday afternoon" the model would pick its own
      // cut-off, query only that slice, and truthfully report one opening while
      // the picker showed eight that day — and the cut-off varied between runs,
      // so the same question gave different answers. Widening here means the
      // model physically cannot be blind to the rest of the day.
      const dayStart = DateTime.fromJSDate(windowStart).setZone(OWNER_TIMEZONE).startOf("day");
      const dayEnd = DateTime.fromJSDate(windowEnd).setZone(OWNER_TIMEZONE).endOf("day");

      const availArgs = {
        requestedStart: dayStart.toUTC().toJSDate(),
        requestedEnd: dayEnd.toUTC().toJSDate(),
        durationMinutes: durationMinutes as number | undefined,
      };
      const { slots, warnings } = team
        ? await getJointAvailability({ ...availArgs, coHostIds: team.coHostIds })
        : await getAvailability(availArgs);

      const { matching, alsoFreeSameDay } = partitionSlots(slots, windowStart, windowEnd);
      const iso = (s: { start: Date; end: Date }) => ({
        start: s.start.toISOString(),
        end: s.end.toISOString(),
      });
      return JSON.stringify({
        matching: matching.map(iso),
        alsoFreeSameDay: alsoFreeSameDay.map(iso),
        warnings,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// PUBLIC booking tool — the only write the public agent can perform. Fenced by
// closures the route supplies: tryReserveBooking atomically checks-and-claims
// the once-per-visitor slot before we ever await the write, so two
// create_public_booking tool_use blocks resolved in the same turn (the SDK
// runs them via Promise.all) can't both pass. If the write then fails,
// releaseBooking gives the slot back. createBooking itself re-validates the
// slot and rules.
// ---------------------------------------------------------------------------
export interface PublicBookingFence {
  tryReserveBooking: () => boolean;
  releaseBooking: () => void;
}

/// Split slots into those inside the visitor's requested window and the rest of
/// the same day(s). Keeping both means the agent can honour a stated preference
/// without silently hiding everything just outside it.
export function partitionSlots(
  slots: Array<{ start: Date; end: Date }>,
  windowStart: Date,
  windowEnd: Date
): { matching: Array<{ start: Date; end: Date }>; alsoFreeSameDay: Array<{ start: Date; end: Date }> } {
  const matching: Array<{ start: Date; end: Date }> = [];
  const alsoFreeSameDay: Array<{ start: Date; end: Date }> = [];
  for (const s of slots) {
    // A slot counts as requested when it STARTS within the window; a slot that
    // merely overlaps the edge is offered as a nearby alternative instead.
    if (s.start >= windowStart && s.start < windowEnd) matching.push(s);
    else alsoFreeSameDay.push(s);
  }
  return { matching, alsoFreeSameDay };
}

export function createPublicBookingTool(fence: PublicBookingFence, team?: TeamBookingContext) {
  return betaTool({
    name: "create_public_booking",
    description:
      (team
        ? "Book a meeting with all the hosts for the visitor you are talking to; every host is added to the invite. "
        : "Book a meeting with the owner for the visitor you are talking to. ") +
      "The meeting length is whatever the start/end you pass spans — use the slot the visitor " +
      "picked at their requested duration. Only call this once you have confirmed the " +
      "exact slot and the visitor's name, email, and timezone. Book at most once per conversation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startISO: { type: "string", description: "Slot start, ISO 8601 UTC." },
        endISO: { type: "string", description: "Slot end, ISO 8601 UTC." },
        attendeeName: { type: "string" },
        attendeeEmail: { type: "string" },
        attendeeTimezone: { type: "string", description: "IANA timezone, e.g. America/New_York." },
      },
      required: ["startISO", "endISO", "attendeeName", "attendeeEmail", "attendeeTimezone"],
    },
    run: async (input) => {
      if (!fence.tryReserveBooking()) {
        return JSON.stringify({ error: "booking_limit", message: "A booking was already made in this session." });
      }
      try {
        const booking = await createBooking({
          start: new Date(input.startISO as string),
          end: new Date(input.endISO as string),
          attendeeName: input.attendeeName as string,
          attendeeEmail: input.attendeeEmail as string,
          attendeeTimezone: input.attendeeTimezone as string,
          createdVia: CreatedVia.public_agent,
          ...(team
            ? {
                coHostIds: team.coHostIds,
                additionalAttendeeEmails: team.coHostEmails,
                teamId: team.id,
                hostLabel: team.name,
                hosts: team.hosts,
              }
            : {}),
        });
        return JSON.stringify({
          ok: true,
          bookingId: booking.id,
          start: booking.startTime.toISOString(),
          end: booking.endTime.toISOString(),
        });
      } catch (err) {
        fence.releaseBooking();
        if (err instanceof BookingError) return JSON.stringify({ error: err.code, message: err.message });
        return JSON.stringify({ error: "booking_failed", message: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  });
}

export function findMutualTimesTool() {
  return betaTool({
    name: "find_mutual_times",
    description:
      "Find meeting times that work for BOTH the visitor and the owner. Pass the " +
      "meeting duration, the search window, and the visitor's OWN free windows " +
      "(convert what they told you into UTC ISO intervals). Returns the mutually-" +
      "free bookable slots in UTC plus the owner's timezone. Returns only free/busy " +
      "overlap — never the owner's event details. If mutualSlots is empty, there is " +
      "no overlap; ask the visitor for more availability.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        durationMinutes: { type: "number", description: "Meeting length in minutes." },
        windowStartISO: { type: "string", description: "Search window start, ISO 8601 UTC." },
        windowEndISO: { type: "string", description: "Search window end, ISO 8601 UTC." },
        requesterFreeSlots: {
          type: "array",
          description: "The visitor's own free windows, each ISO 8601 UTC.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              startISO: { type: "string" },
              endISO: { type: "string" },
            },
            required: ["startISO", "endISO"],
          },
        },
        requesterTimezone: { type: "string", description: "The visitor's IANA timezone." },
      },
      required: [
        "durationMinutes",
        "windowStartISO",
        "windowEndISO",
        "requesterFreeSlots",
        "requesterTimezone",
      ],
    },
    run: async (input) => runFindMutualTimes(input as unknown as FindMutualTimesArgs),
  });
}

// ---------------------------------------------------------------------------
// PRIVATE tools — full detail + writes. Never exposed to the public agent.
// ---------------------------------------------------------------------------
export function getScheduleTool() {
  return betaTool({
    name: "get_schedule",
    description:
      "Get the owner's full merged calendar for a range — real events (with titles/attendees), " +
      "personal blocks, and bookings. Private only.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        startISO: { type: "string" },
        endISO: { type: "string" },
      },
      required: ["startISO", "endISO"],
    },
    run: async ({ startISO, endISO }) => {
      const view = await getScheduleView(new Date(startISO as string), new Date(endISO as string));
      return JSON.stringify({
        events: view.events.map((e) => ({
          // id + account are what update_event / delete_event need to target
          // this specific event on the account it lives on.
          id: e.id,
          account: e.accountEmail,
          title: e.title,
          start: e.start.toISOString(),
          end: e.end.toISOString(),
        })),
        blocks: view.blocks.map((b) => ({ title: b.title, start: b.start.toISOString(), end: b.end.toISOString() })),
        // Actionables were omitted here, so the agent could not see the ones it
        // had already created. Asked to change one it created a second instead,
        // three times over. id is what update_actionable / delete_actionable
        // need to target an existing one.
        actionables: (view.actionables ?? []).map((a) => ({
          id: a.id,
          title: a.title,
          start: a.start.toISOString(),
          end: a.end.toISOString(),
        })),
        bookings: view.bookings.map((b) => ({
          id: b.id,
          title: b.title,
          start: b.start.toISOString(),
          attendee: b.attendeeName,
        })),
        warnings: view.warnings,
      });
    },
  });
}

export function createPrivateBookingTool() {
  return betaTool({
    name: "create_booking",
    description:
      "Book a meeting on the owner's behalf. Confirm the details with the owner first. " +
      "By default it lands on the owner's default (destination) calendar; to book onto a specific connected " +
      "calendar, pass accountEmail (get the options from list_calendars).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        startISO: { type: "string" },
        endISO: { type: "string" },
        attendeeName: { type: "string" },
        attendeeEmail: { type: "string" },
        attendeeTimezone: { type: "string" },
        accountEmail: {
          type: "string",
          description: "Target calendar (connected account email, from list_calendars). Omit for the default calendar.",
        },
      },
      required: ["startISO", "endISO", "attendeeName", "attendeeEmail", "attendeeTimezone"],
    },
    run: async (input) => {
      try {
        const booking = await createBooking({
          title: input.title as string | undefined,
          start: new Date(input.startISO as string),
          end: new Date(input.endISO as string),
          attendeeName: input.attendeeName as string,
          attendeeEmail: input.attendeeEmail as string,
          attendeeTimezone: input.attendeeTimezone as string,
          targetAccountEmail: (input.accountEmail as string | undefined)?.trim() || undefined,
          createdVia: CreatedVia.private_agent,
        });
        return JSON.stringify({ ok: true, bookingId: booking.id });
      } catch (err) {
        if (err instanceof BookingError) return JSON.stringify({ error: err.code, message: err.message });
        return JSON.stringify({ error: "booking_failed", message: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  });
}

export function deleteBookingTool() {
  return betaTool({
    name: "delete_booking",
    description:
      "Cancel/delete one of the owner's bookings by id (get the id from get_schedule). This removes the " +
      "meeting from the owner's calendar AND emails the attendee that it's cancelled — so confirm the exact " +
      "booking (attendee name + time) with the owner and get an explicit yes before calling. Cannot be undone.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        bookingId: { type: "string", description: "Booking id (from get_schedule)." },
      },
      required: ["bookingId"],
    },
    run: async ({ bookingId }) => {
      try {
        const booking = await cancelBooking(bookingId as string);
        return JSON.stringify({ ok: true, bookingId: booking.id, status: booking.status });
      } catch (err) {
        if (err instanceof BookingError) return JSON.stringify({ error: err.code, message: err.message });
        return JSON.stringify({ error: "cancel_failed", message: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  });
}

/// Move an existing booking. The attendee-facing manage page could already do
/// this; the agent could only CANCEL, so over WhatsApp "push my 3pm to 4pm"
/// meant cancelling and rebooking by hand — which emails the attendee a
/// cancellation, then a fresh invitation, and invalidates their manage link.
export function rescheduleBookingTool() {
  return betaTool({
    name: "reschedule_booking",
    description:
      "Move one of the owner's bookings to a new time, keeping the same attendee (get the id from " +
      "get_schedule). The attendee is emailed the new time and the owner gets one 'moved' alert — this is " +
      "NOT the same as cancelling and re-booking, which would email a cancellation and break the attendee's " +
      "manage link. Check the new slot is free with get_availability first, and confirm the exact booking " +
      "and new time with the owner before calling.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        bookingId: { type: "string", description: "Booking id (from get_schedule)." },
        startISO: { type: "string", description: "New start, ISO 8601 UTC." },
        endISO: { type: "string", description: "New end, ISO 8601 UTC." },
      },
      required: ["bookingId", "startISO", "endISO"],
    },
    run: async ({ bookingId, startISO, endISO }) => {
      const start = new Date(startISO as string);
      const end = new Date(endISO as string);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
        return JSON.stringify({ error: "invalid_range", message: "endISO must be after startISO." });
      }
      try {
        const booking = await rescheduleBooking(bookingId as string, { start, end });
        return JSON.stringify({
          ok: true,
          bookingId: booking.id,
          // The id CHANGES: a reschedule books a new row and cancels the old, so
          // anything holding the previous id must use this one from now on.
          previousBookingId: bookingId,
          start: booking.startTime.toISOString(),
          end: booking.endTime.toISOString(),
          attendee: booking.attendeeName,
        });
      } catch (err) {
        if (err instanceof BookingError) return JSON.stringify({ error: err.code, message: err.message });
        return JSON.stringify({
          error: "reschedule_failed",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
  });
}


// ---------------------------------------------------------------------------
// Invites (owner, 2026-09-24): create_event with guests. The body says where
// to meet, in person or online, and ends with the owner's links.
// ---------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseAttendees(raw: unknown): { list: { email: string; name?: string }[] } | { error: string; message: string } {
  if (raw === undefined) return { list: [] };
  if (!Array.isArray(raw)) return { error: "invalid_attendee", message: "attendees must be a list of {email, name?}." };
  const seen = new Set<string>();
  const list: { email: string; name?: string }[] = [];
  for (const a of raw as unknown[]) {
    const o = (a && typeof a === "object" ? a : {}) as { email?: unknown; name?: unknown };
    const email = typeof o.email === "string" ? o.email.trim() : "";
    if (!EMAIL.test(email)) return { error: "invalid_attendee", message: `Not an email address: ${String(o.email)}` };
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : undefined;
    list.push({ email, name });
  }
  return { list };
}

function buildInvite(
  input: Record<string, unknown>,
  guests: { email: string; name?: string }[],
  start: Date,
  end: Date
):
  | { description: string; descriptionHtml: string; location: string; videoLink?: string; meeting: "in_person" | "online" }
  | { error: string; message: string } {
  const meeting = input.meeting === "in_person" || input.meeting === "online" ? input.meeting : null;
  if (!meeting) {
    return { error: "meeting_required", message: "With attendees, pass meeting: 'in_person' (with location) or 'online'." };
  }
  const location = (input.location as string | undefined)?.trim() || "";
  const videoLink = (input.videoLink as string | undefined)?.trim() || HOST.videoLink || "";
  if (meeting === "in_person" && !location) {
    return { error: "location_required", message: "An in-person invite needs a location." };
  }
  if (meeting === "online" && !videoLink) {
    return {
      error: "no_video_link",
      message: "No room link is configured (NEXT_PUBLIC_OWNER_VIDEO_LINK) and none was given; pass videoLink.",
    };
  }
  if (meeting === "online" && !/^https?:\/\//i.test(videoLink)) {
    return { error: "invalid_video_link", message: "videoLink must start with http:// or https://." };
  }
  const args: InviteInput = {
    title: (input.title as string).trim(),
    start,
    end,
    hostName: HOST.name,
    timezone: OWNER_TIMEZONE,
    attendeeNames: guests.map((g) => g.name ?? "").filter(Boolean),
    meeting,
    location: meeting === "in_person" ? location : undefined,
    videoUrl: meeting === "online" ? videoLink : undefined,
    note: (input.note as string | undefined)?.trim() || undefined,
    links: { consulting: HOST.practice.url, github: HOST.githubUrl, research: HOST.researchUrl, linkedin: HOST.linkedin },
  };
  return {
    description: renderInviteDescription(args),
    descriptionHtml: renderInviteDescriptionHtml(args),
    // The join link doubles as the location online, so calendar apps surface
    // a join button, the same as bookings.
    location: meeting === "in_person" ? location : videoLink,
    videoLink: meeting === "online" ? videoLink : undefined,
    meeting,
  };
}

export function createEventTool() {
  return betaTool({
    name: "create_event",
    description:
      "Create a real calendar event on the owner's calendar. This is the DEFAULT tool whenever the owner asks " +
      "to schedule, add, book time for, or put something on his calendar — use create_event unless he " +
      "explicitly asks for reserved/blocked/hold time, in which case use create_personal_block instead. " +
      "Events CAN recur: pass recurrenceRule (an iCal RRULE, e.g. FREQ=WEEKLY;BYDAY=SU) plus timezone for " +
      "a repeating event. Recurrence is NOT limited to blocks. " +
      "By default the event lands on the owner's default (destination) calendar; to put it on a specific " +
      "connected calendar, pass accountEmail (get the options from list_calendars). " +
      "To INVITE people, pass attendees (their emails, names if known) and meeting: 'in_person' with a " +
      "location, or 'online' (the owner's fixed room link is used unless videoLink is given). The invite " +
      "body then says where to meet and ends with the owner's consulting, GitHub and research links; " +
      "the provider emails every guest, so confirm guests, time and place with the owner first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        startISO: { type: "string", description: "Event start (first occurrence), ISO 8601 UTC." },
        endISO: { type: "string", description: "Event end (first occurrence), ISO 8601 UTC." },
        attendees: {
          type: "array",
          description: "Guests to invite. Each gets the provider's invite email.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { email: { type: "string" }, name: { type: "string" } },
            required: ["email"],
          },
        },
        meeting: {
          type: "string",
          enum: ["in_person", "online"],
          description: "Required with attendees: in_person (give location) or online (owner's room, or videoLink).",
        },
        videoLink: { type: "string", description: "Online only: a specific join link instead of the owner's room." },
        note: { type: "string", description: "Optional agenda or context for the guests, shown in the invite body." },
        addVideoLink: {
          type: "boolean",
          description:
            "Create a real video-call link for this event (Google Meet, or Teams on a Microsoft account). " +
            "Defaults to TRUE — anything with other people on it needs a way to join. Pass false for a solo " +
            "hold, focus time, or a reminder to yourself, where a meeting room would be noise. Ignored when " +
            "attendees are given: an invite uses the owner's fixed room (or videoLink) instead of a minted link.",
        },
        description: { type: "string" },
        location: { type: "string" },
        recurrenceRule: {
          type: "string",
          description: "iCal RRULE body for a recurring event (e.g. FREQ=WEEKLY;BYDAY=SU). Omit for a one-off.",
        },
        timezone: {
          type: "string",
          description: "IANA timezone the event is authored in (e.g. America/Los_Angeles). Required when recurrenceRule is set.",
        },
        accountEmail: {
          type: "string",
          description: "Target calendar (connected account email, from list_calendars). Omit for the default calendar.",
        },
      },
      required: ["title", "startISO", "endISO"],
    },
    run: async (input) => {
      const start = new Date(input.startISO as string);
      const end = new Date(input.endISO as string);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
        return JSON.stringify({ error: "invalid_range" });
      }
      const recurrenceRule = (input.recurrenceRule as string | undefined)?.trim() || undefined;
      const timezone = (input.timezone as string | undefined)?.trim() || undefined;
      if (recurrenceRule && !timezone) {
        return JSON.stringify({ error: "timezone_required", message: "A recurring event needs a timezone." });
      }
      if (timezone && !isValidTimezone(timezone)) {
        return JSON.stringify({ error: "invalid_timezone", message: `Unknown timezone: ${timezone}` });
      }
      // Guests: validated up front so a bad address never reaches the provider.
      const attendees = parseAttendees(input.attendees);
      if ("error" in attendees) return JSON.stringify(attendees);
      const invite = attendees.list.length > 0 ? buildInvite(input, attendees.list, start, end) : null;
      if (invite && "error" in invite) return JSON.stringify(invite);

      const account = await resolveTargetAccount(input.accountEmail);
      if ("error" in account) return JSON.stringify(account);
      try {
        const created = await createDestinationEvent(account, {
          title: (input.title as string).trim(),
          start,
          end,
          description: invite ? invite.description : (input.description as string | undefined)?.trim() || undefined,
          descriptionHtml: invite ? invite.descriptionHtml : undefined,
          location: invite ? invite.location : (input.location as string | undefined)?.trim() || undefined,
          recurrenceRule,
          timezone,
          // An invite uses the owner's fixed room (or a pasted link), never a
          // provider-minted conference: two links on one invite is confusing.
          conference: invite ? false : input.addVideoLink !== false,
          ...(invite
            ? {
                attendeeEmail: attendees.list[0].email,
                attendeeName: attendees.list[0].name,
                additionalAttendeeEmails: attendees.list.slice(1).map((a) => a.email),
              }
            : {}),
        });
        return JSON.stringify({
          ok: true,
          eventId: created.id,
          // Null when the provider declined or the account cannot host one —
          // say so rather than implying a link exists.
          videoLink: invite ? (invite.videoLink ?? null) : (created.videoLink ?? null),
          account: account.email,
          recurring: !!recurrenceRule,
          start: start.toISOString(),
          end: end.toISOString(),
          ...(invite ? { invited: attendees.list.map((a) => a.email), meeting: invite.meeting } : {}),
        });
      } catch (err) {
        return JSON.stringify({ error: "event_failed", message: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  });
}

export function listCalendarsTool() {
  return betaTool({
    name: "list_calendars",
    description:
      "List the owner's connected calendars (accounts) you can write to. Returns each calendar's email, " +
      "name, provider, whether it's the default (destination), and whether it's connected. Use this to pick " +
      "a target when the owner names a specific calendar (e.g. 'my consulting calendar' or 'my work account') " +
      "— then pass the chosen email as accountEmail to create_event, create_actionable, or create_booking. " +
      "Omit accountEmail to use the default calendar.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: async () => {
      const accounts = await prisma.account.findMany({ orderBy: [{ isDestination: "desc" }, { email: "asc" }] });
      return JSON.stringify({
        calendars: accounts.map((a) => ({
          email: a.email,
          name: a.displayName ?? a.email,
          provider: a.provider,
          isDefault: a.isDestination,
          connected: !!(a.refreshToken || a.accessToken),
        })),
      });
    },
  });
}

export function createActionableTool() {
  return betaTool({
    name: "create_actionable",
    description:
      "Create an actionable — a day-scoped to-do that appears on the owner's calendar as an actionable (its own " +
      "kind, distinct from an event or a reserved block). Provide dayISO (any instant on the target day; " +
      "interpreted in the owner's timezone). For a timed item that lands at a specific time on the calendar, " +
      "pass startISO and endISO (UTC); omit them for an all-day/untimed checklist item. This does NOT create a " +
      "calendar EVENT — an actionable is its own thing. Confirm the wording and day with the owner first. " +
      "Only call this for an item the owner has just asked for: do NOT re-create items from earlier in the " +
      "conversation when confirming a list back to them. Calling it twice for the same title, day and time is " +
      "safe — it returns the existing item with duplicate:true rather than adding a second.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        dayISO: { type: "string", description: "Any ISO 8601 instant on the target day; the day is read in the owner's timezone." },
        startISO: { type: "string", description: "Optional timed start (ISO 8601 UTC). If set, endISO is required." },
        endISO: { type: "string", description: "Optional timed end (ISO 8601 UTC). If set, startISO is required." },
        location: { type: "string", description: "In-person location." },
        videoLink: { type: "string", description: "Online meeting URL." },
        items: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional to-do list under this actionable, in order. Use it when the owner's request names one task " +
            "with several parts or lists steps: ONE actionable with items, not one actionable per line.",
        },
      },
      required: ["title", "dayISO"],
    },
    run: async (input) => {
      const title = (input.title as string)?.trim();
      if (!title) return JSON.stringify({ error: "missing_title", message: "A title is required." });
      const itemTitles = Array.isArray(input.items) ? (input.items as unknown[]).filter((t): t is string => typeof t === "string") : [];
      const { create: items } = diffItems([], itemTitles.map((t) => ({ title: t })));

      // The day the actionable belongs to, as the app's stable day key: the
      // owner-local midnight of dayISO, stored as a UTC instant (matches how the
      // Blocks pane keys todos by day).
      const day = DateTime.fromISO(input.dayISO as string, { zone: OWNER_TIMEZONE });
      if (!day.isValid) return JSON.stringify({ error: "invalid_day", message: "dayISO is not a valid date." });
      const dayStart = day.startOf("day");
      const dayKey = dayStart.toUTC().toJSDate();

      // Timed (both ends) vs untimed (neither). A lone start/end is ambiguous.
      const hasStart = input.startISO !== undefined;
      const hasEnd = input.endISO !== undefined;
      if (hasStart !== hasEnd) {
        return JSON.stringify({ error: "invalid_range", message: "Pass both startISO and endISO, or neither." });
      }
      let start: Date | null = null;
      let end: Date | null = null;
      if (hasStart && hasEnd) {
        start = new Date(input.startISO as string);
        end = new Date(input.endISO as string);
        if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
          return JSON.stringify({ error: "invalid_range", message: "endISO must be after startISO." });
        }
      }

      const location = (input.location as string | undefined)?.trim() || undefined;
      const videoLink = (input.videoLink as string | undefined)?.trim() || undefined;

      // An actionable is a Todo — a first-class item the calendar renders as an
      // actionable (timed ones land on the grid at their time). It is NOT mirrored
      // to a provider event, so it never shows up as a duplicate "EVENT".
      // Same invariant as update_actionable: when the item is timed, the day it
      // belongs to is the day its start falls on, so a dayISO that disagrees
      // with startISO cannot file it on the wrong day.
      const effectiveDayKey = start
        ? DateTime.fromJSDate(start).setZone(OWNER_TIMEZONE).startOf("day").toUTC().toJSDate()
        : dayKey;

      // IDEMPOTENCY. Asked to add a second actionable in a follow-up turn, the
      // agent re-created the FIRST one too, and the owner ended up with "Put
      // together all the immigration things" twice at 8–10 PM.
      //
      // The reason it can happen at all: conversation history is replayed to the
      // model as plain text (run.ts maps each turn to role + content), so a
      // previous tool call leaves no structured trace. The model's only memory
      // of having already created something is its own prose — and when it
      // composes a combined "both are on tonight's list" confirmation, calling
      // create for both items is a very easy mistake to make.
      //
      // Telling it to call list_actionables first (see that tool's description)
      // is advice, not a guard; #21 added the missing verbs but left this path
      // able to write the same row twice. Same title, same day, same timing is
      // never a thing the owner wants twice, so return the existing item instead
      // of a second row. Different times with the same title are left alone —
      // two "Gym" entries in a day are legitimate.
      const duplicate = await prisma.todo.findFirst({
        where: {
          date: effectiveDayKey,
          title: { equals: title, mode: "insensitive" },
          startTime: start,
          endTime: end,
        },
      });
      if (duplicate) {
        return JSON.stringify({
          ok: true,
          todoId: duplicate.id,
          timed: !!(start && end),
          duplicate: true,
          message: `"${duplicate.title}" is already on that day at the same time — kept the existing one.`,
        });
      }

      const last = await prisma.todo.findFirst({ where: { date: effectiveDayKey }, orderBy: { sortOrder: "desc" } });
      const todo = await prisma.todo.create({
        data: {
          title,
          date: effectiveDayKey,
          startTime: start,
          endTime: end,
          location: location ?? null,
          videoLink: videoLink ?? null,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          items: { create: items },
        },
        include: withItems,
      });

      const created = Array.isArray(todo.items) ? todo.items : [];
      return JSON.stringify({
        ok: true,
        todoId: todo.id,
        timed: !!(start && end),
        items: created.map((i) => ({ id: i.id, title: i.title, done: i.done })),
        progress: progress(created),
      });
    },
  });
}

/// List every actionable on a day — including UNTIMED ones, which get_schedule
/// cannot show because it only places timed items on the grid. Without this the
/// agent is blind to exactly the items it is most likely to duplicate.
export function listActionablesTool() {
  return betaTool({
    name: "list_actionables",
    description:
      "List the owner's actionables (day-scoped to-dos) for a day, timed and untimed alike, with their ids. " +
      "ALWAYS call this before creating an actionable the owner may already have, and before changing one — " +
      "use update_actionable to modify an existing item rather than creating a second.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dayISO: { type: "string", description: "Any ISO 8601 instant on the target day; read in the owner's timezone." },
      },
      required: ["dayISO"],
    },
    run: async ({ dayISO }) => {
      const day = DateTime.fromISO(dayISO as string, { zone: OWNER_TIMEZONE });
      if (!day.isValid) return JSON.stringify({ error: "invalid_day", message: "dayISO is not a valid date." });
      const todos = await prisma.todo.findMany({
        where: { date: day.startOf("day").toUTC().toJSDate() },
        orderBy: { sortOrder: "asc" },
        include: withItems,
      });
      return JSON.stringify({
        actionables: todos.map((t) => ({
          id: t.id,
          title: t.title,
          done: t.done,
          start: t.startTime?.toISOString() ?? null,
          end: t.endTime?.toISOString() ?? null,
          location: t.location,
          videoLink: t.videoLink,
          phone: t.phone,
          items: t.items.map((i) => ({ id: i.id, title: i.title, done: i.done })),
          progress: progress(t.items),
        })),
      });
    },
  });
}

/// Change an existing actionable. Its absence is why "make that 5pm" produced a
/// second actionable instead of moving the first: create was the only actionable
/// verb the agent had.
export function updateActionableTool() {
  return betaTool({
    name: "update_actionable",
    description:
      "Update an existing actionable in place (get its id from list_actionables or get_schedule). Use this to " +
      "retime, rename, relocate or complete one — never create a second actionable to express a change. Only " +
      "the fields you pass are altered. Pass clearTime:true to turn a timed actionable back into an untimed one.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "The actionable's id." },
        title: { type: "string" },
        startISO: { type: "string", description: "New timed start (ISO 8601 UTC). If set, endISO is required." },
        endISO: { type: "string", description: "New timed end (ISO 8601 UTC). If set, startISO is required." },
        clearTime: { type: "boolean", description: "Make the actionable untimed." },
        dayISO: { type: "string", description: "Move it to another day (any instant on that day)." },
        location: { type: "string" },
        videoLink: { type: "string" },
        phone: { type: "string" },
        done: { type: "boolean" },
      },
      required: ["id"],
    },
    run: async (input) => {
      const id = (input.id as string)?.trim();
      if (!id) return JSON.stringify({ error: "missing_id", message: "An actionable id is required." });
      const existing = await prisma.todo.findUnique({ where: { id } });
      if (!existing) {
        return JSON.stringify({ error: "not_found", message: "No actionable with that id. Call list_actionables." });
      }

      const data: Record<string, unknown> = {};
      const title = (input.title as string | undefined)?.trim();
      if (title) data.title = title;
      if (input.location !== undefined) data.location = (input.location as string)?.trim() || null;
      if (input.videoLink !== undefined) data.videoLink = (input.videoLink as string)?.trim() || null;
      if (input.phone !== undefined) data.phone = (input.phone as string)?.trim() || null;
      if (input.done !== undefined) data.done = !!input.done;

      if (input.dayISO !== undefined) {
        const day = DateTime.fromISO(input.dayISO as string, { zone: OWNER_TIMEZONE });
        if (!day.isValid) return JSON.stringify({ error: "invalid_day", message: "dayISO is not a valid date." });
        data.date = day.startOf("day").toUTC().toJSDate();
      }

      if (input.clearTime) {
        data.startTime = null;
        data.endTime = null;
      } else {
        const hasStart = input.startISO !== undefined;
        const hasEnd = input.endISO !== undefined;
        if (hasStart !== hasEnd) {
          return JSON.stringify({ error: "invalid_range", message: "Pass both startISO and endISO, or neither." });
        }
        if (hasStart && hasEnd) {
          const start = new Date(input.startISO as string);
          const end = new Date(input.endISO as string);
          if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
            return JSON.stringify({ error: "invalid_range", message: "endISO must be after startISO." });
          }
          data.startTime = start;
          data.endTime = end;
        }
      }

      // The day-key FOLLOWS the start time. An actionable is stored with both a
      // `date` (the day it belongs to, which the Blocks pane queries) and a
      // start/end (which the calendar grid places it by). Retiming one without
      // the other splits the item across two days: moved to Aug 7, it showed on
      // the Aug 7 calendar and stayed in the Aug 6 checklist. An explicit dayISO
      // still wins, for deliberately filing an item on another day.
      if (input.dayISO === undefined && data.startTime instanceof Date) {
        data.date = DateTime.fromJSDate(data.startTime)
          .setZone(OWNER_TIMEZONE)
          .startOf("day")
          .toUTC()
          .toJSDate();
      }

      if (Object.keys(data).length === 0) {
        return JSON.stringify({ error: "nothing_to_update", message: "Pass at least one field to change." });
      }
      const todo = await prisma.todo.update({ where: { id }, data });
      return JSON.stringify({
        ok: true,
        todoId: todo.id,
        title: todo.title,
        start: todo.startTime?.toISOString() ?? null,
        end: todo.endTime?.toISOString() ?? null,
      });
    },
  });
}

/// Remove an actionable — needed to clean up duplicates the agent itself made.
export function deleteActionableTool() {
  return betaTool({
    name: "delete_actionable",
    description:
      "Delete an actionable by id (get it from list_actionables). Confirm with the owner first, and prefer " +
      "update_actionable when the owner wants a change rather than a removal.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async ({ id }) => {
      const existing = await prisma.todo.findUnique({ where: { id: id as string } });
      if (!existing) return JSON.stringify({ error: "not_found", message: "No actionable with that id." });
      await prisma.todo.delete({ where: { id: id as string } });
      return JSON.stringify({ ok: true, deleted: existing.title });
    },
  });
}

// ---------------------------------------------------------------------------
// Recurring actionables. A recurring actionable is a TEMPLATE that seeds an
// ordinary actionable onto each of its due days (e.g. "pay rent, last day of
// every month"). The daily cron materializes occurrences; each seeded item then
// carries forward like any other actionable, so an unfinished one keeps nagging.
// Distinct from a recurring EVENT (which writes to a provider calendar) and from
// a recurring REMINDER (a one-off WhatsApp/SMS ping).
// ---------------------------------------------------------------------------

/// Create a recurring actionable from an iCal RRULE. The model already emits
/// RRULEs for events, so it can translate "end of every month" → the rule here.
export function createRecurringActionableTool() {
  return betaTool({
    name: "create_recurring_actionable",
    description:
      "Set up a RECURRING actionable — a to-do that reappears on its own schedule, e.g. 'pay rent on the last " +
      "day of every month'. Give a title and an iCal RRULE body (no 'RRULE:' prefix). Examples: last day of the " +
      "month = FREQ=MONTHLY;BYMONTHDAY=-1; the 1st of each month = FREQ=MONTHLY;BYMONTHDAY=1; every Monday = " +
      "FREQ=WEEKLY;BYDAY=MO; every weekday = FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR; daily = FREQ=DAILY; every two " +
      "weeks = FREQ=WEEKLY;INTERVAL=2. Add COUNT=n or UNTIL=YYYYMMDD to stop it. For an untimed checklist item " +
      "(the common case) omit startISO/endISO; pass both for a timed one and its time-of-day repeats each day. " +
      "This seeds today's occurrence immediately if today is a due day. Confirm the wording and cadence with the " +
      "owner first. To change the schedule, cancel and recreate; to change wording, edit the seeded actionable.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        rrule: { type: "string", description: "iCal RRULE body, e.g. FREQ=MONTHLY;BYMONTHDAY=-1." },
        startISO: { type: "string", description: "Optional: a timed start (ISO 8601). Its owner-local time-of-day repeats. Requires endISO." },
        endISO: { type: "string", description: "Optional: a timed end (ISO 8601), same day as startISO, after it. Requires startISO." },
        location: { type: "string", description: "In-person location." },
        videoLink: { type: "string", description: "Online meeting URL." },
        phone: { type: "string", description: "Phone number for a call." },
      },
      required: ["title", "rrule"],
    },
    run: async (input) => {
      // Optional timed occurrence: convert the representative instant to
      // minutes-past-owner-local-midnight, which repeats each due day. Validation
      // of the title, rule and range lives in the shared service.
      const hasStart = input.startISO !== undefined;
      const hasEnd = input.endISO !== undefined;
      let startMinutes: number | null = null;
      let endMinutes: number | null = null;
      if (hasStart && hasEnd) {
        const s = DateTime.fromISO(input.startISO as string).setZone(OWNER_TIMEZONE);
        const e = DateTime.fromISO(input.endISO as string).setZone(OWNER_TIMEZONE);
        if (!s.isValid || !e.isValid) {
          return JSON.stringify({ error: "invalid_range", message: "startISO/endISO are not valid instants." });
        }
        startMinutes = s.hour * 60 + s.minute;
        endMinutes = e.hour * 60 + e.minute;
      } else if (hasStart !== hasEnd) {
        return JSON.stringify({ error: "invalid_range", message: "Pass both startISO and endISO, or neither." });
      }

      const result = await createRecurringActionable({
        title: (input.title as string) ?? "",
        rrule: (input.rrule as string) ?? "",
        startMinutes,
        endMinutes,
        location: (input.location as string | undefined) ?? null,
        videoLink: (input.videoLink as string | undefined) ?? null,
        phone: (input.phone as string | undefined) ?? null,
      });
      if (!result.ok) return JSON.stringify({ error: result.error, message: result.message });

      return JSON.stringify({
        ok: true,
        recurringId: result.template.id,
        title: result.template.title,
        rrule: result.template.rrule,
        timed: startMinutes != null,
        seeded: result.seeded, // the upcoming actionable is already on its day
        nextOccurrence: result.nextOccurrence,
      });
    },
  });
}

/// List the owner's active recurring actionables with their ids and next due day.
export function listRecurringActionablesTool() {
  return betaTool({
    name: "list_recurring_actionables",
    description:
      "List the owner's recurring actionables (the schedules that seed repeating to-dos), with their ids, rule, " +
      "and next due date. Call this before cancelling one so you have its id.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: async () => {
      const templates = await prisma.recurringTodo.findMany({
        where: { active: true },
        orderBy: { createdAt: "asc" },
      });
      return JSON.stringify({
        recurring: templates.map((t) => {
          const anchor = DateTime.fromJSDate(t.createdAt).setZone(OWNER_TIMEZONE).startOf("day");
          const next = nextOccurrence(t.rrule, anchor);
          return {
            id: t.id,
            title: t.title,
            rrule: t.rrule,
            timed: t.startMinutes != null,
            nextOccurrence: next ? next.toISODate() : null,
          };
        }),
      });
    },
  });
}

/// Cancel a recurring actionable — stops seeding new days. Already-seeded to-dos
/// are left alone (the owner may still want to do them).
export function cancelRecurringActionableTool() {
  return betaTool({
    name: "cancel_recurring_actionable",
    description:
      "Stop a recurring actionable from seeding any more days (get its id from list_recurring_actionables). " +
      "Actionables it already created are left in place. Confirm with the owner first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async ({ id }) => {
      const existing = await prisma.recurringTodo.findUnique({ where: { id: id as string } });
      if (!existing) return JSON.stringify({ error: "not_found", message: "No recurring actionable with that id." });
      await prisma.recurringTodo.update({ where: { id: id as string }, data: { active: false } });
      return JSON.stringify({ ok: true, cancelled: existing.title });
    },
  });
}

// Resolve the calendar to WRITE a new item to: an explicitly named connected
// account (by email, e.g. from list_calendars), or the default destination when
// none is given. Returns the Account, or an error payload the tool returns
// verbatim. Lets the owner target any of their connected calendars.
async function resolveTargetAccount(
  email: unknown
): Promise<Account | { error: string; message: string }> {
  if (email && typeof email === "string") {
    const account = await prisma.account.findFirst({ where: { email } });
    if (!account) return { error: "unknown_account", message: `No connected account for ${email}.` };
    if (!account.refreshToken && !account.accessToken) {
      return { error: "account_not_connected", message: `${email} is not connected — reconnect it first.` };
    }
    return account;
  }
  const destination = await prisma.account.findFirst({ where: { isDestination: true } });
  if (!destination) return { error: "no_destination", message: "No destination account is configured." };
  if (!destination.refreshToken && !destination.accessToken) {
    return {
      error: "destination_not_connected",
      message: `Destination account ${destination.email} is not connected. Authorize it first.`,
    };
  }
  return destination;
}

// Resolve the connected account an event lives on (from its accountEmail, as
// surfaced by get_schedule), or an error payload the tool can return verbatim.
// Editing/deleting hits whichever account owns the event — not necessarily the
// destination account — so update_event/delete_event resolve by email here.
async function resolveOwningAccount(
  email: unknown
): Promise<Account | { error: string; message: string }> {
  if (!email || typeof email !== "string") {
    return { error: "missing_account", message: "accountEmail is required (get it from get_schedule)." };
  }
  const account = await prisma.account.findFirst({ where: { email } });
  if (!account) return { error: "unknown_account", message: `No connected account for ${email}.` };
  if (!account.refreshToken && !account.accessToken) {
    return { error: "account_not_connected", message: `${email} is not connected — reconnect it to change its events.` };
  }
  return account;
}

export function updateEventTool() {
  return betaTool({
    name: "update_event",
    description:
      "Edit an existing real calendar event — change its time, title, location, or description. " +
      "Get the event's id and accountEmail from get_schedule first, and confirm the change with the owner " +
      "before calling. To RESCHEDULE/move an event, use this tool with the new startISO and endISO — do " +
      "NOT create a duplicate with create_event. Only the fields you pass are changed; others are left as-is.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Provider event id (from get_schedule)." },
        accountEmail: { type: "string", description: "Email of the account the event lives on (from get_schedule)." },
        title: { type: "string" },
        startISO: { type: "string", description: "New start, ISO 8601 UTC. If set, endISO is required too." },
        endISO: { type: "string", description: "New end, ISO 8601 UTC. If set, startISO is required too." },
        location: { type: "string" },
        description: { type: "string" },
        notify: { type: "boolean", description: "Email guests about the change. Default false." },
      },
      required: ["id", "accountEmail"],
    },
    run: async (input) => {
      const account = await resolveOwningAccount(input.accountEmail);
      if ("error" in account) return JSON.stringify(account);

      // Time must move as a pair so we can validate the range; a lone start or
      // end can't be checked against the untouched other side.
      const hasStart = input.startISO !== undefined;
      const hasEnd = input.endISO !== undefined;
      if (hasStart !== hasEnd) {
        return JSON.stringify({ error: "invalid_range", message: "Pass both startISO and endISO to change the time." });
      }
      let start: Date | undefined;
      let end: Date | undefined;
      if (hasStart && hasEnd) {
        start = new Date(input.startISO as string);
        end = new Date(input.endISO as string);
        if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
          return JSON.stringify({ error: "invalid_range", message: "endISO must be after startISO." });
        }
      }

      const draft = {
        ...(input.title !== undefined ? { title: (input.title as string).trim() } : {}),
        ...(input.description !== undefined ? { description: (input.description as string).trim() } : {}),
        ...(input.location !== undefined ? { location: (input.location as string).trim() } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
      };
      if (Object.keys(draft).length === 0) {
        return JSON.stringify({ error: "nothing_to_update", message: "No fields to change were provided." });
      }

      try {
        await updateDestinationEvent(account, input.id as string, draft, { notify: input.notify === true });
        return JSON.stringify({
          ok: true,
          id: input.id,
          ...(start ? { start: start.toISOString() } : {}),
          ...(end ? { end: end.toISOString() } : {}),
        });
      } catch (err) {
        return JSON.stringify({ error: "event_update_failed", message: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  });
}

export function deleteEventTool() {
  return betaTool({
    name: "delete_event",
    description:
      "Delete an existing real calendar event. Get the event's id and accountEmail from get_schedule first. " +
      "This is destructive and cannot be undone — ALWAYS confirm with the owner first, stating the event's " +
      "title and time, and only call after he explicitly says yes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Provider event id (from get_schedule)." },
        accountEmail: { type: "string", description: "Email of the account the event lives on (from get_schedule)." },
        notify: { type: "boolean", description: "Email guests about the cancellation. Default false." },
      },
      required: ["id", "accountEmail"],
    },
    run: async (input) => {
      const account = await resolveOwningAccount(input.accountEmail);
      if ("error" in account) return JSON.stringify(account);
      try {
        await deleteDestinationEvent(account, input.id as string, { notify: input.notify === true, throwOnError: true });
        return JSON.stringify({ ok: true, deleted: input.id });
      } catch (err) {
        return JSON.stringify({ error: "event_delete_failed", message: err instanceof Error ? err.message : "Unknown error" });
      }
    },
  });
}

export function listPersonalBlocksTool() {
  return betaTool({
    name: "list_personal_blocks",
    description: "List the owner's reserved-time blocks (id, title, time, recurrence).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: async () => {
      const blocks = await prisma.personalBlock.findMany({ orderBy: { startTime: "asc" } });
      return JSON.stringify({
        blocks: blocks.map((b) => ({
          id: b.id,
          title: b.title,
          start: b.startTime.toISOString(),
          end: b.endTime.toISOString(),
          timezone: b.timezone,
          recurrenceRule: b.recurrenceRule,
        })),
      });
    },
  });
}

export function createPersonalBlockTool() {
  return betaTool({
    name: "create_personal_block",
    description:
      "Reserve BLOCKED/HOLD time on the owner's calendar (sleep, gym, deep work…) — use ONLY when the owner " +
      "explicitly asks to block off, reserve, or hold time. For ordinary scheduling requests, use " +
      "create_event instead (that's the default). Times are UTC ISO; provide the block's IANA timezone " +
      "and an optional iCal RRULE body (e.g. FREQ=DAILY).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        startISO: { type: "string" },
        endISO: { type: "string" },
        timezone: { type: "string", description: "IANA timezone the block is authored in." },
        recurrenceRule: { type: "string", description: "iCal RRULE body, or omit for a one-off." },
      },
      required: ["title", "startISO", "endISO", "timezone"],
    },
    run: async (input) => {
      const tz = input.timezone as string;
      if (!isValidTimezone(tz)) return JSON.stringify({ error: "invalid_timezone", message: `Unknown timezone: ${tz}` });
      const start = new Date(input.startISO as string);
      const end = new Date(input.endISO as string);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
        return JSON.stringify({ error: "invalid_range" });
      }
      const block = await prisma.personalBlock.create({
        data: {
          title: (input.title as string).trim(),
          startTime: start,
          endTime: end,
          timezone: tz,
          recurrenceRule: (input.recurrenceRule as string | undefined)?.trim() || null,
        },
      });
      return JSON.stringify({ ok: true, blockId: block.id });
    },
  });
}

export function deletePersonalBlockTool() {
  return betaTool({
    name: "delete_personal_block",
    description: "Delete a reserved-time block by id (get the id from list_personal_blocks first).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async ({ id }) => {
      try {
        await prisma.personalBlock.delete({ where: { id: id as string } });
        return JSON.stringify({ ok: true });
      } catch {
        return JSON.stringify({ error: "not_found" });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// To-do lists under an actionable (replaced event follow-ups, 2026-09-24).
// A list-shaped request ("for the Keith meeting: send the links, remove
// Stephanie from Salesforce") is ONE actionable with items, never one
// actionable per line. Progress ("1 of 3") is derived; finishing every item
// does not complete the actionable.
// ---------------------------------------------------------------------------

async function ownedTodo(actionableId: unknown): Promise<{ id: string } | { error: string; message: string }> {
  if (typeof actionableId !== "string" || !actionableId) {
    return { error: "missing_actionable", message: "actionableId is required (from list_actionables)." };
  }
  const todo = await prisma.todo.findUnique({ where: { id: actionableId }, select: { id: true } });
  return todo ?? { error: "not_found", message: "No actionable with that id." };
}

export function addTodoItemsTool() {
  return betaTool({
    name: "add_todo_items",
    description:
      "Append items to an actionable's to-do list. Get the actionable's id from list_actionables (or from " +
      "create_actionable's result). Pass the items as short imperative titles, in order. Items render as " +
      "markdown: write a link as [label](https://…), never a bare URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        actionableId: { type: "string" },
        titles: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      required: ["actionableId", "titles"],
    },
    run: async (input) => {
      const owner = await ownedTodo(input.actionableId);
      if ("error" in owner) return JSON.stringify(owner);
      const titles = Array.isArray(input.titles) ? (input.titles as unknown[]).filter((t): t is string => typeof t === "string") : [];
      const existing = await prisma.todoItem.findMany({ where: { todoId: owner.id }, orderBy: { sortOrder: "desc" }, take: 1 });
      const base = (existing[0]?.sortOrder ?? -1) + 1;
      const { create } = diffItems([], titles.map((title) => ({ title })));
      if (create.length === 0) return JSON.stringify({ error: "missing_titles", message: "At least one non-empty title is required." });
      await prisma.todoItem.createMany({ data: create.map((c) => ({ ...c, sortOrder: base + c.sortOrder, todoId: owner.id })) });
      const items = await prisma.todoItem.findMany({ where: { todoId: owner.id }, orderBy: { sortOrder: "asc" } });
      return JSON.stringify({ ok: true, actionableId: owner.id, items: items.map((i) => ({ id: i.id, title: i.title, done: i.done })), progress: progress(items) });
    },
  });
}

export function setTodoItemDoneTool() {
  return betaTool({
    name: "set_todo_item_done",
    description:
      "Check off (or reopen) one item of an actionable's to-do list. When the owner says they finished " +
      "something that matches an item, mark the ITEM, not the whole actionable. Get ids from list_actionables.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        actionableId: { type: "string" },
        itemId: { type: "string" },
        done: { type: "boolean", description: "Defaults to true." },
      },
      required: ["actionableId", "itemId"],
    },
    run: async (input) => {
      const owner = await ownedTodo(input.actionableId);
      if ("error" in owner) return JSON.stringify(owner);
      const done = input.done === undefined ? true : !!input.done;
      const r = await prisma.todoItem.updateMany({ where: { id: input.itemId as string, todoId: owner.id }, data: { done } });
      if (r.count === 0) return JSON.stringify({ error: "not_found", message: "No such item on that actionable." });
      const items = await prisma.todoItem.findMany({ where: { todoId: owner.id }, orderBy: { sortOrder: "asc" } });
      return JSON.stringify({ ok: true, progress: progress(items) });
    },
  });
}

export function removeTodoItemTool() {
  return betaTool({
    name: "remove_todo_item",
    description: "Remove one item from an actionable's to-do list. Get ids from list_actionables. Confirm first.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { actionableId: { type: "string" }, itemId: { type: "string" } },
      required: ["actionableId", "itemId"],
    },
    run: async (input) => {
      const owner = await ownedTodo(input.actionableId);
      if ("error" in owner) return JSON.stringify(owner);
      const r = await prisma.todoItem.deleteMany({ where: { id: input.itemId as string, todoId: owner.id } });
      if (r.count === 0) return JSON.stringify({ error: "not_found", message: "No such item on that actionable." });
      return JSON.stringify({ ok: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Proactive reminders — set/list/cancel timed nudges the app sends to the owner
// over WhatsApp/SMS. Private only.
// ---------------------------------------------------------------------------
export function setReminderTool() {
  return betaTool({
    name: "set_reminder",
    description:
      "Schedule a proactive reminder that the app will send to the owner (WhatsApp/SMS) at a specific time. " +
      "Use for requests like 'remind me at 12:15 for X'. Convert the requested time to a UTC ISO instant in " +
      "the owner's timezone. Put the full reminder text (including the event's time + details) in `message` so it " +
      "reads well on its own. For a repeat, pass an iCal RRULE body in `recurrenceRule` (e.g. 'FREQ=DAILY'). " +
      "To keep details fresh, link an event from get_schedule via `event` (use a real event's id+account, or a " +
      "booking's id) and `eventDateISO` (that event's day).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        fireAtISO: { type: "string" },
        message: { type: "string" },
        recurrenceRule: { type: "string" },
        event: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", enum: ["event", "booking"] },
            id: { type: "string" },
            account: { type: "string" },
          },
          required: ["kind", "id"],
        },
        eventDateISO: { type: "string" },
      },
      required: ["fireAtISO", "message"],
    },
    run: async (input) => {
      const i = input as {
        fireAtISO: string; message: string; recurrenceRule?: string;
        event?: { kind: "event" | "booking"; id: string; account?: string }; eventDateISO?: string;
      };
      const res = await createNudge({
        fireAtISO: i.fireAtISO,
        message: i.message,
        recurrenceRule: i.recurrenceRule ?? null,
        event: i.event ?? null,
        eventDateISO: i.eventDateISO ?? null,
      });
      return JSON.stringify(res);
    },
  });
}

export function listRemindersTool() {
  return betaTool({
    name: "list_reminders",
    description: "List the owner's upcoming proactive reminders (id, when, text, whether it repeats).",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: async () => JSON.stringify({ reminders: await listUpcomingNudges() }),
  });
}

export function cancelReminderTool() {
  return betaTool({
    name: "cancel_reminder",
    description: "Cancel an upcoming reminder by its id (from list_reminders).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async (input) => JSON.stringify(await cancelNudge((input as { id: string }).id)),
  });
}
