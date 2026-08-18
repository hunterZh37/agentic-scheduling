import { HOST, OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";
import { DEFAULT_DESTINATION_EMAIL } from "@/lib/env";

export const metadata = {
  title: `Terms of Service — ${HOST.eventTitle}`,
  description: `Terms for booking time or connecting a calendar to this scheduling app.`,
};

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 720, margin: "0 auto", padding: "48px 20px 80px", fontFamily: "system-ui, sans-serif", color: "#1d1d1f", lineHeight: 1.6 },
  h1: { fontSize: 28, marginBottom: 4 },
  updated: { color: "#6e6e73", fontSize: 14, marginBottom: 32 },
  h2: { fontSize: 18, marginTop: 36, marginBottom: 10 },
  p: { margin: "0 0 14px", color: "#333" },
  li: { marginBottom: 8, color: "#333" },
};

export default function TermsPage() {
  return (
    <main style={S.main}>
      <h1 style={S.h1}>Terms of Service</h1>
      <p style={S.updated}>Self-hosted instance operated by {HOST.name}.</p>

      <p style={S.p}>
        This scheduling app is operated by {OWNER_FIRST_NAME} to manage {OWNER_FIRST_NAME}
        &apos;s own calendar and to let visitors book time. By connecting a calendar
        account or booking time through this app, you agree to the following.
      </p>

      <h2 style={S.h2}>1. What this app does</h2>
      <p style={S.p}>
        This app aggregates free/busy time across connected Google and Microsoft
        calendars, offers a public booking page backed by that availability, and lets{" "}
        {OWNER_FIRST_NAME} manage the calendar via a private dashboard, text/WhatsApp, or
        voice note. It is software {OWNER_FIRST_NAME} operates for personal/business use —
        not a commercial SaaS product offered to the public.
      </p>

      <h2 style={S.h2}>2. Booking time through the public page</h2>
      <p style={S.p}>
        If you book time through the public booking page, the details you provide (name,
        email, timezone) are used solely to create and manage that booking, as described in
        the <a href="/privacy">Privacy Policy</a>. You can reschedule or cancel your own
        booking at any time via the link in your confirmation email.
      </p>

      <h2 style={S.h2}>3. No warranty</h2>
      <p style={S.p}>
        This app is provided &quot;as is,&quot; without warranty of any kind. {OWNER_FIRST_NAME}
        makes reasonable efforts to keep it available and accurate, but does not guarantee
        uninterrupted availability, and is not liable for missed meetings, scheduling
        conflicts, or data loss arising from use of this app, to the fullest extent
        permitted by law.
      </p>

      <h2 style={S.h2}>4. Acceptable use</h2>
      <p style={S.p}>
        Don&apos;t use the public booking page or agent chat to submit spam, abusive
        content, or attempts to access data or functionality beyond booking your own time.
        {OWNER_FIRST_NAME} may block access for misuse.
      </p>

      <h2 style={S.h2}>5. Open source</h2>
      <p style={S.p}>
        This application is open-source software, MIT licensed, available at{" "}
        <a href="https://github.com/hunterZh37/agentic-scheduling">
          github.com/hunterZh37/agentic-scheduling
        </a>. The license governs the code itself; these Terms govern your use of this
        particular running instance.
      </p>

      <h2 style={S.h2}>6. Changes</h2>
      <p style={S.p}>
        These terms may be updated as the app changes. Continued use after an update means
        you accept the revised terms.
      </p>

      <h2 style={S.h2}>7. Contact</h2>
      <p style={S.p}>
        Questions about these terms can be sent to{" "}
        <a href={`mailto:${DEFAULT_DESTINATION_EMAIL}`}>{DEFAULT_DESTINATION_EMAIL}</a>.
      </p>
    </main>
  );
}
