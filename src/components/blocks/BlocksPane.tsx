"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { locationHref } from "@/lib/maps";
import { accountVar } from "@/lib/design/accounts";
import { friendlyRecurrence, presetToRule, type RecurrencePreset } from "@/lib/recurrence/friendly";
import { formatRange, relativeDayTime, isOvernight } from "@/lib/timeFormat";
import { EventModal } from "@/components/calendar/EventModal";
import type { FollowupRow } from "@/components/calendar/EventFollowups";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Spinner } from "@/components/ui/Spinner";
import type { CalendarItem, ItemAttendee } from "@/components/calendar/types";
import ReminderControl from "@/components/reminders/ReminderControl";
import { agendaDetailItem, untimedTodoDetailItem, upcomingBookingDetailItem, type AgendaItem, type BookingRow } from "./detailItem";
import { dismissKey, visibleUpcomingBookings } from "./upcomingBookings";
import { NewBlockSheet } from "./NewBlockSheet";
import { RecurringModal } from "./RecurringModal";
import { AgendaFollowups } from "./AgendaFollowups";
import { haptic } from "@/lib/motion/haptics";
import styles from "./BlocksPane.module.css";

/// Group flat follow-up rows by their eventKey (the agenda looks them up by an
/// event row's key, which equals the follow-up's eventKey).
function groupFollowups(rows: FollowupRow[]): Map<string, FollowupRow[]> {
  const map = new Map<string, FollowupRow[]>();
  for (const f of rows) {
    const arr = map.get(f.eventKey);
    if (arr) arr.push(f);
    else map.set(f.eventKey, [f]);
  }
  return map;
}

/// Immutably replace one key's follow-up list in the grouped map.
function updateFollowMap(
  map: Map<string, FollowupRow[]>,
  key: string,
  fn: (list: FollowupRow[]) => FollowupRow[]
): Map<string, FollowupRow[]> {
  const next = new Map(map);
  next.set(key, fn(next.get(key) ?? []));
  return next;
}

export interface TodoRow {
  id: string;
  title: string;
  done: boolean;
  sortOrder: number;
  // A todo is either UNTIMED (both null) or TIMED (both set).
  startTime: string | null;
  endTime: string | null;
  // "Where" — at most one is meaningful: an in-person location, an online
  // meeting link, or a phone number for a call.
  location: string | null;
  videoLink: string | null;
  phone: string | null;
  // Set when this todo was carried forward from an unfinished one the day
  // before (the id of the source). Null for an ordinary todo. Drives the small
  // "carried over" marker so a rolled-over item is recognisable.
  rolledFromId?: string | null;
  // Set when this todo was SEEDED by a recurring template ("pay rent, last day
  // of every month"). Null for a one-off. Drives the small "recurring" marker.
  recurringTodoId?: string | null;
}
/// A recurring actionable SCHEDULE (a RecurringTodo template), shown in its own
/// section so a series is visible the moment it's set up — not only on the first
/// day it seeds a to-do. `nextOccurrence` is an ISO date (owner-local).
export interface RecurringRow {
  id: string;
  title: string;
  cadence: string;
  nextOccurrence: string | null;
  timed: boolean;
  // Enough to open the editor without a second fetch.
  rrule: string;
  startMinutes: number | null;
  endMinutes: number | null;
  location: string | null;
  videoLink: string | null;
  phone: string | null;
}
export interface BlockRow {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  timezone: string;
  recurrenceRule: string | null;
  visible: boolean;
  done: boolean;
}
export type { BookingRow };
export interface EventRow {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  accountEmail: string;
  // Detail fields present on the raw /api/schedule event, needed to open the
  // full event detail modal (mirrors CalendarItem's event-only fields).
  location?: string;
  description?: string;
  videoLink?: string;
  organizer?: { email: string; name?: string };
  attendees?: ItemAttendee[];
  reminders?: number[];
  htmlLink?: string;
}
/// A booking that lands on the selected day (from /api/schedule).
export interface DayBookingRow {
  id: string;
  title: string;
  start: string;
  end: string;
  attendeeName: string;
  attendeeEmail?: string;
  attendeeTimezone: string;
  status: string;
}
/// A birthday occurrence that lands on the selected day (from /api/schedule).
export interface DayBirthdayRow {
  id: string;
  name: string;
  date: string;
  age: number | null;
}

/// Classify a free-text "where" into at most one of a location, a video
/// link, or a phone number, so the add-todo row can offer a single input
/// instead of three. URL-shaped -> link; digits/phone-punctuation-only (with
/// enough digits to be a real number) -> phone; anything else -> location.
function classifyTodoWhere(raw: string): { location?: string; videoLink?: string; phone?: string } {
  const value = raw.trim();
  if (!value) return {};
  if (/^https?:\/\//i.test(value) || /^www\./i.test(value)) return { videoLink: value };
  const digitCount = (value.match(/\d/g) ?? []).length;
  if (/^[\d+\-() .]+$/.test(value) && digitCount >= 7) return { phone: value };
  return { location: value };
}

/// Renders a todo's "where" — a video link (as a clickable "Join call"), a
/// phone number (as a tel: link), or a plain location string. Renders
/// nothing if none are set. Shared by the untimed rows and the merged
/// timed-todo agenda rows.
/// The three kinds of item the add card can create, in the order shown by the
/// segmented selector. `colorVar` matches each kind's existing identity color
/// elsewhere in the pane (Actionable's checkbox accent, the block color, and
/// the confirmed/event blue used by real calendar events).
const ITEM_TYPES: Array<{ key: "event" | "todo" | "block"; label: string; colorVar: string }> = [
  { key: "event", label: "Event", colorVar: "--state-confirmed" },
  { key: "todo", label: "Actionable", colorVar: "--accent" },
  { key: "block", label: "Reserved Block", colorVar: "--state-busy" },
];

function TodoWhere({ location, videoLink, phone }: { location?: string; videoLink?: string; phone?: string }) {
  if (videoLink) {
    return (
      <a href={videoLink} target="_blank" rel="noreferrer" className={styles.todoWhereLink} onClick={(e) => e.stopPropagation()}>
        Join call
      </a>
    );
  }
  if (phone) {
    return (
      <a href={`tel:${phone}`} className={styles.todoWhereLink} onClick={(e) => e.stopPropagation()}>
        {phone}
      </a>
    );
  }
  if (location) {
    return (
      <a
        href={locationHref(location)}
        target="_blank"
        rel="noreferrer"
        className={styles.todoWhereLink}
        onClick={(e) => e.stopPropagation()}
      >
        {location}
      </a>
    );
  }
  return null;
}

export interface BlocksPaneProps {
  blocksOverride?: BlockRow[];
  bookingsOverride?: BookingRow[];
  eventsOverride?: EventRow[];
  /// The day whose events fill the agenda section. Defaults to today so demo /
  /// standalone usages keep working unchanged.
  selectedDate?: DateTime;
  /// Change the selected day (used by the recurring editor's "Go to that day"
  /// jump). The parent owns the date, same setter the calendar grid uses.
  onSelectDate?: (day: DateTime) => void;
  /// Called after a block mutation (visibility toggle, delete, create) so the
  /// parent can refresh the separately-fetched calendar view in real time.
  onScheduleChange?: () => void;
  /// Bumped by the parent (e.g. after an event edit from the calendar grid) to
  /// force this pane to refetch its agenda.
  reloadKey?: number;
  /// Whether this pane is currently the visible one. On mobile the three panes
  /// are all mounted but only the active tab's is displayed (the rest are
  /// `display:none`), so the pane can be laid out for the first time well after
  /// mount. Used to (re)trigger the one-shot now-line auto-scroll once the pane
  /// actually becomes visible. Defaults to true so desktop / standalone usages
  /// (where the pane is always shown) auto-scroll on load as before.
  active?: boolean;
}

/// A small looped-arrow marking a to-do that rolled over from an unfinished one
/// the day before. Inline SVG (no emoji), inherits the muted marker color.
function CarriedIcon() {
  return (
    <svg
      className={styles.carriedIcon}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
    </svg>
  );
}

/// A small refresh loop marking a to-do that was seeded by a recurring schedule.
/// Inline SVG (no emoji), inherits the muted marker color.
function RecurringIcon() {
  return (
    <svg
      className={styles.carriedIcon}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

export function BlocksPane({ blocksOverride, bookingsOverride, eventsOverride, selectedDate, onSelectDate, onScheduleChange, reloadKey = 0, active = true }: BlocksPaneProps) {
  const [blocks, setBlocks] = useState<BlockRow[]>(blocksOverride ?? []);
  const [bookings, setBookings] = useState<BookingRow[]>(bookingsOverride ?? []);
  // The owner's active recurring-actionable schedules (day-independent, like
  // Upcoming bookings). Loaded with the rest of the pane.
  const [recurring, setRecurring] = useState<RecurringRow[]>([]);
  const [pendingRecurringCancel, setPendingRecurringCancel] = useState<RecurringRow | null>(null);
  const [cancellingRecurring, setCancellingRecurring] = useState(false);
  // The recurring schedule whose detail/edit panel is open (click a row title).
  const [recurringDetail, setRecurringDetail] = useState<RecurringRow | null>(null);
  const [events, setEvents] = useState<EventRow[]>(eventsOverride ?? []);
  // The selected day's expanded block occurrences and bookings, used only for
  // the merged agenda checklist (the sections below manage templates / all
  // upcoming bookings separately).
  const [dayBookings, setDayBookings] = useState<DayBookingRow[]>([]);
  const [dayBirthdays, setDayBirthdays] = useState<DayBirthdayRow[]>([]);
  // Day-scoped to-dos shown atop the Today agenda. Reloaded whenever the
  // selected day changes.
  const [todos, setTodos] = useState<TodoRow[]>([]);
  // The Apple-Reminders-style add card: a title input that expands into a
  // type selector (Event / Actionable / Reserved Block) plus type-specific
  // fields, routed on submit to /api/todos, /api/events, or /api/blocks.
  const [itemExpanded, setItemExpanded] = useState(false);
  const [itemType, setItemType] = useState<"event" | "todo" | "block">("todo");
  const [itemTitle, setItemTitle] = useState("");
  // "yyyy-MM-dd", event/block only; empty = the selected agenda day.
  const [itemDate, setItemDate] = useState("");
  // Reserved-Block only: the last day of a multi-day span (e.g. a weekend).
  // Empty = a single-day block ending on itemDate.
  const [itemEndDate, setItemEndDate] = useState("");
  // Reserved-Block only: cover each day in full instead of a time range.
  const [itemAllDay, setItemAllDay] = useState(false);
  // Optional HH:mm draft values for the item's time range; empty = untimed
  // (Actionable only — Event and Reserved Block require both).
  const [itemStartDraft, setItemStartDraft] = useState("");
  const [itemEndDraft, setItemEndDraft] = useState("");
  // Free-text "where": classified into location/videoLink/phone for a todo,
  // used as a plain location for an event.
  const [itemWhereDraft, setItemWhereDraft] = useState("");
  // Event-only description.
  const [itemNotesDraft, setItemNotesDraft] = useState("");
  // Recurrence for a quick-added Event or Reserved Block; "never" = one-off.
  const [itemRecurrence, setItemRecurrence] = useState<RecurrencePreset>("never");
  const [itemSaving, setItemSaving] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Follow-up actionables, grouped by their event occurrence key (== agenda
  // event row key). Loaded alongside the schedule; mutated optimistically.
  const [followupsByKey, setFollowupsByKey] = useState<Map<string, FollowupRow[]>>(new Map());
  const [sheetOpen, setSheetOpen] = useState(false);
  // Live clock driving the red "now" marker in the agenda; ticks each minute.
  const [now, setNow] = useState<DateTime>(() => DateTime.now().setZone(OWNER_TIMEZONE));
  // The now-line row/element; on first load we scroll it to the center of the
  // agenda so the viewport opens at the current time, not the top of the day.
  const nowRef = useRef<HTMLLIElement | null>(null);
  const didAutoScrollRef = useRef(false);
  // The reserved block whose detail panel is open (reuses the calendar's modal).
  const [detailItem, setDetailItem] = useState<CalendarItem | null>(null);
  // The reserved block being edited (opens the block sheet pre-filled). Null =
  // no edit in progress; distinct from `sheetOpen` which creates a new block.
  const [editBlock, setEditBlock] = useState<BlockRow | null>(null);
  // The reserved block pending deletion (shows a confirm dialog); null = none.
  const [pendingDelete, setPendingDelete] = useState<BlockRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The booking pending cancellation (shows a confirm dialog); null = none.
  const [pendingBookingCancel, setPendingBookingCancel] = useState<BookingRow | null>(null);
  const [cancellingBooking, setCancellingBooking] = useState(false);
  const isDemo = blocksOverride !== undefined;
  // True while `reload` is fetching the agenda from the DB — drives the header
  // loading spinner. Starts true for a real pane (its first fetch is pending),
  // false in demo/QA mode where data is passed in and nothing is fetched.
  const [loading, setLoading] = useState(!isDemo);
  // Mutations here were fire-and-forget: `await fetch(...)` then reload, with
  // the response never inspected. A delete that FAILED therefore looked exactly
  // like one that succeeded — the row simply came back on reload — which is how
  // "I deleted the duplicate and it's still there" becomes impossible to tell
  // apart from "the delete never happened". Surface it instead.
  const [actionError, setActionError] = useState<string | null>(null);
  // The actionable pending deletion (shows a confirm dialog); null = none.
  // Destructive, and triggered by a control that is invisible until hover — a
  // single click was far too easy to fire by accident, and impossible to tell
  // apart from a miss. Same ConfirmDialog the reserved blocks and booking
  // cancellations use, rather than a second bespoke pattern.

  // The selected agenda day (defaults to today in the owner's timezone).
  const selectedDay = useMemo(
    () => (selectedDate ?? DateTime.now().setZone(OWNER_TIMEZONE)).startOf("day"),
    [selectedDate]
  );

  const reload = useCallback(async () => {
    if (isDemo) return;
    const day = selectedDay;
    const start = encodeURIComponent(day.toUTC().toISO()!);
    const end = encodeURIComponent(day.endOf("day").toUTC().toISO()!);
    setLoading(true);
    try {
      const [b, k, s, t, c, f, rc] = await Promise.all([
        fetch("/api/blocks").then((r) => r.json()),
        fetch("/api/bookings").then((r) => r.json()),
        fetch(`/api/schedule?start=${start}&end=${end}`).then((r) => r.json()),
        fetch(`/api/todos?date=${start}`).then((r) => r.json()),
        fetch("/api/checkoffs").then((r) => r.json()),
        fetch("/api/followups").then((r) => r.json()),
        fetch("/api/recurring").then((r) => r.json()),
      ]);
      setBlocks(b.blocks ?? []);
      setBookings(
        (k.bookings ?? []).map((x: BookingRow) => ({
          id: x.id,
          title: x.title,
          startTime: x.startTime,
          endTime: x.endTime,
          attendeeName: x.attendeeName,
          attendeeEmail: x.attendeeEmail ?? undefined,
          attendeeTimezone: x.attendeeTimezone,
          status: x.status,
          updatedAt: x.updatedAt,
        }))
      );
      setEvents(
        ((s.events ?? []) as EventRow[])
          .slice()
          .sort((a, b) => Number(a.allDay) - Number(b.allDay) || a.start.localeCompare(b.start))
      );
      setDayBookings((s.bookings ?? []) as DayBookingRow[]);
      setDayBirthdays((s.birthdays ?? []) as DayBirthdayRow[]);
      setTodos((t.todos ?? []) as TodoRow[]);
      setChecked(new Set((c.keys ?? []) as string[]));
      setFollowupsByKey(groupFollowups((f.followups ?? []) as FollowupRow[]));
      setRecurring((rc.recurring ?? []) as RecurringRow[]);
    } finally {
      setLoading(false);
    }
  }, [isDemo, selectedDay]);

  // Refetch just the follow-ups (used when the event modal closes — modal edits
  // to follow-ups should show in the agenda without reloading the whole schedule).
  const reloadFollowups = useCallback(async () => {
    if (isDemo) return;
    const f = await fetch("/api/followups").then((r) => r.json()).catch(() => ({}));
    setFollowupsByKey(groupFollowups((f.followups ?? []) as FollowupRow[]));
  }, [isDemo]);

  const addFollowup = async (eventKey: string, title: string) => {
    if (isDemo) return;
    try {
      const res = await fetch("/api/followups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventKey, title }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.followup) {
        setFollowupsByKey((prev) => updateFollowMap(prev, eventKey, (list) => [...list, d.followup as FollowupRow]));
      }
    } catch {
      /* ignore — user can retry */
    }
  };

  const toggleFollowup = (eventKey: string, id: string, done: boolean) => {
    setFollowupsByKey((prev) => updateFollowMap(prev, eventKey, (list) => list.map((f) => (f.id === id ? { ...f, done } : f))));
    if (isDemo) return;
    void fetch(`/api/followups/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    });
  };

  const deleteFollowup = (eventKey: string, id: string) => {
    setFollowupsByKey((prev) => updateFollowMap(prev, eventKey, (list) => list.filter((f) => f.id !== id)));
    if (isDemo) return;
    void fetch(`/api/followups/${id}`, { method: "DELETE" });
  };

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  // Advance the "now" marker each minute.
  useEffect(() => {
    const id = setInterval(() => setNow(DateTime.now().setZone(OWNER_TIMEZONE)), 60_000);
    return () => clearInterval(id);
  }, []);

  // Cross an event/booking row off ("done"). Persisted to the Checkoff store so
  // it survives a refresh (these items have no DB row of their own). Optimistic:
  // flip the local set immediately, then write through.
  const toggleChecked = (id: string) => {
    // Compute the target state up front (deterministic, no side effects inside
    // the updater — which React StrictMode double-invokes in dev).
    const done = !checked.has(id);
    haptic("select");
    setChecked((prev) => {
      const next = new Set(prev);
      if (done) next.add(id);
      else next.delete(id);
      return next;
    });
    if (isDemo) return;
    void fetch("/api/checkoffs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: id, done }),
    });
  };

  const deleteBlock = async (id: string) => {
    if (isDemo) {
      setBlocks((b) => b.filter((x) => x.id !== id));
      return;
    }
    await fetch(`/api/blocks/${id}`, { method: "DELETE" });
    void reload();
    onScheduleChange?.();
  };

  // Cancel a booking: removes it from the calendar and emails the attendee.
  const cancelBookingRow = async (id: string) => {
    if (isDemo) {
      setBookings((b) => b.filter((x) => x.id !== id));
      return;
    }
    await fetch(`/api/bookings/${id}`, { method: "DELETE" });
    void reload();
    onScheduleChange?.();
  };

  // Cancel a recurring actionable: stops it seeding new days. Already-seeded
  // to-dos are left in place.
  const cancelRecurring = async (id: string) => {
    if (isDemo) {
      setRecurring((r) => r.filter((x) => x.id !== id));
      return;
    }
    await fetch(`/api/recurring/${id}`, { method: "DELETE" });
    setRecurring((r) => r.filter((x) => x.id !== id));
  };

  // Cross a block off ("done"). Server-backed like todos, so the struck-through
  // state survives a browser refresh instead of living only in local `checked`.
  const toggleBlockDone = async (id: string, done: boolean) => {
    haptic("select");
    if (isDemo) {
      setBlocks((b) => b.map((x) => (x.id === id ? { ...x, done } : x)));
      return;
    }
    await fetch(`/api/blocks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    });
    void reload();
    onScheduleChange?.();
  };

  // Show/hide a block's visual on the calendar day-grid and Today agenda,
  // without removing it from this management list.
  const toggleBlockVisible = async (block: BlockRow) => {
    if (isDemo) {
      setBlocks((b) => b.map((x) => (x.id === block.id ? { ...x, visible: !x.visible } : x)));
      return;
    }
    await fetch(`/api/blocks/${block.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visible: !block.visible }),
    });
    void reload();
    onScheduleChange?.();
  };

  // Combine a draft "HH:mm" with a given day (in the owner's timezone) into a
  // UTC instant, mirroring how `date` itself is derived below.
  const buildTime = (day: DateTime, hhmm: string) => {
    const [hour, minute] = hhmm.split(":").map(Number);
    return day.set({ hour, minute, second: 0, millisecond: 0 }).toUTC().toISO();
  };

  // The day an Event/Reserved Block is created on: the item card's own date
  // field if the user changed it, otherwise the selected agenda day. Actionable
  // to-dos ignore this and always use the selected day directly (they have no
  // date field of their own).
  const effectiveItemDay = useMemo(() => {
    if (!itemDate) return selectedDay;
    const d = DateTime.fromISO(itemDate, { zone: OWNER_TIMEZONE });
    return d.isValid ? d.startOf("day") : selectedDay;
  }, [itemDate, selectedDay]);

  // Switching type pre-fills a sensible default time range for Event/Reserved
  // Block (both require one), mirroring NewBlockSheet's 09:00–10:00 default.
  const selectItemType = (key: "event" | "todo" | "block") => {
    setItemType(key);
    if (key !== "todo" && itemStartDraft === "" && itemEndDraft === "") {
      setItemStartDraft("09:00");
      setItemEndDraft("10:00");
    }
  };

  const collapseItemDraft = () => {
    setItemExpanded(false);
    setItemType("todo");
    setItemTitle("");
    setItemDate("");
    setItemEndDate("");
    setItemAllDay(false);
    setItemStartDraft("");
    setItemEndDraft("");
    setItemWhereDraft("");
    setItemNotesDraft("");
    setItemRecurrence("never");
    setItemError(null);
    setItemSaving(false);
  };

  const addItem = async () => {
    const title = itemTitle.trim();
    if (!title || isDemo || itemSaving) return;

    if (itemType === "todo") {
      const startDraft = itemStartDraft;
      const endDraft = itemEndDraft;
      const whereDraft = itemWhereDraft;
      // Only treat the range as timed when both ends are filled and ordered;
      // otherwise fall back to an untimed todo rather than blocking the add.
      const timed = startDraft !== "" && endDraft !== "" && endDraft > startDraft;
      // A repeating actionable is a RecurringTodo template (its own endpoint),
      // NOT a one-off Todo — the template seeds a real actionable onto each due
      // day. "never" → an ordinary one-off todo on the selected day.
      const recurrenceRule = presetToRule(itemRecurrence);
      collapseItemDraft();
      if (recurrenceRule) {
        await fetch("/api/recurring", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            rrule: recurrenceRule,
            ...(timed ? { startTime: buildTime(selectedDay, startDraft), endTime: buildTime(selectedDay, endDraft) } : {}),
            ...classifyTodoWhere(whereDraft),
          }),
        });
      } else {
        await fetch("/api/todos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            date: selectedDay.toUTC().toISO(),
            ...(timed ? { startTime: buildTime(selectedDay, startDraft), endTime: buildTime(selectedDay, endDraft) } : {}),
            ...classifyTodoWhere(whereDraft),
          }),
        });
      }
      void reload();
      return;
    }

    // Event and Reserved Block both write a real, timed item. Blocks additionally
    // support a multi-day span and an all-day toggle (e.g. a weekend for moving);
    // events stay single-day. All-day covers each day in full:
    // [startDay 00:00, endDay + 1 day 00:00).
    const startDay = effectiveItemDay;
    const endDay =
      itemType === "block" && itemEndDate
        ? DateTime.fromISO(itemEndDate, { zone: OWNER_TIMEZONE }).startOf("day")
        : startDay;

    let startTime: string;
    let endTime: string;
    if (itemType === "block" && itemAllDay) {
      startTime = startDay.toUTC().toISO()!;
      endTime = endDay.plus({ days: 1 }).toUTC().toISO()!;
    } else {
      if (itemStartDraft === "" || itemEndDraft === "") {
        setItemError("Start and end time are required.");
        return;
      }
      const [sh, sm] = itemStartDraft.split(":").map(Number);
      const [eh, em] = itemEndDraft.split(":").map(Number);
      const s = startDay.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
      let e = endDay.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
      if (endDay.hasSame(startDay, "day") && e <= s) e = e.plus({ days: 1 }); // overnight
      if (e <= s) {
        setItemError("End must be after start.");
        return;
      }
      startTime = s.toUTC().toISO()!;
      endTime = e.toUTC().toISO()!;
    }
    setItemSaving(true);
    setItemError(null);
    const endpoint = itemType === "event" ? "/api/events" : "/api/blocks";
    // A repeating quick-add carries an RRULE; both endpoints anchor recurrence
    // to a timezone (events send local wall-clock so a weekly slot holds
    // across DST). "never" → one-off, no recurrenceRule / timezone sent.
    const recurrenceRule = presetToRule(itemRecurrence);
    const payload =
      itemType === "event"
        ? {
            title,
            startTime,
            endTime,
            ...(itemWhereDraft.trim() ? { location: itemWhereDraft.trim() } : {}),
            ...(itemNotesDraft.trim() ? { description: itemNotesDraft.trim() } : {}),
            ...(recurrenceRule ? { recurrenceRule, timezone: OWNER_TIMEZONE } : {}),
          }
        : { title, startTime, endTime, timezone: OWNER_TIMEZONE, ...(recurrenceRule ? { recurrenceRule } : {}) };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Could not create item.");
      }
      collapseItemDraft();
      void reload();
      onScheduleChange?.();
    } catch (e) {
      setItemError(e instanceof Error ? e.message : "Something went wrong.");
      setItemSaving(false);
    }
  };

  const toggleTodoDone = async (id: string, done: boolean) => {
    haptic("select");
    if (isDemo) return;
    await fetch(`/api/todos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    });
    void reload();
  };

  const confirmedBookings = useMemo(
    () => bookings.filter((b) => b.status === "confirmed"),
    [bookings]
  );

  // What the "Upcoming bookings" list shows.
  //
  // A cancelled booking stays visible so the owner can SEE that it was
  // cancelled — a meeting vanishing without a trace is indistinguishable from
  // one that was never made. But it should not linger: it disappears 24h after
  // being cancelled, or immediately if dismissed with the trash control.
  //
  // `updatedAt` is the cancellation time in practice: nothing writes to a
  // booking row after it is cancelled. Using it avoids a `cancelledAt` column,
  // and a migration against production Neon, for a purely cosmetic deadline.
  const upcomingBookings = useMemo(
    () => visibleUpcomingBookings(bookings, checked, now.toMillis()),
    [bookings, checked, now]
  );

  // Hide a cancelled booking now. Persisted through the generic Checkoff store
  // (a namespaced key), so it stays dismissed on every device rather than only
  // in this browser — and without a schema change. The booking row itself is
  // untouched: this hides it, it does not delete history.
  const dismissBooking = async (id: string) => {
    const key = dismissKey(id);
    setChecked((prev) => new Set(prev).add(key));
    if (isDemo) return;
    try {
      const res = await fetch("/api/checkoffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, done: true }),
      });
      if (!res.ok) {
        setChecked((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        setActionError(`Couldn't dismiss that cancelled booking (${res.status}).`);
      }
    } catch {
      setChecked((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setActionError("Couldn't reach the server to dismiss that booking.");
    }
  };

  // Untimed todos stay pinned atop the list as plain checkable rows; timed
  // todos are merged into the agenda below so they slot in by time.
  const untimedTodos = useMemo(() => todos.filter((t) => !t.startTime), [todos]);
  const timedTodos = useMemo(() => todos.filter((t) => t.startTime && t.endTime), [todos]);

  // Everything happening on the selected day — calendar events, reserved-block
  // occurrences, bookings, and timed todos — merged into one time-sorted checklist.
  const agendaItems = useMemo<AgendaItem[]>(() => {
    const items: AgendaItem[] = [
      ...events.map((ev) => ({
        // Include start AND account: some providers return the same id for
        // multiple occurrences on a day, and one meeting present on two
        // connected calendars comes back twice with the same id and start.
        // Either collision makes React drop or duplicate a row (check one →
        // both).
        key: `event:${ev.id}:${ev.start}:${ev.accountEmail}`,
        kind: "event" as const,
        title: ev.title,
        start: ev.start,
        end: ev.end,
        allDay: ev.allDay,
        colorVar: accountVar(ev.accountEmail),
        eventId: ev.id,
        accountEmail: ev.accountEmail,
        location: ev.location,
        description: ev.description,
        videoLink: ev.videoLink,
        organizer: ev.organizer,
        attendees: ev.attendees,
        reminders: ev.reminders,
        htmlLink: ev.htmlLink,
      })),
      // Reserved blocks are deliberately NOT merged in here. They live in the
      // "Reserved time" section below, which lists the block itself rather than
      // its per-day occurrences. Listing both meant standing commitments (sleep,
      // gym, a multi-day hold) repeated down the day alongside the things that
      // are actually happening, and a long block could fill the agenda outright.
      ...dayBookings
        .filter((b) => b.status === "confirmed")
        .map((b) => ({
          key: `booking:${b.id}`,
          kind: "booking" as const,
          title: b.title,
          start: b.start,
          end: b.end,
          allDay: false,
          colorVar: "--state-booking",
          attendeeName: b.attendeeName,
          attendeeEmail: b.attendeeEmail,
          bookingId: b.id,
        })),
      ...timedTodos.map((t) => ({
        key: `todo:${t.id}`,
        kind: "todo" as const,
        title: t.title,
        start: t.startTime!,
        end: t.endTime!,
        allDay: false,
        colorVar: "--accent",
        todoId: t.id,
        done: t.done,
        carriedOver: !!t.rolledFromId,
        recurring: !!t.recurringTodoId,
        location: t.location ?? undefined,
        videoLink: t.videoLink ?? undefined,
        phone: t.phone ?? undefined,
      })),
      ...dayBirthdays.map((b) => ({
        key: `birthday:${b.id}`,
        kind: "birthday" as const,
        title: `${b.name}'s birthday${b.age != null ? ` (turns ${b.age})` : ""}`,
        start: b.date,
        end: b.date,
        allDay: true,
        colorVar: "--state-birthday",
      })),
    ];
    return items.sort(
      (a, b) => Number(a.allDay) - Number(b.allDay) || a.start.localeCompare(b.start)
    );
  }, [events, dayBookings, timedTodos, dayBirthdays]);

  // Where the current-time marker sits in the agenda: after every item that has
  // already started, before the first upcoming (or all-day) item. Only shown
  // when the selected day is today; -1 hides it. Compared by timestamp so the
  // position is timezone-correct.
  const nowIndex = useMemo(() => {
    if (!selectedDay.hasSame(now, "day")) return -1;
    const nowMs = now.toMillis();
    // Compare against each item's END so the line sits ABOVE the item that's
    // currently happening (start ≤ now < end), not below it — the in-progress
    // block reads as "now", with everything fully past above the line.
    const i = agendaItems.findIndex((it) => it.allDay || new Date(it.end).getTime() > nowMs);
    return i === -1 ? agendaItems.length : i;
  }, [selectedDay, now, agendaItems]);

  // On first load (today only), center the agenda on the now-line so the pane
  // opens at the current time instead of the top of the day. Runs once, after
  // the now marker has mounted; the minute tick and later re-renders don't
  // re-trigger it, so it never fights the user's own scrolling.
  //
  // The visibility gate matters on mobile: all three panes are mounted at once
  // and the inactive ones are `display:none`, so this can fire while the pane
  // has no layout — scrolling a zero-layout element silently does nothing but
  // would still burn the one-shot. We bail (WITHOUT arming the ref) until the
  // now-line is actually laid out (`offsetParent` is null under a display:none
  // ancestor), and re-run when `active` flips so the scroll lands the moment
  // the Blocks tab is first opened. Desktop keeps working because the pane is
  // always visible there, regardless of `active`.
  useEffect(() => {
    if (didAutoScrollRef.current) return;
    if (nowIndex < 0) return;
    const el = nowRef.current;
    if (!el || el.offsetParent === null) return;
    el.scrollIntoView({ block: "center" });
    didAutoScrollRef.current = true;
  }, [nowIndex, active]);

  // "Today" when the selected day is today, otherwise a friendly label (e.g.
  // "Sat, Jul 11").
  const agendaLabel = useMemo(() => {
    const today = DateTime.now().setZone(OWNER_TIMEZONE).startOf("day");
    return selectedDay.hasSame(today, "day") ? "Today" : selectedDay.toFormat("ccc, LLL d");
  }, [selectedDay]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.headerTitle}>Schedule</h2>
          {loading && <Spinner className={styles.headerSpinner} label="Loading blocks" />}
        </div>
        <button className={styles.addBtn} onClick={() => setItemExpanded(true)} aria-label="Add item">
          +
        </button>
      </div>

      {actionError && (
        <p className={styles.actionError} role="status">
          {actionError}
        </p>
      )}

      <div className={styles.scroll}>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{agendaLabel}</span>
            <span className={styles.count}>{untimedTodos.length + agendaItems.length}</span>
          </div>
          {untimedTodos.length === 0 && agendaItems.length === 0 && !itemExpanded ? (
            <p className={styles.empty}>Nothing scheduled.</p>
          ) : (
            <ul className={`${styles.list} ${styles.agendaList}`}>
              {untimedTodos.map((t) => {
                // Open the same editor a timed actionable uses. Untimed to-dos
                // had no click target, so they were the one row you couldn't edit.
                const openDetail = () => setDetailItem(untimedTodoDetailItem(t, selectedDay));
                return (
                <li key={`todo:${t.id}`} className={`${styles.row} ${t.done ? styles.rowChecked : ""}`}>
                  <button
                    className={styles.checkbox}
                    style={{ borderColor: "var(--accent)", background: t.done ? "var(--accent)" : "transparent" }}
                    onClick={() => void toggleTodoDone(t.id, !t.done)}
                    aria-pressed={t.done}
                    aria-label={t.done ? "Mark not done" : "Mark done"}
                  >
                    {t.done && (
                      <svg className={styles.checkMark} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                        <path d="M2.5 6.2 L5 8.6 L9.5 3.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                  <div
                    className={`${styles.rowBody} ${styles.rowBodyOpen}`}
                    role="button"
                    tabIndex={0}
                    onClick={openDetail}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openDetail();
                      }
                    }}
                  >
                    <span className={styles.rowTitleRow}>
                      <span className={styles.rowTitle}>{t.title}</span>
                      <span className={styles.tag} style={{ color: "var(--accent)" }}>
                        Actionable
                      </span>
                    </span>
                    {(t.location || t.videoLink || t.phone || t.rolledFromId || t.recurringTodoId) && (
                      <span className={styles.rowSub}>
                        {t.rolledFromId && (
                          <span className={styles.carried} title="Carried over from yesterday, still not done">
                            <CarriedIcon />
                            carried over
                          </span>
                        )}
                        {t.recurringTodoId && (
                          <>
                            {t.rolledFromId && <span className={styles.dot}>·</span>}
                            <span className={styles.carried} title="Seeded by a recurring schedule">
                              <RecurringIcon />
                              recurring
                            </span>
                          </>
                        )}
                        {(t.location || t.videoLink || t.phone) && (
                          <>
                            {(t.rolledFromId || t.recurringTodoId) && <span className={styles.dot}>·</span>}
                            <TodoWhere location={t.location ?? undefined} videoLink={t.videoLink ?? undefined} phone={t.phone ?? undefined} />
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  <ReminderControl title={t.title} startISO={t.startTime ?? null} itemRef={{ kind: "todo", id: t.id }} />
                </li>
                );
              })}
              {itemExpanded && (
              <li className={styles.addCard}>
                <div className={styles.addTitleRow}>
                  <button className={styles.addIcon} onClick={() => void addItem()} aria-label="Add item">
                    +
                  </button>
                  <input
                    className={styles.addTitleInput}
                    value={itemTitle}
                    placeholder="Add an item…"
                    autoFocus
                    onChange={(e) => setItemTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addItem();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        collapseItemDraft();
                      }
                    }}
                  />
                  <button className={styles.addCollapse} onClick={collapseItemDraft} aria-label="Cancel">
                    ×
                  </button>
                </div>

                <div className={styles.addDetails}>
                    <div className={styles.itemTypeSeg} role="tablist" aria-label="Item type">
                      {ITEM_TYPES.map((t) => (
                        <button
                          key={t.key}
                          type="button"
                          role="tab"
                          className={`${styles.itemTypeBtn} ${itemType === t.key ? styles.itemTypeBtnActive : ""}`}
                          style={itemType === t.key ? { color: `var(${t.colorVar})` } : undefined}
                          onClick={() => selectItemType(t.key)}
                          aria-selected={itemType === t.key}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>

                    {itemType === "event" && (
                      <input
                        className={styles.addNotesInput}
                        value={itemNotesDraft}
                        placeholder="Notes"
                        onChange={(e) => setItemNotesDraft(e.target.value)}
                      />
                    )}

                    <div className={styles.chipsRow}>
                      {itemType !== "todo" && (
                        <input
                          type="date"
                          className={styles.chip}
                          value={itemDate || selectedDay.toISODate()!}
                          max={itemType === "block" ? itemEndDate || undefined : undefined}
                          onChange={(e) => setItemDate(e.target.value)}
                          aria-label={itemType === "block" ? "Start date" : "Date"}
                        />
                      )}
                      {itemType === "block" && (
                        <input
                          type="date"
                          className={styles.chip}
                          value={itemEndDate || itemDate || selectedDay.toISODate()!}
                          min={itemDate || selectedDay.toISODate()!}
                          onChange={(e) => setItemEndDate(e.target.value)}
                          aria-label="End date"
                        />
                      )}
                      {itemType === "block" && (
                        <label className={styles.chip} style={{ display: "inline-flex", alignItems: "center", gap: "4px", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={itemAllDay}
                            onChange={(e) => setItemAllDay(e.target.checked)}
                          />
                          All day
                        </label>
                      )}
                      {!(itemType === "block" && itemAllDay) && (
                        <span className={styles.chip}>
                          <input
                            type="time"
                            className={styles.chipTimeInput}
                            value={itemStartDraft}
                            onChange={(e) => setItemStartDraft(e.target.value)}
                            aria-label="Start time"
                          />
                          <span className={styles.todoTimeSep}>–</span>
                          <input
                            type="time"
                            className={styles.chipTimeInput}
                            value={itemEndDraft}
                            onChange={(e) => setItemEndDraft(e.target.value)}
                            aria-label="End time"
                          />
                        </span>
                      )}
                      {itemType !== "block" && (
                        <input
                          className={styles.chip}
                          value={itemWhereDraft}
                          placeholder={itemType === "todo" ? "Location, link, or phone" : "Location"}
                          onChange={(e) => setItemWhereDraft(e.target.value)}
                        />
                      )}
                      {/* Repeat is offered for every type now, including
                          Actionables (a repeating actionable is a RecurringTodo).
                          Monthly options are shown for actionables and events, but
                          not reserved blocks: the block occurrence expander shifts
                          its anchor by whole weeks, which is correct for weekly but
                          would break a monthly phase. */}
                      {/* Labeled so the recurrence control is discoverable: a
                          bare "Does not repeat" dropdown didn't read as "this is
                          how you make it repeat". The visible "Repeat" tag names
                          it. */}
                      <label className={styles.repeatChip}>
                        <span className={styles.repeatLabel}>Repeat</span>
                        <select
                          className={styles.repeatSelect}
                          value={itemRecurrence}
                          onChange={(e) => setItemRecurrence(e.target.value as RecurrencePreset)}
                          aria-label="Repeat"
                        >
                          <option value="never">Does not repeat</option>
                          <option value="everyday">Every day</option>
                          <option value="weekly">Weekly</option>
                          <option value="weekdays">Weekdays</option>
                          {itemType !== "block" && <option value="monthly">Every month</option>}
                          {itemType !== "block" && <option value="monthlyLast">Monthly on the last day</option>}
                        </select>
                      </label>
                    </div>

                    {itemError && <p className={styles.addError}>{itemError}</p>}
                  </div>
              </li>
              )}
              {agendaItems.map((item, idx) => {
                const isTodo = item.kind === "todo";
                const isBlock = item.kind === "block";
                // A birthday is a read-only marker, not a to-do — it has no
                // checkbox and can't be toggled/checked off.
                const isBirthday = item.kind === "birthday";
                // Timed todos and blocks carry their own server-backed done
                // state (persisted across refresh); events and bookings use the
                // local, unpersisted check set.
                const on = isTodo || isBlock ? !!item.done : checked.has(item.key);
                const toggle = isTodo
                  ? () => void toggleTodoDone(item.todoId!, !item.done)
                  : isBlock
                    ? () => void toggleBlockDone(item.blockId!, !item.done)
                    : () => toggleChecked(item.key);
                const isEvent = item.kind === "event";
                // The item happening right now (start ≤ now < end): bold it, and
                // the now-line is overlaid on top of it at the true current-time
                // position (like the calendar grid crosses a tile).
                const isNow =
                  nowIndex >= 0 &&
                  !item.allDay &&
                  new Date(item.start).getTime() <= now.toMillis() &&
                  now.toMillis() < new Date(item.end).getTime();
                // How far through the in-progress item we are (0 = just started,
                // 1 = about to end), used to place the overlaid now-line.
                const nowFrac = isNow
                  ? Math.min(
                      1,
                      Math.max(
                        0,
                        (now.toMillis() - new Date(item.start).getTime()) /
                          (new Date(item.end).getTime() - new Date(item.start).getTime())
                      )
                    )
                  : 0;
                // Every kind except birthday maps to a modal item (see
                // detailItem.ts) — a fall-through here is the "row silently
                // isn't clickable" bug (regressions #28, #29).
                const detail = agendaDetailItem(item);
                const openDetail = detail ? () => setDetailItem(detail) : undefined;
                return (
                  <Fragment key={item.key}>
                    {/* When "now" lands in a gap (the next item hasn't started),
                        show the line as its own row above that item. */}
                    {idx === nowIndex && !isNow && (
                      <li ref={nowRef} className={styles.nowRow} aria-hidden="true">
                        <span className={styles.nowDot} />
                        <span className={styles.nowTime}>{now.toFormat("h:mm a")}</span>
                        <span className={styles.nowRule} />
                      </li>
                    )}
                  {/* Reminders fire before the item, so their indicator sits
                      ABOVE it — mirroring the follow-up row below. Shown for
                      events and bookings (the items a reminder can attach to). */}
                  {(isEvent || item.kind === "booking") && !isDemo && (
                    <li className={styles.reminderRow}>
                      <ReminderControl
                        compact
                        title={item.title}
                        startISO={item.start}
                        itemRef={
                          isEvent
                            ? { kind: "event", id: item.eventId!, account: item.accountEmail }
                            : { kind: "booking", id: item.key.replace(/^booking:/, "") }
                        }
                      />
                    </li>
                  )}
                  <li
                    ref={idx === nowIndex && isNow ? nowRef : undefined}
                    className={`${styles.row} ${on ? styles.rowChecked : ""} ${isNow ? styles.rowNow : ""}`}
                    style={
                      isNow
                        ? ({ borderColor: `var(${item.colorVar})`, "--now-top": `${nowFrac * 100}%` } as CSSProperties)
                        : undefined
                    }
                  >
                    {/* When "now" is inside this item, draw the timeline across it:
                        the hairline sits BEHIND the row content (text stays crisp),
                        with a dot at the left edge and a solid time pill parked in
                        the empty space on the right. */}
                    {idx === nowIndex && isNow && (
                      <>
                        <span className={styles.nowLine} aria-hidden="true" />
                        <span className={styles.nowLineDot} aria-hidden="true" />
                        <span className={styles.nowLineTime} aria-hidden="true">{now.toFormat("h:mm a")}</span>
                      </>
                    )}
                    {isBirthday ? (
                      // A birthday isn't a to-do — no checkbox, just a spacer so
                      // its title still lines up with the rows around it.
                      <span className={styles.checkboxSpacer} aria-hidden="true" />
                    ) : (
                      <button
                        className={styles.checkbox}
                        style={{ borderColor: `var(${item.colorVar})`, background: on ? `var(${item.colorVar})` : "transparent" }}
                        onClick={toggle}
                        aria-pressed={on}
                        aria-label={on ? "Mark not done" : "Mark done"}
                      >
                        {on && (
                          <svg className={styles.checkMark} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                            <path d="M2.5 6.2 L5 8.6 L9.5 3.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    )}
                    <div
                      className={`${styles.rowBody} ${openDetail ? styles.rowBodyOpen : ""}`}
                      role={openDetail ? "button" : undefined}
                      tabIndex={openDetail ? 0 : undefined}
                      onClick={openDetail}
                      onKeyDown={
                        openDetail
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                openDetail();
                              }
                            }
                          : undefined
                      }
                    >
                      <span className={styles.rowTitleRow}>
                        <span className={`${styles.rowTitle} ${isNow ? styles.rowTitleNow : ""}`}>{item.title}</span>
                        <span className={styles.tag} style={{ color: `var(${item.colorVar})` }}>
                          {item.kind === "event"
                            ? "Event"
                            : item.kind === "block"
                              ? "Reserved"
                              : item.kind === "todo"
                                ? "Actionable"
                                : item.kind === "birthday"
                                  ? "Birthday"
                                  : "Booking"}
                        </span>
                      </span>
                      <span className={styles.rowSub}>
                        <span className="tnum">
                          {item.allDay
                            ? "All day"
                            : formatRange(new Date(item.start), new Date(item.end), OWNER_TIMEZONE)}
                        </span>
                        {item.carriedOver && (
                          <>
                            <span className={styles.dot}>·</span>
                            <span className={styles.carried} title="Carried over from yesterday, still not done">
                              <CarriedIcon />
                              carried over
                            </span>
                          </>
                        )}
                        {item.recurring && (
                          <>
                            <span className={styles.dot}>·</span>
                            <span className={styles.carried} title="Seeded by a recurring schedule">
                              <RecurringIcon />
                              recurring
                            </span>
                          </>
                        )}
                        {item.kind === "booking" && item.attendeeName && (
                          <>
                            <span className={styles.dot}>·</span>
                            {item.attendeeName}
                          </>
                        )}
                        {isTodo && (item.location || item.videoLink || item.phone) && (
                          <>
                            <span className={styles.dot}>·</span>
                            <TodoWhere location={item.location} videoLink={item.videoLink} phone={item.phone} />
                          </>
                        )}
                      </span>
                    </div>
                    {/* The bell that CREATES a reminder. Actionables always had
                        one here; events and bookings only had the compact
                        indicator above the row, which hides itself when no
                        reminder exists — so there was no way to add a first
                        reminder to an event from the agenda at all. Same
                        control, same place, for every item a reminder can
                        attach to. */}
                    {!isDemo && (isTodo || isEvent || item.kind === "booking") && (
                      <ReminderControl
                        title={item.title}
                        startISO={item.start}
                        itemRef={
                          isTodo
                            ? { kind: "todo", id: item.todoId! }
                            : isEvent
                              ? { kind: "event", id: item.eventId!, account: item.accountEmail }
                              : { kind: "booking", id: item.key.replace(/^booking:/, "") }
                        }
                      />
                    )}
                  </li>
                  {isEvent && !isDemo && (
                    <AgendaFollowups
                      items={followupsByKey.get(item.key) ?? []}
                      onToggle={(id, done) => toggleFollowup(item.key, id, done)}
                      onDelete={(id) => deleteFollowup(item.key, id)}
                      onAdd={(title) => void addFollowup(item.key, title)}
                    />
                  )}
                  </Fragment>
                );
              })}
              {nowIndex === agendaItems.length && agendaItems.length > 0 && (
                <li ref={nowRef} className={styles.nowRow} aria-hidden="true">
                  <span className={styles.nowDot} />
                  <span className={styles.nowTime}>{now.toFormat("h:mm a")}</span>
                  <span className={styles.nowRule} />
                </li>
              )}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Reserved time</span>
            <span className={styles.count}>{blocks.length}</span>
          </div>
          <ul className={styles.list}>
            {blocks.map((block) => {
              const start = new Date(block.startTime);
              const end = new Date(block.endTime);
              const overnight = isOvernight(start, end, block.timezone);
              const colorVar = "--state-busy";
              const on = block.done;
              return (
                <li
                  key={block.id}
                  className={`${styles.row} ${on ? styles.rowChecked : ""} ${!block.visible ? styles.rowHidden : ""}`}
                >
                  <button
                    className={styles.checkbox}
                    style={{ borderColor: `var(${colorVar})`, background: on ? `var(${colorVar})` : "transparent" }}
                    onClick={() => void toggleBlockDone(block.id, !block.done)}
                    aria-pressed={on}
                    aria-label={on ? "Mark active" : "Mark done"}
                  >
                    {on && (
                      <svg className={styles.checkMark} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                        <path d="M2.5 6.2 L5 8.6 L9.5 3.6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </button>
                  <div
                    className={`${styles.rowBody} ${styles.rowBodyOpen}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Edit ${block.title}`}
                    onClick={() => setEditBlock(block)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setEditBlock(block);
                      }
                    }}
                  >
                    <span className={styles.rowTitle}>{block.title}</span>
                    <span className={styles.rowSub}>
                      <span className="tnum">{formatRange(start, end, block.timezone)}</span>
                      <span className={styles.dot}>·</span>
                      <span className={styles.recur} style={{ color: `var(${colorVar})` }}>
                        ↻ {friendlyRecurrence(block.recurrenceRule, overnight)}
                      </span>
                    </span>
                  </div>
                  <button
                    className={styles.editBtn}
                    onClick={() => setEditBlock(block)}
                    aria-label={`Edit ${block.title}`}
                    title="Edit"
                  >
                    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                      <path
                        d="M2.5 13.5l.9-3.1 6.6-6.6 2.2 2.2-6.6 6.6-3.1.9Z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinejoin="round"
                      />
                      <path d="M9 4.5l2.2 2.2" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                  </button>
                  <button
                    className={styles.visToggle}
                    onClick={() => void toggleBlockVisible(block)}
                    aria-pressed={block.visible}
                    aria-label={block.visible ? `Hide ${block.title}` : `Show ${block.title}`}
                  >
                    {block.visible ? (
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <path
                          d="M1 8s2.7-4.5 7-4.5S15 8 15 8s-2.7 4.5-7 4.5S1 8 1 8Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinejoin="round"
                        />
                        <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                        <path
                          d="M1 8s2.7-4.5 7-4.5S15 8 15 8s-2.7 4.5-7 4.5S1 8 1 8Z"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinejoin="round"
                        />
                        <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
                        <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                      </svg>
                    )}
                  </button>
                  <button
                    className={styles.rowDelete}
                    onClick={() => setPendingDelete(block)}
                    aria-label={`Delete ${block.title}`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
            <li>
              <button className={styles.newBlockRow} onClick={() => setSheetOpen(true)}>
                <span className={styles.plus}>+</span> New block
              </button>
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>Upcoming bookings</span>
            <span className={styles.count}>{confirmedBookings.length}</span>
          </div>
          {upcomingBookings.length === 0 ? (
            <p className={styles.empty}>No upcoming bookings.</p>
          ) : (
            <ul className={styles.list}>
              {upcomingBookings.map((bk) => {
                const cancelled = bk.status === "cancelled";
                return (
                <li key={bk.id} className={`${styles.row} ${cancelled ? styles.rowCancelled : ""}`}>
                  <span className={styles.bookingDot} />
                  {/* Opens the same booking detail modal as the agenda and the
                      calendar grid. This row was the last booking surface left
                      unclickable (regression #29). */}
                  <div
                    className={`${styles.rowBody} ${styles.rowBodyOpen}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailItem(upcomingBookingDetailItem(bk))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setDetailItem(upcomingBookingDetailItem(bk));
                      }
                    }}
                  >
                    <span className={styles.rowTitle}>{bk.title}</span>
                    <span className={styles.rowSub}>
                      {/* Show the booking in the OWNER's timezone, like the rest
                          of the dashboard (calendar grid + event detail). It used
                          to render the ATTENDEE's zone here, so the same booking
                          appeared at two different times/zones across the owner's
                          own views. See docs/REGRESSIONS.md. */}
                      <span className="tnum">
                        {relativeDayTime(new Date(bk.startTime), OWNER_TIMEZONE)}
                      </span>
                      <span className={styles.dot}>·</span>
                      {OWNER_TIMEZONE}
                      <span className={styles.dot}>·</span>
                      {/* Was the hard-coded string "Confirmed", so a cancelled
                          booking that reached this list announced itself as
                          confirmed. Read the real status. */}
                      <span className={cancelled ? styles.cancelledTag : styles.confirmed}>
                        {cancelled ? "Cancelled" : "Confirmed"}
                      </span>
                    </span>
                  </div>
                  {/* Nothing to cancel twice — a cancelled row offers a way to
                      clear it from the list instead. It hides the row; the
                      booking record itself is kept. */}
                  {cancelled ? (
                    <button
                      className={styles.rowDismiss}
                      onClick={() => void dismissBooking(bk.id)}
                      aria-label={`Dismiss cancelled booking: ${bk.title}`}
                      title="Remove from this list (hides it in 24h anyway)"
                    >
                      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                        <path
                          d="M2.8 4.2h10.4M6.4 4.2V3a.8.8 0 0 1 .8-.8h1.6a.8.8 0 0 1 .8.8v1.2M4.3 4.2l.6 8.6a1 1 0 0 0 1 .93h4.2a1 1 0 0 0 1-.93l.6-8.6M6.6 6.8v4.3M9.4 6.8v4.3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  ) : (
                    <button
                      className={styles.rowDelete}
                      onClick={() => setPendingBookingCancel(bk)}
                      aria-label={`Cancel booking: ${bk.title}`}
                      title="Cancel booking"
                    >
                      ×
                    </button>
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Recurring actionables. Their own section so a series is visible the
            moment it's set up — not only on the first day it seeds a to-do.
            Without this, "pay rent, last day of every month" created on the 30th
            shows nothing until the 31st, and setup looks like it silently failed. */}
        {!isDemo && recurring.length > 0 && (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>Recurring</span>
              <span className={styles.count}>{recurring.length}</span>
            </div>
            <ul className={styles.list}>
              {recurring.map((r) => {
                const next = r.nextOccurrence
                  ? DateTime.fromISO(r.nextOccurrence, { zone: OWNER_TIMEZONE }).startOf("day")
                  : null;
                const today = DateTime.now().setZone(OWNER_TIMEZONE).startOf("day");
                const nextLabel = next
                  ? next.equals(today)
                    ? "today"
                    : next.equals(today.plus({ days: 1 }))
                      ? "tomorrow"
                      : next.toFormat("EEE, MMM d")
                  : "no more occurrences";
                return (
                  <li key={r.id} className={styles.row}>
                    <span className={styles.recurringMark} aria-hidden="true">
                      <RecurringIcon />
                    </span>
                    {/* Clickable title opens the detail/edit panel, the same way
                        an actionable or event row does. */}
                    <div
                      className={`${styles.rowBody} ${styles.rowBodyOpen}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setRecurringDetail(r)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setRecurringDetail(r);
                        }
                      }}
                    >
                      <span className={styles.rowTitle}>{r.title}</span>
                      <span className={styles.rowSub}>
                        {r.cadence}
                        <span className={styles.dot}>·</span>
                        <span className="tnum">Next: {nextLabel}</span>
                      </span>
                    </div>
                    <button
                      className={styles.rowDelete}
                      onClick={() => setPendingRecurringCancel(r)}
                      aria-label={`Cancel recurring actionable: ${r.title}`}
                      title="Stop this recurring actionable"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>

      {(sheetOpen || editBlock) && (
        <NewBlockSheet
          block={editBlock ?? undefined}
          onClose={() => {
            setSheetOpen(false);
            setEditBlock(null);
          }}
          onCreated={() => {
            setSheetOpen(false);
            setEditBlock(null);
            void reload();
            onScheduleChange?.();
          }}
        />
      )}

      {detailItem && (
        <EventModal
          item={detailItem}
          onClose={() => {
            setDetailItem(null);
            // Backstop: also refetch on close in case a write is still settling.
            void reloadFollowups();
          }}
          onChanged={() => {
            void reload();
            onScheduleChange?.();
          }}
          // Refetch as soon as each modal follow-up write resolves (race-free).
          onFollowupsChanged={() => void reloadFollowups()}
        />
      )}

      {recurringDetail && (
        <RecurringModal
          row={recurringDetail}
          onClose={() => setRecurringDetail(null)}
          onSaved={() => {
            void reload();
            onScheduleChange?.();
          }}
          onStop={(r) => {
            setRecurringDetail(null);
            setPendingRecurringCancel(r);
          }}
          onGoToDay={(iso) => onSelectDate?.(DateTime.fromISO(iso, { zone: OWNER_TIMEZONE }))}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete “${pendingDelete.title}”?`}
          body="This removes the reserved block and all its occurrences. This can’t be undone."
          confirmLabel="Delete block"
          busy={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            setDeleting(true);
            await deleteBlock(pendingDelete.id);
            setDeleting(false);
            setPendingDelete(null);
          }}
        />
      )}

      {pendingBookingCancel && (
        <ConfirmDialog
          title={`Cancel “${pendingBookingCancel.title}”?`}
          body="This removes the meeting from your calendar and emails the attendee that it’s cancelled. This can’t be undone."
          confirmLabel="Cancel booking"
          cancelLabel="Keep booking"
          busy={cancellingBooking}
          onCancel={() => setPendingBookingCancel(null)}
          onConfirm={async () => {
            setCancellingBooking(true);
            await cancelBookingRow(pendingBookingCancel.id);
            setCancellingBooking(false);
            setPendingBookingCancel(null);
          }}
        />
      )}

      {pendingRecurringCancel && (
        <ConfirmDialog
          title={`Stop “${pendingRecurringCancel.title}”?`}
          body="This stops the recurring schedule from adding any more days. To-dos it already created stay on your list."
          confirmLabel="Stop recurring"
          cancelLabel="Keep it"
          busy={cancellingRecurring}
          onCancel={() => setPendingRecurringCancel(null)}
          onConfirm={async () => {
            setCancellingRecurring(true);
            await cancelRecurring(pendingRecurringCancel.id);
            setCancellingRecurring(false);
            setPendingRecurringCancel(null);
          }}
        />
      )}

    </div>
  );
}
