import { describe, it, expect } from "vitest";
import { isMeetingLocation, locationHref, locationLabel } from "./maps";

const MAPS = "https://www.google.com/maps/search/?api=1&query=";

// The owner's real case: a provider (Kaiser's Zoom video visit) wrote the
// meeting link into the location field as MARKDOWN, so the URL sits mid-string.
const KAISER =
  "[Zoom video visit](https://healthy.kaiserpermanente.org/mychartcn/Visits/VisitDetails?csn=WP-24HYccGTfirWRcgXe897SVaw-3D-3D-248v3AEo4v2VJ-2BYbp-2B4nYUdvgc-2F6Rl4nHyP3qtxC-2FT6tI-3D)";
const KAISER_URL =
  "https://healthy.kaiserpermanente.org/mychartcn/Visits/VisitDetails?csn=WP-24HYccGTfirWRcgXe897SVaw-3D-3D-248v3AEo4v2VJ-2BYbp-2B4nYUdvgc-2F6Rl4nHyP3qtxC-2FT6tI-3D";

describe("locationHref", () => {
  it("opens a markdown meeting link at its URL, not a Maps search for it", () => {
    expect(locationHref(KAISER)).toBe(KAISER_URL);
  });

  it("opens a meeting URL that follows free text", () => {
    expect(locationHref("Zoom: https://zoom.us/j/123456?pwd=abc")).toBe(
      "https://zoom.us/j/123456?pwd=abc"
    );
  });

  it("drops sentence punctuation trailing an embedded URL", () => {
    expect(locationHref("Join at https://meet.google.com/abc-defg-hij.")).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
    expect(locationHref("Room 4 (https://zoom.us/j/1)")).toBe("https://zoom.us/j/1");
  });

  it("still links a bare URL and a www. host directly", () => {
    expect(locationHref("https://zoom.us/j/1")).toBe("https://zoom.us/j/1");
    expect(locationHref("  www.example.com/room ")).toBe("https://www.example.com/room");
  });

  it("still searches Maps for a place name or address", () => {
    expect(locationHref("1600 Amphitheatre Pkwy, Mountain View")).toBe(
      MAPS + encodeURIComponent("1600 Amphitheatre Pkwy, Mountain View")
    );
    expect(locationHref("Blue Bottle Coffee")).toBe(MAPS + encodeURIComponent("Blue Bottle Coffee"));
  });

  it("never turns a non-http scheme into the href", () => {
    // Location text comes from calendar invites, i.e. from other people. A
    // markdown link with a javascript: target must not become a clickable href.
    const evil = "[Join](javascript:alert(1))";
    expect(locationHref(evil)).toBe(MAPS + encodeURIComponent(evil));
  });
});

describe("locationLabel", () => {
  it("shows a markdown link's label instead of the raw markdown", () => {
    expect(locationLabel(KAISER)).toBe("Zoom video visit");
  });

  it("falls back to the URL when the markdown label is empty", () => {
    expect(locationLabel("[](https://zoom.us/j/1)")).toBe("https://zoom.us/j/1");
  });

  it("leaves ordinary locations untouched", () => {
    expect(locationLabel("Blue Bottle Coffee")).toBe("Blue Bottle Coffee");
    expect(locationLabel("Zoom: https://zoom.us/j/1")).toBe("Zoom: https://zoom.us/j/1");
  });

  it("does not unwrap a markdown link with an unsafe target", () => {
    expect(locationLabel("[Join](javascript:alert(1))")).toBe("[Join](javascript:alert(1))");
  });
});

describe("isMeetingLocation", () => {
  it("tells a meeting link from a place", () => {
    expect(isMeetingLocation(KAISER)).toBe(true);
    expect(isMeetingLocation("Zoom: https://zoom.us/j/1")).toBe(true);
    expect(isMeetingLocation("Blue Bottle Coffee")).toBe(false);
    expect(isMeetingLocation("[Join](javascript:alert(1))")).toBe(false);
  });
});
