# Credentials & Setup Guide

Everything needed to take the app from "runs against placeholders" to "fully
live." Each section maps a service to the exact variables in `.env`.

**Workflow for every secret below:**

1. `cp .env.example .env` (once).
2. Fill in the variable(s) for the service you're setting up.
3. Restart the dev server (`npm run dev`) so it picks up the new values — Next.js
   reads `.env` at startup, not per-request.

`.env` is gitignored. Never commit real secrets.

---

## What unlocks what

| You want… | Set up | Variables |
|---|---|---|
| Connect your calendars (real events + real bookings) | Google Cloud + Azure | `GOOGLE_OAUTH_*`, `MS_OAUTH_*` |
| The agent chat to respond | Anthropic credits | `ANTHROPIC_API_KEY` (+ billing) |
| Reminder emails to send | Resend | `RESEND_API_KEY`, `REMINDER_FROM_EMAIL` |
| Reminder SMS to send | Twilio | `TWILIO_*`, `OWNER_SMS_NUMBER` |
| Deploy to production | Neon/Supabase + Vercel | `DATABASE_URL`, `CRON_SECRET`, all of the above |

You can do these in any order; the app degrades gracefully when a given
credential is missing (e.g. availability still works before calendars connect;
booking shows "calendar isn't connected yet" until the destination is authorized).

The seed script (`prisma/seed.ts`) ships with three example accounts —
`google-personal@example.com`, `google-work@example.com`, and
`microsoft-outlook@example.com` — as placeholders. Edit that file to list your
own accounts before running `npx prisma db seed` (see step 3 below for how the
app matches a signed-in email to a pre-configured account).

---

## 1. Google Calendar

Every Google account connects through **one** OAuth client via per-account
consent. You authorize each account once by visiting its connect URL and
signing in as that account.

### A. Create the project + enable the API
1. Go to <https://console.cloud.google.com> and create a project (e.g. "agentic-scheduling").
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.

### B. Configure the OAuth consent screen
1. **APIs & Services → OAuth consent screen**.
2. User type: **External** → Create.
3. App name, your support email, developer email. Save.
4. **Scopes** → Add: `openid`, `email`, and
   `https://www.googleapis.com/auth/calendar` (full calendar — needed so any
   account can serve free/busy *and* receive booking writes if it becomes the
   destination). Save.
5. **Test users** → add every Google email you plan to connect. Save.

### C. Create the OAuth client
1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized redirect URIs** → add exactly:
   - `http://localhost:3000/api/oauth/google/callback` (dev)
   - `https://<your-domain>/api/oauth/google/callback` (add when you deploy)
4. Create → copy the **Client ID** and **Client secret**.

### D. Set the variables
```
GOOGLE_OAUTH_CLIENT_ID="…apps.googleusercontent.com"
GOOGLE_OAUTH_CLIENT_SECRET="…"
GOOGLE_OAUTH_REDIRECT_URI="http://localhost:3000/api/oauth/google/callback"
```
(`GOOGLE_DELEGATION_SA_KEY_B64` stays empty — we use per-account OAuth for all.)

### ⚠️ Gotchas
- **Testing-mode refresh tokens expire after 7 days.** While the consent screen
  is in "Testing", Google expires refresh tokens weekly, so the app loses access
  and you'd have to re-connect each account. For durable access, **Publish** the
  app (Consent screen → "Publish app"). A single-user app requesting the calendar
  scope can publish without formal verification for personal use; Google may show
  an "unverified app" warning you click through.
- **Managed Workspace accounts may be blocked.** If one of your accounts lives
  on a Google Workspace domain you don't administer, that domain's admins can
  block unverified third-party apps from accessing it. If a connect attempt
  fails with an admin-policy error, that account can't be connected until the
  domain's admin allows the app — your other accounts are unaffected. Set
  `checkForConflicts=false` on any account you can't connect so the aggregator
  doesn't warn on it.

---

## 2. Microsoft / Outlook

For a personal or work Microsoft account — commonly used as the default
booking destination.

### A. Register the app
1. Go to <https://portal.azure.com> → **Microsoft Entra ID → App registrations → New registration**.
2. Name it.
3. **Supported account types**: *"Accounts in any organizational directory and
   personal Microsoft accounts"* (personal outlook.com needs this).
4. **Redirect URI**: platform **Web** →
   `http://localhost:3000/api/oauth/microsoft/callback` (add the prod URL later).
5. Register → copy the **Application (client) ID**.

### B. Client secret + permissions
1. **Certificates & secrets → New client secret** → copy the **Value** (not the ID).
2. **API permissions → Add a permission → Microsoft Graph → Delegated** → add
   `Calendars.ReadWrite` and `offline_access` → Add.

### C. Set the variables
```
MS_OAUTH_CLIENT_ID="…"
MS_OAUTH_CLIENT_SECRET="…"      # the secret VALUE
MS_OAUTH_TENANT_ID="common"     # 'common' supports personal + work accounts
MS_OAUTH_REDIRECT_URI="http://localhost:3000/api/oauth/microsoft/callback"
```

---

## 3. Connect the accounts (after Google + Microsoft are set)

With the dev server running, connect each account by signing in as that account:

- Google (repeat for each account): <http://localhost:3000/api/oauth/google/start>
- Microsoft: <http://localhost:3000/api/oauth/microsoft/start>

The callback matches the signed-in email to one of the pre-configured accounts
(from `prisma/seed.ts`) and stores its tokens. Verify status any time:

```
curl -s http://localhost:3000/api/accounts | python3 -m json.tool
```

Each account should flip to `"connected": true`. Once the **destination**
account is connected, bookings write to its calendar and the booking flow
reaches the success state.

> Tip: if `/api/oauth/google/start` returns a 503 "not configured", the client
> id/secret aren't set (or the server wasn't restarted after editing `.env`).

---

## 4. Anthropic API (both agents)

The agent code is already wired — it just needs credits on the key.

1. Go to <https://console.anthropic.com> → **Settings → Billing** → add a payment
   method / purchase credits.
2. **API Keys → Create Key** → copy it.
3. Set:
   ```
   ANTHROPIC_API_KEY="sk-ant-…"
   ```
Restart the server; the private pane and the public "Ask the assistant" tab will
respond. (A key with an empty credit balance returns "credit balance too low" —
add credits and it works immediately.)

---

## 5. Resend (reminder emails)

1. Go to <https://resend.com> → **API Keys → Create** → copy it.
2. **Domains → Add Domain** and complete DNS verification, *or* for quick testing
   use Resend's onboarding sender.
3. Set:
   ```
   RESEND_API_KEY="re_…"
   REMINDER_FROM_EMAIL="reminders@your-verified-domain.com"
   OWNER_EMAIL="you@example.com"   # where the owner's own reminders go
   ```

> Gotcha: `REMINDER_FROM_EMAIL` must be on a **verified** domain, or Resend
> rejects the send. Until you verify a domain, testing is limited to your own
> address.

---

## 6. Twilio (reminder SMS)

1. Go to <https://console.twilio.com> → copy **Account SID** and **Auth Token**.
2. **Phone Numbers → Buy a number** with SMS capability (trial gives one).
3. Set (numbers in E.164, e.g. `+15551234567`):
   ```
   TWILIO_ACCOUNT_SID="AC…"
   TWILIO_AUTH_TOKEN="…"
   TWILIO_FROM_NUMBER="+1…"     # your Twilio number
   OWNER_SMS_NUMBER="+1…"       # the owner's mobile
   ```

> Gotcha: **trial accounts can only send to verified numbers** and prepend a
> trial notice. Verify the owner's mobile under **Verified Caller IDs**, or
> upgrade. SMS reminders for the owner only fire when `OWNER_SMS_NUMBER` is
> set; attendees get email only (the public page collects no phone number).

---

## 7. Production deploy (Vercel) — when ready

1. **Database**: create a Postgres on [Neon](https://neon.tech) or
   [Supabase](https://supabase.com); copy the connection string.
2. **Vercel**: import the GitHub repo. In **Settings → Environment Variables**,
   add every variable from `.env` (with production values), plus:
   ```
   DATABASE_URL="<neon/supabase connection string>"
   APP_BASE_URL="https://<your-domain>"
   CRON_SECRET="<random 32+ char string>"   # Vercel Cron sends this to the reminder route
   PRIVATE_AUTH_SECRET="<random string>"     # gates the private agent endpoint
   ```
3. Update **both** OAuth redirect URIs to your production domain in the Google and
   Azure consoles (and the `*_REDIRECT_URI` env vars).
4. Apply the schema + seed against the prod DB:
   ```
   DATABASE_URL="<prod url>" npx prisma migrate deploy
   DATABASE_URL="<prod url>" npx prisma db seed
   ```
5. `vercel.json` already schedules the reminder worker every 5 minutes; Vercel
   attaches `CRON_SECRET` as a Bearer token automatically once the env var is set.

---

## Quick verification checklist

- [ ] `curl localhost:3000/api/accounts` shows the accounts you connected as `connected: true`
- [ ] `/book` shows real free slots and a booking to the connected destination reaches "You're booked"
- [ ] The agent panes reply (Anthropic credits present)
- [ ] `curl localhost:3000/api/cron/reminders` returns a JSON result (and sends due reminders once Resend/Twilio are set)
