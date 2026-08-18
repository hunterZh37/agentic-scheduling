import { DateTime } from "luxon";
import { ReminderRecipient } from "@prisma/client";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";

export interface RenderInput {
  title: string;
  start: Date; // UTC
  attendeeName: string;
  recipient: ReminderRecipient;
  /// Timezone to render the time in (the recipient's own zone).
  timezone: string;
}

export interface RenderedMessage {
  subject: string;
  text: string;
}

/// Format a UTC instant in a given zone, e.g. "Monday, Jul 20 at 2:00 PM EDT".
export function formatInZone(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: "utc" })
    .setZone(timezone)
    .toFormat("EEEE, MMM d 'at' h:mm a ZZZZ");
}

/// Plain-text body for a booking's calendar event. This is what the attendee
/// reads inside the provider invite (the .ics email), which otherwise arrives
/// with no message at all. Times are shown in the attendee's own zone; kept
/// short and plain-text so it renders identically on Outlook, Gmail, and Apple
/// Mail (no HTML). Pure and unit-testable.
export function renderBookingDescription(input: {
  start: Date;
  end: Date;
  attendeeName: string;
  hostName: string;
  timezone: string;
  /// Optional LinkedIn URL appended to the professional signature.
  linkedinUrl?: string;
  /// Optional self-serve manage link; when present, replaces "reply to the owner".
  manageUrl?: string;
  /// Optional video-call join link, shown as a "Join" line.
  videoUrl?: string;
}): string {
  const startLocal = DateTime.fromJSDate(input.start, { zone: "utc" }).setZone(input.timezone);
  const endLocal = DateTime.fromJSDate(input.end, { zone: "utc" }).setZone(input.timezone);
  const day = startLocal.toFormat("EEEE, MMM d");
  const window = `${startLocal.toFormat("h:mm a")} – ${endLocal.toFormat("h:mm a ZZZZ")}`;
  const minutes = Math.round(endLocal.diff(startLocal, "minutes").minutes);
  const first = input.attendeeName.trim().split(/\s+/)[0] || input.attendeeName.trim();
  // Friendly first name in the body; full name only in the signature.
  const hostFirst = input.hostName.trim().split(/\s+/)[0] || input.hostName.trim();
  const manageLine = input.manageUrl
    ? `Need to reschedule or cancel? Manage your booking here:\n${input.manageUrl}`
    : `It's on your calendar now. Need to reschedule or cancel? Just reply and ${hostFirst} will sort it out.`;
  const lines = [
    `Hi ${first},`,
    ``,
    `Your ${minutes}-minute meeting with ${hostFirst} is confirmed.`,
    ``,
    `When: ${day}`,
    `Time: ${window}`,
    ...(input.videoUrl ? [`Join the video call: ${input.videoUrl}`] : []),
    ``,
    manageLine,
    ``,
    `Looking forward to speaking with you!`,
    ``,
    // Professional sign-off. Plain-text URL so every mail client linkifies it.
    `Best,`,
    input.hostName,
  ];
  if (input.linkedinUrl) lines.push(`LinkedIn: ${input.linkedinUrl}`);
  return lines.join("\n");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/// HTML version of the booking description, for the calendar invite body. Adds
/// real visual hierarchy — bold labels and key details — that plain text can't.
/// Uses only <br>, <strong>, <a> and an inline-styled wrapper so it renders
/// consistently across Gmail, Outlook, and Apple Mail (which strip <style>
/// blocks and most block-level CSS). Google/Microsoft both accept this as the
/// event body. Pure. See renderBookingDescription for the plain-text fallback.
export function renderBookingDescriptionHtml(input: {
  start: Date;
  end: Date;
  attendeeName: string;
  hostName: string;
  timezone: string;
  linkedinUrl?: string;
  manageUrl?: string;
  videoUrl?: string;
}): string {
  const startLocal = DateTime.fromJSDate(input.start, { zone: "utc" }).setZone(input.timezone);
  const endLocal = DateTime.fromJSDate(input.end, { zone: "utc" }).setZone(input.timezone);
  const day = escapeHtml(startLocal.toFormat("EEEE, MMM d"));
  const timeRange = escapeHtml(
    `${startLocal.toFormat("h:mm a")} – ${endLocal.toFormat("h:mm a ZZZZ")}`
  );
  const minutes = Math.round(endLocal.diff(startLocal, "minutes").minutes);
  const first = escapeHtml(input.attendeeName.trim().split(/\s+/)[0] || input.attendeeName.trim());
  const host = escapeHtml(input.hostName);
  // Friendly first name in the body; full name only in the signature.
  const hostFirst = escapeHtml(input.hostName.trim().split(/\s+/)[0] || input.hostName.trim());
  const link = input.linkedinUrl
    ? `<br>LinkedIn: <a href="${escapeHtml(input.linkedinUrl)}">${escapeHtml(input.linkedinUrl)}</a>`
    : "";
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">` +
    `Hi <strong>${first}</strong>,<br><br>` +
    `Your <strong>${minutes}-minute</strong> meeting with <strong>${hostFirst}</strong> is confirmed.<br><br>` +
    `<strong>When:</strong> ${day}<br>` +
    `<strong>Time:</strong> ${timeRange}<br>` +
    (input.videoUrl
      ? `<strong>Join:</strong> <a href="${escapeHtml(input.videoUrl)}">${escapeHtml(input.videoUrl)}</a><br>`
      : "") +
    `<br>` +
    (input.manageUrl
      ? `Need to reschedule or cancel? <a href="${escapeHtml(input.manageUrl)}">Manage your booking</a>.<br><br>`
      : `It's on your calendar now. Need to reschedule or cancel? Just reply and <strong>${hostFirst}</strong> will sort it out.<br><br>`) +
    `Looking forward to speaking with you!<br><br>` +
    `Best,<br><strong>${host}</strong>${link}` +
    `</div>`
  );
}

/// Single-line reminder detail, without a leading "Reminder:" prefix — meant to
/// fill a WhatsApp approved-template variable (e.g. {{1}}), which can't contain
/// newlines. Whitespace is collapsed so a stray tab/newline in a title can't
/// break the template. Pure — same recipient-aware phrasing as renderReminder.
export function renderReminderDetail(input: RenderInput): string {
  const when = formatInZone(input.start, input.timezone);
  const text =
    input.recipient === ReminderRecipient.hunter
      ? `"${input.title}" with ${input.attendeeName} on ${when}`
      : `"${input.title}" with ${OWNER_FIRST_NAME} on ${when}`;
  return text.replace(/\s+/g, " ").trim();
}

/// Render a reminder for a recipient. Pure — the time is always shown in the
/// recipient's own timezone so both parties read it correctly.
export function renderReminder(input: RenderInput): RenderedMessage {
  const when = formatInZone(input.start, input.timezone);
  const subject = `Reminder: ${input.title}`;
  const text =
    input.recipient === ReminderRecipient.hunter
      ? `Reminder: "${input.title}" with ${input.attendeeName} on ${when}.`
      : `Hi ${input.attendeeName}, this is a reminder for "${input.title}" with ${OWNER_FIRST_NAME} on ${when}. See you then!`;
  return { subject, text };
}
