import { BookingPage } from "@/components/booking/BookingPage";
import { HOST, OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";
import { optionalEnv } from "@/lib/env";

export const metadata = {
  title: `Book time with ${OWNER_FIRST_NAME}`,
  description:
    `Book a consulting session with ${OWNER_FIRST_NAME} at ${HOST.practice.name}: ` +
    `${HOST.practice.fields}.`,
};

// Public booking page — anyone can reach this; only free/busy is ever exposed.
// `?preview=1` (set by the dashboard's "Preview booking page" link) reveals a
// "Back to dashboard" control; ordinary visitors never get it.
export default async function Book({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string; reschedule?: string; t?: string }>;
}) {
  const { preview, reschedule, t } = await searchParams;
  // Shown in the no-JS fallback so a visitor can still reach the owner. Comes
  // from env so the repo carries no personal address.
  const contactEmail = optionalEnv("OWNER_EMAIL") ?? optionalEnv("HUNTER_EMAIL");
  return (
    <>
      {/* The booking UI is client-rendered: it needs the visitor's timezone
          before it can show a single slot. So without this block the served
          HTML has no text in it at all, and a crawler that does not run JS sees
          a blank page — which is how a four-week-old domain gets rated Phishing
          by a classifier that never saw the content we kept pointing it at.
          This is the genuine no-JS fallback, and it says the same things the
          rendered page does. Keep it truthful: it is what reviewers read.
          See docs/REGRESSIONS.md. */}
      <noscript>
        <h1>Book time with {HOST.name}</h1>
        <p>
          This is the booking page for {HOST.practice.name}, the personal consulting practice of{" "}
          {HOST.name} at <a href={HOST.practice.url}>{HOST.practice.domain}</a> — consulting across{" "}
          {HOST.practice.fields}. Pick a length and an open time, and you will get a calendar
          invite with a video link. Only free/busy time is shown — never the details of anything
          on the calendar.
        </p>
        <p>
          Booking takes a name and an email address, which are used to send the invite. There is
          nothing to download, nothing to pay, and no account to create.
        </p>
        <p>
          Choosing a time needs JavaScript, because the times are shown in your own timezone.
          {contactEmail ? (
            <>
              {" "}If you would rather not enable it, email{" "}
              <a href={`mailto:${contactEmail}`}>{contactEmail}</a> and {OWNER_FIRST_NAME} will
              arrange a time directly.
            </>
          ) : (
            <> If you would rather not enable it, use the security contact below to arrange a
              time directly.</>
          )}
        </p>
        <p>
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> ·{" "}
          <a href="/.well-known/security.txt">Security contact</a>
        </p>
      </noscript>
      <BookingPage
        preview={preview === "1"}
        reschedule={reschedule && t ? { id: reschedule, token: t } : undefined}
      />
    </>
  );
}
