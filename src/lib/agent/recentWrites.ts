/// In-process claims on a write the agent is about to make, keyed by what
/// would make two writes the same thing (account + title + start + end).
///
/// The calendar lookup in create_event catches a repeat across turns, but two
/// identical calls in flight at once both see an empty calendar and both
/// write. The claim is taken synchronously before any await, so the second
/// caller sees it and waits for the first to finish, then reads its result.
/// Instance-local (Fluid Compute reuses instances, so this covers the
/// realistic double-submit); the calendar lookup remains the cross-instance
/// guard. See docs/REGRESSIONS.md.

type Outcome = { eventId: string; videoLink: string | null; duplicate: boolean };

const claims = new Map<string, Promise<Outcome | null>>();
const TTL_MS = 2 * 60 * 1000;

export const recentWrites = {
  key(parts: (string | number | null | undefined)[]): string {
    return parts.map((p) => String(p ?? "").trim().toLowerCase()).join("|");
  },
  /// The in-flight (or just-finished) write for this key, if any.
  pending(key: string): Promise<Outcome | null> | undefined {
    return claims.get(key);
  },
  /// Register a write. The promise resolves to its outcome (null on failure)
  /// and is remembered for TTL_MS so a straggler still sees it.
  claim(key: string, work: () => Promise<Outcome | null>): Promise<Outcome | null> {
    const p = work().catch(() => null);
    claims.set(key, p);
    const expire = () => setTimeout(() => { if (claims.get(key) === p) claims.delete(key); }, TTL_MS);
    const t = expire();
    if (typeof t === "object" && "unref" in t) (t as { unref(): void }).unref();
    return p;
  },
  clear(): void {
    claims.clear();
  },
};
