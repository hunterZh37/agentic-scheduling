import { describe, it, expect } from "vitest";
import { renderInviteDescription, renderInviteDescriptionHtml, footerLines, footerHtml } from "./invite";
import { renderBookingDescription, renderBookingDescriptionHtml } from "./render";

// Alex sends calendar invites (owner, 2026-09-24): the body says WHERE the
// meeting is (a place for in person, the room link for online), and every
// invite the app writes, Alex's or a visitor booking's, ends with the same
// footer: consulting site, GitHub profile, research site.

const links = {
  consulting: "https://hunterzhangconsulting.com",
  github: "https://github.com/hunterZh37",
  research: "https://www.protocolz.org/",
  linkedin: "https://www.linkedin.com/in/example/",
};
const base = {
  title: "Product review",
  start: new Date("2026-10-02T17:00:00.000Z"), // 10:00 AM Pacific
  end: new Date("2026-10-02T17:45:00.000Z"),
  hostName: "Alex Rivera",
  timezone: "America/Los_Angeles",
  attendeeNames: ["Torrey Fields"],
  links,
};

describe("footer", () => {
  it("lists consulting, GitHub and research, in that order, as plain URLs", () => {
    expect(footerLines(links)).toEqual([
      "Consulting: https://hunterzhangconsulting.com",
      "GitHub: https://github.com/hunterZh37",
      "Research: https://www.protocolz.org/",
    ]);
  });
  it("skips a link that is not configured", () => {
    expect(footerLines({ ...links, github: "" })).toEqual([
      "Consulting: https://hunterzhangconsulting.com",
      "Research: https://www.protocolz.org/",
    ]);
  });
  it("renders the same three as anchors in HTML", () => {
    const h = footerHtml(links);
    expect(h).toContain('<a href="https://github.com/hunterZh37">');
    expect(h).toContain("Research:");
    expect(h).not.toContain("<script");
  });
});

describe("renderInviteDescription", () => {
  it("in person: shows the place under Where and no join link", () => {
    const t = renderInviteDescription({ ...base, meeting: "in_person", location: "Blue Bottle, 66 Mint St" });
    expect(t).toContain("Hi Torrey,");
    expect(t).toContain("Product review with Alex");
    expect(t).toContain("When: Friday, Oct 2");
    expect(t).toContain("Time: 10:00 AM – 10:45 AM PDT");
    expect(t).toContain("Where: Blue Bottle, 66 Mint St");
    expect(t).not.toMatch(/Join/);
    expect(t).toContain("GitHub: https://github.com/hunterZh37");
  });

  it("online: shows the join link and no place", () => {
    const t = renderInviteDescription({ ...base, meeting: "online", videoUrl: "https://zoom.us/j/1" });
    expect(t).toContain("Join online: https://zoom.us/j/1");
    expect(t).not.toMatch(/Where:/);
  });

  it("greets a few guests by name, everyone past three, and includes a note", () => {
    const t = renderInviteDescription({ ...base, attendeeNames: ["Torrey Fields", "Sam Lee"], meeting: "online", videoUrl: "https://zoom.us/j/1", note: "Bring the Q3 numbers." });
    expect(t).toContain("Hi Torrey and Sam,");
    expect(t).toContain("Bring the Q3 numbers.");
    expect(renderInviteDescription({ ...base, attendeeNames: ["A B", "C D", "E F"], meeting: "online", videoUrl: "https://zoom.us/j/1" })).toContain("Hi A, C and E,");
    expect(renderInviteDescription({ ...base, attendeeNames: ["A B", "C D", "E F", "G H"], meeting: "online", videoUrl: "https://zoom.us/j/1" })).toContain("Hi all,");
  });

  it("falls back to a plain greeting when no name is known", () => {
    const t = renderInviteDescription({ ...base, attendeeNames: [], meeting: "online", videoUrl: "https://zoom.us/j/1" });
    expect(t).toMatch(/^Hi,\n/);
  });

  it("HTML: escapes user text and links the join URL and footer", () => {
    const h = renderInviteDescriptionHtml({ ...base, title: "<b>x</b>", meeting: "online", videoUrl: "https://zoom.us/j/1" });
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(h).toContain('<a href="https://zoom.us/j/1">');
    expect(h).toContain('<a href="https://www.protocolz.org/">');
    expect(h).toContain(`LinkedIn: <a href="${links.linkedin}">`);
  });
});

describe("booking invites carry the same footer", () => {
  const booking = {
    start: base.start,
    end: base.end,
    attendeeName: "Torrey Fields",
    hostName: "Alex Rivera",
    timezone: "America/Los_Angeles",
    linkedinUrl: links.linkedin,
    footer: links,
  };
  it("plain text ends with the footer after the signature", () => {
    const t = renderBookingDescription(booking);
    const sig = t.indexOf("Alex Rivera");
    const foot = t.indexOf("Consulting: https://hunterzhangconsulting.com");
    expect(sig).toBeGreaterThan(-1);
    expect(foot).toBeGreaterThan(sig);
    expect(t).toContain("Research: https://www.protocolz.org/");
  });
  it("HTML includes the footer anchors", () => {
    const h = renderBookingDescriptionHtml(booking);
    expect(h).toContain('<a href="https://github.com/hunterZh37">');
  });
  it("without a footer the booking text is unchanged in shape", () => {
    const t = renderBookingDescription({ ...booking, footer: undefined });
    expect(t).not.toMatch(/Consulting:/);
  });
});
