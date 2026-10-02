import { describe, it, expect, vi, beforeEach } from "vitest";

// "The event was created as a duplicate twice" (owner, 2026-10-02): one
// "Meeting with Yosef, 9 to 10" became two Google events a minute apart.
// Ledger #42 closed the same hole for actionables; create_event had no
// guard at all. Pinned here: an identical event already on that calendar
// is returned, not re-written; and two simultaneous identical calls write
// once.

const created = vi.fn();
const listed = vi.fn();
vi.mock("@/lib/calendar/write", () => ({ createDestinationEvent: (...a: unknown[]) => created(...a) }));
vi.mock("@/lib/calendar/read", () => ({ listEvents: (...a: unknown[]) => listed(...a) }));
vi.mock("@/lib/db", () => ({
  prisma: { account: { findFirst: vi.fn(async () => ({ id: "a1", email: "owner@example.com", refreshToken: "r", accessToken: "a", isDestination: true })), findUnique: vi.fn() } },
}));
vi.mock("@/lib/clientConfig", () => ({ OWNER_TIMEZONE: "America/Los_Angeles" }));

import { createEventTool } from "./tools";
import { recentWrites } from "./recentWrites";

const run = async (input: unknown) =>
  JSON.parse(await (createEventTool() as unknown as { run: (i: unknown) => Promise<string> }).run(input));
const args = { title: "Meeting with Yosef", startISO: "2026-10-02T16:00:00.000Z", endISO: "2026-10-02T17:00:00.000Z", addVideoLink: false };
const existing = {
  id: "evt_existing",
  accountEmail: "owner@example.com",
  title: "meeting with yosef ",
  start: new Date("2026-10-02T16:00:00.000Z"),
  end: new Date("2026-10-02T17:00:00.000Z"),
  allDay: false,
  attendees: [],
};

beforeEach(() => {
  created.mockReset().mockResolvedValue({ id: "evt_new" });
  listed.mockReset().mockResolvedValue([]);
  recentWrites.clear();
});

describe("create_event does not write the same event twice", () => {
  it("creates when nothing matches on that calendar", async () => {
    const r = await run(args);
    expect(r.ok).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
    expect(listed).toHaveBeenCalledWith(expect.objectContaining({ email: "owner@example.com" }), new Date(args.startISO), new Date(args.endISO));
  });

  it("returns the existing event (title case-insensitive, same start and end) instead of writing", async () => {
    listed.mockResolvedValue([existing]);
    const r = await run(args);
    expect(r.ok).toBe(true);
    expect(r.duplicate).toBe(true);
    expect(r.eventId).toBe("evt_existing");
    expect(created).not.toHaveBeenCalled();
  });

  it("still creates when only the time or the title differs", async () => {
    listed.mockResolvedValue([existing]);
    await run({ ...args, endISO: "2026-10-02T17:30:00.000Z" });
    await run({ ...args, title: "Meeting with Yosef (prep)" });
    expect(created).toHaveBeenCalledTimes(2);
  });

  it("asking to invite a guest to an event that exists without them still writes (the invite is not swallowed)", async () => {
    listed.mockResolvedValue([existing]);
    const r = await run({ ...args, attendees: [{ email: "yosef@example.com" }], meeting: "in_person", location: "Blue Bottle" });
    expect(r.duplicate).toBeUndefined();
    expect(r.invited).toEqual(["yosef@example.com"]);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("the same invite to the same guests twice writes once", async () => {
    listed.mockResolvedValue([{ ...existing, attendees: [{ email: "Yosef@example.com" }] }]);
    const r = await run({ ...args, attendees: [{ email: "yosef@example.com" }], meeting: "in_person", location: "Blue Bottle" });
    expect(r.duplicate).toBe(true);
    expect(created).not.toHaveBeenCalled();
  });

  it("two simultaneous identical calls write once", async () => {
    listed.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 30)); return []; });
    const [a, b] = await Promise.all([run(args), run(args)]);
    expect(created).toHaveBeenCalledTimes(1);
    expect([a.duplicate, b.duplicate].filter(Boolean)).toHaveLength(1);
    expect(a.eventId && b.eventId).toBeTruthy();
  });

  it("a failed lookup does not block the write", async () => {
    listed.mockRejectedValue(new Error("provider down"));
    const r = await run(args);
    expect(r.ok).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
  });
});
