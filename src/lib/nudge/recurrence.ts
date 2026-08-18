import { rrulestr } from "rrule";
import { toFloating, floatingToZonedUtc } from "@/lib/availability/recurrence";

/// The next fire instant strictly after `after` for `recurrenceRule` anchored at
/// `anchor`, computed in `tz` (DST-safe via the floating-time technique).
/// Returns null for a one-off (null rule) or when the rule is exhausted.
export function nextOccurrence(
  anchor: Date,
  recurrenceRule: string | null,
  tz: string,
  after: Date
): Date | null {
  if (!recurrenceRule) return null;
  const dtstart = toFloating(anchor, tz);
  const rule = rrulestr(`RRULE:${recurrenceRule}`, { dtstart });
  const next = rule.after(toFloating(after, tz), false); // false = strictly after
  return next ? floatingToZonedUtc(next, tz) : null;
}
