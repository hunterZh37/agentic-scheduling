"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE, GRID_START_HOUR, GRID_END_HOUR, HOUR_PX, DEFAULT_SCROLL_HOUR } from "@/lib/clientConfig";
import { accountVar } from "@/lib/design/accounts";
import { useAccountLabels } from "@/components/calendars/useAccountLabels";
import { formatRange, formatTimeCompact } from "@/lib/timeFormat";
import { useSchedule } from "./useSchedule";
import { layoutDay } from "./layout";
import type { CalendarItem } from "./types";
import { EventModal } from "./EventModal";
import { Spinner } from "@/components/ui/Spinner";
import styles from "./CalendarView.module.css";

type View = "day" | "week" | "month";

export interface CalendarViewProps {
  initialView?: View;
  /// Hide the toolbar's Day/Week/Month switch (used inside the fixed 3-pane).
  lockView?: boolean;
  reloadKey?: number;
  /// When provided, render these items instead of fetching (design QA / demos).
  itemsOverride?: CalendarItem[];
  /// Rendered at the very start of the toolbar (e.g. window traffic lights).
  leading?: React.ReactNode;
  /// Rendered at the very end of the toolbar (e.g. a theme toggle).
  trailing?: React.ReactNode;
  /// Show the built-in account legend row (default true; the 3-pane renders its
  /// own legend as a footer instead).
  showLegend?: boolean;
  /// The day highlighted as "selected" (week/month clickable days, day view).
  /// When provided the calendar becomes day-selectable; the parent owns the value.
  selectedDate?: DateTime;
  /// Called with the day the user clicks in the week/month grid (or navigates to
  /// in day view). Enables the selectable-day affordances when present.
  onSelectDate?: (date: DateTime) => void;
  /// Called after an event is edited/deleted from the detail modal, so the
  /// parent can refresh sibling panes (e.g. the Blocks agenda).
  onScheduleChange?: () => void;
  /// Called after each successful pull from the providers, so the parent can
  /// show a "last synced" indicator. `warnings` is how many accounts didn't sync.
  onSynced?: (info: { at: number; warnings: number }) => void;
}

/// React key for a rendered item.
///
/// `item.id` is an IDENTITY ("event:<providerId>") and is parsed as one in three
/// places — EventModal strips the prefix to get the provider id for edit and
/// delete, and followupKey builds the occurrence key from it. So the occurrence
/// start cannot be baked into the id itself.
///
/// It does have to be in the KEY: providers return the same event id for every
/// occurrence of a recurring series, and an overnight item can put two
/// occurrences in one range. Blocks already do this (`block:<id>:<start>` in
/// types.ts); events were missed.
///
/// The ACCOUNT is needed too. One meeting the owner is on from two connected
/// calendars comes back twice with the same provider id AND the same start —
/// deliberately, since each is that calendar's copy and they carry different
/// colours. Without the account in the key React warned "two children with the
/// same key" on every dashboard load, and may drop or duplicate a tile.
const renderKey = (item: { id: string; start: Date; accountEmail?: string }) =>
  `${item.id}:${item.start.toISOString()}:${item.accountEmail ?? ""}`;

const HOURS = Array.from(
  { length: GRID_END_HOUR - GRID_START_HOUR + 1 },
  (_, i) => GRID_START_HOUR + i
);
const GRID_HEIGHT = (GRID_END_HOUR - GRID_START_HOUR) * HOUR_PX;

export function CalendarView({
  initialView = "week",
  lockView = false,
  reloadKey = 0,
  itemsOverride,
  leading,
  trailing,
  showLegend = true,
  selectedDate,
  onSelectDate,
  onScheduleChange,
  onSynced,
}: CalendarViewProps) {
  const [view, setView] = useState<View>(initialView);
  const [selected, setSelected] = useState<CalendarItem | null>(null);
  const [anchor, setAnchor] = useState<DateTime>(() =>
    DateTime.now().setZone(OWNER_TIMEZONE).startOf("day")
  );
  const [now, setNow] = useState<DateTime>(() => DateTime.now().setZone(OWNER_TIMEZONE));

  // In day view the shown day and the selected day are one and the same, so the
  // day view follows selectedDate when the parent controls it (else the anchor).
  const dayShown = selectedDate ?? anchor;

  // Advance the current-time line each minute. Also refresh when the tab regains
  // visibility/focus: browsers pause setInterval in backgrounded tabs and while
  // the machine sleeps, so a tab left open across midnight would otherwise keep
  // pointing "today" at yesterday until the throttled interval eventually fired.
  useEffect(() => {
    const tick = () => setNow(DateTime.now().setZone(OWNER_TIMEZONE));
    // Re-seed from the real client clock on mount: the useState initializer runs
    // during SSR/prerender (baked at build time, possibly a prior day), and React
    // hydration keeps that stale value — so "today" could point at yesterday on
    // first load until the interval eventually caught up.
    tick();
    const id = setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
    };
  }, []);

  const days = useMemo(() => {
    if (view === "day") return [dayShown];
    if (view === "week") {
      const weekStart = anchor.startOf("week"); // Monday (ISO)
      return Array.from({ length: 7 }, (_, i) => weekStart.plus({ days: i }));
    }
    // Month: a 6-week grid starting on the Sunday on/before the 1st.
    const first = anchor.startOf("month");
    const gridStart = first.minus({ days: first.weekday % 7 });
    return Array.from({ length: 42 }, (_, i) => gridStart.plus({ days: i }));
  }, [view, anchor, dayShown]);

  const rangeStart = days[0].startOf("day");
  const rangeEnd = days[days.length - 1].endOf("day");
  // Bump to force a refetch without waiting on the parent-controlled reloadKey.
  const [retryNonce, setRetryNonce] = useState(0);
  const fetched = useSchedule(rangeStart, rangeEnd, reloadKey + retryNonce);
  const items = itemsOverride ?? fetched.items;
  // itemsOverride (design QA / demos) bypasses the fetch entirely, so its
  // loading/error/warnings state is meaningless — ignore it in that case.
  const showFetchState = !itemsOverride;

  // Report each successful provider pull upward for the "last synced" indicator.
  useEffect(() => {
    if (itemsOverride || fetched.fetchedAt === null) return;
    onSynced?.({ at: fetched.fetchedAt, warnings: fetched.warnings.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched.fetchedAt]);

  const title = useMemo(() => {
    if (view === "day") return dayShown.toFormat("cccc '·' LLLL d");
    if (view === "week") return days[0].toFormat("LLLL yyyy");
    return anchor.toFormat("LLLL yyyy");
  }, [view, anchor, dayShown, days]);

  const go = (dir: -1 | 1) => {
    // Day view: stepping the shown day also moves the selected day so the two
    // stay in lockstep. Week/month just move the anchor as before.
    if (view === "day") {
      const next = dayShown.plus({ days: dir });
      setAnchor(next);
      onSelectDate?.(next);
      return;
    }
    setAnchor((a) => a.plus({ [view === "week" ? "weeks" : "months"]: dir }));
  };
  const goToday = () => {
    const nowLocal = DateTime.now().setZone(OWNER_TIMEZONE);
    const today = nowLocal.startOf("day");
    // "Today" is an explicit "sync to the current moment" action — refresh `now`
    // too, so the "today" pill / now-line land on the real today immediately even
    // if the seeded `now` had gone stale (long-open tab, or SSR-baked value).
    setNow(nowLocal);
    setAnchor(today);
    // Also snap the selected day back to today so the Blocks pane's agenda
    // resets, not just the calendar view (in Month/Week the day selection
    // otherwise lingers on whatever was last clicked).
    onSelectDate?.(today);
  };

  return (
    <div className={styles.root}>
      <Toolbar
        title={title}
        view={view}
        lockView={lockView}
        leading={leading}
        trailing={trailing}
        onView={setView}
        onPrev={() => go(-1)}
        onNext={() => go(1)}
        onToday={goToday}
      />
      {showLegend && <Legend />}
      {showFetchState && fetched.loading && (
        <div className={styles.statusBar}>
          <Spinner label="Loading schedule" /> Loading…
        </div>
      )}
      {showFetchState && fetched.error && !fetched.loading && (
        <div className={styles.errorBar}>
          <span>Couldn&apos;t load your schedule.</span>
          <button className={styles.retryBtn} onClick={() => setRetryNonce((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      {showFetchState && !fetched.loading && fetched.warnings.length > 0 && (
        <div className={styles.warnBar}>
          {fetched.warnings.length} account{fetched.warnings.length > 1 ? "s" : ""} didn&apos;t sync:{" "}
          {fetched.warnings.map((w) => w.email).join(", ")}
        </div>
      )}
      {view === "month" ? (
        <MonthGrid
          days={days}
          items={items}
          now={now}
          anchorMonth={anchor}
          onSelect={setSelected}
          selectedDate={selectedDate}
          onSelectDay={onSelectDate}
        />
      ) : (
        <Grid
          days={days}
          // Birthdays are all-day, zero-duration markers rendered only by
          // MonthGrid (and the agenda) — the timed grid has no slot for them.
          items={items.filter((it) => it.kind !== "birthday")}
          now={now}
          single={view === "day"}
          onSelect={setSelected}
          selectedDate={selectedDate}
          onSelectDay={onSelectDate}
        />
      )}
      {selected && (
        <EventModal
          item={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setRetryNonce((n) => n + 1);
            onScheduleChange?.();
          }}
        />
      )}
    </div>
  );
}

function Toolbar({
  title,
  view,
  lockView,
  leading,
  trailing,
  onView,
  onPrev,
  onNext,
  onToday,
}: {
  title: string;
  view: View;
  lockView: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onView: (v: View) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  return (
    <div className={styles.toolbar}>
      <div className={styles.toolbarLeft}>
        {leading}
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.navGroup}>
          <button className={styles.iconBtn} onClick={onPrev} aria-label="Previous">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </button>
          <button className={styles.iconBtn} onClick={onNext} aria-label="Next">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </div>
        <button className={styles.todayBtn} onClick={onToday}>
          Today
        </button>
      </div>
      <div className={styles.toolbarRight}>
        {!lockView && (
          <div className={styles.segmented} role="tablist" aria-label="Calendar view">
            {(["day", "week", "month"] as View[]).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                className={`${styles.segment} ${view === v ? styles.segmentActive : ""}`}
                onClick={() => onView(v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        )}
        {trailing}
      </div>
    </div>
  );
}

function Legend() {
  // Real connected accounts, not a fixed example list — every account gets a
  // stable color from accountVar() with zero configuration (see lib/design/accounts.ts).
  // Colour keys off the address; the text is whatever the owner named it.
  const accounts = useAccountLabels();

  return (
    <div className={styles.legend}>
      {accounts.map((a) => (
        <span key={a.email} className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: `var(${accountVar(a.email)})` }} />
          {a.label}
        </span>
      ))}
      <span className={styles.legendItem}>
        <span className={styles.legendReserved} />
        Personal block (reserved)
      </span>
    </div>
  );
}

function Grid({
  days,
  items,
  now,
  single,
  onSelect,
  selectedDate,
  onSelectDay,
}: {
  days: DateTime[];
  items: CalendarItem[];
  now: DateTime;
  single: boolean;
  onSelect: (item: CalendarItem) => void;
  selectedDate?: DateTime;
  onSelectDay?: (day: DateTime) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Open scrolled to the working day even though the full 24h is rendered.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = (DEFAULT_SCROLL_HOUR - GRID_START_HOUR) * HOUR_PX;
    }
  }, []);
  return (
    <div className={styles.gridScroll} ref={scrollRef}>
      <div className={`${styles.grid} ${single ? styles.gridSingle : ""}`}>
        {/* Day headers */}
        <div className={styles.gutterCorner} />
        {days.map((day) => {
          const isToday = day.hasSame(now, "day");
          const isWeekend = day.weekday >= 6;
          const isSelected = selectedDate ? day.hasSame(selectedDate, "day") : false;
          const selectable = onSelectDay !== undefined;
          return (
            <div
              key={`h-${day.toISODate()}`}
              className={`${styles.dayHead} ${isWeekend ? styles.weekend : ""} ${
                selectable ? styles.dayHeadSelectable : ""
              } ${isSelected ? styles.dayHeadSelected : ""}`}
              role={selectable ? "button" : undefined}
              tabIndex={selectable ? 0 : undefined}
              aria-pressed={selectable ? isSelected : undefined}
              onClick={selectable ? () => onSelectDay(day) : undefined}
              onKeyDown={
                selectable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectDay(day);
                      }
                    }
                  : undefined
              }
            >
              <span className={styles.dayName}>{day.toFormat("ccc").toUpperCase()}</span>
              <span className={`${styles.dayNum} tnum ${isToday ? styles.dayNumToday : ""}`}>
                {day.toFormat("d")}
              </span>
            </div>
          );
        })}

        {/* Time gutter */}
        <div className={styles.gutter} style={{ height: GRID_HEIGHT }}>
          {HOURS.slice(0, -1).map((h, i) => (
            <div key={h} className={styles.gutterLabel} style={{ top: i * HOUR_PX }}>
              {DateTime.fromObject({ hour: h }).toFormat("h a")}
            </div>
          ))}
        </div>

        {/* Day columns */}
        {days.map((day) => {
          const dayStartUtc = day.startOf("day").toUTC().toJSDate();
          const dayEndUtc = day.endOf("day").toUTC().toJSDate();
          const dayItems = items.filter(
            (it) => it.end > dayStartUtc && it.start < dayEndUtc
          );
          const positioned = layoutDay(
            dayItems,
            day.startOf("day"),
            OWNER_TIMEZONE,
            GRID_START_HOUR,
            GRID_END_HOUR,
            HOUR_PX
          );
          const isToday = day.hasSame(now, "day");
          const isWeekend = day.weekday >= 6;
          const isSelected = selectedDate ? day.hasSame(selectedDate, "day") : false;
          const nowOffset = (now.hour + now.minute / 60 - GRID_START_HOUR) * HOUR_PX;
          const showNowLine = isToday && nowOffset >= 0 && nowOffset <= GRID_HEIGHT;

          return (
            <div
              key={`c-${day.toISODate()}`}
              className={`${styles.col} ${isToday ? styles.today : ""} ${
                isWeekend ? styles.weekend : ""
              } ${isSelected ? styles.colSelected : ""}`}
              style={{ height: GRID_HEIGHT }}
            >
              {positioned.map((p) => (
                <Tile key={renderKey(p.item)} item={p.item} top={p.top} height={p.height} laneIndex={p.laneIndex} laneCount={p.laneCount} onSelect={onSelect} />
              ))}
              {showNowLine && (
                <div className={styles.nowLine} style={{ top: nowOffset }}>
                  <span className={styles.nowDot} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Tile({
  item,
  top,
  height,
  laneIndex,
  laneCount,
  onSelect,
}: {
  item: CalendarItem;
  top: number;
  height: number;
  laneIndex: number;
  laneCount: number;
  onSelect: (item: CalendarItem) => void;
}) {
  const gap = 3;
  const widthPct = 100 / laneCount;
  const style: React.CSSProperties = {
    top,
    height,
    left: `calc(${laneIndex * widthPct}% + ${laneIndex === 0 ? 0 : gap / 2}px)`,
    width: `calc(${widthPct}% - ${laneCount > 1 ? gap : 0}px)`,
  };

  // Below this height there's only room for the title on one line.
  const showTime = height >= 38;

  if (item.kind === "block") {
    return (
      <div className={`${styles.tile} ${styles.blockTile}`} style={style} onClick={() => onSelect(item)}>
        <span className={styles.tileTitle}>{item.title}</span>
        {showTime && (
          <span className={`${styles.tileTime} tnum`}>{formatTimeCompact(item.start, OWNER_TIMEZONE)}</span>
        )}
      </div>
    );
  }

  // Actionables render as their own kind (accent, hollow ring) and open the
  // same detail modal as events.
  if (item.kind === "actionable") {
    return (
      <div className={`${styles.tile} ${styles.actionableTile}`} style={style} onClick={() => onSelect(item)}>
        <span className={styles.tileTitle}>◦ {item.title}</span>
        {showTime && (
          <span className={`${styles.tileTime} tnum`}>{formatTimeCompact(item.start, OWNER_TIMEZONE)}</span>
        )}
      </div>
    );
  }

  const accentVar =
    item.kind === "booking" ? "--state-booking" : accountVar(item.accountEmail ?? "");
  return (
    <div
      className={`${styles.tile} ${styles.eventTile}`}
      style={{ ...style, ["--tile-accent" as string]: `var(${accentVar})` }}
      onClick={() => onSelect(item)}
    >
      <span className={styles.tileTitle}>{item.title}</span>
      {showTime && (
        <span className={`${styles.tileTime} tnum`}>
          {height > 54 ? formatRange(item.start, item.end, OWNER_TIMEZONE) : formatTimeCompact(item.start, OWNER_TIMEZONE)}
        </span>
      )}
    </div>
  );
}

function MonthGrid({
  days,
  items,
  now,
  anchorMonth,
  onSelect,
  selectedDate,
  onSelectDay,
}: {
  days: DateTime[];
  items: CalendarItem[];
  now: DateTime;
  anchorMonth: DateTime;
  onSelect: (item: CalendarItem) => void;
  selectedDate?: DateTime;
  onSelectDay?: (day: DateTime) => void;
}) {
  const MAX_CHIPS = 3;
  return (
    <div className={styles.monthScroll}>
      <div className={styles.monthDow}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className={styles.monthGrid} role="grid" aria-label="Month, by day">
        {days.map((day) => {
          const dayStartUtc = day.startOf("day").toUTC().toJSDate();
          const dayEndUtc = day.endOf("day").toUTC().toJSDate();
          const dayItems = items
            .filter((it) => it.end > dayStartUtc && it.start < dayEndUtc)
            .sort((a, b) => a.start.getTime() - b.start.getTime());
          const inMonth = day.hasSame(anchorMonth, "month");
          const isToday = day.hasSame(now, "day");
          const isWeekend = day.weekday >= 6;
          const isSelected = selectedDate ? day.hasSame(selectedDate, "day") : false;
          const selectable = onSelectDay !== undefined;
          // Roving tabindex: exactly one cell is in the tab order (the selected
          // day, else today, else the grid's first day), and Arrow keys move
          // focus between cells. Without this, Tab walked all ~42 cells plus
          // every chip — the a11y finding from the dashboard critique.
          const isTabStop =
            selectable &&
            (isSelected ||
              (!selectedDate && isToday) ||
              (!selectedDate && !days.some((d) => d.hasSame(now, "day")) && day === days[0]));
          const itemLabel = dayItems.length
            ? `${dayItems.length} item${dayItems.length === 1 ? "" : "s"}`
            : "no items";
          return (
            <div
              key={day.toISODate()}
              data-day={day.toISODate()}
              className={`${styles.monthCell} ${inMonth ? "" : styles.monthCellMuted} ${isWeekend ? styles.weekend : ""} ${isToday ? styles.today : ""} ${
                selectable ? styles.monthCellSelectable : ""
              } ${isSelected ? styles.monthCellSelected : ""}`}
              role={selectable ? "gridcell" : undefined}
              tabIndex={selectable ? (isTabStop ? 0 : -1) : undefined}
              aria-selected={selectable ? isSelected : undefined}
              aria-label={
                selectable
                  ? `${day.toFormat("cccc, LLLL d")}, ${itemLabel}${isToday ? ", today" : ""}`
                  : undefined
              }
              onClick={selectable ? () => onSelectDay(day) : undefined}
              onKeyDown={
                selectable
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelectDay(day);
                        return;
                      }
                      const step: Record<string, number> = {
                        ArrowLeft: -1,
                        ArrowRight: 1,
                        ArrowUp: -7,
                        ArrowDown: 7,
                      };
                      const delta = step[e.key];
                      if (delta === undefined) return;
                      e.preventDefault();
                      const target = day.plus({ days: delta }).toISODate();
                      const grid = e.currentTarget.parentElement;
                      const next = grid?.querySelector<HTMLElement>(`[data-day="${target}"]`);
                      next?.focus();
                    }
                  : undefined
              }
            >
              <span className={`${styles.monthDayNum} tnum ${isToday ? styles.dayNumToday : ""}`}>
                {day.toFormat("d")}
              </span>
              <div className={styles.chips}>
                {dayItems.slice(0, MAX_CHIPS).map((it) => {
                  const accent =
                    it.kind === "block" || it.kind === "birthday"
                      ? undefined
                      : it.kind === "booking"
                        ? "--state-booking"
                        : it.kind === "actionable"
                          ? "--accent"
                          : accountVar(it.accountEmail ?? "");
                  return (
                    <button
                      key={renderKey(it)}
                      className={`${styles.chip} ${it.kind === "block" ? styles.chipBlock : ""} ${it.kind === "birthday" ? styles.chipBirthday : ""}`}
                      style={accent ? { ["--chip" as string]: `var(${accent})` } : undefined}
                      // Chips open the item's detail modal; don't let the click
                      // bubble to the day cell and change the selected day.
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(it);
                      }}
                    >
                      {it.kind !== "block" && it.kind !== "birthday" && <span className={styles.chipDot} />}
                      <span className={styles.chipTitle}>{it.title}</span>
                    </button>
                  );
                })}
                {dayItems.length > MAX_CHIPS && (
                  // Just "+N" — the word "more" truncated to "mor" in the narrow
                  // dashboard cell, which read as broken.
                  <span className={styles.moreChip}>+{dayItems.length - MAX_CHIPS}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
