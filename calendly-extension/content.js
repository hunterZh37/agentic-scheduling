// Runs on every calendly.com page. Scrapes the visible time slots + the viewing
// date/timezone, asks your self-hosted scheduling app whether the owner is
// free for each, and badges the slots inline. Calendly's own green dots
// reflect the calendars connected to the *Calendly* account; these badges
// reflect the accounts connected to *your app* — which may differ. That
// difference is the whole point.

// --- scraping -------------------------------------------------------------

// The ISO day being viewed. Calendly puts it in the URL (?date=YYYY-MM-DD).
function getDate() {
  const d = new URL(location.href).searchParams.get("date");
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// Every visible time-slot button on the selected day.
function getSlotButtons() {
  return [...document.querySelectorAll('button[data-container="time-button"]')];
}

// The label used both as the slot key and for parsing, e.g. "9:30pm".
function slotLabel(btn) {
  return (btn.getAttribute("data-start-time") || btn.textContent || "").trim();
}

// Meeting length, e.g. "15 min" on the event card. Falls back to 30.
function getDurationMinutes() {
  const m = (document.body.innerText || "").match(/\b(\d{1,3})\s*min\b/i);
  return m ? parseInt(m[1], 10) : 30;
}

// --- rendering ------------------------------------------------------------

// Visual style per badge state. `loading` shows immediately while the check is
// in flight so slots never sit un-annotated; `unknown` is the give-up state
// after retries fail.
const STATES = {
  loading: { text: "loading…", bg: "#eef0f2", fg: "#5b6470", opacity: "0.85" },
  free: { text: "✓ you're free", bg: "#e6f7ed", fg: "#137a3e", opacity: "1" },
  busy: { text: "✗ busy", bg: "#fdeaea", fg: "#b42318", opacity: "0.5" },
  unknown: { text: "—", bg: "#eef0f2", fg: "#8a929c", opacity: "0.85" },
};

function mark(btn, state) {
  if (btn.dataset.bwhBadged === state) return; // already correct, skip (no loop)
  btn.dataset.bwhBadged = state;
  const s = STATES[state];
  btn.style.position = "relative";
  btn.style.opacity = s.opacity;
  let tag = btn.querySelector(".bwh-tag");
  if (!tag) {
    tag = document.createElement("span");
    tag.className = "bwh-tag";
    btn.appendChild(tag);
  }
  tag.textContent = s.text;
  tag.setAttribute(
    "style",
    [
      "position:absolute",
      "right:10px",
      "top:50%",
      "transform:translateY(-50%)",
      "font-size:11px",
      "font-weight:600",
      "line-height:1",
      "padding:3px 7px",
      "border-radius:999px",
      "pointer-events:none",
      `background:${s.bg}`,
      `color:${s.fg}`,
    ].join(";")
  );
}

// --- orchestration --------------------------------------------------------

let lastKey = "";

async function run(attempt = 0) {
  const date = getDate();
  const btns = getSlotButtons();
  if (!date || btns.length === 0) return;

  const slots = btns.map(slotLabel);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const durationMinutes = getDurationMinutes();

  // Skip redundant work if nothing relevant changed since last run — but always
  // proceed on a retry (attempt > 0). Badging mutates the DOM, which retriggers
  // the observer; this guard is what stops that from looping.
  const key = `${date}|${timezone}|${durationMinutes}|${slots.join(",")}`;
  if (key === lastKey && attempt === 0) return;
  lastKey = key;

  // Show "loading…" right away so slots are never left un-annotated while the
  // request is in flight.
  for (const btn of btns) mark(btn, "loading");

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: "check",
      payload: { date, timezone, durationMinutes, slots },
    });
  } catch {
    resp = null;
  }
  const results =
    resp && resp.ok && resp.data && Array.isArray(resp.data.results) ? resp.data.results : null;

  if (!results) {
    // Transient failure: retry a couple times (slots keep showing "loading…"),
    // then fall back to a neutral dash. Keep lastKey set so we don't hammer the
    // endpoint — a date change gives it a fresh attempt.
    if (attempt < 2) {
      setTimeout(() => run(attempt + 1), 1200);
      return;
    }
    for (const btn of getSlotButtons()) {
      if (btn.dataset.bwhBadged === "loading") mark(btn, "unknown");
    }
    return;
  }

  const free = new Map(results.map((r) => [r.slot, r.free]));
  for (const btn of getSlotButtons()) {
    const label = slotLabel(btn);
    if (free.has(label)) mark(btn, free.get(label) ? "free" : "busy");
  }
}

// Calendly is a SPA: slots load async and change when you pick another date.
// Re-run on DOM changes, debounced, plus once shortly after load.
let debounce;
new MutationObserver(() => {
  clearTimeout(debounce);
  debounce = setTimeout(run, 400);
}).observe(document.body, { childList: true, subtree: true });

setTimeout(run, 1200);
