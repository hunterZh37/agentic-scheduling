import type { BookingRow } from "./detailItem";

/// How long a cancelled booking stays in the Upcoming list before hiding
/// itself. Long enough that the owner sees the cancellation on their next look
/// at the dashboard, short enough that the list does not fill with dead rows.
export const CANCELLED_VISIBLE_MS = 24 * 60 * 60 * 1000;

/// Checkoff key marking a cancelled booking as dismissed from the UI. Its own
/// namespace so it can never collide with an agenda item's crossed-off key.
export const dismissKey = (bookingId: string) => `dismissed-booking:${bookingId}`;

/// Which bookings the "Upcoming bookings" list shows, in start order.
///
/// Confirmed bookings always show. A cancelled one stays visible so the owner
/// can SEE that it was cancelled — a meeting vanishing without a trace is
/// indistinguishable from one that was never made — but it should not linger:
/// it drops off 24h after cancellation, or immediately once dismissed.
///
/// `updatedAt` stands in for the cancellation time: nothing writes to a booking
/// row after it is cancelled. That avoids adding a `cancelledAt` column, and a
/// migration against production, for a purely cosmetic deadline. A row with no
/// `updatedAt` is kept rather than hidden — failing towards showing too much is
/// recoverable with the trash control; failing towards hiding is not.
export function visibleUpcomingBookings(
  bookings: BookingRow[],
  dismissed: ReadonlySet<string>,
  nowMs: number
): BookingRow[] {
  const cutoff = nowMs - CANCELLED_VISIBLE_MS;
  return bookings
    .filter((b) => {
      if (b.status !== "cancelled") return true;
      if (dismissed.has(dismissKey(b.id))) return false;
      const at = b.updatedAt ? new Date(b.updatedAt).getTime() : null;
      if (at === null || Number.isNaN(at)) return true;
      return at > cutoff;
    })
    .slice()
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}
