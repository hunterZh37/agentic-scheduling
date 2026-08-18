import { CreatedVia } from "@prisma/client";
import { prisma } from "@/lib/db";
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
    "Read the owner's full schedule for a range: real calendar events (with titles and attendees), reserved blocks, bookings, birthdays and timed actionables.",
  inputSchema: {
    type: "object",
    properties: {
      startISO: { type: "string" },
      endISO: { type: "string" },
    },
    required: ["startISO", "endISO"],
  },
  run: async (a) => {
    const view = await getScheduleView(parseDate(a.startISO, "startISO"), parseDate(a.endISO, "endISO"));
    return {
      events: view.events.map((e) => ({
        id: e.id, account: e.accountEmail, title: e.title,
        start: iso(e.start), end: iso(e.end), allDay: e.allDay, location: e.location,
      })),
      blocks: view.blocks.map((b) => ({ id: b.id, title: b.title, start: iso(b.start), end: iso(b.end) })),
      bookings: view.bookings.map((b) => ({
        id: b.id, title: b.title, start: iso(b.start), end: iso(b.end), attendee: b.attendeeName,
      })),
      actionables: (view.actionables ?? []).map((t) => ({
        id: t.id, title: t.title, start: iso(t.start), end: iso(t.end), done: t.done,
      })),
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
    const created = await createDestinationEvent(account, {
      title, start, end, description: str(a.description), location: str(a.location),
      conference: a.addVideoLink !== false,
    });
    return { ok: true, eventId: created.id, videoLink: created.videoLink ?? null, account: account.email };
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
    const todo = await prisma.todo.create({
      data: { title, date: dayKey, startTime, endTime, sortOrder: (last?.sortOrder ?? -1) + 1 },
    });
    return { ok: true, todoId: todo.id, timed: !!(startTime && endTime) };
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
  setReminderTool,
];

/// Tools visible to a caller at the given trust level. An unauthenticated caller
/// must not even SEE the private tools — listing them would leak what the owner
/// tracks and invite probing.
export function toolsFor(authed: boolean): McpTool[] {
  return MCP_TOOLS.filter((t) => authed || t.tier === "public");
}
