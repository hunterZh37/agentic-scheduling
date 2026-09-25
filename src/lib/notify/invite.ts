import { DateTime } from "luxon";
import { escapeHtml } from "./render";

/// Calendar invites Alex sends on the owner's behalf (owner, 2026-09-24), and
/// the footer every invite the app writes now ends with. Pure: the callers
/// supply the names and links, so this renders the same from the agent, the
/// booking page and tests.

export interface FooterLinks {
  consulting?: string;
  github?: string;
  research?: string;
  /// Shown in the signature line, not the footer, as before.
  linkedin?: string;
}

/// "Consulting: <url>" lines, in a fixed order, skipping anything unset.
export function footerLines(links: FooterLinks): string[] {
  const rows: [string, string | undefined][] = [
    ["Consulting", links.consulting],
    ["GitHub", links.github],
    ["Research", links.research],
  ];
  return rows.filter(([, url]) => !!url?.trim()).map(([label, url]) => `${label}: ${url!.trim()}`);
}

export function footerHtml(links: FooterLinks): string {
  const rows: [string, string | undefined][] = [
    ["Consulting", links.consulting],
    ["GitHub", links.github],
    ["Research", links.research],
  ];
  return rows
    .filter(([, url]) => !!url?.trim())
    .map(([label, url]) => {
      const u = escapeHtml(url!.trim());
      return `${label}: <a href="${u}">${u}</a>`;
    })
    .join("<br>");
}

export interface InviteInput {
  title: string;
  start: Date;
  end: Date;
  hostName: string;
  /// The zone the times are written in: the owner's, since the owner is the
  /// one writing the invite and the guests may be anywhere.
  timezone: string;
  /// Guest names the owner gave, for the greeting. Empty = "Hi,".
  attendeeNames: string[];
  meeting: "in_person" | "online";
  /// In person: the place. Required for meeting = in_person.
  location?: string;
  /// Online: the room link. Required for meeting = online.
  videoUrl?: string;
  /// Optional agenda or context from the owner, verbatim.
  note?: string;
  links: FooterLinks;
}

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full.trim();
}

/// "Hi Torrey," / "Hi Torrey and Sam," / "Hi Torrey, Sam and Lee," up to
/// three names; more than that (or none known) is "Hi all," / "Hi,".
function greeting(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean).map(firstName);
  if (clean.length === 0) return "Hi,";
  if (clean.length === 1) return `Hi ${clean[0]},`;
  if (clean.length <= 3) return `Hi ${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]},`;
  return "Hi all,";
}

function whenLines(input: InviteInput): { day: string; window: string } {
  const s = DateTime.fromJSDate(input.start, { zone: "utc" }).setZone(input.timezone);
  const e = DateTime.fromJSDate(input.end, { zone: "utc" }).setZone(input.timezone);
  return { day: s.toFormat("EEEE, MMM d"), window: `${s.toFormat("h:mm a")} – ${e.toFormat("h:mm a ZZZZ")}` };
}

/// Plain-text invite body. The place OR the join link, never both: the
/// meeting is one or the other, and a guest should not have to guess.
export function renderInviteDescription(input: InviteInput): string {
  const { day, window } = whenLines(input);
  const host = firstName(input.hostName);
  const where =
    input.meeting === "in_person"
      ? `Where: ${input.location?.trim() ?? ""}`
      : `Join online: ${input.videoUrl?.trim() ?? ""}`;
  const lines = [
    greeting(input.attendeeNames),
    ``,
    `You're invited: ${input.title.trim()} with ${host}.`,
    ``,
    `When: ${day}`,
    `Time: ${window}`,
    where,
    ...(input.note?.trim() ? [``, input.note.trim()] : []),
    ``,
    `Need a different time? Just reply and ${host} will sort it out.`,
    ``,
    `Best,`,
    input.hostName,
    ...(input.links.linkedin ? [`LinkedIn: ${input.links.linkedin}`] : []),
    ``,
    ...footerLines(input.links),
  ];
  return lines.join("\n");
}

/// HTML twin, same content, for mail clients that render the body. Only
/// <br>, <strong>, <a> and an inline-styled wrapper, like the booking body.
export function renderInviteDescriptionHtml(input: InviteInput): string {
  const { day, window } = whenLines(input);
  const host = escapeHtml(firstName(input.hostName));
  const where =
    input.meeting === "in_person"
      ? `<strong>Where:</strong> ${escapeHtml(input.location?.trim() ?? "")}`
      : (() => {
          const u = escapeHtml(input.videoUrl?.trim() ?? "");
          return `<strong>Join online:</strong> <a href="${u}">${u}</a>`;
        })();
  const note = input.note?.trim() ? `<br>${escapeHtml(input.note.trim())}<br>` : "";
  const linkedin = input.links.linkedin
    ? `<br>LinkedIn: <a href="${escapeHtml(input.links.linkedin)}">${escapeHtml(input.links.linkedin)}</a>`
    : "";
  const footer = footerHtml(input.links);
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">` +
    `${escapeHtml(greeting(input.attendeeNames))}<br><br>` +
    `You're invited: <strong>${escapeHtml(input.title.trim())}</strong> with <strong>${host}</strong>.<br><br>` +
    `<strong>When:</strong> ${escapeHtml(day)}<br>` +
    `<strong>Time:</strong> ${escapeHtml(window)}<br>` +
    `${where}<br>` +
    note +
    `<br>Need a different time? Just reply and <strong>${host}</strong> will sort it out.<br><br>` +
    `Best,<br><strong>${escapeHtml(input.hostName)}</strong>${linkedin}` +
    (footer ? `<br><br>${footer}` : "") +
    `</div>`
  );
}
