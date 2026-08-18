// Public booking page presentation config. The event is one flexible 30-min
// type for v1 ("Book time with <owner's first name>").
//
// This module is imported by both server code (src/lib/booking/service.ts)
// and the client-rendered booking page (BookingPage.tsx, "use client") and
// dashboard assistant (AgentPane.tsx). Next only inlines NEXT_PUBLIC_ env vars
// into the browser bundle when they are read as a *literal* member expression
// (`process.env.NEXT_PUBLIC_FOO`) — a dynamic lookup like
// `optionalEnv("NEXT_PUBLIC_FOO")` is NOT inlined and silently resolves to the
// default in the browser, causing a hydration mismatch (server renders the real
// name, the client renders the placeholder and wins). So, like OWNER_TIMEZONE
// in clientConfig.ts, these MUST use the literal form.
const OWNER_NAME = process.env.NEXT_PUBLIC_OWNER_NAME?.trim() || "Alex Rivera";
const OWNER_NAME_PARTS = OWNER_NAME.trim().split(/\s+/).filter(Boolean);
/// Owner's first name, derived from OWNER_NAME — used in the event title and
/// prompt strings that address the owner by name.
export const OWNER_FIRST_NAME = OWNER_NAME_PARTS[0] ?? OWNER_NAME;
const OWNER_INITIALS =
  OWNER_NAME_PARTS.map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3) || "AR";

const PRACTICE_FIELDS = [
  "AI automation",
  "robotics",
  "product development",
  "intelligence safety",
];
const PRACTICE_FIELDS_PROSE =
  PRACTICE_FIELDS.length > 1
    ? `${PRACTICE_FIELDS.slice(0, -1).join(", ")}, and ${PRACTICE_FIELDS[PRACTICE_FIELDS.length - 1]}`
    : PRACTICE_FIELDS.join("");

export const HOST = {
  name: OWNER_NAME,
  initials: OWNER_INITIALS,
  eventTitle: `Book time with ${OWNER_FIRST_NAME}`,
  /// Default meeting length (must be one of durationOptions).
  durationMinutes: 30,
  /// Lengths the booker can choose from, in minutes.
  durationOptions: [15, 30, 45, 60, 90, 120],
  description:
    "Pick how long and when. Only my free time is shown, and you'll get a calendar invite with the video link.",
  /// The practice this booking page belongs to. Declared once so every surface
  /// says the same thing: it is the site's clearest identity signal, and the
  /// first thing a web-reputation reviewer reads.
  practice: {
    name: "Hunter Zhang Consulting",
    domain: "hunterzhangconsulting.com",
    url: "https://hunterzhangconsulting.com",
    /// Discrete consulting areas, one per line in the booking rail. Written in
    /// mid-sentence casing because `fields` below splices them into prose.
    fieldList: PRACTICE_FIELDS,
    /// The same areas as prose, for the meta descriptions and the noscript
    /// fallback ("AI automation, robotics, …, and intelligence safety").
    fields: PRACTICE_FIELDS_PROSE,
  },
  /// The owner's research site, linked from the booking rail.
  researchUrl: "https://www.protocolz.org/",
  /// Public source code of this app, linked from the booking rail. This app is
  /// open source; the link doubles as a trust signal for visitors.
  sourceUrl: "https://github.com/hunterZh37/agentic-scheduling",
  /// Public LinkedIn profile, used in the booking invite's signature. Empty by
  /// default (optional feature) — set NEXT_PUBLIC_OWNER_LINKEDIN to enable.
  linkedin: process.env.NEXT_PUBLIC_OWNER_LINKEDIN ?? "",
  /// Fixed video-call room included on every booking (event location + invite).
  /// Empty by default (optional feature) — set NEXT_PUBLIC_OWNER_VIDEO_LINK to
  /// a reusable meeting room link to enable.
  videoLink: process.env.NEXT_PUBLIC_OWNER_VIDEO_LINK ?? "",
};

/// Human label for a meeting length in minutes: "45 min", "1 hr", "1.5 hr",
/// "1 hr 15 min".
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h} hr`;
  if (m === 30) return `${h}.5 hr`;
  return `${h} hr ${m} min`;
}

// A small curated timezone list for the override dropdown; the booker's detected
// zone is added on top if it isn't already present.
export const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];
