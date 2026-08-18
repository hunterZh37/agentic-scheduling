import {
  BookingStatus,
  CreatedVia,
  Prisma,
  ReminderChannel,
  ReminderRecipient,
  type Account,
  type Booking,
  type Reminder,
} from "@prisma/client";
import { prisma } from "@/lib/db";
import { optionalEnv } from "@/lib/env";
import { fanOutBusy } from "@/lib/calendar/aggregate";
import { type Interval } from "@/lib/availability/interval";
import { sendEmail } from "@/lib/notify/email";
import { ownerEmailAddress } from "@/lib/notify/contact";
import {
  renderBookingDescription,
  renderBookingDescriptionHtml,
  formatInZone,
} from "@/lib/notify/render";
import { HOST, OWNER_FIRST_NAME } from "./publicConfig";
import { signManageToken, buildManageUrl } from "./manageToken";
import { sendTwilioMessage, sendWhatsAppTemplate } from "@/lib/sms/send";
import { sendSms } from "@/lib/notify/sms";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import {
  createDestinationEvent,
  deleteDestinationEvent,
  type EventDraft, type CreatedEvent } from "@/lib/calendar/write";
import { expandBlocks } from "@/lib/availability/index";
import { actionableBusy } from "@/lib/availability/actionableBusy";
import { checkSlotBookable, type BookingRejection } from "./conflict";
import { computeReminderPlan } from "./schedule";

export class BookingError extends Error {
  constructor(
    public code:
      | BookingRejection
      | "no_destination"
      // A named target account (private agent booking onto a specific calendar)
      // doesn't exist among the connected accounts.
      | "unknown_account"
      | "destination_not_connected"
      // Live free/busy couldn't be verified after retries. Distinct from
      // "conflict" (a real double-book) so the UI doesn't mislabel a transient
      // provider blip as "that time was just taken".
      | "availability_unverified"
      // No booking exists for the given id (e.g. cancel of an unknown/stale id).
      | "booking_not_found",
    message: string
  ) {
    super(message);
    this.name = "BookingError";
  }
}

/// Revalidate live free/busy, retrying transient per-account failures before
/// giving up. `fanOutBusy` marks an account failed on any blip (provider
/// 429/5xx, a token-refresh race); failing a booking closed on one such hiccup
/// — across several connected calendars — is a spurious failure the visitor
/// sees as "temporary issue verifying availability" / "that time was just
/// taken". Retry a few times, then report `verified:false` only if it still
/// can't be fully checked, so we never book over a possibly-busy time. Pure and
/// injectable (fetch + sleep) so the retry policy is unit-testable.
export async function revalidateBusyWithRetry(
  fetchBusy: () => Promise<{ busy: Interval[]; errors: unknown[] }>,
  opts: { attempts?: number; backoffMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<{ busy: Interval[]; verified: boolean }> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoffMs = opts.backoffMs ?? 250;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let last: { busy: Interval[]; errors: unknown[] } = { busy: [], errors: ["not run"] };
  for (let i = 0; i < attempts; i++) {
    last = await fetchBusy();
    if (last.errors.length === 0) return { busy: last.busy, verified: true };
    if (i < attempts - 1) await sleep(backoffMs * (i + 1));
  }
  return { busy: last.busy, verified: false };
}

export interface CreateBookingInput {
  title?: string;
  start: Date;
  end: Date;
  attendeeName: string;
  attendeeEmail: string;
  attendeeTimezone: string;
  createdVia: CreatedVia;
  now?: Date;
  /// Write the booking to a specific connected account (by email) instead of the
  /// default destination. Used by the private agent to book onto any of the
  /// owner's connected calendars. Unset = the destination account.
  targetAccountEmail?: string;
  /// Skip the "new booking" WhatsApp alert to the owner. Used by reschedule, which
  /// sends its own "moved" alert instead of a misleading new-booking one.
  suppressHostAlert?: boolean;
  /// Skip the attendee confirmation email. Used by the demo, whose fixed demo
  /// attendee address is not a real inbox — sending would just bounce.
  suppressAttendeeEmail?: boolean;
  /// JOINT (team) booking: the co-hosts who must ALSO be free for this slot.
  /// Their free/busy is re-checked at write time alongside the owner's, so a
  /// direct API call can never book a time one of them is busy. Empty/absent =
  /// an ordinary single-owner booking (unchanged).
  coHostIds?: string[];
  /// JOINT booking: co-host emails to add to the invite, so the event lands on
  /// their calendars too. The single write still targets the owner's
  /// destination; everyone rides on one invite (no second write, no co-host
  /// tokens used here).
  additionalAttendeeEmails?: string[];
  /// The team this booking was made through, recorded on the row for tracing.
  teamId?: string;
  /// JOINT booking: the team label the confirmation/invite say the meeting is
  /// "with", and every host to sign off from. Absent = solo (owner only).
  hostLabel?: string;
  hosts?: { name: string; linkedin?: string | null }[];
}

export interface CreateBookingDeps {
  /// Injectable calendar writer (real destination write by default; stubbed in
  /// tests to exercise row/reminder creation without a connected account).
  writeEvent?: (account: Account, draft: EventDraft) => Promise<CreatedEvent>;
}

const DEFAULT_SETTINGS = {
  bookingHorizonDays: 60,
  minNoticeHours: 0,
  bufferMinutes: 0,
  defaultEventDurationMinutes: 30,
  reminderOffsetsMinutes: [1440, 60],
};

/// Create a booking: revalidate the slot, write the event to the destination
/// account, then persist the Booking and its scheduled Reminder rows.
export async function createBooking(
  input: CreateBookingInput,
  deps: CreateBookingDeps = {}
): Promise<Booking & { reminders: Reminder[] }> {
  const now = input.now ?? new Date();
  const writeEvent = deps.writeEvent ?? createDestinationEvent;

  // The subjects whose calendars/blocks gate this slot: the owner always
  // (coHostId=null), plus the team's co-hosts for a joint booking. This must
  // match what the availability read considered — the owner page is scoped to
  // owner-only, so a single-owner write must load only owner blocks, and a joint
  // write must load the team members' blocks too. Loading ALL blocks (the old
  // behaviour) would let one co-host's reserved time reject an unrelated owner
  // booking. See docs/REGRESSIONS.md.
  const coHostIds = [...new Set(input.coHostIds ?? [])];
  const [settingsRow, destination, blocks] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" } }),
    prisma.account.findFirst({ where: { isDestination: true } }),
    prisma.personalBlock.findMany({
      where: { OR: [{ coHostId: null }, { coHostId: { in: coHostIds } }] },
    }),
  ]);
  const settings = settingsRow ?? DEFAULT_SETTINGS;

  // The calendar to write to: an explicitly requested connected account, or the
  // default destination. Both must exist and be connected.
  const target = input.targetAccountEmail
    ? await prisma.account.findFirst({ where: { email: input.targetAccountEmail } })
    : destination;
  if (!target) {
    throw new BookingError(
      input.targetAccountEmail ? "unknown_account" : "no_destination",
      input.targetAccountEmail
        ? `No connected account for ${input.targetAccountEmail}.`
        : "No destination account is configured."
    );
  }
  if (!target.refreshToken && !target.accessToken) {
    throw new BookingError(
      "destination_not_connected",
      `Account ${target.email} is not connected. Authorize it before booking.`
    );
  }

  // Revalidate the slot against live busy + personal blocks (defense in depth).
  // If any conflict-checked account's free/busy query failed, its busy intervals
  // are missing from `busy` — fail closed rather than book over a time that may
  // actually be busy (under-reporting is exactly what aggregate.ts warns about).
  // Retry first: a single transient blip on one of several calendars shouldn't
  // sink an otherwise-open slot (see revalidateBusyWithRetry).
  // Re-check EVERY subject: the owner (null) and each co-host. A joint slot is
  // only bookable when all of them are free, and any subject failing to verify
  // fails the whole booking closed — never book over a time a co-host might be
  // busy just because the owner is free.
  const subjects: Array<string | null> = [null, ...coHostIds];
  const fanResults = await Promise.all(
    subjects.map((id) => revalidateBusyWithRetry(() => fanOutBusy(input.start, input.end, id)))
  );
  if (fanResults.some((r) => !r.verified)) {
    throw new BookingError(
      "availability_unverified",
      "Couldn't verify availability across all calendars right now. Please try again in a moment."
    );
  }
  const busy = fanResults.flatMap((r) => r.busy);
  const blockBusy = expandBlocks(
    blocks.map((b) => ({
      startTime: b.startTime,
      endTime: b.endTime,
      timezone: b.timezone,
      recurrenceRule: b.recurrenceRule,
    })),
    input.start,
    input.end
  );
  // Hiding a slot on the page is not enough: this is the write path, and a
  // direct API call reaches it without ever loading the page.
  const todoBusy = await actionableBusy(input.start, input.end);
  const rejection = checkSlotBookable(
    { start: input.start, end: input.end },
    [...busy, ...blockBusy, ...todoBusy],
    now,
    settings
  );
  if (rejection) {
    throw new BookingError(rejection, `Slot cannot be booked: ${rejection}.`);
  }

  const title = input.title?.trim() || `${input.attendeeName} <> ${OWNER_FIRST_NAME}`;

  // Give the attendee an actual message in the invite — the provider .ics
  // otherwise arrives with an empty body. Rendered in the attendee's own zone.
  // Pre-generate the booking id so the self-serve manage link (reschedule /
  // cancel) can be embedded in the invite, which is written before the row.
  const bookingId = crypto.randomUUID();
  const manageUrl = buildManageUrl(bookingId, await signManageToken(bookingId));

  const descriptionArgs = {
    start: input.start,
    end: input.end,
    attendeeName: input.attendeeName,
    hostName: HOST.name,
    timezone: input.attendeeTimezone,
    linkedinUrl: HOST.linkedin,
    manageUrl,
    videoUrl: HOST.videoLink,
    // Joint booking: say "with <team>" and sign off from every host. Solo leaves
    // these undefined and the renderer keeps its owner-only output.
    hostLabel: input.hostLabel,
    hosts: input.hosts,
  };
  const description = renderBookingDescription(descriptionArgs);
  const descriptionHtml = renderBookingDescriptionHtml(descriptionArgs);

  // Write to the real calendar first — if this fails, no row is created. The
  // video link doubles as the event location so calendar apps surface a join
  // button.
  const created = await writeEvent(target, {
    title,
    description,
    descriptionHtml,
    location: HOST.videoLink,
    start: input.start,
    end: input.end,
    attendeeName: input.attendeeName,
    attendeeEmail: input.attendeeEmail,
    // Co-hosts ride on the same invite so the event lands on their calendars.
    additionalAttendeeEmails: input.additionalAttendeeEmails,
  });
  // Bookings keep using the owner's static room (HOST.videoLink) as the
  // location, so no per-event conference is requested here; only the id is
  // needed downstream.
  const externalEventId = created.id;

  const channelsFor = (recipient: ReminderRecipient): ReminderChannel[] => {
    const channels: ReminderChannel[] = [ReminderChannel.email];
    // Attendee gives only an email; the owner also gets a second channel when
    // configured. Prefer WhatsApp (an approved template delivers reliably any
    // time) over plain SMS — TWILIO_FROM_NUMBER is A2P-unregistered and SMS
    // sends from it fail (error 30034) — so only fall back to SMS when
    // WhatsApp isn't fully configured. Never both, to avoid double-sending.
    if (recipient === ReminderRecipient.hunter) {
      const ownerSmsNumber = optionalEnv("OWNER_SMS_NUMBER") ?? optionalEnv("HUNTER_SMS_NUMBER");
      const whatsappTo =
        optionalEnv("OWNER_WHATSAPP_NUMBER") ?? optionalEnv("HUNTER_WHATSAPP_NUMBER") ?? ownerSmsNumber;
      if (
        optionalEnv("TWILIO_REMINDER_CONTENT_SID") &&
        optionalEnv("TWILIO_WHATSAPP_FROM") &&
        whatsappTo
      ) {
        channels.push(ReminderChannel.whatsapp);
      } else if (ownerSmsNumber) {
        channels.push(ReminderChannel.sms);
      }
    }
    return channels;
  };

  const plan = computeReminderPlan({
    start: input.start,
    offsetsMinutes: settings.reminderOffsetsMinutes,
    recipients: [ReminderRecipient.hunter, ReminderRecipient.attendee],
    channelsFor,
    now,
  });

  let booking: Booking & { reminders: Reminder[] };
  try {
    booking = await prisma.booking.create({
      data: {
        id: bookingId,
        title,
        startTime: input.start,
        endTime: input.end,
        attendeeName: input.attendeeName,
        attendeeEmail: input.attendeeEmail,
        attendeeTimezone: input.attendeeTimezone,
        destinationAccountId: target.id,
        externalEventId,
        status: BookingStatus.confirmed,
        createdVia: input.createdVia,
        ...(input.teamId ? { teamId: input.teamId } : {}),
        reminders: {
          create: plan.map((p) => ({
            recipient: p.recipient,
            channel: p.channel,
            fireAt: p.fireAt,
          })),
        },
      },
      include: { reminders: true },
    });
  } catch (err) {
    // The calendar event was already written (and invites emailed). If the row
    // can't be persisted we must not orphan a live, untracked event — delete it.
    await deleteDestinationEvent(target, externalEventId);
    // A unique-index violation means another CONFIRMED booking already holds
    // this slot on the destination account: a concurrent double-book that
    // slipped past the free/busy revalidation (TOCTOU). Surface as a conflict.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new BookingError("conflict", "That time was just taken.");
    }
    throw err;
  }

  // Immediate confirmation email to the attendee. Best-effort: the booking is
  // already committed and the provider calendar invite already sent, so a mail
  // failure must never fail the booking (and the scheduled reminder emails are
  // the durable fallback). No-ops when email isn't configured.
  if (!input.suppressAttendeeEmail) {
    await sendAttendeeConfirmation(booking, {
      hostLabel: input.hostLabel,
      hosts: input.hosts,
    }).catch((err) => console.error("[booking] attendee confirmation email failed:", err));
  }

  // Ping the owner over WhatsApp when a VISITOR books (public link/agent) — not
  // when the owner books via their own private agent (they already know). Best-effort.
  if (booking.createdVia !== CreatedVia.private_agent && !input.suppressHostAlert) {
    await notifyHostOfBooking(booking).catch((err) =>
      console.error("[booking] owner WhatsApp alert failed:", err)
    );
  }

  return booking;
}

function whatsappAddress(num: string): string {
  return num.startsWith("whatsapp:") ? num : `whatsapp:${num}`;
}

/// Fan an alert out to the owner over three channels independently (WhatsApp +
/// SMS + email, via Promise.allSettled), so one failing — or being
/// unconfigured — never blocks the others. `templateVar` is the {{1}} value if
/// an approved WhatsApp template SID is configured. Email is the only channel
/// that doesn't ride on Twilio: when the WhatsApp sender silently lost its
/// Meta registration (error 63112), every booking alert died in transit and
/// nothing reached the owner for days. See docs/REGRESSIONS.md.
export async function alertHost(text: string, templateVar: string): Promise<void> {
  const results = await Promise.allSettled([
    sendWhatsAppAlert(text, templateVar),
    sendSmsAlert(text),
    sendEmailAlert(text),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.error("[booking] owner alert channel failed:", r.reason);
  }
}

/// Owner-facing label for which of the two visitor booking mechanisms was
/// used. The owner wants every new-booking alert to say HOW the person booked:
/// picking a slot on the page, or talking to the agent. (private_agent never
/// reaches the alert path — the owner's own bookings aren't announced — but
/// the mapping is total so a future caller can't produce an unlabeled alert.)
export function bookingMechanismLabel(via: CreatedVia): string {
  switch (via) {
    case CreatedVia.public_link:
      return "booked via the booking page UI";
    case CreatedVia.public_agent:
      return "booked by chatting with the agent";
    case CreatedVia.private_agent:
      return "booked via your private agent";
  }
}

/// The new-booking alert body/template-variable. Pure so the exact owner-facing
/// wording — including the mechanism label — is unit-testable.
export function newBookingSummary(booking: Booking): string {
  const when = formatInZone(booking.startTime, OWNER_TIMEZONE);
  return `${booking.attendeeName} (${booking.attendeeEmail}) booked "${booking.title}" for ${when} — ${bookingMechanismLabel(booking.createdVia)}.`;
}

async function notifyHostOfBooking(booking: Booking): Promise<void> {
  const summary = newBookingSummary(booking);
  await alertHost(`🔔 New booking — ${summary}`, summary);
}

/// Alert the owner that an attendee cancelled their own booking (self-serve).
async function notifyHostOfCancellation(booking: Booking): Promise<void> {
  const when = formatInZone(booking.startTime, OWNER_TIMEZONE);
  const summary = `${booking.attendeeName} (${booking.attendeeEmail}) cancelled "${booking.title}", which was ${when}.`;
  await alertHost(`❌ Booking cancelled — ${summary}`, summary);
}

/// Alert the owner that an attendee rescheduled their booking to a new time.
async function notifyHostOfReschedule(previous: Booking, next: Booking): Promise<void> {
  const from = formatInZone(previous.startTime, OWNER_TIMEZONE);
  const to = formatInZone(next.startTime, OWNER_TIMEZONE);
  const summary = `${next.attendeeName} (${next.attendeeEmail}) moved "${next.title}" from ${from} to ${to}.`;
  await alertHost(`🔄 Booking rescheduled — ${summary}`, summary);
}

/// WhatsApp alert: an approved content template when TWILIO_BOOKING_ALERT_CONTENT_SID
/// is set (deliverable any time), else a freeform message — which only lands
/// inside WhatsApp's 24h window (within 24h of the owner last messaging the
/// sandbox). No-ops when WhatsApp isn't configured.
async function sendWhatsAppAlert(freeformText: string, templateVar: string): Promise<void> {
  // Staging/e2e: never ping the real owner for synthetic test bookings.
  if (optionalEnv("E2E_STUB_CALENDAR") === "true") return;
  const to =
    optionalEnv("OWNER_WHATSAPP_NUMBER") ??
    optionalEnv("HUNTER_WHATSAPP_NUMBER") ??
    optionalEnv("OWNER_SMS_NUMBER") ??
    optionalEnv("HUNTER_SMS_NUMBER");
  const from = optionalEnv("TWILIO_WHATSAPP_FROM");
  if (!to || !from) return;
  const contentSid = optionalEnv("TWILIO_BOOKING_ALERT_CONTENT_SID");
  if (contentSid) {
    await sendWhatsAppTemplate(whatsappAddress(to), whatsappAddress(from), contentSid, {
      "1": templateVar,
    });
  } else {
    await sendTwilioMessage(whatsappAddress(to), whatsappAddress(from), freeformText);
  }
}

/// SMS alert: plain SMS via TWILIO_FROM_NUMBER. OFF by default — the owner uses
/// WhatsApp only, and the US 10DLC sender can't send SMS without A2P 10DLC
/// registration (Twilio error 30034), so the attempt just fails. Set
/// BOOKING_ALERT_SMS_ENABLED=true (once A2P is registered) to turn it back on.
/// Also no-ops when SMS isn't otherwise configured.
async function sendSmsAlert(text: string): Promise<void> {
  if (optionalEnv("BOOKING_ALERT_SMS_ENABLED") !== "true") return;
  const to = optionalEnv("OWNER_SMS_NUMBER") ?? optionalEnv("HUNTER_SMS_NUMBER");
  const from = optionalEnv("TWILIO_FROM_NUMBER");
  if (!to || !from) return;
  await sendSms(to, text);
}

/// Email alert to the owner's real address (env, then the destination calendar
/// account). Quietly no-ops only when email itself isn't configured (no
/// RESEND_API_KEY — local dev); an unresolvable owner address THROWS so the
/// failure is logged by alertHost instead of reading as sent-to-nobody.
async function sendEmailAlert(text: string): Promise<void> {
  if (!optionalEnv("RESEND_API_KEY")) return;
  const to = await ownerEmailAddress();
  if (!to) {
    throw new Error(
      "owner email alert: no owner address — set OWNER_EMAIL or connect a destination calendar"
    );
  }
  await sendEmail(to, text, text);
}

/// Email the attendee an immediate booking confirmation — the same rich content
/// as the calendar invite body (bold details, manage link, signature), as both
/// HTML and a plain-text fallback. Quietly no-ops when email isn't configured
/// (no RESEND_API_KEY), so local/dev bookings don't error.
async function sendAttendeeConfirmation(
  booking: Booking,
  // Same team context passed to the invite body, so the confirmation EMAIL is
  // team-aware too (it renders separately from the calendar event). Absent = solo.
  team?: { hostLabel?: string; hosts?: { name: string; linkedin?: string | null }[] }
): Promise<void> {
  if (!optionalEnv("RESEND_API_KEY")) return;
  const manageUrl = buildManageUrl(booking.id, await signManageToken(booking.id));
  const args = {
    start: booking.startTime,
    end: booking.endTime,
    attendeeName: booking.attendeeName,
    hostName: HOST.name,
    timezone: booking.attendeeTimezone,
    linkedinUrl: HOST.linkedin,
    manageUrl,
    videoUrl: HOST.videoLink,
    hostLabel: team?.hostLabel,
    hosts: team?.hosts,
  };
  await sendEmail(
    booking.attendeeEmail,
    `Confirmed: ${booking.title}`,
    renderBookingDescription(args),
    renderBookingDescriptionHtml(args)
  );
}

/// Cancel a booking: remove its calendar event (emailing the attendee that it's
/// cancelled) and mark the row cancelled. Soft-cancel by design — the schedule
/// and bookings views already filter to `confirmed`, and the reminder worker
/// skips cancelled bookings, so pending reminders stop firing without deleting
/// rows; the record is kept for history. Idempotent: cancelling an already-
/// cancelled booking is a no-op. Throws BookingError("booking_not_found") for an
/// unknown id.
export async function cancelBooking(
  bookingId: string,
  opts: { notifyHost?: boolean } = {}
): Promise<Booking> {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { destinationAccount: true },
  });
  if (!booking) {
    throw new BookingError("booking_not_found", "No booking exists with that id.");
  }
  if (booking.status === BookingStatus.cancelled) return booking; // idempotent, no alert

  // Delete the provider event first and notify the attendee. Best-effort (the
  // helper swallows provider errors) so a stale/already-deleted event doesn't
  // block cancelling the booking on our side.
  if (booking.externalEventId) {
    await deleteDestinationEvent(booking.destinationAccount, booking.externalEventId, {
      notify: true,
    });
  }

  const cancelled = await prisma.booking.update({
    where: { id: bookingId },
    data: { status: BookingStatus.cancelled },
  });

  // Only when the attendee self-cancels — not for the owner's own dashboard/agent
  // cancels, or the internal cancel of a reschedule (which sends a "moved" alert).
  if (opts.notifyHost) {
    await notifyHostOfCancellation(cancelled).catch((err) =>
      console.error("[booking] owner cancellation alert failed:", err)
    );
  }

  return cancelled;
}

/// Reschedule a booking to a new time: book the same attendee at the new slot,
/// then cancel the original. New-first so a failure to book (e.g. the slot was
/// taken) leaves the original booking intact and surfaces the error to the
/// caller. The attendee thus receives a cancellation for the old event and a
/// fresh invite for the new one. Throws booking_not_found for an unknown or
/// already-cancelled id.
export async function rescheduleBooking(
  oldId: string,
  input: { start: Date; end: Date; title?: string }
): Promise<Booking> {
  const old = await prisma.booking.findUnique({ where: { id: oldId } });
  if (!old || old.status === BookingStatus.cancelled) {
    throw new BookingError("booking_not_found", "That booking no longer exists.");
  }

  const created = await createBooking({
    // A title override lets the owner rename while moving; otherwise keep the
    // attendee-facing title unchanged.
    title: input.title?.trim() || old.title,
    start: input.start,
    end: input.end,
    attendeeName: old.attendeeName,
    attendeeEmail: old.attendeeEmail,
    attendeeTimezone: old.attendeeTimezone,
    createdVia: old.createdVia,
    // A reschedule sends one "moved" alert (below), not a new-booking alert.
    suppressHostAlert: true,
  });

  // Old event goes away only after the new one is safely booked. Best-effort:
  // if this fails the attendee has both, which the owner can clean up — better
  // than losing the just-confirmed new time. No cancel alert here — the move is
  // reported as a single reschedule alert.
  await cancelBooking(oldId).catch((err) =>
    console.error("[booking] reschedule: failed to cancel old booking", oldId, err)
  );

  await notifyHostOfReschedule(old, created).catch((err) =>
    console.error("[booking] owner reschedule alert failed:", err)
  );

  return created;
}
