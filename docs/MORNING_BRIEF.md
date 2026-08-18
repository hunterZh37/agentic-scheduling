# Daily WhatsApp morning brief

Every morning at **7am in the owner's timezone** (`OWNER_TIMEZONE`, default
`America/New_York`), a WhatsApp message summarizes the day ahead — a concise,
single-line brief of the day's events, reserved blocks, and bookings.

## How it works

- **Trigger:** Vercel Cron hits `/api/cron/morning-brief` **hourly** (`0 * * * *`
  in `vercel.json`). The route only actually sends when the local hour in
  `OWNER_TIMEZONE` is 7. An hourly trigger + local-hour guard is **DST-safe** —
  a fixed UTC cron time would drift an hour twice a year when the offset changes.
- **Content:** `buildMorningBrief` (`src/lib/brief/morning.ts`) fetches today's
  schedule via `getScheduleView` and renders a concise, single-line summary. The
  formatter (`formatMorningBrief`) is pure and unit-tested.
- **Delivery:** `sendWhatsAppTemplate` (`src/lib/sms/send.ts`) sends via Twilio's
  Content API.

## Why a WhatsApp *template* (not a plain message)

WhatsApp blocks business-**initiated** messages (anything outside the 24-hour
reply window) unless they use a **pre-approved Message Template**. A proactive
7am push is business-initiated, so it must reference an approved template by its
**Content SID**; the generated brief is passed in as template variable `{{1}}`.

> The Twilio WhatsApp **sandbox** is not a substitute here — it requires
> re-joining every 24h, which defeats a daily unattended push. Use an approved
> template on a real WhatsApp sender.

Template variables also can't contain newlines, tabs, or long whitespace runs, so
the brief is normalized to one clean line before sending.

## Required environment variables

`OWNER_TIMEZONE` / `OWNER_WHATSAPP_NUMBER` / `OWNER_SMS_NUMBER` are the
canonical names; the legacy aliases `HUNTER_TIMEZONE` / `HUNTER_WHATSAPP_NUMBER`
/ `HUNTER_SMS_NUMBER` are still honored as fallbacks if set.

| Variable | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio account + auth (shared with SMS). |
| `TWILIO_WHATSAPP_FROM` | WhatsApp-enabled Twilio sender, e.g. `whatsapp:+14155238886`. |
| `TWILIO_MORNING_BRIEF_CONTENT_SID` | The approved WhatsApp template's Content SID (`HX…`). Its body must contain a `{{1}}` placeholder for the brief. |
| `OWNER_WHATSAPP_NUMBER` | Recipient. Falls back to `OWNER_SMS_NUMBER` if unset; the `whatsapp:` prefix is added automatically. |
| `CRON_SECRET` | Shared secret Vercel Cron sends; the route rejects public calls. |
| `OWNER_TIMEZONE` | Timezone the 7am fire time is evaluated in. |

If any of the WhatsApp variables are unset, the route no-ops (`sent: false`) and
returns the generated brief instead — safe for testing.

## To go live, the owner must provide

1. A **WhatsApp-enabled Twilio sender** (a number registered with WhatsApp), set
   as `TWILIO_WHATSAPP_FROM`.
2. An **approved WhatsApp Message Template** with a single `{{1}}` body variable
   (e.g. *"Good morning 👋 Here's your day: {{1}}"*). Create it in the
   Twilio Console (Messaging → Content Template Builder), submit for WhatsApp
   approval, then put its Content SID in `TWILIO_MORNING_BRIEF_CONTENT_SID`.
3. `OWNER_WHATSAPP_NUMBER` (or rely on the `OWNER_SMS_NUMBER` fallback).
4. `CRON_SECRET` set in the Vercel project (Cron sends it as a Bearer token).

## Testing

The route accepts `?force=1` (still behind the `CRON_SECRET` check) to run
regardless of the hour:

```bash
# Local: returns the generated brief; sends only if WhatsApp env is set.
curl "http://localhost:3000/api/cron/morning-brief?force=1"
```

Vercel Cron only runs on the **deployed** app — it will not fire on `localhost`.
