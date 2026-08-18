# Deploying to the cloud (Vercel + Neon)

One-time runbook to take this app from local Docker to production. Decisions
baked in: **Vercel Pro**, **fresh database** (no local-data migration), launch
on the **`*.vercel.app`** subdomain first (custom domain can come later).

Steps marked **[you]** require your own console login and can't be automated.
Steps marked **[cmd]** are commands you run in this repo.

---

## 0. Prerequisites already done in the repo
- `prisma/schema.prisma` has `directUrl = env("DIRECT_URL")` (pooled vs direct split).
- `package.json` build script is `prisma generate && next build` (so Vercel always builds a fresh Prisma client).
- `vercel.json` declares both crons (`/api/cron/reminders` every 5 min, `/api/cron/morning-brief` hourly) — these register automatically on deploy and work on Pro.
- Production build is verified green locally (`npm run build`).

---

## 1. Provision Postgres — Neon **[you]**
1. Create a Neon project (any region near you).
2. From the connection dialog copy **two** strings:
   - **Pooled** (has `-pooler` in the host) → this becomes `DATABASE_URL`. Append `?pgbouncer=true&connection_limit=1`.
   - **Direct** (no `-pooler`) → this becomes `DIRECT_URL`.

## 2. Run migrations + seed against Neon **[cmd]**
Point a shell at the Neon URLs and deploy the 13 migrations, then seed the singletons (Settings row, starter sleep block):
```bash
DATABASE_URL="<neon-pooled-url>" DIRECT_URL="<neon-direct-url>" npx prisma migrate deploy
DATABASE_URL="<neon-pooled-url>" DIRECT_URL="<neon-direct-url>" npm run db:seed
```
Use `migrate deploy` (not `migrate dev`) — it applies existing migrations without generating new ones.

## 3. Create the Vercel project **[you]**
1. Import your GitHub repo (e.g. `youruser/agentic-scheduling`) into Vercel.
2. Framework preset: Next.js (auto-detected). Leave the build command as-is (it reads `package.json`).
3. Deploy once to get the assigned `https://<project>.vercel.app` URL — note it; several env vars below reference it. (This first deploy will 500 at runtime until env vars are set — that's expected.)

## 4. Set environment variables in Vercel → Settings → Environment Variables (Production) **[you]**
Set every name below. `<domain>` = your `https://<project>.vercel.app`.

**Core**
- `DATABASE_URL` = Neon pooled URL (with `?pgbouncer=true&connection_limit=1`)
- `DIRECT_URL` = Neon direct URL
- `APP_BASE_URL` = `<domain>`  ← used for OAuth redirects **and** Twilio signature validation; must match exactly
- `PRIVATE_AUTH_SECRET` = a long random string (gates the private UI/agent; the private route 500s in prod if unset)
- `CRON_SECRET` = a long random string (the cron routes 500 in prod if unset). Generate one with `openssl rand -base64 32`.
- `ANTHROPIC_API_KEY`

**Owner identity**
- `NEXT_PUBLIC_OWNER_NAME` = your name (e.g. `"Alex Rivera"`) — shown on the public booking page
- `NEXT_PUBLIC_OWNER_LINKEDIN`, `NEXT_PUBLIC_OWNER_VIDEO_LINK` = optional, leave blank to omit

**Timezone (set BOTH — the second is inlined at build time; legacy aliases `HUNTER_TIMEZONE` / `NEXT_PUBLIC_HUNTER_TIMEZONE` are still honored)**
- `OWNER_TIMEZONE` = e.g. `America/New_York`
- `NEXT_PUBLIC_OWNER_TIMEZONE` = same value

**Google Calendar**
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI` = `<domain>/api/oauth/google/callback`

**Microsoft / Outlook**
- `MS_OAUTH_CLIENT_ID`, `MS_OAUTH_CLIENT_SECRET`
- `MS_OAUTH_TENANT_ID` = `common`
- `MS_OAUTH_REDIRECT_URI` = `<domain>/api/oauth/microsoft/callback`
- `DEFAULT_DESTINATION_EMAIL` = your default booking destination email

**Email reminders (Resend)**
- `RESEND_API_KEY`, `REMINDER_FROM_EMAIL`

**Twilio (SMS + WhatsApp)**
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`
- `TWILIO_WHATSAPP_FROM`, `TWILIO_MORNING_BRIEF_CONTENT_SID`

**Contact (legacy aliases `HUNTER_EMAIL` / `HUNTER_SMS_NUMBER` / `HUNTER_WHATSAPP_NUMBER` are still honored)**
- `OWNER_EMAIL`, `OWNER_SMS_NUMBER`, `OWNER_WHATSAPP_NUMBER`

**Do NOT set:** `SMS_SKIP_SIGNATURE_CHECK` (dev-only bypass). Optional/unused today: `VAPID_*`, `GOOGLE_DELEGATION_SA_KEY_B64`.

> `NEXT_PUBLIC_OWNER_NAME`, `NEXT_PUBLIC_OWNER_LINKEDIN`, `NEXT_PUBLIC_OWNER_VIDEO_LINK`, and `NEXT_PUBLIC_OWNER_TIMEZONE` are all baked into the build — changing any of them later needs a **redeploy**, not just an env edit.

## 5. Register the production OAuth redirect URIs **[you]**
- **Google Cloud Console** → your OAuth 2.0 Client → Authorized redirect URIs → add `<domain>/api/oauth/google/callback`. Confirm the consent screen covers your account (add it as a test user if the app is in "testing").
- **Azure App Registration** → Authentication → Redirect URIs → add `<domain>/api/oauth/microsoft/callback`. Confirm supported account types match `common` and the client secret hasn't expired.

## 6. Point Twilio at the deployed webhook **[you]**
- In the Twilio Console, set the Messaging webhook for your SMS/WhatsApp number to `<domain>/api/sms/inbound` (HTTP POST).
- Signature validation rebuilds the URL from `APP_BASE_URL` — it must equal `<domain>` exactly or inbound messages get 403'd.

## 7. Redeploy & smoke test
Trigger a redeploy (push a commit or "Redeploy" in Vercel) so all env vars — including the build-time `NEXT_PUBLIC_*` — take effect. Then:
1. App loads at `<domain>`; private UI is gated by `PRIVATE_AUTH_SECRET`.
2. Connect Google + Microsoft via the in-app OAuth flow — **tokens must be re-minted from the prod domain** (local tokens don't carry over). Verify each `Account` row gets tokens.
3. `GET <domain>/api/availability` returns free/busy.
4. Create a booking → verify the event lands on the destination account and `Reminder` rows appear.
5. Crons (replace `<secret>` with `CRON_SECRET`):
   ```bash
   curl -H "Authorization: Bearer <secret>" <domain>/api/cron/reminders            # 200 + result
   curl <domain>/api/cron/reminders                                                # 401
   curl -H "Authorization: Bearer <secret>" "<domain>/api/cron/morning-brief?force=1"  # returns the brief
   ```
6. Send an inbound SMS from `OWNER_SMS_NUMBER` → agent replies; from any other number → rejected.

---

## Later: custom domain
Add it in Vercel, then **repeat steps 4–6's URL-dependent items** with the new host: `APP_BASE_URL`, `GOOGLE_OAUTH_REDIRECT_URI`, `MS_OAUTH_REDIRECT_URI` (env, needs redeploy for the build-time one), the Google/Azure redirect URIs, and the Twilio webhook.

## Local dev is unchanged
Docker Postgres on `localhost:5433` stays as-is. Keep `DIRECT_URL` in your local `.env` equal to `DATABASE_URL` so `prisma migrate`/`validate` work locally.
