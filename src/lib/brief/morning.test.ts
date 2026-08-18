import { describe, it, expect, vi, beforeEach } from "vitest";
import { DateTime } from "luxon";
import {
  formatMorningBrief,
  formatMorningBriefFreeform,
  collectBriefItems,
  buildMorningBriefs,
} from "./morning";
import type { ScheduleView } from "@/lib/schedule/service";

vi.mock("@/lib/schedule/service", () => ({ getScheduleView: vi.fn() }));
import { getScheduleView } from "@/lib/schedule/service";

const TZ = "America/Los_Angeles";
// 7am PDT on Jul 11 2026 (America/Los_Angeles is UTC-7 in July).
const day = DateTime.fromISO("2026-07-11T07:00:00", { zone: TZ }).startOf("day");
const emptyView: ScheduleView = { events: [], blocks: [], bookings: [], birthdays: [], warnings: [] };

function view(partial: Partial<ScheduleView>): ScheduleView {
  return { events: [], blocks: [], bookings: [], birthdays: [], warnings: [], ...partial };
}

// Convenience: build an event at a given local time on the test day.
function ev(hhmm: string, title: string, durationMin = 60, allDay = false) {
  const [h, m] = hhmm.split(":").map(Number);
  const start = day.set({ hour: h, minute: m }).toUTC().toJSDate();
  const end = day.set({ hour: h, minute: m }).plus({ minutes: durationMin }).toUTC().toJSDate();
  return {
    id: title,
    accountEmail: "owner@example.com",
    title,
    start,
    end,
    allDay,
    attendees: [],
  };
}

describe("collectBriefItems", () => {
  const block = (title: string, hour: number) => ({
    id: `b-${title}`,
    title,
    start: day.set({ hour }).toUTC().toJSDate(),
    end: day.set({ hour: hour + 1 }).toUTC().toJSDate(),
    done: false,
  });
  const actionable = (title: string, hour: number) => ({
    id: `a-${title}`,
    title,
    start: day.set({ hour }).toUTC().toJSDate(),
    end: day.set({ hour: hour + 1 }).toUTC().toJSDate(),
    done: false,
    location: null,
    videoLink: null,
    phone: null,
  });

  it("merges events, actionables and bookings in chronological order", () => {
    const items = collectBriefItems(
      view({
        events: [ev("13:00", "CS w/Mr Owens")],
        actionables: [actionable("Pick up car", 6)],
      })
    );
    expect(items.map((i) => i.title)).toEqual(["Pick up car", "CS w/Mr Owens"]);
    expect(items[0].kind).toBe("actionable");
    expect(items[1].kind).toBe("event");
  });

  // Reported from a real brief: "3 items: 12:00 AM Sleep · 9:00 AM CS and ELA
  // CAMP · 11:00 PM Sleep". A nightly block appeared TWICE — the tail of last
  // night and the start of tonight — and buried the one thing actually
  // happening. Reserved time is the shape of the day, not an item in it.
  it("leaves reserved blocks out entirely", () => {
    const items = collectBriefItems(
      view({
        events: [ev("09:00", "CS and ELA CAMP")],
        blocks: [block("Sleep", 0), block("Sleep", 23)],
      })
    );
    expect(items.map((i) => i.title)).toEqual(["CS and ELA CAMP"]);
    expect(items.some((i) => i.title === "Sleep")).toBe(false);
  });

  it("counts a day of actionables as a full day, not an empty one", () => {
    // Actionables were missing from the brief altogether, so a packed day of
    // to-dos could read as "nothing on your calendar".
    const items = collectBriefItems(
      view({ actionables: [actionable("Fetch the car", 17), actionable("Planning", 18)] })
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "actionable")).toBe(true);
  });
});

describe("formatMorningBrief", () => {
  it("reports an open day when nothing is scheduled", () => {
    const line = formatMorningBrief(view({}), day, TZ);
    expect(line).toBe("Saturday, Jul 11 — nothing on your calendar. An open day ahead.");
  });

  it("lists timed items with local times and the day's bounds", () => {
    const line = formatMorningBrief(
      view({ events: [ev("09:00", "Standup", 30), ev("12:30", "Lunch w/ Kim"), ev("13:00", "CS", 180)] }),
      day,
      TZ
    );
    expect(line).toContain("Saturday, Jul 11 — 3 items");
    expect(line).toContain("9:00 AM Standup");
    expect(line).toContain("12:30 PM Lunch w/ Kim");
    expect(line).toContain("Starts 9:00 AM, wraps 4:00 PM.");
  });

  it("lists every timed item — no '+N more' abbreviation (owner request, 2026-08-18)", () => {
    const line = formatMorningBrief(
      view({
        events: [
          ev("08:00", "A"),
          ev("09:00", "B"),
          ev("10:00", "C"),
          ev("11:00", "D"),
          ev("12:00", "E"),
          ev("13:00", "F"),
        ],
      }),
      day,
      TZ
    );
    expect(line).toContain("6 items");
    expect(line).not.toContain("more");
    expect(line).toContain("12:00 PM E");
    expect(line).toContain("1:00 PM F");
  });

  it("separates all-day items from timed ones", () => {
    const line = formatMorningBrief(
      view({ events: [ev("00:00", "Holiday", 0, true), ev("09:00", "Standup", 30)] }),
      day,
      TZ
    );
    expect(line).toContain("1 all-day");
    expect(line).toContain("9:00 AM Standup");
  });

  it("produces a template-safe single line (no newlines or tabs)", () => {
    const line = formatMorningBrief(
      view({ events: [ev("09:00", "Multi\nline\ttitle")] }),
      day,
      TZ
    );
    expect(line).not.toMatch(/[\n\t]/);
    expect(line).not.toMatch(/ {5,}/);
    expect(line).toContain("Multi line title");
  });
});

describe("formatMorningBriefFreeform", () => {
  it("renders one 'start – end: title' line per item", () => {
    const out = formatMorningBriefFreeform(
      view({ events: [ev("09:33", "grant making salesforce", 27), ev("16:07", "finalize agentic scheduling", 233)] }),
      day,
      TZ
    );
    expect(out).toContain("Jul 11 — 2 items:");
    expect(out).toContain("9:33 AM – 10:00 AM: grant making salesforce");
    expect(out).toContain("4:07 PM – 8:00 PM: finalize agentic scheduling");
    expect(out.split("\n").length).toBeGreaterThan(2); // real multi-line agenda
  });

  it("notes an open day when nothing is scheduled", () => {
    expect(formatMorningBriefFreeform(view({}), day, TZ)).toContain("nothing on your calendar");
  });
});

// Reported 2026-08-15: the brief said "nothing on your calendar. An open day
// ahead." while two CS sessions sat on the Outlook calendar. The account's
// fetch had failed transiently; getScheduleView degraded it to a warnings
// entry, and the brief formatted the empty view as a genuinely open day.
describe("calendar warnings", () => {
  const warn = { email: "owner@outlook.example", message: "Microsoft calendarView failed: 503" };

  it("never claims an open day while a calendar could not be read", () => {
    const line = formatMorningBrief(view({ warnings: [warn] }), day, TZ);
    expect(line).not.toContain("An open day ahead");
    expect(line).not.toContain("nothing on your calendar");
    expect(line).toContain("owner@outlook.example");
  });

  it("flags possibly missing items when a day has items AND a warning", () => {
    const line = formatMorningBrief(view({ events: [ev("09:00", "Standup")], warnings: [warn] }), day, TZ);
    expect(line).toContain("9:00 AM Standup");
    expect(line).toContain("owner@outlook.example");
  });

  it("stays a template-safe single line with warnings present", () => {
    const line = formatMorningBrief(view({ warnings: [warn] }), day, TZ);
    expect(line).not.toMatch(/[\n\t]/);
    expect(line).not.toMatch(/ {5,}/);
  });

  it("freeform: reports the unreadable calendar instead of an open day", () => {
    const out = formatMorningBriefFreeform(view({ warnings: [warn] }), day, TZ);
    expect(out).not.toContain("An open day ahead");
    expect(out).toContain("owner@outlook.example");
  });
});

describe("buildMorningBriefs", () => {
  const mocked = vi.mocked(getScheduleView);
  // 8am on the test day, owner-local.
  const now = day.set({ hour: 8 });
  const warnView = view({
    warnings: [{ email: "owner@outlook.example", message: "boom" }],
  });
  const okView = view({ events: [ev("09:00", "CS w/Mr Owner", 180)] });

  beforeEach(() => mocked.mockReset());

  it("fetches once when the view is clean", async () => {
    mocked.mockResolvedValueOnce(okView);
    const briefs = await buildMorningBriefs(now, { retryDelayMs: 0 });
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(briefs.line).toContain("CS w/Mr Owner");
    expect(briefs.warnings).toEqual([]);
  });

  it("retries once on warnings and uses the recovered view", async () => {
    mocked.mockResolvedValueOnce(warnView).mockResolvedValueOnce(okView);
    const briefs = await buildMorningBriefs(now, { retryDelayMs: 0 });
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(briefs.line).toContain("CS w/Mr Owner");
    expect(briefs.line).not.toContain("owner@outlook.example");
    expect(briefs.warnings).toEqual([]);
  });

  it("reports the warning when the retry also fails", async () => {
    mocked.mockResolvedValueOnce(warnView).mockResolvedValueOnce(warnView);
    const briefs = await buildMorningBriefs(now, { retryDelayMs: 0 });
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(briefs.line).not.toContain("An open day ahead");
    expect(briefs.line).toContain("owner@outlook.example");
    expect(briefs.freeform).toContain("owner@outlook.example");
    expect(briefs.warnings).toHaveLength(1);
  });
});

describe("morning brief birthdays", () => {
  it("lists a birthday as an all-day item with age", () => {
    const day = DateTime.fromISO("2026-07-05T12:00:00", { zone: TZ });
    const view: ScheduleView = {
      ...emptyView,
      birthdays: [{ id: "m", name: "Martin", date: new Date("2026-07-05T07:00:00Z"), age: 30 }],
    };
    const out = formatMorningBriefFreeform(view, day, TZ);
    expect(out).toContain("🎂 Martin's birthday (turns 30)");
  });
  it("omits age when unknown", () => {
    const day = DateTime.fromISO("2026-07-05T12:00:00", { zone: TZ });
    const view: ScheduleView = {
      ...emptyView,
      birthdays: [{ id: "n", name: "Nadia", date: new Date("2026-07-05T07:00:00Z"), age: null }],
    };
    expect(formatMorningBriefFreeform(view, day, TZ)).toContain("🎂 Nadia's birthday");
    expect(formatMorningBriefFreeform(view, day, TZ)).not.toContain("turns");
  });
});
