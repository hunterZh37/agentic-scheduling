/// Run named monitor checks, then re-run any that failed once after a short
/// delay, keeping the second verdict. Exists because one Neon cold start (the
/// free tier suspends compute after idle) plus a 1-connection Prisma pool made
/// three checks "fail" in the same 4-hourly run with nothing actually down —
/// an alert about a blip that had already healed. A real outage fails both
/// attempts and still alerts at full strength; a blip that recovers is
/// reported as ok with the flap preserved in the detail.

export interface NamedCheck {
  name: string;
  label: string;
  ok: boolean;
  detail: string;
}

export async function runChecksWithRetry(
  runners: Record<string, () => Promise<NamedCheck>>,
  opts: { delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<NamedCheck[]> {
  const delayMs = opts.delayMs ?? 3000;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  const first = await Promise.all(Object.values(runners).map((run) => run()));
  if (first.every((c) => c.ok)) return first;

  await sleep(delayMs);
  return Promise.all(
    first.map(async (c) => {
      if (c.ok) return c;
      const runner = runners[c.name];
      if (!runner) return c; // defensive: unknown name keeps its first verdict
      const second = await runner();
      return second.ok
        ? { ...second, detail: `${second.detail} (first attempt failed: ${c.detail})` }
        : second;
    })
  );
}
