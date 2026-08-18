import { describe, it, expect } from "vitest";
import { ReminderChannel, ReminderRecipient } from "@prisma/client";
import { computeReminderPlan } from "./schedule";

const d = (iso: string) => new Date(iso);
const emailOnly = () => [ReminderChannel.email];

describe("computeReminderPlan", () => {
  const start = d("2026-06-10T18:00:00Z");

  it("schedules each offset for each recipient", () => {
    const plan = computeReminderPlan({
      start,
      offsetsMinutes: [1440, 60], // 24h, 1h
      recipients: [ReminderRecipient.hunter, ReminderRecipient.attendee],
      channelsFor: emailOnly,
      now: d("2026-06-01T00:00:00Z"),
    });
    expect(plan).toHaveLength(4);
    const fires = plan.map((p) => `${p.recipient}@${p.fireAt.toISOString()}`).sort();
    expect(fires).toEqual([
      "attendee@2026-06-09T18:00:00.000Z", // 24h
      "attendee@2026-06-10T17:00:00.000Z", // 1h
      "hunter@2026-06-09T18:00:00.000Z",
      "hunter@2026-06-10T17:00:00.000Z",
    ]);
  });

  it("drops reminders whose fire time is already in the past", () => {
    // Booking 90 min out: the 24h reminder is in the past, the 1h is not.
    const soon = d("2026-06-10T18:00:00Z");
    const plan = computeReminderPlan({
      start: soon,
      offsetsMinutes: [1440, 60],
      recipients: [ReminderRecipient.hunter],
      channelsFor: emailOnly,
      now: d("2026-06-10T16:30:00Z"),
    });
    expect(plan.map((p) => p.fireAt.toISOString())).toEqual(["2026-06-10T17:00:00.000Z"]);
  });

  it("honors custom offsets and multiple channels", () => {
    const plan = computeReminderPlan({
      start,
      offsetsMinutes: [10],
      recipients: [ReminderRecipient.hunter],
      channelsFor: () => [ReminderChannel.email, ReminderChannel.sms],
      now: d("2026-06-01T00:00:00Z"),
    });
    expect(plan).toHaveLength(2);
    expect(plan.map((p) => p.channel).sort()).toEqual([ReminderChannel.email, ReminderChannel.sms]);
    expect(plan.every((p) => p.fireAt.toISOString() === "2026-06-10T17:50:00.000Z")).toBe(true);
  });

  it("ignores non-positive offsets", () => {
    const plan = computeReminderPlan({
      start,
      offsetsMinutes: [0, -30],
      recipients: [ReminderRecipient.hunter],
      channelsFor: emailOnly,
      now: d("2026-06-01T00:00:00Z"),
    });
    expect(plan).toEqual([]);
  });
});
