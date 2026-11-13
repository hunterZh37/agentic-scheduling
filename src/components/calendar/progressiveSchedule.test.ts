import { describe, it, expect } from "vitest";
import { loadScheduleProgressively, type ScheduleSnapshot } from "./progressiveSchedule";
import type { ApiEvent } from "./types";

// Owner, 2026-11-12: "Is there a way to say the Outlook email is slow, and show
// the other calendars first and the Outlook ones last, progressively?"
// One slow calendar used to hold the whole dashboard on "Loading…".

const START = "2026-11-12T08:00:00.000Z";
const END = "2026-11-13T08:00:00.000Z";

const ev = (id: string, accountEmail: string): ApiEvent =>
  ({ id, accountEmail, title: id, start: START, end: END }) as ApiEvent;

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const BASE = {
  events: [],
  blocks: [{ id: "b1", title: "Gym", start: START, end: END }],
  bookings: [],
  birthdays: [],
  warnings: [],
  accounts: [
    { id: "fast", email: "fast@example.com" },
    { id: "slow", email: "slow@example.com" },
  ],
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("loadScheduleProgressively", () => {
  it("shows the base and the fast calendar while the slow one is still out", async () => {
    const slow = deferred<Response>();
    const snaps: ScheduleSnapshot[] = [];
    const urls: string[] = [];
    const { base, done } = loadScheduleProgressively(START, END, (s) => snaps.push(s), {
      fetcher: (url) => {
        urls.push(url);
        if (url.includes("events=none")) return json(BASE);
        if (url.includes("account=fast")) return json({ events: [ev("f1", "fast@example.com")], warnings: [] });
        return slow.promise;
      },
    });

    await base;
    await new Promise((r) => setTimeout(r, 0));
    const mid = snaps[snaps.length - 1];
    expect(mid.data.blocks).toHaveLength(1);
    expect(mid.data.events.map((e) => e.id)).toEqual(["f1"]);
    expect(mid.pending).toEqual(["slow@example.com"]);

    slow.resolve(new Response(JSON.stringify({ events: [ev("s1", "slow@example.com")], warnings: [] })));
    await done;
    const last = snaps[snaps.length - 1];
    expect(last.data.events.map((e) => e.id).sort()).toEqual(["f1", "s1"]);
    expect(last.pending).toEqual([]);
    expect(urls[0]).toContain("/api/schedule?start=");
    expect(urls[0]).toContain("&events=none");
  });

  it("a calendar that fails becomes a warning and the rest still load", async () => {
    const snaps: ScheduleSnapshot[] = [];
    const { done } = loadScheduleProgressively(START, END, (s) => snaps.push(s), {
      fetcher: (url) => {
        if (url.includes("events=none")) return json(BASE);
        if (url.includes("account=fast")) return json({ events: [ev("f1", "fast@example.com")], warnings: [] });
        return json({ events: [], warnings: [{ email: "slow@example.com", message: "Didn't answer within 10 seconds." }] });
      },
    });
    await done;
    const last = snaps[snaps.length - 1];
    expect(last.data.events.map((e) => e.id)).toEqual(["f1"]);
    expect(last.data.warnings).toEqual([{ email: "slow@example.com", message: "Didn't answer within 10 seconds." }]);
  });

  it("a network error on one calendar is a warning, not a crash", async () => {
    const snaps: ScheduleSnapshot[] = [];
    const { done } = loadScheduleProgressively(START, END, (s) => snaps.push(s), {
      fetcher: (url) => {
        if (url.includes("events=none")) return json(BASE);
        if (url.includes("account=fast")) return json({ events: [], warnings: [] });
        return Promise.reject(new TypeError("Failed to fetch"));
      },
    });
    await done;
    expect(snaps[snaps.length - 1].data.warnings).toEqual([{ email: "slow@example.com", message: "Failed to fetch" }]);
  });

  it("a refresh keeps a calendar's last events until its fresh answer lands", async () => {
    const slow = deferred<Response>();
    const snaps: ScheduleSnapshot[] = [];
    const previous = new Map([["slow@example.com", [ev("old", "slow@example.com")]]]);
    const { base, done } = loadScheduleProgressively(START, END, (s) => snaps.push(s), {
      previous,
      fetcher: (url) => {
        if (url.includes("events=none")) return json(BASE);
        if (url.includes("account=fast")) return json({ events: [], warnings: [] });
        return slow.promise;
      },
    });
    await base;
    expect(snaps[0].data.events.map((e) => e.id)).toEqual(["old"]);
    slow.resolve(new Response(JSON.stringify({ events: [ev("new", "slow@example.com")], warnings: [] })));
    await done;
    expect(snaps[snaps.length - 1].data.events.map((e) => e.id)).toEqual(["new"]);
  });

  it("rejects base (and done) when the first request fails, so the page shows Retry", async () => {
    const { base, done } = loadScheduleProgressively(START, END, () => {}, {
      fetcher: () => json({ error: "boom" }, 500),
    });
    await expect(base).rejects.toThrow("schedule request failed: 500");
    await expect(done).rejects.toThrow("schedule request failed: 500");
  });

  it("no calendars connected: done still resolves", async () => {
    const { done } = loadScheduleProgressively(START, END, () => {}, {
      fetcher: () => json({ ...BASE, accounts: [] }),
    });
    await expect(done).resolves.toBeUndefined();
  });

  it("a calendar hidden or removed mid-load (404) is dropped quietly, not a sync failure", async () => {
    const snaps: ScheduleSnapshot[] = [];
    const { done } = loadScheduleProgressively(START, END, (s) => snaps.push(s), {
      fetcher: (url) => {
        if (url.includes("events=none")) return json(BASE);
        if (url.includes("account=fast")) return json({ events: [ev("f1", "fast@example.com")], warnings: [] });
        return json({ error: "not_found" }, 404);
      },
    });
    await done;
    const last = snaps[snaps.length - 1];
    expect(last.data.warnings).toEqual([]);
    expect(last.data.events.map((e) => e.id)).toEqual(["f1"]);
  });

  it("passes the abort signal to every request so a superseded load can be cancelled", async () => {
    const ctl = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const { done } = loadScheduleProgressively(START, END, () => {}, {
      signal: ctl.signal,
      fetcher: (url, signal) => {
        seen.push(signal);
        if (url.includes("events=none")) return json(BASE);
        return json({ events: [], warnings: [] });
      },
    });
    await done;
    expect(seen).toHaveLength(3);
    expect(seen.every((s) => s === ctl.signal)).toBe(true);
  });
});
