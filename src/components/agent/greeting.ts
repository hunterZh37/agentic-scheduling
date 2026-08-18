/// The time-of-day word for the agent's greeting, from an hour (0-23) in the
/// owner's timezone. The greeting used to be a hardcoded "Morning" that read
/// wrong every afternoon and evening — the first line the owner sees from an
/// agent that is supposed to know their day. Pure so the boundaries are pinned
/// by a test.
export function greetingWord(hour: number): "Morning" | "Afternoon" | "Evening" {
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}
