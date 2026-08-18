#!/usr/bin/env node
// Live delivery test for the messaging pipeline.
//
// SENDS REAL MESSAGES to the owner — one email, one WhatsApp. That is the whole
// point: the automated e2e (src/lib/notify/pipeline.e2e.test.ts) proves the
// pipeline builds the right request, but only a real send proves the
// credentials are valid, the template is approved, and the message actually
// arrives. Every reminder failure here has been in that second half.
//
// Nothing else is touched: no booking is created, no reminder row is written.
//
//   npm run test:messaging -- --send        # actually send
//   npm run test:messaging                  # dry run: report config only
//
// Reads credentials from the environment, so run it where they exist (locally
// with a .env, or `vercel env pull` first). It never prints a credential.

const SEND = process.argv.includes("--send");
const env = (k) => process.env[k] || undefined;

const line = (state, name, detail) => {
  const tag = state === "ok" ? "\x1b[32mok\x1b[0m  " : state === "skip" ? "\x1b[33mskip\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag} ${name}${detail ? ` — ${detail}` : ""}`);
  return state !== "fail";
};

console.log(`\nMessaging live test ${SEND ? "\x1b[31m(SENDING REAL MESSAGES)\x1b[0m" : "(dry run)"}\n`);

let ok = true;

// --- Email ------------------------------------------------------------------
const resendKey = env("RESEND_API_KEY");
const to = env("OWNER_EMAIL") || env("HUNTER_EMAIL") || env("DEFAULT_DESTINATION_EMAIL");
const from = env("REMINDER_FROM_EMAIL");

if (!resendKey) {
  ok = line("fail", "email", "RESEND_API_KEY unset");
} else if (!to) {
  // The exact fault that sent weeks of mail to a placeholder.
  ok = line("fail", "email", "no owner address in env — set OWNER_EMAIL");
} else if (/@(example\.(com|net|org)|.*\.invalid)$/i.test(to)) {
  ok = line("fail", "email", `recipient ${to} is a reserved domain and accepts no mail`);
} else if (!SEND) {
  line("skip", "email", `would send to ${to} from ${from ?? "(default)"}`);
} else {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: from ?? "reminders@example.com",
      to,
      subject: "Messaging pipeline test",
      text: "This is a live test of the reminder email pipeline. If you are reading it, email delivery works.",
    }),
  });
  const body = await res.json().catch(() => ({}));
  ok = line(res.ok ? "ok" : "fail", "email", res.ok ? `accepted for ${to} (id ${body.id ?? "?"})` : `Resend ${res.status}: ${JSON.stringify(body).slice(0, 120)}`) && ok;
}

// --- WhatsApp ---------------------------------------------------------------
const sid = env("TWILIO_ACCOUNT_SID");
const token = env("TWILIO_AUTH_TOKEN");
const waFrom = env("TWILIO_WHATSAPP_FROM");
const waTo = env("OWNER_WHATSAPP_NUMBER") || env("HUNTER_WHATSAPP_NUMBER") || env("OWNER_SMS_NUMBER");
const contentSid = env("TWILIO_REMINDER_CONTENT_SID");
const wa = (n) => (n?.startsWith("whatsapp:") ? n : `whatsapp:${n}`);

if (!sid || !token) {
  ok = line("fail", "whatsapp", "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN unset");
} else if (!waFrom || !waTo) {
  ok = line("fail", "whatsapp", "sender or owner number unset");
} else if (!contentSid) {
  // Freeform outside the 24h window is rejected with 63016 — this is not
  // optional for a reminder, which is always business-initiated.
  ok = line("fail", "whatsapp", "TWILIO_REMINDER_CONTENT_SID unset — a reminder would send freeform and be rejected");
} else if (!SEND) {
  line("skip", "whatsapp", `would send template ${contentSid} to ${waTo}`);
} else {
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      From: wa(waFrom),
      To: wa(waTo),
      ContentSid: contentSid,
      ContentVariables: JSON.stringify({ "1": "Live test of the reminder pipeline — no action needed." }),
    }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  ok = line(res.ok ? "ok" : "fail", "whatsapp", res.ok ? `accepted (sid ${body.sid ?? "?"}, status ${body.status ?? "?"})` : `Twilio ${res.status}: ${String(body.message ?? "").slice(0, 120)}`) && ok;

  if (res.ok) {
    console.log(
      "\n  \x1b[33mNote\x1b[0m Twilio ACCEPTING a WhatsApp message is not delivery. Failures\n" +
        "       (63016, 63049) arrive minutes later on /api/sms/status. Check the\n" +
        "       phone, and the Vercel logs, before calling this a pass."
    );
  }
}

console.log(
  SEND
    ? `\n${ok ? "\x1b[32mboth channels accepted\x1b[0m — now confirm they actually arrived" : "\x1b[31msomething failed\x1b[0m"}\n`
    : "\n\x1b[2mdry run — re-run with --send to deliver\x1b[0m\n"
);
process.exit(ok ? 0 : 1);
