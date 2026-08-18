# Calendly Availability

A tiny Chrome extension. On **any** Calendly booking page, it badges each
offered time slot with **your own** free/busy — pulled live from your
self-hosted instance of this scheduling app (its connected accounts + personal
blocks), not Calendly's. Green `✓ you're free` / red `✗ busy`, busy slots dimmed.

No clicks: it runs automatically whenever a Calendly page's slots appear, and
re-checks when you switch dates.

> **Before you install:** this extension hardcodes your deployment's domain
> (Chrome extensions can't read `.env` files). Edit `ENDPOINT` in
> `background.js` and `host_permissions` in `manifest.json`, replacing
> `your-deployment.example.com` with your actual deployment domain, before
> loading it.

## Why not just use Calendly's built-in green dots?

Calendly's native dots reflect the calendars connected to *your Calendly
account*. These badges reflect the accounts connected to *your own scheduling
app*, which may be a different set — so they can disagree, and that's the point.

## Install (one-time, ~30 seconds)

1. Set your deployment domain (see the note above).
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select this `calendly-extension/` folder.
5. Done. Open any Calendly page (e.g. someone's `/30min` link) and the slots
   will badge themselves after a moment.

To update it later, pull the repo and click the **↻ reload** icon on the
extension card.

## How it works

- `content.js` scrapes the visible slot buttons (`data-start-time`), the viewing
  date (from the URL), your browser timezone, and the meeting length.
- `background.js` (service worker) POSTs those to
  `https://your-deployment.example.com/api/availability/check`, which returns
  free/busy per slot (timezone math + free/busy aggregation happen
  server-side).
- `content.js` badges each slot.

## Notes / limitations

- Reads Calendly's rendered DOM, so a big Calendly redesign of the slot list
  could need a selector tweak (`button[data-container="time-button"]`).
- Times are interpreted in **your browser's timezone**, which matches Calendly's
  default. If you manually change Calendly's timezone dropdown to a different
  zone, the check may be off by that offset.
- The `/api/availability/check` endpoint returns only free/busy booleans (never
  event titles) — the same class of info the public booking page already exposes.
