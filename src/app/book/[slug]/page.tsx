import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { BookingPage } from "@/components/booking/BookingPage";
import { HOST } from "@/lib/booking/publicConfig";
import { optionalEnv } from "@/lib/env";
import { teamForSlug, firstNamesLabel } from "@/lib/teams/resolve";

// A JOINT booking page: /book/<team-slug>. Offers only the times when EVERY
// member (the owner and the team's co-hosts) is free. Public; only free/busy is
// ever exposed, never anyone's calendar content.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const team = await teamForSlug(slug);
  if (!team) return { title: "Booking link not found" };
  // Name the PEOPLE (co-hosts first), not the team's internal name — matches the
  // OG card, the booking title, and the emails.
  const label = firstNamesLabel([...team.coHosts.map((c) => c.name), HOST.name]);
  const title = `Book time with ${label}`;
  const description = `A shared booking link for ${label}. Pick a time that works for everyone and get a calendar invite.`;
  return {
    // `absolute` bypasses the site-wide "· Book with <owner>" title template, so
    // the joint page reads as the team's, not the owner's.
    title: { absolute: title },
    description,
    openGraph: { title, description },
    twitter: { title, description },
  };
}

export default async function TeamBook({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const team = await teamForSlug(slug);
  if (!team) notFound();

  // Co-hosts first, then the owner. Each name links to their LinkedIn when set.
  const members = [
    ...team.coHosts.map((c) => ({ name: c.name, linkedin: c.linkedin ?? undefined })),
    { name: HOST.name, linkedin: HOST.linkedin || undefined },
  ];
  const memberNames = members.map((m) => m.name);
  const contactEmail = optionalEnv("OWNER_EMAIL") ?? optionalEnv("HUNTER_EMAIL");

  return (
    <>
      {/* No-JS fallback carrying the same truthful identity the rendered page
          shows — reputation crawlers do not run JS. Mirrors /book. See
          docs/REGRESSIONS.md. */}
      <noscript>
        <h1>Book time with {team.name}</h1>
        <p>
          This is a shared booking page for {memberNames.join(" and ")}. It offers only the
          times when everyone is free, so you can pick one open slot that works for the whole
          group. You will get a calendar invite with a video link. Only free/busy time is shown,
          never the details of anything on anyone&apos;s calendar.
        </p>
        <p>
          It is operated by {HOST.name} at <a href={HOST.practice.url}>{HOST.practice.domain}</a>.
          Booking takes a name and an email address, used to send the invite. There is nothing to
          download, nothing to pay, and no account to create.
        </p>
        <p>
          Choosing a time needs JavaScript, because the times are shown in your own timezone.
          {contactEmail ? (
            <>
              {" "}If you would rather not enable it, email{" "}
              <a href={`mailto:${contactEmail}`}>{contactEmail}</a> to arrange a time directly.
            </>
          ) : (
            <> If you would rather not enable it, use the security contact below to arrange a time
              directly.</>
          )}
        </p>
        <p>
          <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> ·{" "}
          <a href="/.well-known/security.txt">Security contact</a>
        </p>
      </noscript>
      <BookingPage
        team={{
          slug: team.slug,
          name: team.name,
          eventTitle: team.eventTitle,
          videoLink: team.videoLink,
          durationOptionsMinutes: team.durationOptionsMinutes,
          members,
        }}
      />
    </>
  );
}
