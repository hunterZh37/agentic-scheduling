"use client";

import { useState } from "react";
import { DateTime } from "luxon";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import styles from "./BookingPage.module.css";

interface BookingInfo {
  id: string;
  title: string;
  start: string; // ISO UTC
  end: string; // ISO UTC
  timezone: string;
  cancelled: boolean;
}

/// The manage screen an attendee lands on from the invite's manage link. Shows
/// their booking and lets them reschedule (→ the booking page in reschedule
/// mode) or cancel (→ the token-gated cancel endpoint). Invalid/expired links
/// and already-cancelled/past bookings each render a plain message.
export function ManageBooking({
  token,
  booking,
}: {
  token: string;
  booking: BookingInfo | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<"idle" | "cancelling" | "cancelled">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!booking) {
    return (
      <div className={styles.page}>
        <div className={styles.formCard}>
          <h2 className={styles.formTitle}>Link not valid</h2>
          <p className={styles.successSub}>
            This manage link is invalid or has expired. If you need to change your booking,
            just reply to your calendar invite.
          </p>
        </div>
      </div>
    );
  }

  const start = DateTime.fromISO(booking.start, { zone: "utc" }).setZone(booking.timezone);
  const end = DateTime.fromISO(booking.end, { zone: "utc" }).setZone(booking.timezone);
  const past = DateTime.fromISO(booking.end, { zone: "utc" }) < DateTime.utc();
  const range = `${start.toFormat("h:mm a")} – ${end.toFormat("h:mm a")}`;

  const cancel = async () => {
    setConfirming(false);
    setState("cancelling");
    setError(null);
    try {
      const res = await fetch(
        `/api/public/bookings/${booking.id}/cancel?t=${encodeURIComponent(token)}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.message ?? "Couldn't cancel — please try again.");
        setState("idle");
        return;
      }
      setState("cancelled");
    } catch {
      setError("Couldn't reach the server — please try again.");
      setState("idle");
    }
  };

  if (booking.cancelled || state === "cancelled") {
    return (
      <div className={styles.page}>
        <div className={styles.successCard}>
          <div className={styles.check}>✓</div>
          <h2 className={styles.successTitle}>Booking cancelled</h2>
          <p className={styles.successSub}>
            Your meeting has been cancelled and removed from the calendar. Thanks for letting
            us know.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.formCard}>
        <h2 className={styles.formTitle}>Manage your booking</h2>
        <div className={styles.summary}>
          <div className={styles.dateBadge}>
            <span className={styles.badgeMon}>{start.toFormat("LLL").toUpperCase()}</span>
            <span className={`${styles.badgeDay} tnum`}>{start.toFormat("d")}</span>
          </div>
          <div>
            <div className={`${styles.summaryTime} tnum`}>{range}</div>
            <div className={styles.summarySub}>
              {start.toFormat("cccc")} · {booking.timezone}
            </div>
          </div>
        </div>

        {past ? (
          <p className={styles.successSub}>This meeting has already taken place.</p>
        ) : (
          <div className={styles.manageActions}>
            <a className={styles.confirmBtn} href={`/book?reschedule=${booking.id}&t=${encodeURIComponent(token)}`}>
              Reschedule
            </a>
            <button
              data-testid="cancel-booking"
              className={styles.secondary}
              onClick={() => setConfirming(true)}
              disabled={state === "cancelling"}
            >
              {state === "cancelling" ? "Cancelling…" : "Cancel booking"}
            </button>
          </div>
        )}
        {error && <p className={styles.formError}>{error}</p>}
      </div>

      {confirming && (
        <ConfirmDialog
          title="Cancel this booking?"
          body="This removes the meeting from the calendar and can't be undone."
          confirmLabel="Cancel booking"
          cancelLabel="Keep booking"
          onConfirm={() => void cancel()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
