import { describe, it, expect, vi } from "vitest";
import { runNegotiation, type NegotiationEvent } from "./negotiationDemo";
import { PERSONAS } from "./personas";

const persona = PERSONAS[0];

describe("runNegotiation", () => {
  it("streams a full negotiation ending in a result", async () => {
    const events: NegotiationEvent[] = [];
    const runAgentB = vi
      .fn()
      .mockResolvedValueOnce("Hi! Ada wants 30 min, free Tue/Wed afternoons ET.")
      .mockResolvedValueOnce("Tuesday 2pm ET works great.");
    const runAgentA = vi
      .fn()
      .mockResolvedValueOnce({
        text: "Alex is free Tue 2pm or Wed 3pm ET — either work?",
        toolEvents: [{ name: "find_mutual_times", summary: "checking Alex's availability" }],
      })
      .mockResolvedValueOnce({
        text: "Great — Tuesday 2pm it is.",
        toolEvents: [],
        confirmed: { startISO: "2026-07-21T18:00:00Z", endISO: "2026-07-21T18:30:00Z" },
      });

    const bookMeeting = vi.fn().mockResolvedValue({ ok: true });
    await runNegotiation(persona, (e) => events.push(e), { runAgentA, runAgentB, bookMeeting, maxTurns: 10 });

    expect(events.map((e) => e.type)).toEqual([
      "persona",
      "message", // B opener
      "tool",    // A find_mutual_times
      "message", // A proposal
      "message", // B accept
      "message", // A confirm text
      "result",
      "booked",
      "done",
    ]);
    expect(bookMeeting).toHaveBeenCalledWith(persona, {
      startISO: "2026-07-21T18:00:00Z",
      endISO: "2026-07-21T18:30:00Z",
    });
    const msgs = events.filter((e) => e.type === "message") as Extract<NegotiationEvent, { type: "message" }>[];
    expect(msgs.map((m) => m.agent)).toEqual(["B", "A", "B", "A"]);
    const result = events.find((e) => e.type === "result");
    expect(result).toMatchObject({ startISO: "2026-07-21T18:00:00Z", endISO: "2026-07-21T18:30:00Z" });
    expect(runAgentB).toHaveBeenCalledTimes(2);
    expect(runAgentA).toHaveBeenCalledTimes(2);
  });

  it("emits booking_failed when the booking is rejected", async () => {
    const events: NegotiationEvent[] = [];
    const runAgentB = vi.fn().mockResolvedValue("Tuesday 2pm works.");
    const runAgentA = vi.fn().mockResolvedValue({
      text: "Locking it in.",
      toolEvents: [],
      confirmed: { startISO: "2026-07-21T18:00:00Z", endISO: "2026-07-21T18:30:00Z" },
    });
    const bookMeeting = vi.fn().mockResolvedValue({ ok: false, error: "too_soon" });
    await runNegotiation(persona, (e) => events.push(e), { runAgentA, runAgentB, bookMeeting, maxTurns: 10 });
    const types = events.map((e) => e.type);
    expect(types).toContain("result");
    const failed = events.find((e) => e.type === "booking_failed") as Extract<NegotiationEvent, { type: "booking_failed" }>;
    expect(failed?.message).toBe("too_soon");
    expect(types).not.toContain("booked");
    expect(types[types.length - 1]).toBe("done");
  });

  it("emits no_agreement when max turns is reached without confirmation", async () => {
    const events: NegotiationEvent[] = [];
    const runAgentB = vi.fn().mockResolvedValue("How about Monday?");
    const runAgentA = vi.fn().mockResolvedValue({ text: "Monday is busy.", toolEvents: [] });

    await runNegotiation(persona, (e) => events.push(e), { runAgentA, runAgentB, maxTurns: 2 });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("persona");
    expect(types).toContain("no_agreement");
    expect(types[types.length - 1]).toBe("done");
    expect(types).not.toContain("result");
  });

  it("emits an error event (then done) if a turn throws", async () => {
    const events: NegotiationEvent[] = [];
    const runAgentB = vi.fn().mockRejectedValue(new Error("model exploded"));
    const runAgentA = vi.fn();
    await runNegotiation(persona, (e) => events.push(e), { runAgentA, runAgentB, maxTurns: 4 });
    const err = events.find((e) => e.type === "error") as Extract<NegotiationEvent, { type: "error" }>;
    expect(err?.message).toContain("model exploded");
    expect(events[events.length - 1].type).toBe("done");
  });
});
