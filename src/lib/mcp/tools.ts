import { CreatedVia } from "@prisma/client";
import { prisma } from "@/lib/db";
import { diffItems, parseIncomingItems, NOTES_MAX } from "@/lib/todos/items";
import { applyTodoUpdate, deleteTodo, listTodosBetween, todoDay, type TodoUpdateData, type TodoWithItems } from "@/lib/todos/service";
import { shiftToDay } from "@/lib/todos/carryForward";
import { createEventOnce } from "@/lib/calendar/createOnce";
import { getAvailability } from "@/lib/availability/service";
import { computeMutualSlots } from "@/lib/agent/mutualSlots";
import { createBooking, BookingError } from "@/lib/booking/service";
import { getScheduleView } from "@/lib/schedule/service";
import { createDestinationEvent, updateDestinationEvent, deleteDestinationEvent } from "@/lib/calendar/write";
import { createNudge } from "@/lib/nudge/service";
import { isValidTimezone } from "@/lib/validation";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { DateTime } from "luxon";

/// A tool exposed over MCP. `tier` decides who may call it: "public" tools are
/// reachable by any agent (they never reveal calendar detail), "private" tools
/// require the bearer token and can read and mutate the real calendar.
export interface McpTool {
  name: string;
  tier: "public" | "private";
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const iso = (d: Date) => d.toISOString();
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

function parseDate(v: unknown, field: string): Date {
  const d = new Date(String(v));
  if (isNaN(d.getTime())) throw new Error(`${field} must be an ISO 8601 date-time`);
  return d;
}

// ---------------------------------------------------------------------------
// PUBLIC tier — the same posture as the public booking page and
// /api/agent/negotiate: free/busy only. These must never return event titles,
// attendees, or anything about WHO the owner is meeting.
// ---------------------------------------------------------------------------

const getAvailabilityTool: McpTool = {
  name: "get_availability",
  tier: "public",
  description:
    "List the owner's free, bookable meeting slots in a date range. Returns only start/end times in UTC — never event details, titles, or attendees.",
  inputSchema: {
    type: "object",
    properties: {
      startISO: { type: "string", description: "Range start, ISO 8601 UTC." },
      endISO: { type: "string", description: "Range end, ISO 8601 UTC." },
      durationMinutes: { type: "number", description: "Meeting length; defaults to the owner's configured duration." },
    },
    required: ["startISO", "endISO"],
  },
  run: async (a) => {
    const { slots, warnings } = await getAvailability({
      requestedStart: parseDate(a.startISO, "startISO"),
      requestedEnd: parseDate(a.endISO, "endISO"),
      durationMinutes: typeof a.durationMinutes === "number" ? a.durationMinutes : undefined,
    });
    return {
      slots: slots.map((s) => ({ start: iso(s.start), end: iso(s.end) })),
      timezone: OWNER_TIMEZONE,
      warnings: warnings.length,
    };
  },
};

const findMutualTimesTool: McpTool = {
  name: "find_mutual_times",
  tier: "public",
  description:
    "Given the requester's own free windows, return slots where BOTH the requester and the owner are free. Use this to agree a meeting time agent-to-agent, then book it with create_booking.",
  inputSchema: {
    type: "object",
    properties: {
      startISO: { type: "string", description: "Search window start, ISO 8601 UTC." },
      endISO: { type: "string", description: "Search window end, ISO 8601 UTC." },
      durationMinutes: { type: "number", description: "Meeting length in minutes." },
      requesterFree: {
        type: "array",
        description: "The requester's own free windows (UTC).",
        items: {
          type: "object",
          properties: { start: { type: "string" }, end: { type: "string" } },
          required: ["start", "end"],
        },
      },
    },
    required: ["startISO", "endISO", "requesterFree"],
  },
  run: async (a) => {
    const windows = Array.isArray(a.requesterFree) ? a.requesterFree : [];
    const requesterFree = windows.map((w) => {
      const o = w as { start?: unknown; end?: unknown };
      return { start: parseDate(o.start, "requesterFree[].start"), end: parseDate(o.end, "requesterFree[].end") };
    });
    const { mutualSlots, warnings } = await computeMutualSlots({
      windowStart: parseDate(a.startISO, "startISO"),
      windowEnd: parseDate(a.endISO, "endISO"),
      durationMinutes: typeof a.durationMinutes === "number" ? a.durationMinutes : 30,
      requesterFree,
    });
    return {
      mutualSlots: mutualSlots.map((s) => ({ start: iso(s.start), end: iso(s.end) })),
      timezone: OWNER_TIMEZONE,
      warnings: warnings.length,
    };
  },
};

const createBookingTool: McpTool = {
  name: "create_booking",
  tier: "public",
  description:
    "Book a meeting with the owner in a slot returned by get_availability or find_mutual_times. The slot is re-validated server-side; a taken slot is rejected. Only call after the person you represent has explicitly confirmed the time.",
  inputSchema: {
    type: "object",
    properties: {
      startISO: { type: "string", description: "Slot start, ISO 8601 UTC." },
      endISO: { type: "string", description: "Slot end, ISO 8601 UTC." },
      attendeeName: { type: "string" },
      attendeeEmail: { type: "string" },
      attendeeTimezone: { type: "string", description: "IANA timezone, e.g. America/New_York." },
      title: { type: "string", description: "Optional meeting title." },
    },
    required: ["startISO", "endISO", "attendeeName", "attendeeEmail", "attendeeTimezone"],
  },
  run: async (a) => {
    const tz = str(a.attendeeTimezone);
    if (!tz || !isValidTimezone(tz)) throw new Error("attendeeTimezone must be a valid IANA timezone");
    const email = str(a.attendeeEmail);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("attendeeEmail must be a valid email");
    const name = str(a.attendeeName);
    if (!name) throw new Error("attendeeName is required");
    try {
      const booking = await createBooking({
        title: str(a.title),
        start: parseDate(a.startISO, "startISO"),
        end: parseDate(a.endISO, "endISO"),
        attendeeName: name,
        attendeeEmail: email,
        attendeeTimezone: tz,
        createdVia: CreatedVia.public_agent,
      });
      return { ok: true, bookingId: booking.id, start: iso(booking.startTime), end: iso(booking.endTime) };
    } catch (err) {
      if (err instanceof BookingError) throw new Error(`${err.code}: ${err.message}`);
      throw err;
    }
  },
};

// ---------------------------------------------------------------------------
// PRIVATE tier — full calendar read/write. Bearer-token gated at the route.
// ---------------------------------------------------------------------------

const getScheduleTool: McpTool = {
  name: "get_schedule",
  tier: "private",
  description:
    "Read the owner's full schedule for a range: real calendar events (with titles and attendees), reserved blocks, bookings, birthdays and every actionable on the days overlapping the range, timed or not (start/end null when untimed; endISO exclusive). Actionable ids feed update_actionable and delete_actionable.",
  inputSchema: {
    type: "object",
    properties: {
      startISO: { type: "string" },
      endISO: { type: "string" },
    },
    required: ["startISO", "endISO"],
  },
  run: async (a) => {
    const start = parseDate(a.startISO, "startISO"), end = parseDate(a.endISO, "endISO");
    // Actionables come from the todo service, not the view: the view carries
    // only TIMED ones (it places them on the grid), which hid every untimed
    // actionable from MCP and left callers re-creating what already existed.
    const [view, todos] = await Promise.all([getScheduleView(start, end), listTodosBetween(start, end)]);
    return {
      events: view.events.map((e) => ({
        id: e.id, account: e.accountEmail, title: e.title,
        start: iso(e.start), end: iso(e.end), allDay: e.allDay, location: e.location,
      })),
      blocks: view.blocks.map((b) => ({ id: b.id, title: b.title, start: iso(b.start), end: iso(b.end) })),
      bookings: view.bookings.map((b) => ({
        id: b.id, title: b.title, start: iso(b.start), end: iso(b.end), attendee: b.attendeeName,
      })),
      actionables: todos.map(actionableOut),
      timezone: OWNER_TIMEZONE,
      warnings: view.warnings,
    };
  },
};

const listCalendarsTool: McpTool = {
  name: "list_calendars",
  tier: "private",
  description: "List the owner's connected calendars (accounts) that events can be written to.",
  inputSchema: { type: "object", properties: {} },
  run: async () => {
    const accounts = await prisma.account.findMany({ orderBy: [{ isDestination: "desc" }, { email: "asc" }] });
    return {
      calendars: accounts.map((c) => ({
        email: c.email, name: c.displayName ?? c.email, provider: c.provider,
        isDefault: c.isDestination, connected: !!(c.refreshToken || c.accessToken),
      })),
    };
  },
};

async function resolveTarget(email: unknown) {
  const wanted = str(email);
  const account = wanted
    ? await prisma.account.findFirst({ where: { email: wanted } })
    : await prisma.account.findFirst({ where: { isDestination: true } });
  if (!account) throw new Error(wanted ? `No connected account for ${wanted}` : "No destination account configured");
  if (!account.refreshToken && !account.accessToken) throw new Error(`${account.email} is not connected`);
  return account;
}

const createEventTool: McpTool = {
  name: "create_event",
  tier: "private",
  description:
    "Create a real calendar event on one of the owner's connected calendars. Pass accountEmail (from list_calendars) to choose a specific calendar; omit for the default.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      startISO: { type: "string" },
      endISO: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      accountEmail: { type: "string" },
    },
    required: ["title", "startISO", "endISO"],
  },
  run: async (a) => {
    const start = parseDate(a.startISO, "startISO");
    const end = parseDate(a.endISO, "endISO");
    if (end <= start) throw new Error("endISO must be after startISO");
    const title = str(a.title);
    if (!title) throw new Error("title is required");
    const account = await resolveTarget(a.accountEmail);
    // Written at most once (same title, time and calendar): see createEventOnce.
    const created = await createEventOnce(account, {
      title, start, end, description: str(a.description), location: str(a.location),
      conference: a.addVideoLink !== false,
    });
    if (!created) throw new Error("The calendar write failed. Nothing was created.");
    return { ok: true, eventId: created.eventId, videoLink: created.videoLink, account: account.email, ...(created.duplicate ? { duplicate: true } : {}) };
  },
};

const updateEventTool: McpTool = {
  name: "update_event",
  tier: "private",
  description: "Edit an existing calendar event (time, title, location, description). Get id and accountEmail from get_schedule.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" }, accountEmail: { type: "string" },
      title: { type: "string" }, startISO: { type: "string" }, endISO: { type: "string" },
      location: { type: "string" }, description: { type: "string" },
    },
    required: ["id", "accountEmail"],
  },
  run: async (a) => {
    const account = await resolveTarget(a.accountEmail);
    const hasStart = a.startISO !== undefined, hasEnd = a.endISO !== undefined;
    if (hasStart !== hasEnd) throw new Error("pass both startISO and endISO to change the time");
    const draft: Record<string, unknown> = {};
    if (str(a.title)) draft.title = str(a.title);
    if (a.location !== undefined) draft.location = str(a.location) ?? "";
    if (a.description !== undefined) draft.description = str(a.description) ?? "";
    if (hasStart && hasEnd) {
      const start = parseDate(a.startISO, "startISO"), end = parseDate(a.endISO, "endISO");
      if (end <= start) throw new Error("endISO must be after startISO");
      draft.start = start; draft.end = end;
    }
    if (Object.keys(draft).length === 0) throw new Error("no fields to update");
    await updateDestinationEvent(account, String(a.id), draft, { notify: a.notify === true });
    return { ok: true, id: a.id };
  },
};

const deleteEventTool: McpTool = {
  name: "delete_event",
  tier: "private",
  description: "Delete a calendar event. Destructive and irreversible — confirm with the owner before calling.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, accountEmail: { type: "string" }, notify: { type: "boolean" } },
    required: ["id", "accountEmail"],
  },
  run: async (a) => {
    const account = await resolveTarget(a.accountEmail);
    await deleteDestinationEvent(account, String(a.id), { notify: a.notify === true, throwOnError: true });
    return { ok: true, id: a.id };
  },
};

const createBlockTool: McpTool = {
  name: "create_personal_block",
  tier: "private",
  description:
    "Reserve time on the owner's calendar so it cannot be booked (e.g. focus time, a weekend away). Supports multi-day spans and iCal recurrence.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      startISO: { type: "string" },
      endISO: { type: "string" },
      recurrenceRule: { type: "string", description: "iCal RRULE body, e.g. FREQ=WEEKLY;BYDAY=SA,SU. Omit for one-off." },
    },
    required: ["title", "startISO", "endISO"],
  },
  run: async (a) => {
    const title = str(a.title);
    if (!title) throw new Error("title is required");
    const startTime = parseDate(a.startISO, "startISO"), endTime = parseDate(a.endISO, "endISO");
    if (endTime <= startTime) throw new Error("endISO must be after startISO");
    const block = await prisma.personalBlock.create({
      data: { title, startTime, endTime, timezone: OWNER_TIMEZONE, recurrenceRule: str(a.recurrenceRule) ?? null },
    });
    return { ok: true, blockId: block.id };
  },
};

const createActionableTool: McpTool = {
  name: "create_actionable",
  tier: "private",
  description:
    "Create an actionable — a day-scoped to-do that shows on the owner's calendar as its own kind (not an event). Pass startISO/endISO for a timed item, or omit both for an untimed one.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      dayISO: { type: "string", description: "Any instant on the target day; read in the owner's timezone." },
      startISO: { type: "string" },
      endISO: { type: "string" },
      items: {
        type: "array",
        items: { type: "string" },
        description: "Optional to-do list under the actionable, in order (one actionable with items, not one per line).",
      },
      notes: {
        type: "string",
        description: "Free-text context, e.g. a link back to the thread this came from. Rendered with links clickable. Not a task.",
      },
    },
    required: ["title", "dayISO"],
  },
  run: async (a) => {
    const title = str(a.title);
    if (!title) throw new Error("title is required");
    const day = DateTime.fromISO(String(a.dayISO), { zone: OWNER_TIMEZONE });
    if (!day.isValid) throw new Error("dayISO is not a valid date");
    const dayKey = day.startOf("day").toUTC().toJSDate();
    const hasStart = a.startISO !== undefined, hasEnd = a.endISO !== undefined;
    if (hasStart !== hasEnd) throw new Error("pass both startISO and endISO, or neither");
    let startTime: Date | null = null, endTime: Date | null = null;
    if (hasStart && hasEnd) {
      startTime = parseDate(a.startISO, "startISO");
      endTime = parseDate(a.endISO, "endISO");
      if (endTime <= startTime) throw new Error("endISO must be after startISO");
    }
    const last = await prisma.todo.findFirst({ where: { date: dayKey }, orderBy: { sortOrder: "desc" } });
    const itemTitles = Array.isArray(a.items) ? (a.items as unknown[]).filter((t): t is string => typeof t === "string") : [];
    const { create: items } = diffItems([], itemTitles.map((t) => ({ title: t })));
    const todo = await prisma.todo.create({
      data: {
        title,
        date: dayKey,
        startTime,
        endTime,
        notes: (typeof a.notes === "string" ? a.notes.trim().slice(0, NOTES_MAX) : "") || null,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        items: { create: items },
      },
    });
    return { ok: true, todoId: todo.id, timed: !!(startTime && endTime), items: items.length };
  },
};

/// One shape for every actionable the server hands back, so an agent can read
/// a list, edit, and read the result the same way. `day` is the owner-local
/// calendar day; start/end are null for an untimed actionable.
function actionableOut(t: TodoWithItems) {
  return {
    id: t.id,
    title: t.title,
    day: todoDay(t.date),
    start: t.startTime ? iso(t.startTime) : null,
    end: t.endTime ? iso(t.endTime) : null,
    done: t.done,
    recurring: !!t.recurringTodoId,
    items: t.items.map((i) => ({ id: i.id, title: i.title, done: i.done })),
    notes: t.notes,
  };
}

/// Widest range list_actionables will answer: every row carries its items, so
/// an open-ended range is a slow, oversized reply, never a useful one.
const LIST_RANGE_MAX_DAYS = 366;

const bool = (v: unknown, field: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new Error(`${field} must be true or false`);
  return v;
};

const listActionablesTool: McpTool = {
  name: "list_actionables",
  tier: "private",
  description:
    "List every actionable (timed and untimed) on the days overlapping a range, with ids, done state, to-do items (each with its own id and done state) and notes. Call this before create_actionable so an existing one is updated, not duplicated.",
  inputSchema: {
    type: "object",
    properties: {
      startISO: { type: "string", description: "Range start, ISO 8601. The owner-local day it falls on is included." },
      endISO: { type: "string", description: "Range end, ISO 8601, EXCLUSIVE: a day beginning at or after it is left out. To include a whole last day pass the following midnight in the owner's timezone, or late that evening. At most 366 days." },
    },
    required: ["startISO", "endISO"],
  },
  run: async (a) => {
    const start = parseDate(a.startISO, "startISO"), end = parseDate(a.endISO, "endISO");
    if (end < start) throw new Error("endISO must not be before startISO");
    if (end.getTime() - start.getTime() > LIST_RANGE_MAX_DAYS * 86_400_000) {
      throw new Error(`range is wider than ${LIST_RANGE_MAX_DAYS} days; ask for a narrower window`);
    }
    const todos = await listTodosBetween(start, end);
    return { actionables: todos.map(actionableOut), timezone: OWNER_TIMEZONE };
  },
};

const updateActionableTool: McpTool = {
  name: "update_actionable",
  tier: "private",
  description:
    "Change an existing actionable (get the id from list_actionables or get_schedule): retitle, move to another day, set or clear its time, mark it done, replace its notes or its to-do list. Use this to reschedule instead of creating a new one.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      dayISO: { type: "string", description: "Move to this day (any instant on it, owner's timezone). A timed actionable keeps its time of day on the new day unless startISO/endISO are also given." },
      startISO: { type: "string", description: "New start, ISO 8601. With endISO sets the time; alone, on a timed actionable, keeps the stored end. Both must fall on dayISO when given, otherwise the actionable moves to the day startISO falls on." },
      endISO: { type: "string", description: "New end, ISO 8601. Alone, on a timed actionable, keeps the stored start." },
      clearTime: { type: "boolean", description: "true makes it untimed (all-day) again." },
      done: { type: "boolean" },
      notes: { type: "string", description: "Replaces the notes. Empty string clears." },
      items: {
        type: "array",
        description: "Replaces the to-do list, in order. Strings or {id, title, done}. An item that matches an existing one (by id, or by title when it has no id) keeps its id and its checked state unless done is given.",
        items: {
          anyOf: [
            { type: "string" },
            { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, done: { type: "boolean" } }, required: ["title"] },
          ],
        },
      },
    },
    required: ["id"],
  },
  run: async (a) => {
    const id = str(a.id);
    if (!id) throw new Error("id is required");
    const existing = await prisma.todo.findUnique({ where: { id }, select: { id: true, startTime: true, endTime: true } });
    if (!existing) throw new Error(`No actionable with id ${id}. Call list_actionables for current ids.`);

    const data: TodoUpdateData = {};
    if (a.title !== undefined) {
      const title = str(a.title);
      if (!title) throw new Error("title cannot be empty");
      data.title = title;
    }
    const done = bool(a.done, "done");
    if (done !== undefined) data.done = done;
    if (a.notes !== undefined) {
      if (typeof a.notes !== "string") throw new Error("notes must be a string");
      data.notes = a.notes.trim().slice(0, NOTES_MAX) || null;
    }

    let day: DateTime | null = null;
    if (a.dayISO !== undefined) {
      day = DateTime.fromISO(String(a.dayISO), { zone: OWNER_TIMEZONE }).startOf("day");
      if (!day.isValid) throw new Error("dayISO is not a valid date");
      data.date = day.toUTC().toJSDate();
    }

    const hasStart = a.startISO !== undefined, hasEnd = a.endISO !== undefined;
    const timed = !!(existing.startTime && existing.endTime);
    if (bool(a.clearTime, "clearTime")) {
      if (hasStart || hasEnd) throw new Error("clearTime cannot be combined with startISO/endISO");
      data.startTime = null;
      data.endTime = null;
    } else if (hasStart || hasEnd) {
      if (hasStart !== hasEnd && !timed) throw new Error("pass both startISO and endISO to give an untimed actionable a time");
      // One end alone keeps the other where it is, moved to the new day if the
      // day changes (shiftToDay keeps the wall-clock time, DST-safe).
      const target = day ?? (hasStart
        ? DateTime.fromJSDate(parseDate(a.startISO, "startISO")).setZone(OWNER_TIMEZONE).startOf("day")
        : DateTime.fromJSDate(existing.startTime!).setZone(OWNER_TIMEZONE).startOf("day"));
      const start = hasStart ? parseDate(a.startISO, "startISO") : shiftToDay(existing.startTime!, target);
      const end = hasEnd ? parseDate(a.endISO, "endISO") : shiftToDay(existing.endTime!, target);
      if (end <= start) throw new Error("endISO must be after startISO");
      // Both instants must sit on the actionable's owner-local day, or it
      // would show on one day's grid and another day's checklist.
      const startDay = DateTime.fromJSDate(start).setZone(OWNER_TIMEZONE).startOf("day");
      const endDay = DateTime.fromJSDate(end).setZone(OWNER_TIMEZONE).startOf("day");
      if (!startDay.equals(target) || !endDay.equals(target)) {
        throw new Error(`startISO and endISO must both fall on ${target.toISODate()} in ${OWNER_TIMEZONE}`);
      }
      data.startTime = start;
      data.endTime = end;
      if (!day) data.date = target.toUTC().toJSDate();
    } else if (day && timed) {
      // Moved by day alone: the times travel with it at the same wall-clock
      // time, or the item would sit on one day's checklist and another's grid.
      data.startTime = shiftToDay(existing.startTime!, day);
      data.endTime = shiftToDay(existing.endTime!, day);
    }

    let items: ReturnType<typeof parseIncomingItems> | undefined;
    if (a.items !== undefined) {
      items = parseIncomingItems(a.items);
      if ("error" in items) throw new Error(items.error);
    }

    if (Object.keys(data).length === 0 && !items) throw new Error("nothing to update: pass at least one field");
    const updated = await applyTodoUpdate(id, data, items && "items" in items ? items.items : undefined, { keepItemState: true });
    if (!updated) throw new Error(`No actionable with id ${id}. Call list_actionables for current ids.`);
    return { ok: true, actionable: actionableOut(updated) };
  },
};

const deleteActionableTool: McpTool = {
  name: "delete_actionable",
  tier: "private",
  description:
    "Delete an actionable by id. Destructive and irreversible. Confirm with the owner before calling. If the actionable comes from a recurring to-do, only that one occurrence is deleted; the series keeps going. If it was carried over from an unfinished earlier day, the unfinished earlier copies go with it (otherwise the next carry-forward would recreate it); the result says how many. Prefer update_actionable when the owner wants a change rather than a removal.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  run: async (a) => {
    const id = str(a.id);
    if (!id) throw new Error("id is required");
    const gone = await deleteTodo(id);
    if (!gone) throw new Error(`No actionable with id ${id}. Call list_actionables for current ids.`);
    const t = gone.todo;
    return {
      ok: true,
      deleted: { id: t.id, title: t.title, day: todoDay(t.date), recurring: !!t.recurringTodoId, carriedFrom: gone.carriedFrom },
    };
  },
};

const setReminderTool: McpTool = {
  name: "set_reminder",
  tier: "private",
  description: "Schedule a proactive reminder message to the owner at a given time (optionally recurring via an iCal RRULE).",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string" },
      fireAtISO: { type: "string", description: "When to send, ISO 8601 UTC. Must be in the future." },
      recurrenceRule: { type: "string" },
    },
    required: ["message", "fireAtISO"],
  },
  run: async (a) => {
    const message = str(a.message);
    if (!message) throw new Error("message is required");
    const r = await createNudge({
      message,
      fireAtISO: String(a.fireAtISO),
      recurrenceRule: str(a.recurrenceRule) ?? null,
    });
    if (!r.ok) throw new Error(r.error);
    return { ok: true, reminderId: r.id, when: r.whenLabel, duplicate: r.duplicate ?? false };
  },
};

export const MCP_TOOLS: McpTool[] = [
  getAvailabilityTool,
  findMutualTimesTool,
  createBookingTool,
  getScheduleTool,
  listCalendarsTool,
  createEventTool,
  updateEventTool,
  deleteEventTool,
  createBlockTool,
  createActionableTool,
  listActionablesTool,
  updateActionableTool,
  deleteActionableTool,
  setReminderTool,
];

/// Tools visible to a caller at the given trust level. An unauthenticated caller
/// must not even SEE the private tools — listing them would leak what the owner
/// tracks and invite probing.
export function toolsFor(authed: boolean): McpTool[] {
  return MCP_TOOLS.filter((t) => authed || t.tier === "public");
}
