import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The booking detail panel now matches events and actionables: the same Edit
// button in the header, with "Cancel booking" moved into edit mode. Saving a
// time change reschedules — which re-invites the attendee. (2026-08-20; the
// panel previously showed a bare header "Cancel booking" and was non-editable.)
//
// SOURCE-level checks because the modal has no render harness in this repo. Each
// assertion is one thing that, if it silently stopped being true, would break
// the booking popover's consistency with the others.
const src = readFileSync(join(__dirname, "EventModal.tsx"), "utf8");

describe("the booking detail panel is standardized with events/actionables", () => {
  it("recognises the booking kind", () => {
    expect(src).toMatch(/const isBooking = item\.kind === "booking"/);
  });

  it("makes a booking editable like every other kind (Edit button in header)", () => {
    expect(src).toMatch(/canEdit =[\s\S]{0,90}\|\| isBooking/);
  });

  it("puts Cancel booking in edit mode, not as a second header button", () => {
    expect(src).toMatch(/isBooking \? "Cancel booking" : "Delete"/);
    // The old header-level cancel button is gone.
    expect(src).not.toMatch(/className=\{styles\.cancelTop\}/);
  });

  it("saves a booking time change through the reschedule endpoint", () => {
    // A booking edit routes to PATCH /api/bookings/[id] (rescheduleBooking),
    // which re-invites the attendee — not the event PATCH.
    expect(src).toMatch(/isBooking\)[\s\S]{0,300}fetch\(`\/api\/bookings\/\$\{encodeURIComponent\(providerId\)\}`[\s\S]{0,200}method: "PATCH"/);
  });

  it("still cancels through the booking DELETE endpoint", () => {
    expect(src).toMatch(/fetch\(`\/api\/bookings\/\$\{encodeURIComponent\(providerId\)\}`/);
    expect(src).toMatch(/method: "DELETE"/);
  });

  it("strips the booking: prefix, so the id sent is the booking's own", () => {
    expect(src).toMatch(/\^\(event\|actionable\|booking\):/);
  });

  it("cancel confirms first, naming who gets emailed", () => {
    expect(src).toMatch(/Cancel this booking\?/);
    expect(src).toMatch(/will be emailed that/);
  });

  it("a move confirm tells the owner the attendee will be re-invited", () => {
    expect(src).toMatch(/get an updated calendar invite/);
  });

  it("does not offer a don't-notify choice for a booking cancel", () => {
    // cancelBooking always emails the attendee — the option would be a lie.
    expect(src).toMatch(/No "don't notify" here/);
    const cancelBranch = src.slice(
      src.indexOf('isBooking && confirm === "delete" ? ('),
      src.indexOf(") : isBooking ? (")
    );
    expect(cancelBranch).not.toMatch(/Don&rsquo;t notify/);
  });

  it("refreshes the schedule and closes on cancel success", () => {
    const fn = src.slice(src.indexOf("const doCancelBooking"), src.indexOf("// Button entry points"));
    expect(fn).toMatch(/onChanged\?\.\(\)/);
    expect(fn).toMatch(/onClose\(\)/);
  });
});
