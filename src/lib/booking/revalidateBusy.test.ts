import { describe, it, expect, vi } from "vitest";
import { revalidateBusyWithRetry } from "./service";

// A booking revalidates live free/busy across every connected calendar and
// fails closed if any account errors. A single transient blip (provider
// 429/5xx, token-refresh race) on one of several calendars would otherwise sink
// an otherwise-open slot — surfaced to visitors as "that time was just taken".
// These lock in the retry-then-fail-closed policy. `sleep` is stubbed so the
// tests don't wait on real backoff.
const noSleep = () => Promise.resolve();
const busyFixture = [{ start: new Date("2026-07-13T15:00:00Z"), end: new Date("2026-07-13T16:00:00Z") }];

describe("revalidateBusyWithRetry", () => {
  it("verifies on the first try when no account errors", async () => {
    const fetchBusy = vi.fn().mockResolvedValue({ busy: busyFixture, errors: [] });
    const r = await revalidateBusyWithRetry(fetchBusy, { sleep: noSleep });
    expect(r.verified).toBe(true);
    expect(r.busy).toEqual(busyFixture);
    expect(fetchBusy).toHaveBeenCalledTimes(1);
  });

  it("retries past a transient error and then verifies", async () => {
    const fetchBusy = vi
      .fn()
      .mockResolvedValueOnce({ busy: [], errors: [{ email: "a@x.com" }] })
      .mockResolvedValueOnce({ busy: busyFixture, errors: [] });
    const r = await revalidateBusyWithRetry(fetchBusy, { sleep: noSleep });
    expect(r.verified).toBe(true);
    expect(r.busy).toEqual(busyFixture);
    expect(fetchBusy).toHaveBeenCalledTimes(2);
  });

  it("fails closed (verified:false) if every attempt errors", async () => {
    const fetchBusy = vi.fn().mockResolvedValue({ busy: [], errors: [{ email: "a@x.com" }] });
    const r = await revalidateBusyWithRetry(fetchBusy, { attempts: 3, sleep: noSleep });
    expect(r.verified).toBe(false);
    expect(fetchBusy).toHaveBeenCalledTimes(3);
  });

  it("honors a custom attempt count", async () => {
    const fetchBusy = vi.fn().mockResolvedValue({ busy: [], errors: [{ email: "a@x.com" }] });
    await revalidateBusyWithRetry(fetchBusy, { attempts: 5, sleep: noSleep });
    expect(fetchBusy).toHaveBeenCalledTimes(5);
  });
});
