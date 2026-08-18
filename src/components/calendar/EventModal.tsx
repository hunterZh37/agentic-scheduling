"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DateTime } from "luxon";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { locationHref } from "@/lib/maps";
import { accountVar, colorForEmail } from "@/lib/design/accounts";
import { useAccountLabels } from "@/components/calendars/useAccountLabels";
import { isOvernight } from "@/lib/timeFormat";
import { sanitizeDescriptionHtml } from "@/lib/text/sanitizeDescriptionHtml";
import { followupKey } from "@/lib/followups/key";
import { useSheetDrag } from "@/lib/motion/useSheetDrag";
import { haptic } from "@/lib/motion/haptics";
import ReminderControl from "@/components/reminders/ReminderControl";
import { EventFollowups } from "./EventFollowups";
import type { CalendarItem } from "./types";
import styles from "./EventModal.module.css";

// One consistent inline-SVG icon per row meaning, so every detail popover
// (event, booking, actionable, block) reads as the same layout. Replaces a set
// of mismatched unicode glyphs — where the same "◍" even stood in for both
// location and guests.
type RowIconName = "when" | "type-event" | "type-booking" | "type-actionable" | "type-block" | "location" | "video" | "guests" | "notes";
const ROW_ICON_PATHS: Record<RowIconName, string> = {
  when: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 1.8",
  "type-event": "M3.5 5h17v15h-17zM3.5 9.5h17M8 3v4M16 3v4",
  "type-booking": "M12 4.5a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4M5.5 20a6.5 6.5 0 0 1 13 0",
  "type-actionable": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 12.5l2.4 2.4 4.6-5",
  "type-block": "M4.5 4.5h15v15h-15zM4.5 9h15",
  location: "M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  video: "M3 6.5h11v11H3zM14 10l6.5-3.5v11L14 14",
  guests: "M9 8.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6M3.5 19a5.5 5.5 0 0 1 11 0M16 3.2a3 3 0 0 1 0 5.8M15.5 14.2a5.5 5.5 0 0 1 4.5 4.8",
  notes: "M5 6.5h14M5 11h14M5 15.5h9",
};
function RowIcon({ name }: { name: RowIconName }) {
  return (
    <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ROW_ICON_PATHS[name]} />
    </svg>
  );
}

function videoProvider(url: string): string {
  if (/zoom\.us/i.test(url)) return "Zoom";
  if (/meet\.google/i.test(url)) return "Google Meet";
  if (/teams\.microsoft/i.test(url)) return "Microsoft Teams";
  return "Video call";
}

// Turn a provider write failure into something actionable. The common case is
// trying to edit/delete an event the owner was invited to but doesn't organize —
// Google/Microsoft answer 403, which we translate instead of showing raw text.
function friendlyWriteError(err: unknown, verb: "change" | "delete" | "cancel"): string {
  const msg = err instanceof Error ? err.message : "Something went wrong.";
  if (/403|forbidden|not the organizer|organizer/i.test(msg)) {
    return `Only the event's organizer can ${verb} it. You can open it in your calendar to respond or request changes.`;
  }
  return msg;
}

// Flatten a provider's (possibly HTML) description into plain text to seed the
// notes editor. If the user doesn't touch the field we omit it from the PATCH,
// so the original rich description is preserved; only an edited field is sent.
function htmlToPlain(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function statusLabel(s?: string): { text: string; cls: string } {
  switch (s) {
    case "accepted":
      return { text: "Yes", cls: "yes" };
    case "declined":
      return { text: "No", cls: "no" };
    case "tentative":
      return { text: "Maybe", cls: "maybe" };
    default:
      return { text: "Awaiting", cls: "awaiting" };
  }
}

export function EventModal({
  item,
  onClose,
  onChanged,
  onFollowupsChanged,
}: {
  item: CalendarItem;
  onClose: () => void;
  /// Called after a successful edit/delete so the parent can refetch.
  onChanged?: () => void;
  /// Called after a follow-up is added/toggled/deleted so the agenda can refetch
  /// (fires once the write resolves — no race with the in-flight request).
  onFollowupsChanged?: () => void;
}) {
  const start = DateTime.fromJSDate(item.start, { zone: "utc" }).setZone(OWNER_TIMEZONE);
  const end = DateTime.fromJSDate(item.end, { zone: "utc" }).setZone(OWNER_TIMEZONE);

  // --- Edit support ---
  const providerId = item.id.replace(/^(event|actionable|booking):/, "");
  // Show Edit on any real event synced from a connected account. Whether the
  // owner may actually change it is the provider's call — Google/Microsoft
  // reject a non-organizer's edit, and we surface that verdict (see
  // doSave/doDelete) rather than guessing from the organizer field, which
  // hides the button on the many sessions others booked with the owner.
  // Actionables are ours in the app's own DB, so they're always editable —
  // no provider round-trip and no organizer question the way events have.
  const isActionable = item.kind === "actionable";
  // A booking is editable by the owner like everything else: the same Edit
  // button in the header, and "Cancel booking" lives inside edit mode (not a
  // second header button). Saving a time change reschedules — books the new
  // slot, drops the old — so the provider sends the attendee an updated invite.
  const isBooking = item.kind === "booking";
  const canEdit = (item.kind === "event" && !!item.accountEmail) || isActionable || isBooking;
  const seedNotes = item.description ? htmlToPlain(item.description) : "";

  const [mode, setMode] = useState<"view" | "edit">("view");
  const [fTitle, setFTitle] = useState(item.title);
  const [fDate, setFDate] = useState(start.toISODate() ?? "");
  const [fStart, setFStart] = useState(start.toFormat("HH:mm"));
  const [fEnd, setFEnd] = useState(end.toFormat("HH:mm"));
  const [fLoc, setFLoc] = useState(item.location ?? "");
  // Actionable-only "where" fields. A Todo stores these as separate columns
  // (location / videoLink / phone) rather than one free-text field.
  const [fUrl, setFUrl] = useState(item.videoLink ?? "");
  const [fPhone, setFPhone] = useState(item.phone ?? "");
  const [fNotes, setFNotes] = useState(seedNotes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A write that touches guests waits on this confirm ("save" | "delete").
  const [confirm, setConfirm] = useState<"save" | "delete" | null>(null);

  // Drag-to-dismiss for the phone bottom sheet. Only while simply viewing — an
  // in-progress edit or a pending confirm shouldn't vanish on a downward drag
  // (same rule the backdrop tap follows). No-op on desktop, where the modal is a
  // centered dialog.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const sheet = useSheetDrag({
    enabled: isMobile && mode === "view" && !confirm && !busy,
    onDismiss: onClose,
  });

  const attendeeCount = item.attendees?.length ?? 0;
  const hasGuests = attendeeCount > 0;

  const buildTimes = () => {
    const s = DateTime.fromISO(`${fDate}T${fStart}`, { zone: OWNER_TIMEZONE });
    let e = DateTime.fromISO(`${fDate}T${fEnd}`, { zone: OWNER_TIMEZONE });
    if (e <= s) e = e.plus({ days: 1 }); // treat end-before-start as overnight
    return { s, e };
  };

  const doSave = async (notify: boolean) => {
    setBusy(true);
    setError(null);
    const { s, e } = buildTimes();

    // Actionables are Todo rows, not provider events: different endpoint, and
    // `date` must move with the times or the item keeps showing under its old
    // day (the agenda queries by that day key).
    if (isActionable) {
      try {
        const res = await fetch(`/api/todos/${encodeURIComponent(providerId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: fTitle.trim(),
            date: s.startOf("day").toUTC().toISO(),
            startTime: s.toUTC().toISO(),
            endTime: e.toUTC().toISO(),
            location: fLoc,
            videoLink: fUrl,
            phone: fPhone,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message ?? "Could not save the actionable.");
        haptic("success");
        onChanged?.();
        onClose();
      } catch (err) {
        setError(friendlyWriteError(err, "change"));
        setBusy(false);
      }
      return;
    }

    // Bookings reschedule through their own endpoint: it re-books the new slot
    // and drops the old, so the attendee gets an updated calendar invite for
    // the new time. (`notify` isn't a choice here — a reschedule always tells
    // the attendee; there's no silent way to move their meeting.)
    if (isBooking) {
      try {
        const res = await fetch(`/api/bookings/${encodeURIComponent(providerId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: fTitle.trim(),
            start: s.toUTC().toISO(),
            end: e.toUTC().toISO(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message ?? "Could not update the booking.");
        haptic("success");
        onChanged?.();
        onClose();
      } catch (err) {
        setError(friendlyWriteError(err, "change"));
        setBusy(false);
        setConfirm(null);
      }
      return;
    }

    const payload: Record<string, unknown> = {
      accountEmail: item.accountEmail,
      title: fTitle.trim(),
      startTime: s.toUTC().toISO(),
      endTime: e.toUTC().toISO(),
      notify,
    };
    // Only send location/notes if the user actually changed them (see route).
    if (fLoc !== (item.location ?? "")) payload.location = fLoc;
    if (fNotes !== seedNotes) payload.description = fNotes;
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(providerId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "Could not save the event.");
      haptic("success");
      onChanged?.();
      onClose();
    } catch (err) {
      setError(friendlyWriteError(err, "change"));
      setBusy(false);
      setConfirm(null);
    }
  };

  const doDelete = async (notify: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = isActionable
        ? await fetch(`/api/todos/${encodeURIComponent(providerId)}`, { method: "DELETE" })
        : await fetch(`/api/events/${encodeURIComponent(providerId)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountEmail: item.accountEmail, notify }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message ?? `Could not delete the ${isActionable ? "actionable" : "event"}.`);
      }
      haptic("success");
      onChanged?.();
      onClose();
    } catch (err) {
      setError(friendlyWriteError(err, "delete"));
      setBusy(false);
      setConfirm(null);
    }
  };

  /// Cancel a booking. Distinct from deleting an event: it releases the slot,
  /// removes the calendar event AND emails the attendee that it is off — so it
  /// always confirms first, and says who is about to be told.
  const doCancelBooking = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? "Could not cancel the booking.");
      haptic("success");
      onChanged?.();
      onClose();
    } catch (err) {
      setError(friendlyWriteError(err, "cancel"));
      setBusy(false);
      setConfirm(null);
    }
  };

  // Button entry points: guests → ask about notifications first; otherwise act.
  const requestSave = () => {
    if (!fTitle.trim()) {
      setError("Title can't be empty.");
      return;
    }
    setError(null);
    if (hasGuests) setConfirm("save");
    else void doSave(false);
  };
  const requestDelete = () => {
    setError(null);
    // Always confirm before deleting. With guests the overlay also asks whether
    // to notify them; without guests it's a plain "are you sure?".
    setConfirm("delete");
  };

  // Escape backs out one level: confirm → edit → close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      if (confirm) setConfirm(null);
      else if (mode === "edit") setMode("view");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy, confirm, mode]);

  // Multi-day/overnight: the end time alone would read as same-day, so tack
  // on each side's weekday, e.g. "11:00 PM Mon – 1:00 AM Tue".
  const overnight = isOvernight(item.start, item.end, OWNER_TIMEZONE);
  const sameMer = !overnight && start.toFormat("a") === end.toFormat("a");
  const timeStr = overnight
    ? `${start.toFormat("h:mm a")} ${start.toFormat("ccc")} – ${end.toFormat("h:mm a")} ${end.toFormat("ccc")}`
    : sameMer
      ? `${start.toFormat("h:mm")} – ${end.toFormat("h:mm a")}`
      : `${start.toFormat("h:mm a")} – ${end.toFormat("h:mm a")}`;
  const dateStr = start.toFormat("cccc, LLLL d");

  const colorVar =
    item.kind === "booking"
      ? "--state-booking"
      : item.kind === "block"
        ? "--state-busy"
        : item.kind === "actionable"
          ? "--accent"
          : accountVar(item.accountEmail ?? "");
  const acct = item.accountEmail ? colorForEmail(item.accountEmail) : undefined;
  // Show the calendar by the name the owner gave it, not the raw address.
  const accountLabels = useAccountLabels();
  const acctLabel = acct
    ? accountLabels.find((a) => a.email === acct.email)?.label ?? acct.email
    : undefined;

  const attendees = item.attendees ?? [];
  const yes = attendees.filter((a) => a.responseStatus === "accepted").length;
  const awaiting = attendees.filter((a) => !a.responseStatus || a.responseStatus === "needsAction").length;

  // Google/Microsoft descriptions can carry HTML (join links, reschedule
  // links, etc.) — sanitize to an allowlist so they render as real links
  // instead of raw markup.
  const descriptionHtml = useMemo(
    () => (item.description ? sanitizeDescriptionHtml(item.description) : undefined),
    [item.description]
  );

  // Render through a portal to <body>. On mobile the panes carry a transform
  // (the tab-switch slide animation), and a position:fixed overlay inside a
  // transformed ancestor is sized to that ancestor, not the viewport — so the
  // backdrop covered only the Blocks pane and the card floated mid-list. The
  // portal escapes any such ancestor so the modal is always viewport-centered.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className={styles.overlay}
      onClick={() => {
        // Don't discard an in-progress edit or a pending confirm on backdrop click.
        if (mode === "view" && !confirm && !busy) onClose();
      }}
    >
      <div
        className={styles.card}
        ref={sheet.ref}
        {...sheet.handlers}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title and controls share one flex row. They used to be absolutely
            positioned over the card, with `.head` reserving a fixed
            padding-right to clear them — a number measured for "Edit ×". Add a
            wider control (this modal grew a "Cancel booking") and the title
            runs underneath it, which is exactly what happened. In flow, the
            title cannot collide with a button whatever the label says. */}
        <div className={styles.head}>
          <span className={styles.swatch} style={{ background: `var(${colorVar})` }} />
          <h2 className={styles.title}>
            {mode === "edit"
              ? isActionable
                ? "Edit actionable"
                : isBooking
                  ? "Edit booking"
                  : "Edit event"
              : item.title}
          </h2>
          <div className={styles.headActions}>
            {canEdit && mode === "view" && (
              <button className={styles.editTop} onClick={() => setMode("edit")}>
                Edit
              </button>
            )}
            <button className={styles.close} onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>

        {mode === "edit" ? (
          <div className={styles.editForm}>
            <label className={styles.fLabel}>Title</label>
            <input
              className={styles.fInput}
              value={fTitle}
              onChange={(e) => setFTitle(e.target.value)}
              autoFocus
            />

            <div className={styles.fGrid}>
              <div className={styles.fCol}>
                <label className={styles.fLabel}>Date</label>
                <input className={styles.fInput} type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} />
              </div>
              <div className={styles.fCol}>
                <label className={styles.fLabel}>Start</label>
                <input className={styles.fInput} type="time" value={fStart} onChange={(e) => setFStart(e.target.value)} />
              </div>
              <div className={styles.fCol}>
                <label className={styles.fLabel}>End</label>
                <input className={styles.fInput} type="time" value={fEnd} onChange={(e) => setFEnd(e.target.value)} />
              </div>
            </div>

            {/* Bookings edit their time only (a reschedule); location and notes
                belong to the owner's own events, not the attendee's meeting. */}
            {!isBooking && (
              <>
                <label className={styles.fLabel}>Location</label>
                <input
                  className={styles.fInput}
                  value={fLoc}
                  onChange={(e) => setFLoc(e.target.value)}
                  placeholder="Add a location"
                />
              </>
            )}

            {/* A Todo keeps its "where" as three distinct columns, so an
                actionable gets a field per kind instead of the single
                free-text box the quick-add row classifies for you. */}
            {isActionable && (
              <>
                <label className={styles.fLabel}>URL</label>
                <input
                  className={styles.fInput}
                  type="url"
                  value={fUrl}
                  onChange={(e) => setFUrl(e.target.value)}
                  placeholder="Meeting or reference link"
                />
                <label className={styles.fLabel}>Phone</label>
                <input
                  className={styles.fInput}
                  type="tel"
                  value={fPhone}
                  onChange={(e) => setFPhone(e.target.value)}
                  placeholder="Number to call"
                />
              </>
            )}

            {/* Notes maps to the provider event's description. A Todo has no
                such field, so it is hidden for actionables rather than shown
                as a control whose input would be silently dropped. A booking's
                description is the attendee's, not the owner's, so hide it too. */}
            {!isActionable && !isBooking && (
              <>
            <label className={styles.fLabel}>Notes</label>
            <textarea
              className={`${styles.fInput} ${styles.fTextarea}`}
              value={fNotes}
              onChange={(e) => setFNotes(e.target.value)}
              placeholder="Add notes"
              rows={3}
            />
              </>
            )}

            {error && <p className={styles.fError}>{error}</p>}

            <div className={styles.footerEdit}>
              <button className={styles.btnDanger} onClick={requestDelete} disabled={busy}>
                {isBooking ? "Cancel booking" : "Delete"}
              </button>
              <span className={styles.footerSpacer} />
              <button
                className={styles.btnGhost}
                onClick={() => {
                  setMode("view");
                  setError(null);
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button className={styles.btnPrimary} onClick={requestSave} disabled={busy || !fTitle.trim()}>
                {busy && !confirm ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
        <div className={styles.rows}>
          <div className={styles.row}>
            <RowIcon name="when" />
            <div>
              <div className={styles.rowMain}>{dateStr}</div>
              <div className={`${styles.rowSub} tnum`}>
                {timeStr} · {OWNER_TIMEZONE}
              </div>
            </div>
          </div>

          {/* Type / identity — one consistent row for every kind, always in the
              same position so event, booking, actionable and block popovers
              share the exact same layout. */}
          <div className={styles.row}>
            <RowIcon
              name={
                item.kind === "booking"
                  ? "type-booking"
                  : item.kind === "actionable"
                    ? "type-actionable"
                    : item.kind === "block"
                      ? "type-block"
                      : "type-event"
              }
            />
            <div className={styles.rowMain}>
              {item.kind === "event" && acct ? (
                <>
                  <span className={styles.acctDot} style={{ background: `var(${acct.cssVar})` }} />
                  {acctLabel}
                </>
              ) : item.kind === "event" ? (
                "Event"
              ) : item.kind === "booking" ? (
                "Booking"
              ) : item.kind === "actionable" ? (
                "Actionable"
              ) : (
                "Reserved time"
              )}
            </div>
          </div>

          {item.videoLink && (
            <div className={styles.row}>
              <RowIcon name="video" />
              <a className={styles.joinBtn} href={item.videoLink} target="_blank" rel="noopener noreferrer">
                Join with {videoProvider(item.videoLink)}
              </a>
            </div>
          )}

          {item.location && (
            <div className={styles.row}>
              <RowIcon name="location" />
              <a
                className={styles.locationLink}
                href={locationHref(item.location)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {item.location}
              </a>
            </div>
          )}

          {(item.kind === "event" || item.kind === "booking" || item.kind === "actionable") && (
            <div className={styles.row}>
              <ReminderControl
                title={item.title}
                startISO={item.start.toISOString()}
                inlineList
                itemRef={{
                  // An actionable is a Todo row; reminders reference it as
                  // eventKind "todo" (the Nudge model's name for it).
                  kind: item.kind === "actionable" ? "todo" : item.kind,
                  id: item.id.replace(/^(event|booking|actionable):/, ""),
                  account: item.accountEmail,
                }}
              />
            </div>
          )}

          {attendees.length > 0 && (
            <div className={styles.row}>
              <RowIcon name="guests" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={styles.guestCount}>
                  {attendees.length} guest{attendees.length > 1 ? "s" : ""}
                  {(yes > 0 || awaiting > 0) && (
                    <span className={styles.guestSub}> · {yes} yes · {awaiting} awaiting</span>
                  )}
                </div>
                <ul className={styles.guests}>
                  {attendees.map((a) => {
                    const s = statusLabel(a.responseStatus);
                    return (
                      <li key={a.email} className={styles.guest}>
                        <span className={styles.guestAvatar}>
                          {(a.name ?? a.email).charAt(0).toUpperCase()}
                        </span>
                        <div className={styles.guestBody}>
                          <span className={styles.guestName}>{a.name ?? a.email}</span>
                          {a.organizer && <span className={styles.organizer}>Organizer</span>}
                        </div>
                        <span className={`${styles.rsvp} ${styles[s.cls]}`}>{s.text}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}

          {descriptionHtml && (
            <div className={styles.row}>
              <RowIcon name="notes" />
              <div className={styles.desc} dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
            </div>
          )}
        </div>
        )}

        {mode === "view" && item.kind === "event" && (
          <EventFollowups eventKey={followupKey(item.id, item.start)} onChanged={onFollowupsChanged} />
        )}

        {mode === "view" && item.htmlLink && (
          <div className={styles.viewFooter}>
            <a className={styles.openExternal} href={item.htmlLink} target="_blank" rel="noopener noreferrer">
              Open in {item.accountEmail?.includes("outlook") ? "Outlook" : "Google Calendar"} ↗
            </a>
          </div>
        )}

        {confirm && (
          <div className={styles.confirmOverlay}>
            <div className={styles.confirmCard}>
              {isBooking && confirm === "delete" ? (
                <>
                  <p className={styles.confirmText}>
                    Cancel this booking?{" "}
                    {item.attendees?.[0]?.name ?? "The attendee"} will be emailed that
                    it&rsquo;s off, and the time goes back on offer.
                  </p>
                  {error && <p className={styles.fError}>{error}</p>}
                  <div className={styles.confirmBtns}>
                    <button className={styles.btnGhost} onClick={() => setConfirm(null)} disabled={busy}>
                      Keep it
                    </button>
                    {/* No "don't notify" here: cancelBooking always emails the
                        attendee, so offering the choice would be a lie. */}
                    <button className={styles.btnDanger} onClick={() => void doCancelBooking()} disabled={busy}>
                      {busy ? "Cancelling…" : "Cancel booking"}
                    </button>
                  </div>
                </>
              ) : isBooking ? (
                <>
                  {/* Moving a booking always re-invites the attendee — there is
                      no silent way to change someone's meeting time. */}
                  <p className={styles.confirmText}>
                    Update this booking? {item.attendees?.[0]?.name ?? "The attendee"} will
                    get an updated calendar invite for the new time.
                  </p>
                  {error && <p className={styles.fError}>{error}</p>}
                  <div className={styles.confirmBtns}>
                    <button className={styles.btnGhost} onClick={() => setConfirm(null)} disabled={busy}>
                      Keep it
                    </button>
                    <button className={styles.btnPrimary} onClick={() => void doSave(true)} disabled={busy}>
                      {busy ? "Updating…" : "Update & notify"}
                    </button>
                  </div>
                </>
              ) : hasGuests ? (
                <>
                  <p className={styles.confirmText}>
                    This event has {attendeeCount} guest{attendeeCount > 1 ? "s" : ""}.{" "}
                    {confirm === "delete" ? "Email them that it's cancelled?" : "Email them about this change?"}
                  </p>
                  {error && <p className={styles.fError}>{error}</p>}
                  <div className={styles.confirmBtns}>
                    <button className={styles.btnGhost} onClick={() => setConfirm(null)} disabled={busy}>
                      Cancel
                    </button>
                    <button
                      className={styles.btnGhost}
                      onClick={() => (confirm === "delete" ? doDelete(false) : doSave(false))}
                      disabled={busy}
                    >
                      Don&rsquo;t notify
                    </button>
                    <button
                      className={styles.btnPrimary}
                      onClick={() => (confirm === "delete" ? doDelete(true) : doSave(true))}
                      disabled={busy}
                    >
                      {busy ? "Working…" : "Notify guests"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className={styles.confirmText}>
                    Delete &ldquo;{item.title}&rdquo;? This can&rsquo;t be undone.
                  </p>
                  {error && <p className={styles.fError}>{error}</p>}
                  <div className={styles.confirmBtns}>
                    <button className={styles.btnGhost} onClick={() => setConfirm(null)} disabled={busy}>
                      Cancel
                    </button>
                    <button className={styles.btnDanger} onClick={() => void doDelete(false)} disabled={busy}>
                      {busy ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
