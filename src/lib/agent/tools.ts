import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { DateTime } from "luxon";
import { CreatedVia, type Account } from "@prisma/client";
import { prisma } from "@/lib/db";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { getAvailability } from "@/lib/availability/service";
import { getScheduleView } from "@/lib/schedule/service";
import { createBooking, cancelBooking, BookingError, rescheduleBooking } from "@/lib/booking/service";
import { createDestinationEvent, updateDestinationEvent, deleteDestinationEvent } from "@/lib/calendar/write";
import { isValidTimezone } from "@/lib/validation";
import { followupKey } from "@/lib/followups/key";
import { createNudge, listUpcomingNudges, cancelNudge } from "@/lib/nudge/service";
import { runFindMutualTimes, type FindMutualTimesArgs } from "./mutualSlots";

// ---------------------------------------------------------------------------
// Shared read tool — free/busy ONLY. Safe for the public agent: never returns
// event titles, attendees, or which account an interval belongs to.
// ---------------------------------------------------------------------------
export function getAvailabilityTool() {
  return betaTool({
    name: "get_availability",
    description:
      "Get the owner's free booking slots. Pass the window the visitor asked for; the whole day is searched " +
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

      const { slots, warnings } = await getAvailability({
        requestedStart: dayStart.toUTC().toJSDate(),
        requestedEnd: dayEnd.toUTC().toJSDate(),
        durationMinutes: durationMinutes as number | undefined,
      });

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

export function createPublicBookingTool(fence: PublicBookingFence) {
  return betaTool({
    name: "create_public_booking",
    description:
      "Book a meeting with the owner for the visitor you are talking to. The meeting " +
      "length is whatever the start/end you pass spans — use the slot the visitor " +
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
      "connected calendar, pass accountEmail (get the options from list_calendars).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        startISO: { type: "string", description: "Event start (first occurrence), ISO 8601 UTC." },
        endISO: { type: "string", description: "Event end (first occurrence), ISO 8601 UTC." },
        addVideoLink: {
          type: "boolean",
          description:
            "Create a real video-call link for this event (Google Meet, or Teams on a Microsoft account). " +
            "Defaults to TRUE — anything with other people on it needs a way to join. Pass false for a solo " +
            "hold, focus time, or a reminder to yourself, where a meeting room would be noise.",
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
      const account = await resolveTargetAccount(input.accountEmail);
      if ("error" in account) return JSON.stringify(account);
      try {
        const created = await createDestinationEvent(account, {
          title: (input.title as string).trim(),
          start,
          end,
          description: (input.description as string | undefined)?.trim() || undefined,
          location: (input.location as string | undefined)?.trim() || undefined,
          recurrenceRule,
          timezone,
          conference: input.addVideoLink !== false,
        });
        return JSON.stringify({
          ok: true,
          eventId: created.id,
          // Null when the provider declined or the account cannot host one —
          // say so rather than implying a link exists.
          videoLink: created.videoLink ?? null,
          account: account.email,
          recurring: !!recurrenceRule,
          start: start.toISOString(),
          end: end.toISOString(),
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
      },
      required: ["title", "dayISO"],
    },
    run: async (input) => {
      const title = (input.title as string)?.trim();
      if (!title) return JSON.stringify({ error: "missing_title", message: "A title is required." });

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
        },
      });

      return JSON.stringify({ ok: true, todoId: todo.id, timed: !!(start && end) });
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
// Follow-up actionables attached to a specific event OCCURRENCE. These are the
// same rows the modal/agenda show — keyed by "event:<providerId>:<startISO>"
// via followupKey. The agent identifies the occurrence with the id + start it
// got from get_schedule; the tools build the key so the agent never has to.
// ---------------------------------------------------------------------------

// Resolve the occurrence key from a get_schedule (eventId, startISO) pair, or an
// error payload the tool can return verbatim.
function resolveFollowupKey(eventId: unknown, startISO: unknown): string | { error: string; message: string } {
  if (!eventId || typeof eventId !== "string") {
    return { error: "missing_event", message: "eventId is required (get it from get_schedule)." };
  }
  if (!startISO || typeof startISO !== "string") {
    return { error: "missing_start", message: "startISO is required (the occurrence start, from get_schedule)." };
  }
  const start = new Date(startISO);
  if (isNaN(start.getTime())) return { error: "invalid_start", message: "startISO is not a valid date." };
  return followupKey(eventId, start);
}

export function listFollowupsTool() {
  return betaTool({
    name: "list_followups",
    description:
      "List the follow-up action items attached to a specific event occurrence. Get the event's id and " +
      "start from get_schedule first, then pass them here. Returns each follow-up's id, title, and done state.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        eventId: { type: "string", description: "Provider event id (from get_schedule)." },
        startISO: { type: "string", description: "The occurrence's start time, ISO 8601 UTC (from get_schedule)." },
      },
      required: ["eventId", "startISO"],
    },
    run: async (input) => {
      const key = resolveFollowupKey(input.eventId, input.startISO);
      if (typeof key !== "string") return JSON.stringify(key);
      const followups = await prisma.eventFollowup.findMany({
        where: { eventKey: key },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });
      return JSON.stringify({ followups: followups.map((f) => ({ id: f.id, title: f.title, done: f.done })) });
    },
  });
}

export function addFollowupTool() {
  return betaTool({
    name: "add_followup",
    description:
      "Attach a follow-up action item to a specific event occurrence (e.g. 'email the notes', 'send the deck', " +
      "'book a follow-up call'). Get the event's id and start from get_schedule first. Confirm the item with " +
      "the owner before calling.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        eventId: { type: "string", description: "Provider event id (from get_schedule)." },
        startISO: { type: "string", description: "The occurrence's start time, ISO 8601 UTC (from get_schedule)." },
        title: {
          type: "string",
          description:
            "The follow-up action item text. Titles render as markdown, so wrap any URL in a short " +
            "markdown link like [notes](https://…) or [spreadsheet](https://…) rather than pasting the " +
            "raw link — pick a concise label from context (the doc's purpose or its title). Never put a " +
            "bare URL in the title.",
        },
      },
      required: ["eventId", "startISO", "title"],
    },
    run: async (input) => {
      const key = resolveFollowupKey(input.eventId, input.startISO);
      if (typeof key !== "string") return JSON.stringify(key);
      const title = (input.title as string).trim();
      if (!title) return JSON.stringify({ error: "empty_title", message: "The follow-up needs a title." });
      const last = await prisma.eventFollowup.findFirst({
        where: { eventKey: key },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      const followup = await prisma.eventFollowup.create({
        data: { eventKey: key, title, sortOrder: (last?.sortOrder ?? -1) + 1 },
      });
      return JSON.stringify({ ok: true, id: followup.id, title: followup.title });
    },
  });
}

export function completeFollowupTool() {
  return betaTool({
    name: "complete_followup",
    description:
      "Mark a follow-up action item done (or reopen it). Get its id from list_followups first. " +
      "Pass done: false to reopen a completed item.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Follow-up id (from list_followups)." },
        done: { type: "boolean", description: "true to mark done, false to reopen. Defaults to true." },
      },
      required: ["id"],
    },
    run: async (input) => {
      const done = input.done === undefined ? true : input.done === true;
      try {
        await prisma.eventFollowup.update({ where: { id: input.id as string }, data: { done } });
        return JSON.stringify({ ok: true, id: input.id, done });
      } catch {
        return JSON.stringify({ error: "not_found" });
      }
    },
  });
}

export function deleteFollowupTool() {
  return betaTool({
    name: "delete_followup",
    description: "Delete a follow-up action item by id (get the id from list_followups first).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    run: async ({ id }) => {
      try {
        await prisma.eventFollowup.delete({ where: { id: id as string } });
        return JSON.stringify({ ok: true });
      } catch {
        return JSON.stringify({ error: "not_found" });
      }
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
