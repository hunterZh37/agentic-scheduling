// Client-safe config (inlined at build via NEXT_PUBLIC_*). The private app
// renders times in the owner's timezone. NEXT_PUBLIC_HUNTER_TIMEZONE is a
// legacy alias, still honored as a fallback.
export const OWNER_TIMEZONE =
  process.env.NEXT_PUBLIC_OWNER_TIMEZONE ??
  process.env.NEXT_PUBLIC_HUNTER_TIMEZONE ??
  "America/New_York";

// Calendar grid renders the full 24h (so vertical scrolling reveals every hour),
// but the viewport scrolls to DEFAULT_SCROLL_HOUR on load so the default view
// still opens around the working day.
export const GRID_START_HOUR = 0;
export const GRID_END_HOUR = 24;
export const HOUR_PX = 54;
export const DEFAULT_SCROLL_HOUR = 7;
