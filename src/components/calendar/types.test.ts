import { describe, it, expect } from "vitest";
import { toCalendarItems, type ScheduleApiResponse } from "./types";

const base: ScheduleApiResponse = { events: [], blocks: [], bookings: [], birthdays: [], warnings: [] };

describe("toCalendarItems birthdays", () => {
  it("maps a birthday occurrence to a birthday CalendarItem", () => {
    const res: ScheduleApiResponse = {
      ...base,
      birthdays: [{ id: "m", name: "Martin", date: "2026-07-05T07:00:00.000Z", age: 30 }],
    };
    const items = toCalendarItems(res);
    const bday = items.find((i) => i.kind === "birthday");
    expect(bday).toBeTruthy();
    expect(bday!.title).toBe("🎂 Martin (30)");
    expect(bday!.id).toBe("birthday:m:2026-07-05T07:00:00.000Z");
  });
});
