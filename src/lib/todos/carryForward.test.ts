import { describe, it, expect, vi, beforeEach } from "vitest";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

vi.mock("@/lib/db", () => ({
  prisma: { todo: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() } },
}));

import { prisma } from "@/lib/db";
import { dayKey, shiftToDay, carriedTodoData, carryForwardTodos } from "./carryForward";

const localHM = (d: Date) => DateTime.fromJSDate(d).setZone(OWNER_TIMEZONE).toFormat("HH:mm");
const localDay = (d: Date) => DateTime.fromJSDate(d).setZone(OWNER_TIMEZONE).toFormat("yyyy-MM-dd");
const instant = (y: number, mo: number, d: number, h: number, mi = 0) =>
  DateTime.fromObject({ year: y, month: mo, day: d, hour: h, minute: mi }, { zone: OWNER_TIMEZONE })
    .toUTC()
    .toJSDate();
const day = (y: number, mo: number, d: number) =>
  DateTime.fromObject({ year: y, month: mo, day: d }, { zone: OWNER_TIMEZONE });

describe("shiftToDay", () => {
  it("keeps the same local time-of-day on the target day", () => {
    const out = shiftToDay(instant(2026, 6, 10, 9, 30), day(2026, 6, 11));
    expect(localHM(out)).toBe("09:30");
    expect(localDay(out)).toBe("2026-06-11");
  });

  it("preserves the local hour across a spring-forward DST boundary, not +24h", () => {
    // A 9:00 AM task on the day before the clock jumps forward should still read
    // 9:00 AM after it moves — a naive +24h would drift by the lost hour.
    const src = instant(2026, 3, 7, 9);
    const out = shiftToDay(src, day(2026, 3, 8));
    expect(localHM(out)).toBe("09:00");
  });
});

describe("carriedTodoData", () => {
  const base = {
    id: "src1",
    title: "Ship the thing",
    startTime: instant(2026, 6, 10, 9),
    endTime: instant(2026, 6, 10, 9, 30),
    location: "Desk",
    videoLink: null,
    phone: null,
  };

  it("clones fields, links the source, dates onto today, keeps the time", () => {
    const c = carriedTodoData(base, day(2026, 6, 11), 5);
    expect(c.rolledFromId).toBe("src1");
    expect(c.title).toBe("Ship the thing");
    expect(c.location).toBe("Desk");
    expect(c.sortOrder).toBe(5);
    expect(c.date).toEqual(dayKey(day(2026, 6, 11)));
    expect(localHM(c.startTime!)).toBe("09:00");
    expect(localHM(c.endTime!)).toBe("09:30");
    expect(localDay(c.startTime!)).toBe("2026-06-11");
  });

  it("carries an untimed todo as untimed", () => {
    const c = carriedTodoData({ ...base, startTime: null, endTime: null }, day(2026, 6, 11), 0);
    expect(c.startTime).toBeNull();
    expect(c.endTime).toBeNull();
  });
});

describe("carryForwardTodos", () => {
  beforeEach(() => vi.clearAllMocks());

  it("carries yesterday's undone, skips already-carried, appends at the end", async () => {
    const src = (id: string, sortOrder: number) => ({
      id,
      title: id.toUpperCase(),
      startTime: null,
      endTime: null,
      location: null,
      videoLink: null,
      phone: null,
      sortOrder,
    });
    vi.mocked(prisma.todo.findMany)
      .mockResolvedValueOnce([src("a", 0), src("b", 1)] as never) // yesterday's undone
      .mockResolvedValueOnce([{ rolledFromId: "a" }] as never); // "a" already carried
    vi.mocked(prisma.todo.findFirst).mockResolvedValueOnce({ sortOrder: 3 } as never); // today's max
    vi.mocked(prisma.todo.create).mockResolvedValue({} as never);

    const res = await carryForwardTodos(day(2026, 6, 11).set({ hour: 8 }));

    expect(res).toEqual({ created: 1, considered: 2 });
    expect(prisma.todo.create).toHaveBeenCalledTimes(1);
    expect(prisma.todo.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ rolledFromId: "b", sortOrder: 4, title: "B" }),
    });
  });

  it("is a no-op when nothing was left undone yesterday", async () => {
    vi.mocked(prisma.todo.findMany).mockResolvedValueOnce([] as never);
    const res = await carryForwardTodos(day(2026, 6, 11).set({ hour: 8 }));
    expect(res).toEqual({ created: 0, considered: 0 });
    expect(prisma.todo.create).not.toHaveBeenCalled();
  });

  it("queries yesterday's day-key for undone todos", async () => {
    vi.mocked(prisma.todo.findMany).mockResolvedValueOnce([] as never);
    await carryForwardTodos(day(2026, 6, 11).set({ hour: 8 }));
    expect(prisma.todo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { date: dayKey(day(2026, 6, 10)), done: false } })
    );
  });
});
