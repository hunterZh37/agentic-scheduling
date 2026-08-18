"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import { HOST, OWNER_FIRST_NAME, COMMON_TIMEZONES, formatDuration } from "@/lib/booking/publicConfig";
import { PublicAgentChat } from "./PublicAgentChat";
import { useSheetDrag } from "@/lib/motion/useSheetDrag";
import { AnimatedHeight } from "@/lib/motion/AnimatedHeight";
import styles from "./BookingPage.module.css";

type Mode = "pick" | "agent";
type Step = "pick" | "confirm" | "success";
interface Slot {
  start: string;
  end: string;
}
interface Confirmed {
  start: string;
  end: string;
  email: string;
  timezone: string;
}

const DEFAULT_TZ = "America/New_York";

export function BookingPage({
  preview = false,
  reschedule,
}: {
  preview?: boolean;
  /// When set, the page reschedules this existing booking instead of creating a
  /// new one: the visitor just picks a new time (no name/email needed).
  reschedule?: { id: string; token: string };
}) {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<Mode>("pick");
  const [step, setStep] = useState<Step>("pick");
  // How long the booker wants to meet; drives the availability query so only
  // slots with that much free time are offered, and the booked event's length.
  const [duration, setDuration] = useState<number>(HOST.durationMinutes);
  // Custom-length mode: a free minutes input alongside the preset pills.
  const [customOn, setCustomOn] = useState(false);
  const [customStr, setCustomStr] = useState("");
  const [bookerTz, setBookerTz] = useState(DEFAULT_TZ);
  const [viewMonth, setViewMonth] = useState(() => DateTime.now().setZone(DEFAULT_TZ).startOf("month"));
  const [selectedDate, setSelectedDate] = useState<DateTime | null>(null);
  const slotListRef = useRef<HTMLDivElement | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  // Picking a day opens the times in a dialog. The inline column kept running
  // out of room — a fixed-height card clipped it, and every attempt to size
  // that box traded one cramped layout for another. A dialog owns the screen,
  // so the whole day is visible however tall the day happens to be.
  const [slotDialogOpen, setSlotDialogOpen] = useState(false);
  // The dialog carries the booking through to the end: times, then details.
  // Picking a time used to drop the visitor back to the page behind it, to a
  // summary bar and a separate confirm screen — three surfaces for one task.
  const [dialogStep, setDialogStep] = useState<"times" | "details">("times");
  const [form, setForm] = useState({ name: "", email: "", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // The times dialog is a bottom sheet on a phone; let it be dragged down to
  // dismiss like a native one. No-op on desktop, where it's a centered dialog.
  const [isPhone, setIsPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const sync = () => setIsPhone(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const sheet = useSheetDrag({
    enabled: isPhone && slotDialogOpen,
    onDismiss: () => setSlotDialogOpen(false),
  });

  // Detect the booker's timezone after mount (avoids SSR/client mismatch).
  // Escape closes the dialog, and the page behind it stops scrolling — without
  // the lock, flicking the times scrolls the page underneath instead.
  useEffect(() => {
    if (!slotDialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSlotDialogOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [slotDialogOpen]);

  // On a phone the calendar stacks ABOVE the times, so picking a day leaves the
  // openings off-screen and the page looks unchanged until you scroll. Bring
  // them into view — but only when they actually are off-screen, and never on
  // desktop, where the list sits beside the calendar and nothing moved.
  useEffect(() => {
    if (!selectedDate) return;
    const el = slotListRef.current;
    if (!el || typeof window === "undefined") return;
    if (!window.matchMedia("(max-width: 768px)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return; // already visible
    el.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [selectedDate]);

  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ;
    setBookerTz(tz);
    setViewMonth(DateTime.now().setZone(tz).startOf("month"));
    setMounted(true);
  }, []);

  // Load slots for the selected day.
  useEffect(() => {
    if (!selectedDate) return;
    let cancelled = false;
    setLoadingSlots(true);
    setSelectedSlot(null);
    const day = selectedDate.setZone(bookerTz, { keepLocalTime: true });
    const dayStart = day.startOf("day").toUTC().toISO();
    const dayEnd = day.endOf("day").toUTC().toISO();
    fetch(`/api/availability?start=${encodeURIComponent(dayStart!)}&end=${encodeURIComponent(dayEnd!)}&duration=${duration}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setSlots(d.slots ?? []); })
      .catch(() => { if (!cancelled) setSlots([]); })
      .finally(() => { if (!cancelled) setLoadingSlots(false); });
    return () => { cancelled = true; };
  }, [selectedDate, bookerTz, refreshToken, duration]);

  const tzOptions = useMemo(() => {
    const set = new Set([bookerTz, ...COMMON_TIMEZONES]);
    return Array.from(set);
  }, [bookerTz]);

  // Re-anchor the view month and selected day into the newly chosen zone so
  // fetched windows and mini-month "today" comparisons all share one zone.
  const handleTzChange = (tz: string) => {
    setBookerTz(tz);
    setViewMonth((m) => m.setZone(tz, { keepLocalTime: true }).startOf("month"));
    setSelectedDate((d) => (d ? d.setZone(tz, { keepLocalTime: true }) : d));
  };

  // Clamp a typed length to a sane range (15 min – 8 hr) and apply it.
  const commitCustom = () => {
    const v = Math.min(480, Math.max(15, Math.round(Number(customStr) || HOST.durationMinutes)));
    setDuration(v);
    setCustomStr(String(v));
  };

  const fmtTime = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).setZone(bookerTz).toFormat("h:mm a");
  const fmtRange = (s: string, e: string) => {
    const a = DateTime.fromISO(s, { zone: "utc" }).setZone(bookerTz);
    const b = DateTime.fromISO(e, { zone: "utc" }).setZone(bookerTz);
    const sameMer = a.toFormat("a") === b.toFormat("a");
    return `${sameMer ? a.toFormat("h:mm") : a.toFormat("h:mm a")} – ${b.toFormat("h:mm a")}`;
  };

  const submit = async () => {
    if (!selectedSlot) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/public/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start: selectedSlot.start,
          end: selectedSlot.end,
          attendeeName: form.name.trim(),
          attendeeEmail: form.email.trim(),
          attendeeTimezone: bookerTz,
          note: form.note.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data.error === "destination_not_connected" || data.error === "no_destination"
            ? `Booking isn't available right now — ${OWNER_FIRST_NAME}'s calendar isn't connected yet.`
            : data.error === "conflict"
              ? "That time was just taken. Pick another slot."
              : data.message ?? "Something went wrong. Try another time."
        );
        setSubmitting(false);
        return;
      }
      setConfirmed({ start: data.booking.start, end: data.booking.end, email: data.booking.attendeeEmail, timezone: bookerTz });
      setStep("success");
      setSlotDialogOpen(false);
    } catch {
      setError("Couldn't reach the server. Please try again.");
      setSubmitting(false);
    }
  };

  const submitReschedule = async () => {
    if (!selectedSlot || !reschedule) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/bookings/${reschedule.id}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: reschedule.token,
          start: selectedSlot.start,
          end: selectedSlot.end,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data.error === "conflict"
            ? "That time was just taken. Pick another slot."
            : data.error === "booking_not_found"
              ? "This booking can't be found — it may have already been cancelled."
              : data.message ?? "Couldn't reschedule. Try another time."
        );
        setSubmitting(false);
        return;
      }
      setConfirmed({ start: data.booking.start, end: data.booking.end, email: "", timezone: bookerTz });
      setStep("success");
      setSlotDialogOpen(false);
    } catch {
      setError("Couldn't reach the server. Please try again.");
      setSubmitting(false);
    }
  };

  const reset = () => {
    setStep("pick");
    setMode("pick");
    setSelectedSlot(null);
    setConfirmed(null);
    setForm({ name: "", email: "", note: "" });
    setSubmitting(false);
    setSlots([]);
    setError(null);
    setRefreshToken((t) => t + 1);
  };

  if (!mounted) return <div className={styles.page} />;

  if (step === "success" && confirmed) {
    return (
      <div className={styles.page}>
        <SuccessCard confirmed={confirmed} fmtRange={fmtRange} onReschedule={reset} rescheduled={!!reschedule} />
      </div>
    );
  }

  if (step === "confirm" && selectedSlot) {
    return (
      <div className={styles.page}>
        <ConfirmForm
          slot={selectedSlot}
          bookerTz={bookerTz}
          form={form}
          setForm={setForm}
          error={error}
          submitting={submitting}
          fmtRange={fmtRange}
          onBack={() => { setStep("pick"); setError(null); }}
          onSubmit={submit}
        />
      </div>
    );
  }

  const canNext = Boolean(selectedSlot);

  return (
    <div className={styles.page}>
      <div className={styles.window}>
        {/* Chrome bar exists only for the owner's preview link. The decorative
            URL pill it used to show just repeated the browser's own address
            bar, so for a real visitor this whole strip was empty weight. */}
        {preview && (
          <div className={styles.chrome}>
            <a className={styles.back} href="/">← Back to dashboard</a>
          </div>
        )}

        <div className={styles.body}>
          {/* Left detail rail */}
          <aside className={styles.rail}>
            <img className={styles.avatar} src="/avatar.jpg" alt={HOST.name} width={64} height={64} />
            <div className={styles.hostName}>{HOST.name}</div>
            {/* What this booking is FOR. A visitor arriving from a cold link has
                no other way to tell, and it is the identity signal reputation
                scanners look for. */}
            <p className={styles.practice}>
              Consulting &middot;{" "}
              <a href={HOST.practice.url} target="_blank" rel="noopener noreferrer">
                {HOST.practice.domain}
              </a>
            </p>
            <h1 className={styles.eventTitle}>{HOST.eventTitle}</h1>
            {/* The practice's areas, one per line. This is the rail's one
                block of substance for a cold visitor deciding whether this
                meeting is for them; the same list feeds the meta description
                and noscript prose via HOST.practice.fields, so the page can
                never claim different expertise in different places. */}
            <div className={styles.railLabel}>The areas I consult in</div>
            <ul className={styles.areas}>
              {HOST.practice.fieldList.map((f) => (
                <li key={f} className={styles.area}>
                  <span className={styles.areaDot} aria-hidden="true" />
                  <span className={styles.areaText}>{f}</span>
                </li>
              ))}
            </ul>
            <p className={styles.research}>
              <a href={HOST.researchUrl} target="_blank" rel="noopener noreferrer">
                Check out my research
              </a>
            </p>
            {/* Authorship credit. Deliberately quiet (small, muted label, set
                off by a hairline) but not easy to skip: the accent dot catches
                the eye and the name itself sits at full text contrast. Uses
                HOST.name so it can never drift from the owner identity shown
                elsewhere — the same name in the page title, security.txt and
                the domain's whois. */}
            <p className={styles.builtBy}>
              <span className={styles.builtByDot} aria-hidden="true" />
              <span>
                Built by <strong>{HOST.name}</strong>
              </span>
            </p>
            {/* The app is open source; a plain call-to-action from the page
                itself is both an invitation and a trust signal for visitors. */}
            <p className={styles.sourceLink}>
              <a href={HOST.sourceUrl} target="_blank" rel="noopener noreferrer">
                Grab your own Agentic Scheduling today
              </a>
              <span className={styles.sourceNote}>Free and open source on GitHub</span>
            </p>
          </aside>

          {/* Right scheduler */}
          <section className={styles.scheduler}>
            {reschedule ? (
              <div className={styles.rescheduleBanner}>
                Rescheduling — pick a new time. Your current booking will be moved and a fresh invite sent.
              </div>
            ) : (
              <div className={styles.switcher} role="tablist">
                {/* The selected segment is a single pill that slides between the
                    two tabs, rather than the highlight jumping instantly. */}
                <span
                  className={`${styles.switcherThumb} ${mode === "agent" ? styles.switcherThumbEnd : ""}`}
                  aria-hidden="true"
                />
                <button
                  role="tab"
                  aria-selected={mode === "pick"}
                  className={`${styles.tab} ${mode === "pick" ? styles.tabActive : ""}`}
                  onClick={() => setMode("pick")}
                >
                  Pick a time
                </button>
                <button
                  role="tab"
                  aria-selected={mode === "agent"}
                  className={`${styles.tab} ${mode === "agent" ? styles.tabActive : ""}`}
                  onClick={() => setMode("agent")}
                >
                  Ask the assistant
                </button>
              </div>
            )}

            <div className={styles.durationRow}>
              <span className={styles.durationLabel}>How long?</span>
              <div className={styles.durationPills}>
                {HOST.durationOptions.map((d) => (
                  <button
                    key={d}
                    className={`${styles.durationPill} ${!customOn && duration === d ? styles.durationPillActive : ""}`}
                    onClick={() => { setCustomOn(false); setDuration(d); }}
                  >
                    {formatDuration(d)}
                  </button>
                ))}
                <button
                  className={`${styles.durationPill} ${customOn ? styles.durationPillActive : ""}`}
                  onClick={() => { setCustomStr(String(duration)); setCustomOn(true); }}
                >
                  Custom
                </button>
                {customOn && (
                  <span className={styles.customField}>
                    <input
                      type="number"
                      className={`${styles.customInput} tnum`}
                      min={15}
                      max={480}
                      step={5}
                      value={customStr}
                      onChange={(e) => setCustomStr(e.target.value)}
                      onBlur={commitCustom}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                      autoFocus
                    />
                    min
                  </span>
                )}
              </div>
            </div>

            <AnimatedHeight trigger={mode} className={styles.panelHost}>
            {mode === "agent" && !reschedule ? (
              <div key="agent" className={styles.panel}>
                <PublicAgentChat bookerTimezone={bookerTz} durationMinutes={duration} />
              </div>
            ) : (
              <div key="pick" className={styles.panel}>
                <div className={styles.pickGrid}>
                  <MiniMonth
                    viewMonth={viewMonth}
                    bookerTz={bookerTz}
                    selectedDate={selectedDate}
                    onPrev={() => setViewMonth((m) => m.minus({ months: 1 }))}
                    onNext={() => setViewMonth((m) => m.plus({ months: 1 }))}
                    onSelect={(d) => {
                      setSelectedDate(d);
                      setDialogStep("times");
                      setSlotDialogOpen(true);
                    }}
                  />
                  <div className={styles.slotCol}>
                    <div className={styles.tzPill}>
                      <span className={styles.globe}>◍</span>
                      <select
                        className={styles.tzSelect}
                        value={bookerTz}
                        onChange={(e) => handleTzChange(e.target.value)}
                      >
                        {tzOptions.map((tz) => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))}
                      </select>
                    </div>
                    <div className={styles.slotList} ref={slotListRef}>
                      {!selectedDate ? (
                        <p className={styles.slotHint}>Pick a day to see open times.</p>
                      ) : loadingSlots ? (
                        <p className={styles.slotHint}>Loading…</p>
                      ) : slots.length === 0 ? (
                        <p className={styles.slotHint}>No open times that day.</p>
                      ) : (
                        slots.map((s) => (
                          <button
                            key={s.start}
                            data-testid="slot"
                            className={`${styles.slot} ${selectedSlot?.start === s.start ? styles.slotSelected : ""} tnum`}
                            onClick={() => setSelectedSlot(s)}
                          >
                            {fmtTime(s.start)}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                </div>

                {reschedule && error && <p className={styles.formError}>{error}</p>}
                {/* Appears on selection rather than sitting there as a filled
                    bar around a disabled button telling you to pick a time.
                    The slot buttons are self-evidently the thing to click, and
                    confirming the choice is more useful than prompting it. */}
                {slotDialogOpen && selectedDate && (
                  <div
                    className={styles.slotBackdrop}
                    onClick={() => setSlotDialogOpen(false)}
                  >
                    <div
                      className={styles.slotDialog}
                      ref={sheet.ref}
                      {...sheet.handlers}
                      role="dialog"
                      aria-modal="true"
                      aria-label={`Open times on ${selectedDate.toFormat("cccc, LLLL d")}`}
                      // The backdrop closes on click; a click inside must not
                      // bubble up to it and shut the dialog the user is using.
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className={styles.slotDialogHead}>
                        {dialogStep === "details" && (
                          <button
                            className={styles.slotDialogBack}
                            onClick={() => {
                              setDialogStep("times");
                              setError(null);
                            }}
                            aria-label="Back to times"
                          >
                            ‹
                          </button>
                        )}
                        <div>
                          <p className={styles.slotDialogTitle}>
                            {dialogStep === "details"
                              ? "Confirm your booking"
                              : selectedDate.toFormat("cccc, LLLL d")}
                          </p>
                          <p className={styles.slotDialogSub}>
                            {dialogStep === "details" && selectedSlot
                              ? `${fmtRange(selectedSlot.start, selectedSlot.end)} · ${selectedDate.toFormat("ccc, LLL d")}`
                              : loadingSlots
                                ? "Finding open times…"
                                : slots.length === 0
                                  ? "No open times that day"
                                  : `${slots.length} open ${slots.length === 1 ? "time" : "times"} · ${duration} min`}
                          </p>
                        </div>
                        <button
                          className={styles.slotDialogClose}
                          onClick={() => setSlotDialogOpen(false)}
                          aria-label="Close"
                        >
                          ✕
                        </button>
                      </div>
                      {dialogStep === "details" && selectedSlot ? (
                        <div className={styles.slotDialogForm}>
                          <ConfirmForm
                            slot={selectedSlot}
                            bookerTz={bookerTz}
                            form={form}
                            setForm={setForm}
                            error={error}
                            submitting={submitting}
                            fmtRange={fmtRange}
                            // The dialog header already offers a way back and
                            // shows the chosen time, so the form drops its own.
                            chrome={false}
                            onBack={() => setDialogStep("times")}
                            onSubmit={submit}
                          />
                        </div>
                      ) : (
                      <div className={styles.slotDialogBody}>
                        {loadingSlots ? (
                          <p className={styles.slotHint}>Loading…</p>
                        ) : slots.length === 0 ? (
                          <p className={styles.slotHint}>
                            Nothing free on this day — try another.
                          </p>
                        ) : (
                          slots.map((sl) => (
                            <button
                              key={sl.start}
                              data-testid="slot-dialog"
                              className={`${styles.slot} ${selectedSlot?.start === sl.start ? styles.slotSelected : ""} tnum`}
                              onClick={() => {
                                setSelectedSlot(sl);
                                setError(null);
                                // Reschedule has no details to collect — the
                                // attendee is already known — so it confirms
                                // straight from the times.
                                if (reschedule) {
                                  setSlotDialogOpen(false);
                                } else {
                                  setDialogStep("details");
                                }
                              }}
                            >
                              {fmtTime(sl.start)}
                            </button>
                          ))
                        )}
                      </div>
                      )}
                    </div>
                  </div>
                )}

                {selectedSlot && !slotDialogOpen && (
                  <div className={styles.confirmBar}>
                    <div className={styles.selInfo}>
                      <span className={styles.selLabel}>Selected</span>
                      <span className="tnum">
                        {fmtRange(selectedSlot.start, selectedSlot.end)} ·{" "}
                        {DateTime.fromISO(selectedSlot.start, { zone: "utc" }).setZone(bookerTz).toFormat("ccc, LLL d")}
                      </span>
                    </div>
                    <button
                      className={styles.next}
                      disabled={!canNext || submitting}
                      onClick={() => (reschedule ? void submitReschedule() : setStep("confirm"))}
                    >
                      {reschedule ? (submitting ? "Rescheduling…" : "Confirm new time") : "Next"}
                    </button>
                  </div>
                )}
              </div>
            )}
            </AnimatedHeight>
          </section>
        </div>
      </div>
      {/* Legal footer. The owner-identity trust signal that scanners look for
          now lives once, in the rail's "Built by" credit, rather than being
          repeated here — the page named its owner four separate times. */}
      <footer className={styles.pageFooter}>
        <a href="/privacy">Privacy</a>
        <span className={styles.footerSep}>·</span>
        <a href="/terms">Terms</a>
      </footer>
    </div>
  );
}

function MiniMonth({
  viewMonth,
  bookerTz,
  selectedDate,
  onPrev,
  onNext,
  onSelect,
}: {
  viewMonth: DateTime;
  bookerTz: string;
  selectedDate: DateTime | null;
  onPrev: () => void;
  onNext: () => void;
  onSelect: (d: DateTime) => void;
}) {
  const today = DateTime.now().setZone(bookerTz).startOf("day");
  const first = viewMonth.startOf("month");
  const leading = first.weekday % 7; // Sun=0 .. Sat=6 (luxon weekday: Mon=1..Sun=7)
  const daysInMonth = viewMonth.daysInMonth ?? 30;
  const cells: (DateTime | null)[] = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(first.set({ day: d }));

  return (
    <div className={styles.month}>
      <div className={styles.monthHead}>
        <span className={styles.monthTitle}>{viewMonth.toFormat("LLLL yyyy")}</span>
        <div className={styles.monthNav}>
          <button className={styles.monthBtn} onClick={onPrev} aria-label="Previous month">‹</button>
          <button className={styles.monthBtn} onClick={onNext} aria-label="Next month">›</button>
        </div>
      </div>
      <div className={styles.dow}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div className={styles.days}>
        {cells.map((day, i) => {
          if (!day) return <span key={i} />;
          const isPast = day < today;
          const isToday = day.hasSame(today, "day");
          const isSelected = selectedDate?.hasSame(day, "day") ?? false;
          return (
            <button
              key={i}
              disabled={isPast}
              className={`${styles.day} tnum ${isPast ? styles.dayPast : ""} ${isToday ? styles.dayToday : ""} ${isSelected ? styles.daySelected : ""}`}
              onClick={() => onSelect(day)}
            >
              {day.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ConfirmForm({
  slot,
  bookerTz,
  form,
  setForm,
  error,
  submitting,
  fmtRange,
  onBack,
  onSubmit,
  chrome = true,
}: {
  slot: Slot;
  bookerTz: string;
  form: { name: string; email: string; note: string };
  setForm: (f: { name: string; email: string; note: string }) => void;
  error: string | null;
  submitting: boolean;
  fmtRange: (s: string, e: string) => string;
  onBack: () => void;
  onSubmit: () => void;
  /// false when rendered inside the times dialog, which supplies its own
  /// panel, title, back control and time summary.
  chrome?: boolean;
}) {
  const dt = DateTime.fromISO(slot.start, { zone: "utc" }).setZone(bookerTz);
  const canSubmit = form.name.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) && !submitting;
  return (
    <div className={chrome ? styles.formCard : styles.formPlain}>
      {chrome && (
        <>
          <button className={styles.back} onClick={onBack}>‹ Back</button>
          <h2 className={styles.formTitle}>Confirm your booking</h2>
        </>
      )}
      <div className={styles.summary}>
        <div className={styles.dateBadge}>
          <span className={styles.badgeMon}>{dt.toFormat("LLL").toUpperCase()}</span>
          <span className={`${styles.badgeDay} tnum`}>{dt.toFormat("d")}</span>
        </div>
        <div>
          <div className={`${styles.summaryTime} tnum`}>{fmtRange(slot.start, slot.end)}</div>
          <div className={styles.summarySub}>{dt.toFormat("cccc")} · {bookerTz}</div>
        </div>
      </div>

      <label className={styles.label}>Name</label>
      <input data-testid="booking-name" className={styles.input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
      <label className={styles.label}>Email</label>
      <input data-testid="booking-email" className={styles.input} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <label className={styles.label}>Anything to share? <span className={styles.optional}>(optional)</span></label>
      <textarea className={styles.textarea} rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Add an agenda or context…" />

      {error && <p className={styles.formError}>{error}</p>}
      <button className={styles.confirmBtn} disabled={!canSubmit} onClick={onSubmit}>
        {submitting ? "Booking…" : "Confirm booking"}
      </button>
    </div>
  );
}

function SuccessCard({
  confirmed,
  fmtRange,
  onReschedule,
  rescheduled = false,
}: {
  confirmed: Confirmed;
  fmtRange: (s: string, e: string) => string;
  onReschedule: () => void;
  rescheduled?: boolean;
}) {
  const dt = DateTime.fromISO(confirmed.start, { zone: "utc" }).setZone(confirmed.timezone);
  const gcal = () => {
    const fmt = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).toFormat("yyyyLLdd'T'HHmmss'Z'");
    const url = new URL("https://calendar.google.com/calendar/render");
    url.searchParams.set("action", "TEMPLATE");
    url.searchParams.set("text", HOST.eventTitle);
    url.searchParams.set("dates", `${fmt(confirmed.start)}/${fmt(confirmed.end)}`);
    if (HOST.videoLink) url.searchParams.set("location", HOST.videoLink);
    window.open(url.toString(), "_blank", "noopener");
  };
  return (
    <div className={styles.successCard}>
      <div className={styles.check}>✓</div>
      <h2 className={styles.successTitle}>{rescheduled ? "You're rescheduled" : "You're booked"}</h2>
      <p className={styles.successSub}>
        {rescheduled
          ? "Your booking's been moved. A new calendar invite is on its way."
          : `A calendar invite with the video link is on its way to ${confirmed.email}.`}
      </p>
      <div className={styles.successSummary}>
        <div className={styles.successEvent}>{HOST.eventTitle.toUpperCase()}</div>
        <div className={`${styles.successWhen} tnum`}>
          {dt.toFormat("ccc, LLL d")} · {fmtRange(confirmed.start, confirmed.end)}
        </div>
        <div className={styles.successTz}>Times shown in {confirmed.timezone}</div>
        {!rescheduled && HOST.videoLink && (
          <div className={styles.successVideo}>
            Video call:{" "}
            <a href={HOST.videoLink} target="_blank" rel="noreferrer">
              {HOST.videoLink.replace(/^https?:\/\//, "")}
            </a>
          </div>
        )}
      </div>
      <div className={styles.successActions}>
        <button className={styles.secondary} onClick={gcal}>Add to calendar</button>
        <button className={styles.secondary} onClick={onReschedule}>Reschedule</button>
      </div>
    </div>
  );
}
