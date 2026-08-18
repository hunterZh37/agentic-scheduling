// In-memory rate-limit + booking guard for the PUBLIC agent.
//
// SCOPE — measured on prod 2026-08-04, so callers know what this does and does
// not buy: the counters live in one process. 25 SEQUENTIAL requests were
// correctly capped (20 allowed, then 429), but 40 CONCURRENT requests spread
// across Lambda instances and only 12 were limited. So this is a real brake on
// a single caller hammering an endpoint, and NOT a defense against a
// distributed or highly-parallel abuser. Durable limiting needs a shared store
// (Redis/DB) — swap this module's impl and keep the interface.
//
// What does NOT depend on this: concurrent double-booking is prevented by a
// unique index in the database, not by the booking guard here.

interface Bucket {
  windowStart: number;
  messageCount: number;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_MESSAGES = 20;

// The booking guard: at most MAX_BOOKINGS per identity per rolling hour. It was
// once a LIFETIME cap of 1 that never reset — which also blocked a legitimate
// visitor booking a second meeting (and made the owner's own testing get stuck
// on "you've already booked recently"). A rolling window still brakes a single
// spammer (the DB unique index is what actually stops double-booking a slot),
// while letting real repeat bookings through. Its own bucket map, separate from
// the message window, keyed on a server-controlled identity (IP) — never an
// attacker-suppliable value like sessionId.
const BOOKING_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_BOOKINGS = 5;

const buckets = new Map<string, Bucket>();
const bookingBuckets = new Map<string, Bucket>();

function bookingBucketFor(key: string, now: number): Bucket {
  const existing = bookingBuckets.get(key);
  if (!existing || now - existing.windowStart >= BOOKING_WINDOW_MS) {
    const fresh = { windowStart: now, messageCount: 0 };
    bookingBuckets.set(key, fresh);
    return fresh;
  }
  return existing;
}

function bucketFor(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (!existing || now - existing.windowStart >= WINDOW_MS) {
    const fresh = { windowStart: now, messageCount: 0 };
    buckets.set(key, fresh);
    return fresh;
  }
  return existing;
}

export interface RateDecision {
  ok: boolean;
  reason?: "message_limit" | "booking_limit";
}

// Callers key the message cap on `ip:sessionId` so a visitor with several tabs
// isn't throttled — a deliberate trade that lets someone rotate sessionId to
// reset their own cap. That's tolerable for message count but NOT for spend:
// every public-agent message is a paid LLM call. This second, higher ceiling is
// keyed on the IP alone (server-controlled), so rotating sessionId can no longer
// multiply the bill without limit.
const MAX_MESSAGES_PER_IP = 60;
const ipBuckets = new Map<string, Bucket>();

/// Count an inbound public-agent message. Rejects past the per-window cap.
/// `ipKey` (when supplied) additionally enforces the per-IP spend ceiling.
export function checkMessageAllowed(
  key: string,
  now = Date.now(),
  ipKey?: string
): RateDecision {
  if (ipKey) {
    const existing = ipBuckets.get(ipKey);
    let ipBucket: Bucket;
    if (!existing || now - existing.windowStart >= WINDOW_MS) {
      ipBucket = { windowStart: now, messageCount: 0 };
      ipBuckets.set(ipKey, ipBucket);
    } else {
      ipBucket = existing;
    }
    if (ipBucket.messageCount >= MAX_MESSAGES_PER_IP) {
      return { ok: false, reason: "message_limit" };
    }
    ipBucket.messageCount += 1;
  }
  const b = bucketFor(key, now);
  if (b.messageCount >= MAX_MESSAGES) return { ok: false, reason: "message_limit" };
  b.messageCount += 1;
  return { ok: true };
}

const DEMO_MAX_RUNS = 5;

/// Count a demo negotiation run. Lower cap than the public agent since each run
/// costs several LLM calls and creates a real (tagged) booking. Shares the
/// windowed bucket store but under its own caller-supplied `demo:` keys.
export function checkDemoAllowed(key: string, now = Date.now()): RateDecision {
  const b = bucketFor(key, now);
  if (b.messageCount >= DEMO_MAX_RUNS) return { ok: false, reason: "message_limit" };
  b.messageCount += 1;
  return { ok: true };
}

/// Whether this identity may still create a booking. Read-only — prefer
/// tryReserveBooking for anything that leads to a write, since check-then-act
/// with this is not atomic against concurrent callers.
export function canBook(key: string, now = Date.now()): boolean {
  return bookingBucketFor(key, now).messageCount < MAX_BOOKINGS;
}

/// Record that a booking was made (call only after a successful write).
export function recordBooking(key: string, now = Date.now()): void {
  bookingBucketFor(key, now).messageCount += 1;
}

// Inbound SMS rate limit, per phone number. Separate sliding window and bucket
// map from the public-agent limiter above: the SMS channel is owner-only and
// each inbound message runs the full private agent, so it gets its own,
// tighter budget without touching the public-agent counts.
const SMS_WINDOW_MS = 60 * 1000; // 1 minute
const SMS_MAX_MESSAGES = 8;

const smsBuckets = new Map<string, Bucket>();

/// Count an inbound SMS from `key` (normalized phone). Rejects past the
/// per-minute cap so a runaway sender can't fan out agent runs.
export function checkSmsAllowed(key: string, now = Date.now()): RateDecision {
  const existing = smsBuckets.get(key);
  let bucket: Bucket;
  if (!existing || now - existing.windowStart >= SMS_WINDOW_MS) {
    bucket = { windowStart: now, messageCount: 0 };
    smsBuckets.set(key, bucket);
  } else {
    bucket = existing;
  }
  if (bucket.messageCount >= SMS_MAX_MESSAGES) return { ok: false, reason: "message_limit" };
  bucket.messageCount += 1;
  return { ok: true };
}

/// Atomically check-and-reserve the once-per-identity booking slot: the check
/// and the increment happen in the same synchronous call, so two concurrent
/// reservations for the same key (e.g. two tool_use blocks resolved via
/// Promise.all in one model turn) can't both succeed. Returns true iff the
/// reservation was granted. On a downstream write failure, call
/// releaseBooking(key) to give the slot back.
export function tryReserveBooking(key: string, now = Date.now()): boolean {
  const bucket = bookingBucketFor(key, now);
  if (bucket.messageCount >= MAX_BOOKINGS) return false;
  bucket.messageCount += 1;
  return true;
}

/// Undo a reservation made by tryReserveBooking after the guarded write fails.
export function releaseBooking(key: string, now = Date.now()): void {
  const bucket = bookingBucketFor(key, now);
  if (bucket.messageCount > 0) bucket.messageCount -= 1;
}

// --- Login throttle ---------------------------------------------------------
// /api/login had no limiter at all: 12 rapid wrong passwords each returned a
// plain 401 with no delay, so a single shared password was guessable at network
// speed, with PBKDF2's ~0.3s as the only cost (and that parallelises).
//
// Same per-instance caveat as everything else in this module (see the header):
// a distributed attacker spreads across Lambdas. It still removes the cheap
// single-origin brute force, and Google sign-in is now the primary path.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

interface LoginBucket {
  windowStart: number;
  failures: number;
}
const loginBuckets = new Map<string, LoginBucket>();

/// Whether this identity may still attempt a password login. `retryAfterSec`
/// is how long the caller should tell them to wait.
export function checkLoginAllowed(
  key: string,
  now = Date.now()
): { ok: boolean; retryAfterSec?: number } {
  const b = loginBuckets.get(key);
  if (!b || now - b.windowStart >= LOGIN_WINDOW_MS) return { ok: true };
  if (b.failures < LOGIN_MAX_FAILURES) return { ok: true };
  return { ok: false, retryAfterSec: Math.ceil((b.windowStart + LOGIN_WINDOW_MS - now) / 1000) };
}

/// Record a failed password attempt, opening a fresh window if needed.
export function recordLoginFailure(key: string, now = Date.now()): void {
  const b = loginBuckets.get(key);
  if (!b || now - b.windowStart >= LOGIN_WINDOW_MS) {
    loginBuckets.set(key, { windowStart: now, failures: 1 });
    return;
  }
  b.failures += 1;
}

/// Clear the counter after a successful login so normal use never accumulates
/// toward a lockout.
export function clearLoginFailures(key: string): void {
  loginBuckets.delete(key);
}

// --- Reschedule throttle ----------------------------------------------------
// A manage token authorizes moving ONE booking, but each reschedule re-books
// via createBooking and emails a fresh manage link, so a hostile attendee
// could loop it into unlimited real calendar writes and owner alerts. The
// once-per-IP booking guard doesn't apply (their one legit booking already
// consumed it), so reschedules get their own small sliding window per IP.
const RESCHEDULE_WINDOW_MS = 60 * 60 * 1000;
const RESCHEDULE_MAX = 5;

const rescheduleBuckets = new Map<string, Bucket>();

/// Count a reschedule attempt from `key` (client IP). Rejects past the
/// per-hour cap; generous enough that a human changing their mind never sees
/// it, tight enough that a scripted loop dies after a handful of writes.
export function checkRescheduleAllowed(key: string, now = Date.now()): RateDecision {
  const existing = rescheduleBuckets.get(key);
  let bucket: Bucket;
  if (!existing || now - existing.windowStart >= RESCHEDULE_WINDOW_MS) {
    bucket = { windowStart: now, messageCount: 0 };
    rescheduleBuckets.set(key, bucket);
  } else {
    bucket = existing;
  }
  if (bucket.messageCount >= RESCHEDULE_MAX) return { ok: false, reason: "message_limit" };
  bucket.messageCount += 1;
  return { ok: true };
}
