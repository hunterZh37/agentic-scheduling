import { HOST, OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";
import { DEFAULT_DESTINATION_EMAIL } from "@/lib/env";

export const metadata = {
  title: `Privacy Policy — ${HOST.eventTitle}`,
  description: `How this scheduling app handles calendar and contact data.`,
};

const S: Record<string, React.CSSProperties> = {
  main: { maxWidth: 720, margin: "0 auto", padding: "48px 20px 80px", fontFamily: "system-ui, sans-serif", color: "#1d1d1f", lineHeight: 1.6 },
  h1: { fontSize: 28, marginBottom: 4 },
  updated: { color: "#6e6e73", fontSize: 14, marginBottom: 32 },
  h2: { fontSize: 18, marginTop: 36, marginBottom: 10 },
  p: { margin: "0 0 14px", color: "#333" },
  li: { marginBottom: 8, color: "#333" },
};

export default function PrivacyPage() {
  return (
    <main style={S.main}>
      <h1 style={S.h1}>Privacy Policy</h1>
      <p style={S.updated}>Self-hosted instance operated by {HOST.name}.</p>

      <p style={S.p}>
        This is a single-owner scheduling application. It is operated by {OWNER_FIRST_NAME}{" "}
        for {OWNER_FIRST_NAME}&apos;s own use, and by visitors who book time through the
        public booking page below. This policy explains what data the app accesses, why,
        and how it is (and is not) used.
      </p>

      <h2 style={S.h2}>1. Data accessed via connected calendar accounts</h2>
      <p style={S.p}>
        When {OWNER_FIRST_NAME} connects a Google or Microsoft calendar account, this app
        requests calendar read/write access (via Google Calendar API and/or Microsoft
        Graph) solely to:
      </p>
      <ul>
        <li style={S.li}>Compute free/busy availability across connected calendars.</li>
        <li style={S.li}>Create, update, or cancel events that {OWNER_FIRST_NAME} or a
          booking visitor schedules through this app.</li>
        <li style={S.li}>Display event details (title, time, attendees) inside the private,
          password-gated dashboard that only {OWNER_FIRST_NAME} can access.</li>
      </ul>
      <p style={S.p}>
        Calendar data is never sold, shared with advertisers, or used for any purpose
        other than operating this scheduling app. It is stored in a private database
        controlled by the operator of this instance — not a shared or third-party service.
      </p>

      <h2 style={S.h2}>2. Data from people who book time</h2>
      <p style={S.p}>
        Visitors using the public booking page provide a name, email address, and
        timezone. That information is used only to create the calendar event, send a
        confirmation/reminder, and — if the visitor uses the self-serve link — to let them
        reschedule or cancel their own booking. It is not shared with third parties beyond
        the service providers listed below, and not used for marketing.
      </p>

      <h2 style={S.h2}>3. Third-party services this app relies on</h2>
      <p style={S.p}>Depending on how this instance is configured, it may send data to:</p>
      <ul>
        <li style={S.li}><strong>Google Calendar API / Microsoft Graph</strong> — to read/write the connected calendars described above.</li>
        <li style={S.li}><strong>Anthropic (Claude)</strong> — to power the scheduling agent. Messages sent to the agent (and the calendar data needed to answer them) are processed by Anthropic&apos;s API to generate a response.</li>
        <li style={S.li}><strong>OpenAI (Whisper)</strong> — only if voice-note transcription is enabled, to convert an inbound voice message to text.</li>
        <li style={S.li}><strong>Twilio</strong> — only if SMS/WhatsApp is enabled, to send/receive text messages and reminders.</li>
        <li style={S.li}><strong>Resend</strong> — only if email is enabled, to send booking confirmations and reminders.</li>
      </ul>
      <p style={S.p}>
        Each of these is only contacted for the specific purpose above, and only when the
        operator has configured credentials for it.
      </p>

      <h2 style={S.h2}>4. Data retention and deletion</h2>
      <p style={S.p}>
        Booking and calendar data is retained for as long as this instance is operated, so
        that past bookings remain visible in history. A visitor or {OWNER_FIRST_NAME} can
        request deletion of a specific booking record by contacting the operator below.
        Disconnecting a calendar account revokes this app&apos;s access token with the
        provider immediately.
      </p>

      <h2 style={S.h2}>5. This is open-source software</h2>
      <p style={S.p}>
        The full source code for this application, including exactly how calendar data is
        read, stored, and used, is publicly available and MIT licensed at{" "}
        <a href="https://github.com/hunterZh37/agentic-scheduling">
          github.com/hunterZh37/agentic-scheduling
        </a>.
      </p>

      <h2 style={S.h2}>6. Contact</h2>
      <p style={S.p}>
        Questions about this policy or a request to delete your data can be sent to{" "}
        <a href={`mailto:${DEFAULT_DESTINATION_EMAIL}`}>{DEFAULT_DESTINATION_EMAIL}</a>.
      </p>
    </main>
  );
}
