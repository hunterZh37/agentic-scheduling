import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/oauth/store", () => ({ getValidAccessToken: vi.fn(async () => "tok") }));
vi.mock("@/lib/env", () => ({ optionalEnv: vi.fn(() => undefined) }));

import { createDestinationEvent } from "./write";
import { Provider } from "@prisma/client";

// An event created through this app carried title, time, location and attendees
// and nothing else, so meetings went out with no way to join them. Google
// ignores conferenceData unless conferenceDataVersion=1 is on the URL — and
// ignores it SILENTLY, returning a normal event with no link and no error,
// which is why this needs a test rather than a manual check.

const googleAccount = { provider: Provider.google } as never;
const msAccount = { provider: Provider.microsoft } as never;

const draft = {
  title: "Abraham & Camilo <> Hunter",
  start: new Date("2026-08-10T20:00:00Z"),
  end: new Date("2026-08-10T21:00:00Z"),
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Mirror the providers: a link comes back only when one was actually asked
  // for. A mock that always returns a link would hide the very bug this covers.
  fetchMock = vi.fn(async (url: string, init: { body: string }) => {
    const requested =
      String(url).includes("conferenceDataVersion=1") ||
      JSON.parse(init.body).isOnlineMeeting === true;
    return {
      ok: true,
      json: async () => ({
        id: "evt_1",
        ...(requested
          ? {
              hangoutLink: "https://meet.google.com/abc-defg-hij",
              onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/xyz" },
            }
          : {}),
      }),
      text: async () => "",
    };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const lastCall = () => {
  const [url, init] = fetchMock.mock.calls[0];
  return { url: String(url), body: JSON.parse((init as { body: string }).body) };
};

describe("Google Meet", () => {
  it("sets conferenceDataVersion=1, without which Google silently ignores the request", async () => {
    await createDestinationEvent(googleAccount, { ...draft, conference: true });
    expect(lastCall().url).toContain("conferenceDataVersion=1");
  });

  it("asks for a hangoutsMeet room with a dedupe id", async () => {
    await createDestinationEvent(googleAccount, { ...draft, conference: true });
    const { body } = lastCall();
    expect(body.conferenceData.createRequest.conferenceSolutionKey.type).toBe("hangoutsMeet");
    // A caller-supplied requestId is what stops a retried create minting a
    // second room for the same meeting.
    expect(body.conferenceData.createRequest.requestId).toMatch(/[0-9a-f-]{36}/);
  });

  it("returns the link so the agent can hand it over", async () => {
    const out = await createDestinationEvent(googleAccount, { ...draft, conference: true });
    expect(out.id).toBe("evt_1");
    expect(out.videoLink).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("asks for nothing when conference is not requested", async () => {
    const out = await createDestinationEvent(googleAccount, draft);
    const { url, body } = lastCall();
    expect(url).not.toContain("conferenceDataVersion");
    expect(body.conferenceData).toBeUndefined();
    expect(out.videoLink).toBeUndefined();
  });
});

describe("Microsoft Teams", () => {
  it("requests a Teams meeting and returns its join URL", async () => {
    const out = await createDestinationEvent(msAccount, { ...draft, conference: true });
    const { body } = lastCall();
    expect(body.isOnlineMeeting).toBe(true);
    expect(body.onlineMeetingProvider).toBe("teamsForBusiness");
    expect(out.videoLink).toBe("https://teams.microsoft.com/l/meetup-join/xyz");
  });

  it("stays a plain event otherwise", async () => {
    await createDestinationEvent(msAccount, draft);
    expect(lastCall().body.isOnlineMeeting).toBeUndefined();
  });
});

describe("callers get an object, not a bare id", () => {
  // tsc cannot catch this: every call site did JSON.stringify({ eventId }),
  // which happily serialises an object, so the API would have started returning
  // eventId as {id,videoLink} with no compile error at all.
  it("returns { id, videoLink }", async () => {
    const out = await createDestinationEvent(googleAccount, { ...draft, conference: true });
    expect(Object.keys(out).sort()).toEqual(["id", "videoLink"]);
    expect(out.videoLink).toBeTruthy();
    expect(typeof out.id).toBe("string");
  });
});
