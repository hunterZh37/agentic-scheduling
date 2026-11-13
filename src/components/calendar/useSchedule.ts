"use client";

import { useEffect, useRef, useState } from "react";
import type { DateTime } from "luxon";
import { CalendarItem, toCalendarItems, type ApiEvent } from "./types";
import { loadScheduleProgressively } from "./progressiveSchedule";

/// How long a calendar may still be loading before the page names it.
/// Short enough to explain a wait, long enough that healthy calendars (which
/// answer in about a second) never flash a note.
export const SLOW_CALENDAR_NOTICE_MS = 1500;

export interface ScheduleState {
  items: CalendarItem[];
  warnings: Array<{ email: string; message: string }>;
  /// True until the first part (blocks, bookings, to-dos) has arrived.
  loading: boolean;
  error: string | null;
  /// Calendars still loading past SLOW_CALENDAR_NOTICE_MS (empty until then).
  slow: string[];
  /// Epoch ms of the last SUCCESSFUL pull from the providers (null until the
  /// first one). Preserved across a failed refetch so the indicator keeps
  /// showing when data was genuinely last synced. Set once every calendar has
  /// answered (or failed).
  fetchedAt: number | null;
}

/// Fetch the merged schedule for [rangeStart, rangeEnd] (local DateTimes; sent
/// to the API as UTC ISO). Refetches when the range or `reloadKey` changes.
/// Calendars arrive one by one (see progressiveSchedule.ts).
export function useSchedule(
  rangeStart: DateTime,
  rangeEnd: DateTime,
  reloadKey = 0
): ScheduleState {
  const [state, setState] = useState<ScheduleState>({
    items: [],
    warnings: [],
    loading: true,
    error: null,
    slow: [],
    fetchedAt: null,
  });
  // Last events per calendar, for the same range only: a refresh keeps them on
  // screen until each calendar's fresh answer lands.
  const previous = useRef<{ range: string; events: Map<string, ApiEvent[]> } | null>(null);

  const startIso = rangeStart.toUTC().toISO() ?? "";
  const endIso = rangeEnd.toUTC().toISO() ?? "";

  useEffect(() => {
    let cancelled = false;
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: string[] = [];
    let showSlow = false;
    const abort = new AbortController();
    const range = `${startIso}|${endIso}`;
    setState((s) => ({ ...s, loading: true, error: null, slow: [] }));

    const { base, done } = loadScheduleProgressively(
      startIso,
      endIso,
      (snap) => {
        if (cancelled) return;
        pending = snap.pending;
        previous.current = { range, events: snap.eventsByEmail };
        setState((s) => ({
          ...s,
          items: toCalendarItems(snap.data),
          warnings: snap.data.warnings,
          loading: false,
          error: null,
          slow: showSlow ? snap.pending : [],
        }));
      },
      {
        previous: previous.current?.range === range ? previous.current.events : undefined,
        signal: abort.signal,
      }
    );

    base.then(
      () => {
        slowTimer = setTimeout(() => {
          if (cancelled) return;
          showSlow = true;
          setState((s) => ({ ...s, slow: pending }));
        }, SLOW_CALENDAR_NOTICE_MS);
      },
      (err: unknown) => {
        if (cancelled) return;
        // Keep the previous fetchedAt: a failed refetch didn't re-sync.
        setState((s) => ({ ...s, items: [], warnings: [], slow: [], loading: false, error: String(err) }));
      }
    );
    done.then(() => {
      if (cancelled) return;
      clearTimeout(slowTimer);
      setState((s) => ({ ...s, slow: [], fetchedAt: Date.now() }));
    }, () => {});

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
      abort.abort();
    };
  }, [startIso, endIso, reloadKey]);

  return state;
}
