"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode, TouchEvent } from "react";
import { DateTime } from "luxon";
import { CalendarView } from "@/components/calendar/CalendarView";
import { BlocksPane } from "@/components/blocks/BlocksPane";
import { AgentPane } from "@/components/agent/AgentPane";
import { CalendarsManager } from "@/components/calendars/CalendarsManager";
import { useAccountLabels } from "@/components/calendars/useAccountLabels";
import { BirthdaysManager } from "@/components/birthdays/BirthdaysManager";
import { RemindersManager } from "@/components/reminders/RemindersManager";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { accountVar } from "@/lib/design/accounts";
import { haptic } from "@/lib/motion/haptics";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import styles from "./ThreePane.module.css";

/// Relative "Synced 2 min ago" label; "just now" under 45s, with a note when
/// some accounts failed to pull.
function syncedLabel(info: { at: number; warnings: number } | null): string {
  if (!info) return "Syncing…";
  const secs = (Date.now() - info.at) / 1000;
  const rel = secs < 45 ? "just now" : DateTime.fromMillis(info.at).toRelative() ?? "recently";
  const warn = info.warnings > 0 ? ` · ${info.warnings} didn't sync` : "";
  return `Synced ${rel}${warn}`;
}

function CalendarsLegend({
  onManage,
  onBirthdays,
  onReminders,
  lastSynced,
  onRefresh,
}: {
  onManage: () => void;
  onBirthdays: () => void;
  onReminders: () => void;
  lastSynced: { at: number; warnings: number } | null;
  onRefresh: () => void;
}) {
  // Real connected accounts, not a fixed example list — every account gets a
  // stable color from accountVar() with zero configuration (see lib/design/accounts.ts).
  // Colour keys off the address; the text is whatever the owner named it.
  const accounts = useAccountLabels();

  // Addresses stay collapsed by default. This bar sits along the bottom of the
  // dashboard, so every connected account's email was on screen permanently —
  // visible in screen shares, screenshots and over the shoulder, none of which
  // need it. The colour dots stay visible either way, so the legend still does
  // its job (mapping a colour to a calendar) without publishing the addresses.
  const [showEmails, setShowEmails] = useState(false);

  return (
    <div className={styles.legend}>
      <button
        className={styles.legendLabel}
        onClick={() => setShowEmails((v) => !v)}
        aria-expanded={showEmails}
        title={showEmails ? "Hide calendar addresses" : "Show calendar addresses"}
      >
        CALENDARS
        <span className={styles.legendChevron} aria-hidden="true">{showEmails ? "▾" : "▸"}</span>
      </button>
      {showEmails ? (
        accounts.map((a) => (
          <span key={a.email} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: `var(${accountVar(a.email)})` }} />
            {a.label}
          </span>
        ))
      ) : (
        <button
          className={styles.legendDots}
          onClick={() => setShowEmails(true)}
          title={`${accounts.length} connected — show addresses`}
        >
          {accounts.map((a) => (
            <span
              key={a.email}
              className={styles.legendDot}
              style={{ background: `var(${accountVar(a.email)})` }}
            />
          ))}
          <span className={styles.legendCount}>{accounts.length}</span>
        </button>
      )}
      <span className={styles.legendItem}>
        <span className={styles.legendReserved} />
        Reserved
      </span>
      <button
        className={`${styles.sync} ${lastSynced?.warnings ? styles.syncWarn : ""}`}
        onClick={onRefresh}
        title="Refresh all calendars now"
      >
        <span className={styles.syncDot} />
        {syncedLabel(lastSynced)}
      </button>
      <a
        className={styles.preview}
        href="/book?preview=1"
        target="_blank"
        rel="noopener noreferrer"
      >
        Preview booking page ↗
      </a>
      <button className={styles.birthdays} onClick={onBirthdays} title="Manage birthdays">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 21h16M5 21v-6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6M4 15c1.5 1 2.5 1 4 0s2.5-1 4 0 2.5 1 4 0 2.5-1 4 0M12 8V5m0 0a1.2 1.2 0 1 0 0-2 1.2 1.2 0 0 0 0 2z" />
        </svg>
        Birthdays
      </button>
      <button className={styles.reminders} onClick={onReminders} title="Manage reminders">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10.3 21a1.9 1.9 0 0 0 3.4 0" />
        </svg>
        Reminders
      </button>
      <button className={styles.manage} onClick={onManage}>Manage</button>
    </div>
  );
}

type Tab = "calendar" | "blocks" | "agent";
// Inline SVG icons, one 1.8px stroke weight, to match the app's drawn-icon
// system (the eye/pencil/trash/bell/cake glyphs) rather than mixing in unicode
// symbols. The agent mark reuses the four-point spark from AgentPane's avatar.
const svgProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  {
    id: "calendar",
    label: "Calendar",
    icon: (
      <svg {...svgProps}>
        <rect x="3" y="4.5" width="18" height="16" rx="2.5" />
        <path d="M3 9h18M8 2.5v4M16 2.5v4" />
      </svg>
    ),
  },
  {
    id: "blocks",
    label: "Blocks",
    icon: (
      <svg {...svgProps}>
        <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
      </svg>
    ),
  },
  {
    id: "agent",
    label: "Agent",
    icon: (
      <svg {...svgProps} fill="currentColor" stroke="none">
        <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
      </svg>
    ),
  },
];

/// The private "Today" workspace: merged day calendar · blocks · agent chat.
export function ThreePane() {
  const [managerOpen, setManagerOpen] = useState(false);
  const [birthdaysOpen, setBirthdaysOpen] = useState(false);
  const [remindersOpen, setRemindersOpen] = useState(false);
  // On phones the three panes can't sit side by side, so we show one at a time
  // and switch with the bottom tab bar. This state is ignored on desktop, where
  // CSS keeps all three panes visible in the grid regardless of its value.
  const [tab, setTab] = useState<Tab>("calendar");
  // Direction of the last mobile tab change, so the incoming pane can slide in
  // from the correct side ("next" = from the right, "prev" = from the left).
  // Null until the first switch, so the initial pane appears without animating.
  const [dir, setDir] = useState<"next" | "prev" | null>(null);
  // The day the user has selected across the calendar; drives the Blocks pane's
  // agenda section. Defaults to today in the owner's timezone.
  const [selectedDate, setSelectedDate] = useState<DateTime>(() =>
    DateTime.now().setZone(OWNER_TIMEZONE).startOf("day")
  );
  // Bumped whenever the Blocks pane mutates a block (visibility/delete/create)
  // so the separately-fetched CalendarView refetches and updates in real time.
  const [calRefresh, setCalRefresh] = useState(0);
  // The reverse: bumped when an event is edited/deleted from the calendar grid,
  // so the Blocks pane's agenda refetches too.
  const [blocksRefresh, setBlocksRefresh] = useState(0);
  // When the calendar last successfully pulled from all providers (drives the
  // "Synced X ago" indicator); warnings counts accounts that didn't sync.
  const [lastSynced, setLastSynced] = useState<{ at: number; warnings: number } | null>(null);

  // Force a pull from every calendar now (clicking the sync indicator).
  const refreshNow = () => {
    setCalRefresh((k) => k + 1);
    setBlocksRefresh((k) => k + 1);
  };
  // Re-render every 30s so the relative "Synced X ago" label stays current
  // between the periodic refetches.
  const [, setSyncTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSyncTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  // On mobile only the active tab's pane is displayed (the others are hidden via
  // CSS); on desktop `paneActive` is a no-op and every pane shows in the grid.
  // The active pane also carries a directional enter class so it slides in;
  // that class only has an effect inside the mobile media query.
  const paneClass = (id: Tab) => {
    const active = tab === id;
    const enter = active && dir ? (dir === "next" ? styles.enterNext : styles.enterPrev) : "";
    return `${styles.pane} ${active ? styles.paneActive : ""} ${enter}`;
  };

  // Switch tabs, remembering which way we moved so the pane can animate in from
  // the matching side. A no-op when already on the target tab.
  const goTo = (next: Tab) => {
    const from = TABS.findIndex((t) => t.id === tab);
    const to = TABS.findIndex((t) => t.id === next);
    if (to === from) return;
    haptic("select");
    setDir(to > from ? "next" : "prev");
    setTab(next);
  };

  // Mobile swipe-to-switch-tabs. Only the touch start point is stored; the
  // gesture is judged once on touchend by comparing net dx/dy so it never has
  // to preventDefault or fight the browser's native vertical scrolling.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (e: TouchEvent<HTMLDivElement>) => {
    const start = touchStart.current;
    touchStart.current = null;
    // Desktop shows all three panes at once, and a manager modal overlays
    // the window — a swipe over either shouldn't flip tabs underneath.
    if (!start || managerOpen || birthdaysOpen || remindersOpen || !window.matchMedia("(max-width: 768px)").matches) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    // Require a clearly horizontal, clearly deliberate swipe so vertical
    // scrolling in Blocks/Agent and taps on the agent input pass through.
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const idx = TABS.findIndex((t) => t.id === tab);
    // Left swipe advances, right swipe goes back; clamp at the ends (no wrap).
    const nextIdx = Math.min(TABS.length - 1, Math.max(0, idx + (dx < 0 ? 1 : -1)));
    if (nextIdx !== idx) goTo(TABS[nextIdx].id);
  };

  // Bookings and edits arrive from OUTSIDE this tab — a visitor books via the
  // public page, or the owner edits on another device — and nothing pushes them
  // in, so the dashboard would sit stale until a manual reload. Refetch both
  // panes when the tab regains focus/visibility, and on a slow interval while
  // visible, so new bookings surface on their own. Gated on visibility so a
  // backgrounded tab doesn't keep hitting the calendar APIs.
  //
  // The interval is deliberately long (5 min): each tick hits /api/schedule +
  // /api/blocks + /api/todos, which wakes the serverless DB. A tighter poll kept
  // Neon's compute awake continuously and burned the monthly compute allowance.
  // Focus/visibility refresh covers the common "came back to the tab" case, so a
  // foregrounded-but-idle tab rarely needs a fresher interval than this.
  useEffect(() => {
    const refresh = () => {
      setCalRefresh((k) => k + 1);
      setBlocksRefresh((k) => k + 1);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 300_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(id);
    };
  }, []);

  return (
    <div className={styles.window} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className={`${paneClass("calendar")} ${styles.calendarPane}`}>
        <div className={styles.calendarBody}>
          <CalendarView
            initialView="month"
            trailing={<ThemeToggle />}
            showLegend={false}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            reloadKey={calRefresh}
            onScheduleChange={() => setBlocksRefresh((k) => k + 1)}
            onSynced={setLastSynced}
          />
        </div>
        <CalendarsLegend
          onManage={() => setManagerOpen(true)}
          onBirthdays={() => setBirthdaysOpen(true)}
          onReminders={() => setRemindersOpen(true)}
          lastSynced={lastSynced}
          onRefresh={refreshNow}
        />
      </div>

      <div className={`${paneClass("blocks")} ${styles.blocksPane}`}>
        <BlocksPane
          selectedDate={selectedDate}
          onScheduleChange={() => setCalRefresh((k) => k + 1)}
          reloadKey={blocksRefresh}
          active={tab === "blocks"}
        />
      </div>

      <div className={`${paneClass("agent")} ${styles.agentPane}`}>
        <AgentPane
          label="your timezone"
          onAgentAction={() => {
            setCalRefresh((k) => k + 1);
            setBlocksRefresh((k) => k + 1);
          }}
        />
      </div>

      {/* Mobile-only bottom tab bar (hidden on desktop) to switch panes. */}
      <nav className={styles.tabBar} role="tablist" aria-label="Workspace">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ""}`}
            onClick={() => goTo(t.id)}
          >
            <span className={styles.tabIcon} aria-hidden>
              {t.icon}
            </span>
            {t.label}
          </button>
        ))}
      </nav>

      {managerOpen && <CalendarsManager onClose={() => setManagerOpen(false)} />}
      {birthdaysOpen && <BirthdaysManager onClose={() => setBirthdaysOpen(false)} />}
      {remindersOpen && <RemindersManager onClose={() => setRemindersOpen(false)} />}
    </div>
  );
}
