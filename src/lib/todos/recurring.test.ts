import { describe, it, expect, vi, beforeEach } from "vitest";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

vi.mock("@/lib/db", () => ({
  prisma: {
    recurringTodo: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
    todo: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

import { prisma } from "@/lib/db";
import {
  validateRRule,
  describeRRule,
  nextOccurrence,
  occurrencesBetween,
  materializeTemplate,
  materializeRecurringTodos,
  createRecurringActionable,
  updateRecurringActionable,
  resyncFutureOccurrences,
} from "./recurring";
import { dayKey } from "./carryForward";

// Owner-local calendar day at midnight.
const day = (y: number, mo: number, d: number) =>
  DateTime.fromObject({ year: y, month: mo, day: d }, { zone: OWNER_TIMEZONE });
const localDay = (d: Date) => DateTime.fromJSDate(d).setZone(OWNER_TIMEZONE).toFormat("yyyy-MM-dd");
const localHM = (d: Date) => DateTime.fromJSDate(d).setZone(OWNER_TIMEZONE).toFormat("HH:mm");

const ANCHOR = day(2026, 1, 1); // template created Jan 1, 2026 (owner-local)

describe("validateRRule", () => {
  it("accepts the rules the app emits", () => {
    expect(validateRRule("FREQ=MONTHLY;BYMONTHDAY=-1")).toBeNull();
    expect(validateRRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")).toBeNull();
    expect(validateRRule("RRULE:FREQ=DAILY")).toBeNull(); // prefix tolerated
  });
  it("rejects an empty or FREQ-less rule", () => {
    expect(validateRRule("")).not.toBeNull();
    expect(validateRRule("BYMONTHDAY=1")).toMatch(/FREQ/);
  });
});

describe("describeRRule", () => {
  it("phrases the rules the UI shows, capitalized", () => {
    expect(describeRRule("FREQ=MONTHLY;BYMONTHDAY=-1").toLowerCase()).toContain("month");
    expect(describeRRule("FREQ=WEEKLY;BYDAY=MO").toLowerCase()).toContain("week");
    expect(describeRRule("FREQ=DAILY")[0]).toMatch(/[A-Z]/);
  });
});

describe("nextOccurrence", () => {
  it("finds the last day of the month for FREQ=MONTHLY;BYMONTHDAY=-1", () => {
    const next = nextOccurrence("FREQ=MONTHLY;BYMONTHDAY=-1", ANCHOR, day(2026, 8, 15));
    expect(next?.toISODate()).toBe("2026-08-31");
  });
  it("is inclusive of the from-day", () => {
    const next = nextOccurrence("FREQ=MONTHLY;BYMONTHDAY=-1", ANCHOR, day(2026, 8, 31));
    expect(next?.toISODate()).toBe("2026-08-31");
  });
  it("rolls to the correct length in a 30-day month", () => {
    const next = nextOccurrence("FREQ=MONTHLY;BYMONTHDAY=-1", ANCHOR, day(2026, 9, 1));
    expect(next?.toISODate()).toBe("2026-09-30");
  });
  it("returns null once a COUNT-bounded rule is exhausted", () => {
    // Two occurrences from the anchor month: Jan 31, Feb 28. Nothing after.
    const next = nextOccurrence("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2", ANCHOR, day(2026, 6, 1));
    expect(next).toBeNull();
  });
});

describe("occurrencesBetween", () => {
  it("lists each due day in the window, inclusive", () => {
    // Aug 3 2026 is a Monday. Mondays: 3, 10, 17.
    const occ = occurrencesBetween("FREQ=WEEKLY;BYDAY=MO", ANCHOR, day(2026, 8, 3), day(2026, 8, 17));
    expect(occ.map((d) => d.toISODate())).toEqual(["2026-08-03", "2026-08-10", "2026-08-17"]);
  });
  it("never predates the anchor (template creation)", () => {
    const late = day(2026, 8, 10);
    const occ = occurrencesBetween("FREQ=DAILY", late, day(2026, 8, 1), day(2026, 8, 12));
    expect(occ.map((d) => d.toISODate())).toEqual(["2026-08-10", "2026-08-11", "2026-08-12"]);
  });
});

describe("materializeTemplate", () => {
  const base = {
    id: "rt1",
    title: "Pay rent",
    rrule: "FREQ=MONTHLY;BYMONTHDAY=-1",
    startMinutes: null,
    endMinutes: null,
    location: null,
    videoLink: null,
    phone: null,
    lastMaterializedOn: null,
    createdAt: ANCHOR.toUTC().toJSDate(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.todo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ sortOrder: 4 });
    (prisma.todo.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t1" });
    (prisma.recurringTodo.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("seeds today's occurrence when today is a due day, linked to the template", async () => {
    const created = await materializeTemplate(base, day(2026, 8, 31).set({ hour: 8 }));
    expect(created).toBe(1);
    const arg = (prisma.todo.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(arg.title).toBe("Pay rent");
    expect(arg.recurringTodoId).toBe("rt1");
    expect(localDay(arg.date)).toBe("2026-08-31");
    expect(arg.startTime).toBeNull(); // untimed
    expect(arg.sortOrder).toBe(5); // after the day's last (4)
  });

  it("eagerly seeds the NEXT upcoming occurrence when today is not a due day", async () => {
    // Set up Aug 15; last-day-of-month is due Aug 31. The actionable should be
    // placed on Aug 31 right away, so it's a real to-do visible on its day.
    const created = await materializeTemplate(base, day(2026, 8, 15).set({ hour: 8 }));
    expect(created).toBe(1);
    expect(localDay((prisma.todo.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data.date)).toBe("2026-08-31");
  });

  it("seeds Aug 31 the moment a last-day series is created on Aug 30 (the reported bug)", async () => {
    const created = await materializeTemplate(base, day(2026, 8, 30).set({ hour: 10 }));
    expect(created).toBe(1);
    const arg = (prisma.todo.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(localDay(arg.date)).toBe("2026-08-31");
    expect(arg.recurringTodoId).toBe("rt1");
  });

  it("a brand-new template does NOT backfill its past occurrences", async () => {
    // Daily rule, never materialized, run today — only today, not every past day.
    const daily = { ...base, rrule: "FREQ=DAILY" };
    const created = await materializeTemplate(daily, day(2026, 8, 20).set({ hour: 8 }));
    expect(created).toBe(1);
    expect(localDay((prisma.todo.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data.date)).toBe("2026-08-20");
  });

  it("catches up missed days since it last ran", async () => {
    // Daily, last ran through Aug 17; running Aug 20 fills 18, 19, 20.
    const daily = { ...base, rrule: "FREQ=DAILY", lastMaterializedOn: dayKey(day(2026, 8, 17)) };
    const created = await materializeTemplate(daily, day(2026, 8, 20).set({ hour: 8 }));
    expect(created).toBe(3);
    const seededDays = (prisma.todo.create as ReturnType<typeof vi.fn>).mock.calls.map((c) => localDay(c[0].data.date));
    expect(seededDays).toEqual(["2026-08-18", "2026-08-19", "2026-08-20"]);
  });

  it("builds a timed occurrence at the template's local time-of-day", async () => {
    const timed = { ...base, startMinutes: 9 * 60, endMinutes: 9 * 60 + 30 };
    await materializeTemplate(timed, day(2026, 8, 31).set({ hour: 8 }));
    const arg = (prisma.todo.create as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(localHM(arg.startTime)).toBe("09:00");
    expect(localHM(arg.endTime)).toBe("09:30");
  });

  it("is idempotent: a unique-violation (already seeded) is a no-op", async () => {
    (prisma.todo.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ code: "P2002" });
    const created = await materializeTemplate(base, day(2026, 8, 31).set({ hour: 8 }));
    expect(created).toBe(0); // swallowed, not thrown
  });

  it("stamps lastMaterializedOn = today after a run", async () => {
    await materializeTemplate(base, day(2026, 8, 31).set({ hour: 8 }));
    const upd = (prisma.recurringTodo.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(upd.where.id).toBe("rt1");
    expect(localDay(upd.data.lastMaterializedOn)).toBe("2026-08-31");
  });
});

describe("createRecurringActionable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.recurringTodo.create as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      id: "new1",
      createdAt: ANCHOR.toUTC().toJSDate(),
      startMinutes: data.startMinutes ?? null,
      endMinutes: data.endMinutes ?? null,
      ...data,
    }));
    (prisma.todo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.todo.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t" });
    (prisma.recurringTodo.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("rejects a rule with no FREQ instead of writing a template", async () => {
    const res = await createRecurringActionable({ title: "Pay rent", rrule: "BYMONTHDAY=-1" });
    expect(res.ok).toBe(false);
    expect(prisma.recurringTodo.create).not.toHaveBeenCalled();
  });

  it("rejects an empty title", async () => {
    const res = await createRecurringActionable({ title: "  ", rrule: "FREQ=DAILY" });
    expect(res.ok).toBe(false);
  });

  it("creates the template and reports the next occurrence", async () => {
    const res = await createRecurringActionable(
      { title: "Pay rent", rrule: "FREQ=MONTHLY;BYMONTHDAY=-1" },
      day(2026, 8, 30).set({ hour: 10 })
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.nextOccurrence).toBe("2026-08-31");
      expect(res.template.rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=-1");
    }
    // eagerly seeded Aug 31
    expect(prisma.todo.create).toHaveBeenCalled();
  });
});

describe("resyncFutureOccurrences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("pushes the template's new time onto future undone occurrences", async () => {
    (prisma.recurringTodo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "rt", title: "Pay rent", startMinutes: 9 * 60, endMinutes: 9 * 60 + 30,
      location: null, videoLink: null, phone: null,
    });
    (prisma.todo.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "t1", date: dayKey(day(2026, 9, 30)) },
    ]);
    (prisma.todo.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const n = await resyncFutureOccurrences("rt", day(2026, 8, 31).set({ hour: 8 }));
    expect(n).toBe(1);
    const upd = (prisma.todo.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(localHM(upd.data.startTime)).toBe("09:00");
    expect(localHM(upd.data.endTime)).toBe("09:30");
    expect(localDay(upd.data.startTime)).toBe("2026-09-30");
  });

  it("only touches future undone occurrences (query is scoped)", async () => {
    (prisma.recurringTodo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "rt", title: "x", startMinutes: null, endMinutes: null, location: null, videoLink: null, phone: null,
    });
    (prisma.todo.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await resyncFutureOccurrences("rt", day(2026, 8, 31).set({ hour: 8 }));
    const where = (prisma.todo.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.recurringTodoId).toBe("rt");
    expect(where.done).toBe(false);
    expect(where.date.gte).toBeInstanceOf(Date);
  });
});

describe("updateRecurringActionable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.recurringTodo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "rt", title: "Pay rent", rrule: "FREQ=MONTHLY;BYMONTHDAY=-1", createdAt: ANCHOR.toUTC().toJSDate(),
      startMinutes: null, endMinutes: null, location: null, videoLink: null, phone: null,
    });
    (prisma.recurringTodo.update as ReturnType<typeof vi.fn>).mockImplementation(async ({ data }) => ({
      id: "rt", title: "Pay rent", rrule: "FREQ=MONTHLY;BYMONTHDAY=-1", createdAt: ANCHOR.toUTC().toJSDate(),
      startMinutes: null, endMinutes: null, location: null, videoLink: null, phone: null, ...data,
    }));
    (prisma.todo.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("404s a missing schedule", async () => {
    (prisma.recurringTodo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await updateRecurringActionable("nope", { title: "x" });
    expect(r).toMatchObject({ ok: false, error: "not_found" });
  });

  it("rejects a bad rrule without writing", async () => {
    const r = await updateRecurringActionable("rt", { rrule: "BYMONTHDAY=1" });
    expect(r.ok).toBe(false);
    expect(prisma.recurringTodo.update).not.toHaveBeenCalled();
  });

  it("rejects a lone time bound", async () => {
    const r = await updateRecurringActionable("rt", { startMinutes: 540, endMinutes: null });
    expect(r).toMatchObject({ ok: false, error: "invalid_range" });
  });

  it("saves a time change and reports the next occurrence", async () => {
    const r = await updateRecurringActionable(
      "rt", { startMinutes: 540, endMinutes: 570 }, day(2026, 8, 31).set({ hour: 8 })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nextOccurrence).toBe("2026-08-31");
    const data = (prisma.recurringTodo.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data.startMinutes).toBe(540);
    expect(data.endMinutes).toBe(570);
  });
});

describe("materializeRecurringTodos", () => {
  it("runs every active template and totals what was seeded", async () => {
    vi.clearAllMocks();
    (prisma.recurringTodo.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "a",
        title: "Pay rent",
        rrule: "FREQ=MONTHLY;BYMONTHDAY=-1",
        startMinutes: null,
        endMinutes: null,
        location: null,
        videoLink: null,
        phone: null,
        lastMaterializedOn: null,
        createdAt: ANCHOR.toUTC().toJSDate(),
      },
    ]);
    (prisma.todo.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.todo.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "t" });
    (prisma.recurringTodo.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    const res = await materializeRecurringTodos(day(2026, 8, 31).set({ hour: 7 }));
    expect(res).toEqual({ templates: 1, created: 1 });
    expect(prisma.recurringTodo.findMany).toHaveBeenCalledWith({ where: { active: true } });
  });
});
