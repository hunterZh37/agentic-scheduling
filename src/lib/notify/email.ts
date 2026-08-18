import { optionalEnv, requireEnv } from "@/lib/env";

/// Whether an address can never actually receive mail.
export function isUnroutable(address: string): boolean {
  const domain = address.trim().toLowerCase().split("@")[1] ?? "";
  return /^(example\.(com|net|org)|(.+\.)?invalid|localhost)$/.test(domain);
}

/// Send an email via Resend. Throws on failure (worker records it and retries
/// next run since sentAt stays null). Pass `html` for a rich version — clients
/// render it and fall back to `text`; the reminder worker sends text-only.
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html?: string
): Promise<void> {
  // Staging/e2e: never email a real inbox — the flow is verified on-screen.
  if (optionalEnv("E2E_STUB_CALENDAR") === "true") {
    console.log(`[email] stubbed (E2E_STUB_CALENDAR) — not sending to ${to}`);
    return;
  }
  // example.com/net/org are RESERVED for documentation (RFC 2606) — mail to
  // them reaches nobody. They only ever appear here as an unset-config
  // fallback, and Resend accepts the request, so the send "succeeds" and the
  // owner simply never hears anything. That is how the daily reputation audit
  // was addressed to owner@example.com for weeks while every log said 200.
  if (isUnroutable(to)) {
    throw new Error(
      `Refusing to send "${subject}" to ${to}: that is a reserved example domain, ` +
        `which means a recipient env var is unset. Set OWNER_EMAIL.`
    );
  }
  const apiKey = requireEnv("RESEND_API_KEY");
  const from = optionalEnv("REMINDER_FROM_EMAIL") ?? "reminders@example.com";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, text, ...(html ? { html } : {}) }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}
