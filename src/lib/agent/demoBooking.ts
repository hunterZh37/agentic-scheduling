import { CreatedVia, BookingStatus } from "@prisma/client";
import { createBooking, cancelBooking } from "@/lib/booking/service";
import { prisma } from "@/lib/db";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";
import type { RequesterPersona } from "./personas";

/// Fixed attendee for every demo booking. Doubles as the stable cleanup key —
/// demo events are identified by this address, not by their (human-editable) title.
export const DEMO_ATTENDEE_EMAIL = "demo@example.com";

export interface DemoSlot {
  startISO: string;
  endISO: string;
}
export type BookOutcome = { ok: true } | { ok: false; error: string };

/// Create a real (but tagged + alert-suppressed) calendar booking for a demo
/// negotiation. Never throws — a BookingError (conflict/too_soon/unverified) or
/// any failure is returned as { ok:false, error }.
export async function bookDemoMeeting(persona: RequesterPersona, slot: DemoSlot): Promise<BookOutcome> {
  try {
    await createBooking({
      title: `[Demo] ${persona.name} <> ${OWNER_FIRST_NAME}`,
      start: new Date(slot.startISO),
      end: new Date(slot.endISO),
      attendeeName: persona.name,
      attendeeEmail: DEMO_ATTENDEE_EMAIL,
      attendeeTimezone: persona.timezone,
      createdVia: CreatedVia.public_agent,
      suppressHostAlert: true,
      suppressAttendeeEmail: true,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export interface CleanupDeps {
  listDemoBookings?: () => Promise<{ id: string }[]>;
  cancel?: (id: string) => Promise<unknown>;
}

/// Cancel every confirmed demo booking (removing the provider event via
/// cancelBooking). Best-effort: one failing cancel does not abort the sweep.
/// Returns the number successfully cancelled.
export async function cleanupDemoBookings(deps: CleanupDeps = {}): Promise<{ deleted: number }> {
  const listDemoBookings =
    deps.listDemoBookings ??
    (() =>
      prisma.booking.findMany({
        where: { attendeeEmail: DEMO_ATTENDEE_EMAIL, status: BookingStatus.confirmed },
        select: { id: true },
      }));
  const cancel = deps.cancel ?? ((id: string) => cancelBooking(id));

  const bookings = await listDemoBookings();
  let deleted = 0;
  for (const b of bookings) {
    try {
      await cancel(b.id);
      deleted += 1;
    } catch {
      // best-effort: skip a booking whose provider event is already gone / errored
    }
  }
  return { deleted };
}
