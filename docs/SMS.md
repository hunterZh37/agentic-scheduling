# SMS control channel

The owner can control their **private** calendar agent by text message. They
text a Twilio number; the app runs the private agent on the message (with a
short rolling history) and texts the reply back. This is a two-way SMS control
channel, and it is **owner-only**.

## Security model

Two independent gates protect the agent — both must pass:

1. **Twilio signature.** Every inbound request carries an `X-Twilio-Signature`
   header. We recompute it (HMAC-SHA1 over the public URL + sorted POST params,
   keyed by `TWILIO_AUTH_TOKEN`) and timing-safe compare. A mismatch → `403`.
   This proves the request actually came from Twilio, not a forged POST.
2. **Sender allowlist.** Even with a valid Twilio signature, the agent only runs
   when `From` equals `OWNER_SMS_NUMBER` (compared in normalized E.164). Any
   other number gets a polite "not authorized" reply and never reaches the
   agent.

There is a local-dev escape hatch, `SMS_SKIP_SIGNATURE_CHECK=true`, which skips
gate 1 only (and logs a warning). The sender allowlist still applies. **Never
set this in production.**

## Endpoint

- Route: `POST /api/sms/inbound` (`src/app/api/sms/inbound/route.ts`)
- Twilio POSTs `application/x-www-form-urlencoded` with `From`, `Body`, `To`,
  `MessageSid`.
- Responds with TwiML XML (`Content-Type: application/xml`). An empty
  `<Response/>` means "no reply".

### Commands

- Any normal text → runs the private agent and replies.
- `reset` or `new` → clears the rolling conversation history for that number.

Conversation history (last ~12 turns) is persisted per phone number in the
`SmsConversation` Prisma model, so multi-turn context survives across the
stateless SMS transport. Inbound messages are rate-limited per number.

## Required environment variables

Add these to `.env` (values live only there; `.env.example` keeps them empty).
`OWNER_SMS_NUMBER` is the canonical name; the legacy alias `HUNTER_SMS_NUMBER`
is still honored as a fallback if set.

| Variable | Purpose |
| --- | --- |
| `TWILIO_ACCOUNT_SID` | Twilio account SID (outbound send + account identity). |
| `TWILIO_AUTH_TOKEN` | Signs/validates the inbound webhook. |
| `TWILIO_FROM_NUMBER` | The Twilio number texts are sent from. |
| `OWNER_SMS_NUMBER` | The owner's cellphone, in E.164 (e.g. `+14155550100`). The **only** number allowed to control the agent. |
| `APP_BASE_URL` | Public base URL of the app; the signature check builds the signed URL from this (req.url is internal behind a tunnel). |
| `SMS_SKIP_SIGNATURE_CHECK` | Optional. `"true"` skips signature validation for local dev only. |

## Setup — Twilio

1. In the [Twilio Console](https://console.twilio.com/), buy or use an
   SMS-capable phone number. Put it in `TWILIO_FROM_NUMBER`.
2. Open **Phone Numbers → Manage → Active numbers → (your number) →
   Configure**.
3. Under **Messaging → "A message comes in"**, set:
   - Webhook: `https://<your-host>/api/sms/inbound`
   - Method: **HTTP POST**
4. Save. Copy your Account SID and Auth Token from the console into
   `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN`.
5. Set `OWNER_SMS_NUMBER` to the owner's cellphone in E.164 and `APP_BASE_URL`
   to the public host from step 3.

`<your-host>` must be the **public** host that matches `APP_BASE_URL` — this is
the URL Twilio signs, so it must match exactly.

## Setup — local development

`localhost` isn't reachable by Twilio, so expose it with a tunnel:

```bash
# Option A — ngrok
ngrok http 3000
# Option B — cloudflared
cloudflared tunnel --url http://localhost:3000
```

Then:

1. Copy the tunnel's `https://…` URL.
2. Set that URL (no trailing slash) as `APP_BASE_URL` in `.env`.
3. Set the Twilio webhook (step 3 above) to
   `https://<tunnel-host>/api/sms/inbound`.
4. Restart `next dev` so the new `APP_BASE_URL` is picked up.

If tunnelling is inconvenient while iterating, set
`SMS_SKIP_SIGNATURE_CHECK=true` to bypass the signature gate — the sender
allowlist still restricts control to `OWNER_SMS_NUMBER`.

## To go live, the owner must provide

- The **Twilio number** to use (or confirm the one to buy).
- The **public host / tunnel URL** for `APP_BASE_URL` and the Twilio webhook.
- Their **cellphone number** in E.164 for `OWNER_SMS_NUMBER`.
- Twilio **Account SID + Auth Token**.
