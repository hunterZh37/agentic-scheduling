import { describe, it, expect } from "vitest";
import { ReminderRecipient } from "@prisma/client";
import {
  renderReminder,
  renderReminderDetail,
  renderBookingDescription,
  renderBookingDescriptionHtml,
  formatInZone,
} from "./render";

const start = new Date("2026-07-20T18:00:00Z");

describe("formatInZone", () => {
  it("renders a UTC instant in the target zone", () => {
    expect(formatInZone(start, "America/New_York")).toBe("Monday, Jul 20 at 2:00 PM EDT");
    expect(formatInZone(start, "America/Los_Angeles")).toBe("Monday, Jul 20 at 11:00 AM PDT");
  });
});

describe("renderReminder", () => {
  it("addresses the attendee and shows their local time", () => {
    const msg = renderReminder({
      title: "Torrey <> Alex",
      start,
      attendeeName: "Torrey",
      recipient: ReminderRecipient.attendee,
      timezone: "America/New_York",
    });
    expect(msg.subject).toBe("Reminder: Torrey <> Alex");
    expect(msg.text).toContain("Hi Torrey");
    expect(msg.text).toContain("2:00 PM EDT");
  });

  it("renders the owner's reminder in the owner's timezone", () => {
    const msg = renderReminder({
      title: "Torrey <> Alex",
      start,
      attendeeName: "Torrey",
      recipient: ReminderRecipient.hunter,
      timezone: "America/Los_Angeles",
    });
    expect(msg.text).toContain("with Torrey");
    expect(msg.text).toContain("11:00 AM PDT");
  });
});

describe("renderReminderDetail", () => {
  it("has no 'Reminder:' prefix and addresses the attendee in their local time", () => {
    const detail = renderReminderDetail({
      title: "Torrey <> Alex",
      start,
      attendeeName: "Torrey",
      recipient: ReminderRecipient.attendee,
      timezone: "America/New_York",
    });
    expect(detail).not.toMatch(/^Reminder:/);
    expect(detail).toBe('"Torrey <> Alex" with Alex on Monday, Jul 20 at 2:00 PM EDT');
  });

  it("addresses the owner with the attendee's name in the owner's local time", () => {
    const detail = renderReminderDetail({
      title: "Torrey <> Alex",
      start,
      attendeeName: "Torrey",
      recipient: ReminderRecipient.hunter,
      timezone: "America/Los_Angeles",
    });
    expect(detail).not.toMatch(/^Reminder:/);
    expect(detail).toBe('"Torrey <> Alex" with Torrey on Monday, Jul 20 at 11:00 AM PDT');
  });

  it("collapses whitespace to a single line", () => {
    const detail = renderReminderDetail({
      title: "Line1\nLine2\tTabbed",
      start,
      attendeeName: "Torrey",
      recipient: ReminderRecipient.hunter,
      timezone: "America/Los_Angeles",
    });
    expect(detail).not.toContain("\n");
    expect(detail).not.toContain("\t");
    expect(detail).toBe('"Line1 Line2 Tabbed" with Torrey on Monday, Jul 20 at 11:00 AM PDT');
  });
});

describe("renderBookingDescription", () => {
  it("summarizes the booking for the attendee in their local time", () => {
    const text = renderBookingDescription({
      start,
      end: new Date("2026-07-20T18:30:00Z"),
      attendeeName: "Torrey Fields",
      hostName: "Alex Rivera",
      timezone: "America/New_York",
      linkedinUrl: "https://www.linkedin.com/in/example/",
      videoUrl: "https://meet.example.com/abc-defg-hij",
    });
    // First name only, duration, day, and start–end window in the attendee zone.
    expect(text).toContain("Hi Torrey,");
    expect(text).toContain("Join the video call: https://meet.example.com/abc-defg-hij");
    // Body uses the short name; full name is reserved for the signature.
    expect(text).toContain("30-minute meeting with Alex is confirmed");
    expect(text).not.toContain("meeting with Alex Rivera");
    expect(text).toContain("When: Monday, Jul 20");
    expect(text).toContain("Time: 2:00 PM – 2:30 PM EDT");
    expect(text).toContain("Looking forward to speaking with you!");
    // Professional signature with the full name + LinkedIn link.
    expect(text).toContain("Best,\nAlex Rivera");
    expect(text).toContain("LinkedIn: https://www.linkedin.com/in/example/");
  });

  it("a JOINT booking says the meeting is with the team and signs off from every host", () => {
    const text = renderBookingDescription({
      start,
      end: new Date("2026-07-20T18:30:00Z"),
      attendeeName: "Torrey Fields",
      hostName: "Alex Rivera", // owner — must NOT be the sole signer here
      timezone: "America/New_York",
      hostLabel: "Ben & Hunter",
      hosts: [
        { name: "Hunter Zhang", linkedin: "https://www.linkedin.com/in/hunterzhang37/" },
        { name: "Ben Brooks", linkedin: "https://www.linkedin.com/in/ben" },
      ],
    });
    expect(text).toContain("meeting with Ben & Hunter is confirmed");
    expect(text).toContain("Best,\nHunter Zhang · https://www.linkedin.com/in/hunterzhang37/");
    expect(text).toContain("Ben Brooks · https://www.linkedin.com/in/ben");
    // The single-owner signature is not used for a joint booking.
    expect(text).not.toContain("meeting with Alex");
  });

  it("omits the LinkedIn line when no url is given", () => {
    const text = renderBookingDescription({
      start,
      end: new Date("2026-07-20T18:30:00Z"),
      attendeeName: "Torrey",
      hostName: "Alex Rivera",
      timezone: "America/New_York",
    });
    expect(text).not.toContain("LinkedIn:");
    expect(text.trimEnd().endsWith("Alex Rivera")).toBe(true);
  });
});

describe("renderBookingDescriptionHtml", () => {
  it("bolds the key details and links LinkedIn", () => {
    const html = renderBookingDescriptionHtml({
      start,
      end: new Date("2026-07-20T18:30:00Z"),
      attendeeName: "Torrey Fields",
      hostName: "Alex Rivera",
      timezone: "America/New_York",
      linkedinUrl: "https://www.linkedin.com/in/example/",
      videoUrl: "https://meet.example.com/abc-defg-hij",
    });
    expect(html).toContain("Hi <strong>Torrey</strong>,");
    expect(html).toContain('<strong>Join:</strong> <a href="https://meet.example.com/abc-defg-hij">');
    expect(html).toContain("<strong>30-minute</strong>");
    // Short name in the body, full name only in the signature.
    expect(html).toContain("meeting with <strong>Alex</strong> is confirmed");
    expect(html).toContain("Best,<br><strong>Alex Rivera</strong>");
    expect(html).toContain("<strong>When:</strong> Monday, Jul 20");
    expect(html).toContain("<strong>Time:</strong> 2:00 PM – 2:30 PM EDT");
    expect(html).toContain('<a href="https://www.linkedin.com/in/example/">');
  });

  it("escapes HTML in the attendee name", () => {
    const html = renderBookingDescriptionHtml({
      start,
      end: new Date("2026-07-20T18:30:00Z"),
      attendeeName: "<script>evil</script>",
      hostName: "Alex Rivera",
      timezone: "UTC",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
