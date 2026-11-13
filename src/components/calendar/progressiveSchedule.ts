import type { ApiEvent, ScheduleApiResponse } from "./types";

/// What the page has so far: everything loaded, plus the calendars still out.
export interface ScheduleSnapshot {
  data: ScheduleApiResponse;
  /// Emails of calendars whose events have not arrived yet.
  pending: string[];
  /// Each calendar's events as last received (seeds the next refresh).
  eventsByEmail: Map<string, ApiEvent[]>;
}

type Fetcher = (url: string, signal?: AbortSignal) => Promise<Response>;

/// Load the schedule so one slow calendar cannot hold up the rest (owner,
/// 2026-11-12: Outlook took ~21s and the whole calendar sat on "Loading…").
///
/// 1. `/api/schedule?events=none`: blocks, bookings, to-dos, birthdays and the
///    list of calendars. Resolves `base`.
/// 2. `/api/schedule/events?account=<id>` for each calendar, in parallel. Each
///    result is reported through `onUpdate` the moment it lands.
///
/// `previous` carries the last load's events for the SAME range: a calendar
/// keeps showing them until its fresh answer arrives, so a background refresh
/// does not blank the grid and refill it.
export function loadScheduleProgressively(
  startIso: string,
  endIso: string,
  onUpdate: (snap: ScheduleSnapshot) => void,
  opts: { previous?: Map<string, ApiEvent[]>; fetcher?: Fetcher; signal?: AbortSignal } = {}
): { base: Promise<void>; done: Promise<void> } {
  // `signal` cancels a superseded load (the owner paged on), so its calendar
  // reads stop instead of running out their deadline against the providers.
  const signal = opts.signal;
  const fetcher: Fetcher = opts.fetcher ?? ((url, sig) => fetch(url, { signal: sig }));
  const range = `start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;

  let resolveAll!: () => void;
  let rejectAll!: (err: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolveAll = res;
    rejectAll = rej;
  });
  // `done` rejects only when `base` does; callers await one or the other.
  done.catch(() => {});

  const base = fetcher(`/api/schedule?${range}&events=none`, signal)
    .then(async (res) => {
      if (!res.ok) throw new Error(`schedule request failed: ${res.status}`);
      return (await res.json()) as ScheduleApiResponse;
    })
    .then((first) => {
      const accounts = first.accounts ?? [];
      const eventsByEmail = new Map<string, ApiEvent[]>();
      for (const a of accounts) {
        const prev = opts.previous?.get(a.email);
        if (prev) eventsByEmail.set(a.email, prev);
      }
      const warnings = [...first.warnings];
      const pending = new Set(accounts.map((a) => a.email));
      const emit = () =>
        onUpdate({
          data: { ...first, events: [...eventsByEmail.values()].flat(), warnings: [...warnings] },
          pending: [...pending],
          eventsByEmail: new Map(eventsByEmail),
        });
      emit();

      const reads = accounts.map((a) =>
        fetcher(`/api/schedule/events?${range}&account=${encodeURIComponent(a.id)}`, signal)
          .then(async (res) => {
            // Hidden or removed since the list was read: deliberately gone, so
            // drop it quietly rather than call it a sync failure.
            if (res.status === 404) {
              eventsByEmail.delete(a.email);
              return;
            }
            if (!res.ok) throw new Error(`calendar request failed: ${res.status}`);
            const body = (await res.json()) as Pick<ScheduleApiResponse, "events" | "warnings">;
            if (body.warnings.length > 0) {
              // A failed read keeps nothing stale: the page says it didn't sync.
              eventsByEmail.delete(a.email);
              warnings.push(...body.warnings);
            } else {
              eventsByEmail.set(a.email, body.events);
            }
          })
          .catch((err: unknown) => {
            eventsByEmail.delete(a.email);
            warnings.push({ email: a.email, message: err instanceof Error ? err.message : String(err) });
          })
          .finally(() => {
            pending.delete(a.email);
            emit();
          })
      );
      void Promise.all(reads).then(() => resolveAll());
    });
  base.catch((err) => rejectAll(err));
  return { base, done };
}
