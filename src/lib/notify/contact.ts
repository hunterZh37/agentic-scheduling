import { ReminderRecipient } from "@prisma/client";
import { optionalEnv, DEFAULT_DESTINATION_EMAIL } from "@/lib/env";
import { prisma } from "@/lib/db";
import { isUnroutable } from "./email";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";

export interface RecipientContact {
  name: string;
  email?: string;
  phone?: string;
  whatsappPhone?: string;
  timezone: string;
}

interface BookingContactFields {
  attendeeName: string;
  attendeeEmail: string;
  attendeeTimezone: string;
}

/// Resolve where and how to reach a reminder's recipient. The attendee's
/// details come from the booking; the owner's from env, then the destination
/// calendar account.
///
/// Async because the owner's address may have to be read from the database.
/// It used to fall through to DEFAULT_DESTINATION_EMAIL, whose last resort is
/// the literal "owner@example.com" — a reserved domain that accepts no mail. A
/// reminder addressed there is accepted by the provider and delivered nowhere,
/// which is indistinguishable from success at every layer that could report it.
export async function resolveContact(
  recipient: ReminderRecipient,
  booking: BookingContactFields
): Promise<RecipientContact> {
  if (recipient === ReminderRecipient.attendee) {
    return {
      name: booking.attendeeName,
      email: booking.attendeeEmail,
      timezone: booking.attendeeTimezone,
    };
  }
  return {
    name: OWNER_FIRST_NAME,
    // env first, then the destination calendar account — definitionally the
    // owner's address and always present in a working install. Never a
    // placeholder: null here makes the worker dead-letter the reminder with a
    // clear reason instead of reporting a send that went nowhere.
    email: (await ownerEmailAddress()) ?? undefined,
    phone: optionalEnv("OWNER_SMS_NUMBER") ?? optionalEnv("HUNTER_SMS_NUMBER"),
    whatsappPhone:
      optionalEnv("OWNER_WHATSAPP_NUMBER") ??
      optionalEnv("HUNTER_WHATSAPP_NUMBER") ??
      optionalEnv("OWNER_SMS_NUMBER") ??
      optionalEnv("HUNTER_SMS_NUMBER"),
    timezone:
      optionalEnv("OWNER_TIMEZONE") ?? optionalEnv("HUNTER_TIMEZONE") ?? "America/New_York",
  };
}

/// The owner's real email address for app-generated mail (audits, alerts).
///
/// Env first, then the DESTINATION calendar account — the address bookings are
/// written to, i.e. definitionally the owner's, and always present in a working
/// install. Returns null rather than a placeholder when nothing resolves, so a
/// caller must decide what to do instead of silently mailing nowhere: every
/// recipient env var was unset in production and the fallback chain ended at the
/// literal string "owner@example.com".
export async function ownerEmailAddress(): Promise<string | null> {
  const configured =
    optionalEnv("OWNER_EMAIL") ??
    optionalEnv("HUNTER_EMAIL") ??
    optionalEnv("DEFAULT_DESTINATION_EMAIL");
  if (configured && !isUnroutable(configured)) return configured;

  const destination = await prisma.account.findFirst({ where: { isDestination: true } });
  const email = destination?.email?.trim();
  return email && !isUnroutable(email) ? email : null;
}
