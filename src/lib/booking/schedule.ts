import { ReminderChannel, ReminderRecipient } from "@prisma/client";

export interface PlannedReminder {
  recipient: ReminderRecipient;
  channel: ReminderChannel;
  fireAt: Date;
}

export interface ReminderPlanInput {
  /// Booking start (UTC).
  start: Date;
  /// Lead times in minutes before the booking (from Settings). Customizable.
  offsetsMinutes: number[];
  /// Recipients to remind (typically hunter + attendee).
  recipients: ReminderRecipient[];
  /// Channels to use for a given recipient (attendee may be email-only,
  /// the owner may add SMS when a number is configured).
  channelsFor: (recipient: ReminderRecipient) => ReminderChannel[];
  /// "Now" — reminders whose fire time has already passed are dropped, so a
  /// booking made 30 min out doesn't immediately fire its 24h reminder.
  now: Date;
}

const MIN = 60_000;

/// Build the concrete set of reminders to persist for a booking. Deterministic
/// and pure; the caller writes the returned rows.
export function computeReminderPlan(input: ReminderPlanInput): PlannedReminder[] {
  const out: PlannedReminder[] = [];
  const seen = new Set<string>();
  for (const offset of input.offsetsMinutes) {
    const fireAt = new Date(input.start.getTime() - offset * MIN);
    if (fireAt.getTime() <= input.now.getTime()) continue; // already past
    if (fireAt.getTime() >= input.start.getTime()) continue; // non-positive offset
    for (const recipient of input.recipients) {
      for (const channel of input.channelsFor(recipient)) {
        // De-dupe identical (recipient, channel, fireAt) triples.
        const key = `${recipient}:${channel}:${fireAt.getTime()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ recipient, channel, fireAt });
      }
    }
  }
  return out;
}
