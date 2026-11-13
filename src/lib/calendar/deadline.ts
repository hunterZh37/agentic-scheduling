/// How long one calendar provider gets to answer a read. A provider can take
/// 20s+ to answer with an error (Microsoft Graph 502s did, 2026-11-12), and
/// every other calendar waited with it. Past this, that calendar is treated as
/// failed. 10s leaves room for a healthy read (a token refresh plus several pages).
export const CALENDAR_READ_TIMEOUT_MS = 10_000;

/// Run a provider read with a deadline: rejects, and aborts the signal handed
/// to `run` (cancelling its requests), when it has not settled in time.
export function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number = CALENDAR_READ_TIMEOUT_MS
): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error(`Didn't answer within ${ms / 1000} seconds.`));
    }, ms);
  });
  // Started inside a promise so a synchronous throw still clears the timer.
  const work = Promise.resolve().then(() => run(ctl.signal));
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
