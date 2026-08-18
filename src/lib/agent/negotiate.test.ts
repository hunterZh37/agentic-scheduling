import { describe, it, expect } from "vitest";
import { findMutualSlots, parseNegotiateBody } from "./negotiate";
import type { Interval } from "@/lib/availability/interval";

const d = (iso: string) => new Date(iso);
const iv = (s: string, e: string): Interval => ({ start: d(s), end: d(e) });
const show = (list: Interval[]) =>
  list.map((i) => `${i.start.toISOString()}/${i.end.toISOString()}`);

describe("findMutualSlots", () => {
  it("keeps host slots fully contained in a requester free window", () => {
    const host = [
      iv("2026-07-20T18:00:00Z", "2026-07-20T18:30:00Z"),
      iv("2026-07-20T19:00:00Z", "2026-07-20T19:30:00Z"),
    ];
    const free = [iv("2026-07-20T17:00:00Z", "2026-07-20T18:45:00Z")];
    expect(show(findMutualSlots(host, free))).toEqual([
      "2026-07-20T18:00:00.000Z/2026-07-20T18:30:00.000Z",
    ]);
  });

  it("drops host slots that only partially overlap a window", () => {
    const host = [iv("2026-07-20T18:00:00Z", "2026-07-20T18:30:00Z")];
    const free = [iv("2026-07-20T18:15:00Z", "2026-07-20T19:00:00Z")];
    expect(findMutualSlots(host, free)).toEqual([]);
  });

  it("drops adjacent-but-not-overlapping slots", () => {
    const host = [iv("2026-07-20T18:00:00Z", "2026-07-20T18:30:00Z")];
    const free = [iv("2026-07-20T18:30:00Z", "2026-07-20T19:00:00Z")];
    expect(findMutualSlots(host, free)).toEqual([]);
  });

  it("merges unsorted/overlapping requester windows before matching", () => {
    const host = [iv("2026-07-20T18:00:00Z", "2026-07-20T18:30:00Z")];
    const free = [
      iv("2026-07-20T18:20:00Z", "2026-07-20T19:00:00Z"),
      iv("2026-07-20T17:00:00Z", "2026-07-20T18:20:00Z"),
    ];
    expect(show(findMutualSlots(host, free))).toEqual([
      "2026-07-20T18:00:00.000Z/2026-07-20T18:30:00.000Z",
    ]);
  });

  it("returns [] for empty inputs", () => {
    expect(findMutualSlots([], [])).toEqual([]);
    expect(findMutualSlots([iv("2026-07-20T18:00:00Z", "2026-07-20T18:30:00Z")], [])).toEqual([]);
  });
});

const validBody = () => ({
  requesterName: "Ada Lovelace",
  requesterEmail: "ada@example.com",
  durationMinutes: 30,
  window: { startISO: "2026-07-20T00:00:00Z", endISO: "2026-07-22T00:00:00Z" },
  requesterFreeSlots: [
    { startISO: "2026-07-20T17:00:00Z", endISO: "2026-07-20T21:00:00Z" },
  ],
  timezone: "America/New_York",
});

describe("parseNegotiateBody", () => {
  it("accepts a well-formed body and parses dates", () => {
    const r = parseNegotiateBody(validBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.requesterName).toBe("Ada Lovelace");
    expect(r.value.durationMinutes).toBe(30);
    expect(r.value.windowStart.toISOString()).toBe("2026-07-20T00:00:00.000Z");
    expect(r.value.requesterFree).toHaveLength(1);
    expect(r.value.requesterFree[0].end.toISOString()).toBe("2026-07-20T21:00:00.000Z");
  });

  it("rejects a non-object body", () => {
    expect(parseNegotiateBody(null)).toEqual({ ok: false, error: "invalid_json" });
  });

  it("rejects a bad email", () => {
    expect(parseNegotiateBody({ ...validBody(), requesterEmail: "nope" })).toEqual({
      ok: false,
      error: "invalid_email",
    });
  });

  it("rejects a missing/blank name", () => {
    expect(parseNegotiateBody({ ...validBody(), requesterName: "  " })).toEqual({
      ok: false,
      error: "invalid_name",
    });
  });

  it("rejects a non-positive duration", () => {
    expect(parseNegotiateBody({ ...validBody(), durationMinutes: 0 })).toEqual({
      ok: false,
      error: "invalid_duration",
    });
  });

  it("rejects an inverted window", () => {
    expect(
      parseNegotiateBody({
        ...validBody(),
        window: { startISO: "2026-07-22T00:00:00Z", endISO: "2026-07-20T00:00:00Z" },
      })
    ).toEqual({ ok: false, error: "invalid_window" });
  });

  it("rejects a window wider than 60 days", () => {
    expect(
      parseNegotiateBody({
        ...validBody(),
        window: { startISO: "2026-07-20T00:00:00Z", endISO: "2026-10-20T00:00:00Z" },
      })
    ).toEqual({ ok: false, error: "range_too_large" });
  });

  it("rejects more than 100 free slots", () => {
    const many = Array.from({ length: 101 }, () => ({
      startISO: "2026-07-20T17:00:00Z",
      endISO: "2026-07-20T18:00:00Z",
    }));
    expect(parseNegotiateBody({ ...validBody(), requesterFreeSlots: many })).toEqual({
      ok: false,
      error: "range_too_large",
    });
  });

  it("rejects a malformed free slot", () => {
    expect(
      parseNegotiateBody({
        ...validBody(),
        requesterFreeSlots: [{ startISO: "not-a-date", endISO: "2026-07-20T18:00:00Z" }],
      })
    ).toEqual({ ok: false, error: "invalid_free_slots" });
  });

  it("rejects a missing/blank timezone", () => {
    expect(parseNegotiateBody({ ...validBody(), timezone: "  " })).toEqual({
      ok: false,
      error: "invalid_timezone",
    });
  });
});
