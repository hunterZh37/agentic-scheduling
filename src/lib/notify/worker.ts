import { BookingStatus, ReminderChannel } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveContact } from "./contact";
import { renderReminder, renderReminderDetail } from "./render";
import { sendEmail } from "./email";
import { sendSms } from "./sms";
import { sendWhatsAppReminder } from "./whatsapp";

export interface Senders {
  email: (to: string, subject: string, text: string) => Promise<void>;
  sms: (to: string, text: string) => Promise<void>;
  whatsapp: (to: string, detail: string, reminderId?: string) => Promise<void>;
}

const defaultSenders: Senders = { email: sendEmail, sms: sendSms, whatsapp: sendWhatsAppReminder };

/// After this many failed dispatch attempts a reminder is dead-lettered
/// (failedAt set) so it stops being retried and can't starve the queue.
const MAX_ATTEMPTS = 5;

/// A permanent failure — retrying can never succeed (missing contact info, an
/// unimplemented channel). These are dead-lettered on the first attempt rather
/// than retried MAX_ATTEMPTS times.
class TerminalReminderError extends Error {}

export interface ProcessOptions {
  now?: Date;
  senders?: Senders;
  /// Max reminders per run (cron is every 5 min; keep runs bounded).
  limit?: number;
}

export interface ProcessResult {
  processed: number;
  sent: number;
  failed: number;
  skipped: number; // e.g. reminders for cancelled bookings
  deadLettered: number; // permanently failed — will not be retried
  errors: Array<{ reminderId: string; message: string }>;
}

/// Grab due reminders (unsent and not dead-lettered) and dispatch them. Each row
/// is atomically claimed before sending so overlapping runs can't double-send;
/// on a transient failure the claim is released for retry, and after
/// MAX_ATTEMPTS (or on a permanent error) the row is dead-lettered so poison
/// rows can't monopolize the batch and starve healthy reminders.
export async function processDueReminders(opts: ProcessOptions = {}): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  const senders = opts.senders ?? defaultSenders;
  const limit = opts.limit ?? 100;

  const due = await prisma.reminder.findMany({
    where: { sentAt: null, failedAt: null, fireAt: { lte: now } },
    include: { booking: true },
    orderBy: { fireAt: "asc" },
    take: limit,
  });

  const result: ProcessResult = {
    processed: due.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    deadLettered: 0,
    errors: [],
  };

  for (const r of due) {
    // Cancelled booking: don't send, but clear the reminder so it isn't
    // reprocessed every run.
    if (r.booking.status === BookingStatus.cancelled) {
      await prisma.reminder.update({ where: { id: r.id }, data: { sentAt: now } });
      result.skipped++;
      continue;
    }

    // Atomically claim the row (mark sent + bump attempts) before dispatching so
    // a concurrent/overlapping run's query can't also select and re-send it. If
    // another run already claimed it, count === 0 and we skip.
    const claim = await prisma.reminder.updateMany({
      where: { id: r.id, sentAt: null, failedAt: null },
      data: { sentAt: now, attempts: { increment: 1 } },
    });
    if (claim.count === 0) continue;
    const attempts = r.attempts + 1;

    try {
      const contact = await resolveContact(r.recipient, r.booking);
      const msg = renderReminder({
        title: r.booking.title,
        start: r.booking.startTime,
        attendeeName: r.booking.attendeeName,
        recipient: r.recipient,
        timezone: contact.timezone,
      });

      if (r.channel === ReminderChannel.email) {
        if (!contact.email) throw new TerminalReminderError("no email address for recipient");
        await senders.email(contact.email, msg.subject, msg.text);
        // Log WHERE it went. Three reminders reported success while nothing
        // arrived, and there was no way to tell from the app which address had
        // been used.
        console.log(`[reminder] ${r.channel} -> ${contact.email} (booking ${r.bookingId})`);
      } else if (r.channel === ReminderChannel.sms) {
        if (!contact.phone) throw new TerminalReminderError("no phone number for recipient");
        await senders.sms(contact.phone, msg.text);
      } else if (r.channel === ReminderChannel.whatsapp) {
        if (!contact.whatsappPhone) throw new TerminalReminderError("no whatsapp number for recipient");
        const detail = renderReminderDetail({
          title: r.booking.title,
          start: r.booking.startTime,
          attendeeName: r.booking.attendeeName,
          recipient: r.recipient,
          timezone: contact.timezone,
        });
        await senders.whatsapp(contact.whatsappPhone, detail, r.id);
        // Twilio ACCEPTING a WhatsApp message is not delivery: failures arrive
        // minutes later on the status webhook (63016/63049 have both been seen
        // here). This line records the attempt; /api/sms/status records the
        // outcome.
        console.log(
          `[reminder] whatsapp -> ${contact.whatsappPhone} (booking ${r.bookingId}) — accepted by Twilio, delivery unconfirmed`
        );
      } else {
        throw new TerminalReminderError(`channel ${r.channel} not implemented (push is deferred)`);
      }

      // Success: sentAt is already set from the claim.
      result.sent++;
    } catch (err) {
      result.failed++;
      result.errors.push({
        reminderId: r.id,
        message: err instanceof Error ? err.message : String(err),
      });
      const terminal = err instanceof TerminalReminderError || attempts >= MAX_ATTEMPTS;
      if (terminal) {
        // Dead-letter: drop it out of the due query permanently.
        await prisma.reminder.update({
          where: { id: r.id },
          data: { sentAt: null, failedAt: now },
        });
        result.deadLettered++;
      } else {
        // Transient: release the claim so it's retried next run.
        await prisma.reminder.update({ where: { id: r.id }, data: { sentAt: null } });
      }
    }
  }

  return result;
}
