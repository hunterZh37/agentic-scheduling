import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { nextOccurrence } from "./recurrence";

const TZ = "America/Los_Angeles";

describe("nextOccurrence", () => {
  it("returns null for a one-off (null rule)", () => {
    expect(nextOccurrence(new Date("2026-07-20T19:15:00Z"), null, TZ, new Date("2026-07-20T19:15:00Z"))).toBeNull();
  });

  it("advances a daily rule to the next day at the same wall-clock time", () => {
    // 12:15 PDT on 2026-07-20 == 19:15Z
    const anchor = new Date("2026-07-20T19:15:00Z");
    const next = nextOccurrence(anchor, "FREQ=DAILY", TZ, anchor);
    expect(next).not.toBeNull();
    const local = DateTime.fromJSDate(next as Date, { zone: "utc" }).setZone(TZ);
    expect(local.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-21 12:15");
  });

  it("keeps wall-clock time across a spring-forward DST transition", () => {
    // US DST starts Sun 2027-03-14. An 8am daily reminder must stay 8am local.
    const anchor = new Date("2027-03-13T16:00:00Z"); // 8:00 PST
    const next = nextOccurrence(anchor, "FREQ=DAILY", TZ, anchor);
    const local = DateTime.fromJSDate(next as Date, { zone: "utc" }).setZone(TZ);
    expect(local.toFormat("yyyy-MM-dd HH:mm")).toBe("2027-03-14 08:00");
  });

  it("advances a weekly rule by 7 days", () => {
    const anchor = new Date("2026-07-20T19:15:00Z"); // Monday
    const next = nextOccurrence(anchor, "FREQ=WEEKLY", TZ, anchor);
    const local = DateTime.fromJSDate(next as Date, { zone: "utc" }).setZone(TZ);
    expect(local.toFormat("yyyy-MM-dd HH:mm")).toBe("2026-07-27 12:15");
  });
});
