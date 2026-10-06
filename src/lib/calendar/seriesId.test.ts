import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/oauth/store", () => ({ getValidAccessToken: vi.fn(async () => "tok") }));

import { listEvents } from "./read";
import { Provider } from "@prisma/client";

// An occurrence of a recurring event must say which series it belongs to.
// Without it, "delete all the events with Benjamin" (owner, 2026-10-06) meant
// deleting 200+ occurrences one at a time through 2030 and still leaving the
// series alive; with it, one delete of the series id removes them all.

const window = [new Date("2026-10-01T00:00:00Z"), new Date("2026-10-31T00:00:00Z")] as const;

function stub(payload: unknown) {
  const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => payload, text: async () => "" }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
afterEach(() => vi.unstubAllGlobals());

describe("series id on recurring occurrences", () => {
  it("Microsoft: seriesMasterId is requested and mapped; a one-off has none", async () => {
    const fetchMock = stub({
      value: [
        { id: "occ_1", seriesMasterId: "master_1", subject: "w/ Benjamin", start: { dateTime: "2026-10-11T19:00:00.0000000" }, end: { dateTime: "2026-10-11T21:00:00.0000000" } },
        { id: "single_1", subject: "Dentist", start: { dateTime: "2026-10-12T16:00:00.0000000" }, end: { dateTime: "2026-10-12T17:00:00.0000000" } },
      ],
    });
    const events = await listEvents({ provider: Provider.microsoft, email: "o@outlook.com" } as never, ...window);
    expect(String(fetchMock.mock.calls[0][0])).toContain("seriesMasterId");
    expect(events.map((e) => [e.id, e.seriesId])).toEqual([
      ["occ_1", "master_1"],
      ["single_1", undefined],
    ]);
  });

  it("Google: recurringEventId is mapped; a one-off has none", async () => {
    stub({
      items: [
        { id: "occ_g", recurringEventId: "master_g", summary: "Gym", start: { dateTime: "2026-10-11T19:00:00Z" }, end: { dateTime: "2026-10-11T20:00:00Z" } },
        { id: "single_g", summary: "Lunch", start: { dateTime: "2026-10-12T19:00:00Z" }, end: { dateTime: "2026-10-12T20:00:00Z" } },
      ],
    });
    const events = await listEvents({ provider: Provider.google, email: "o@gmail.com" } as never, ...window);
    expect(events.map((e) => [e.id, e.seriesId])).toEqual([
      ["occ_g", "master_g"],
      ["single_g", undefined],
    ]);
  });
});
