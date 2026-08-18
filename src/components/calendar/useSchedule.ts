"use client";

import { useEffect, useState } from "react";
import type { DateTime } from "luxon";
import { CalendarItem, ScheduleApiResponse, toCalendarItems } from "./types";

export interface ScheduleState {
  items: CalendarItem[];
  warnings: Array<{ email: string; message: string }>;
  loading: boolean;
  error: string | null;
  /// Epoch ms of the last SUCCESSFUL pull from the providers (null until the
  /// first one). Preserved across a failed refetch so the indicator keeps
  /// showing when data was genuinely last synced.
  fetchedAt: number | null;
}

/// Fetch the merged schedule for [rangeStart, rangeEnd] (local DateTimes; sent
/// to the API as UTC ISO). Refetches when the range or `reloadKey` changes.
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
    fetchedAt: null,
  });

  const startIso = rangeStart.toUTC().toISO();
  const endIso = rangeEnd.toUTC().toISO();

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    const url = `/api/schedule?start=${encodeURIComponent(startIso ?? "")}&end=${encodeURIComponent(endIso ?? "")}`;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`schedule request failed: ${res.status}`);
        return (await res.json()) as ScheduleApiResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setState({
          items: toCalendarItems(data),
          warnings: data.warnings,
          loading: false,
          error: null,
          fetchedAt: Date.now(),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // Keep the previous fetchedAt — a failed refetch didn't re-sync.
        setState((s) => ({ ...s, items: [], warnings: [], loading: false, error: String(err) }));
      });

    return () => {
      cancelled = true;
    };
  }, [startIso, endIso, reloadKey]);

  return state;
}
