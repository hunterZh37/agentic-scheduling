import { describe, it, expect, vi } from "vitest";
import { runChecksWithRetry, NamedCheck } from "./retry";

// The false alarm this guards against: a Neon cold start made three checks
// fail in one monitor run — the DB was fine seconds later, but the owner got
// paged for an outage that had already healed. Blips must recover silently;
// real outages must still fail after the retry.

const ok = (name: string): NamedCheck => ({ name, label: name, ok: true, detail: "fine" });
const bad = (name: string): NamedCheck => ({ name, label: name, ok: false, detail: "pool timeout" });

const noSleep = () => Promise.resolve();

describe("runChecksWithRetry", () => {
  it("does not re-run anything when every check passes", async () => {
    const a = vi.fn().mockResolvedValue(ok("a"));
    const out = await runChecksWithRetry({ a }, { sleep: noSleep });
    expect(out[0].ok).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("a cold-start blip that heals reports ok, with the flap in the detail", async () => {
    const db = vi.fn().mockResolvedValueOnce(bad("db")).mockResolvedValueOnce(ok("db"));
    const out = await runChecksWithRetry({ db }, { sleep: noSleep });
    expect(out[0].ok).toBe(true);
    expect(out[0].detail).toContain("first attempt failed: pool timeout");
    expect(db).toHaveBeenCalledTimes(2);
  });

  it("a real outage fails both attempts and still reports the failure", async () => {
    const db = vi.fn().mockResolvedValue(bad("db"));
    const out = await runChecksWithRetry({ db }, { sleep: noSleep });
    expect(out[0].ok).toBe(false);
    expect(db).toHaveBeenCalledTimes(2);
  });

  it("only failed checks are re-run; passing ones keep their first result", async () => {
    const good = vi.fn().mockResolvedValue(ok("good"));
    const flaky = vi.fn().mockResolvedValueOnce(bad("flaky")).mockResolvedValueOnce(ok("flaky"));
    const out = await runChecksWithRetry({ good, flaky }, { sleep: noSleep });
    expect(out.map((c) => c.ok)).toEqual([true, true]);
    expect(good).toHaveBeenCalledTimes(1);
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});
