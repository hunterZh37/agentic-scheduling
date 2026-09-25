import { describe, it, expect, vi, beforeEach } from "vitest";

// Alex sends calendar invites (owner, 2026-09-24). Pinned: guests become
// attendees on the provider event; in person means the place is the location
// and there is no join link; online means the owner's fixed room is the
// location and the join link, with no provider-minted conference; the body
// says where and ends with the footer; and an online invite with no room
// configured is refused rather than sent without a way to join.

const created = vi.fn();
vi.mock("@/lib/calendar/write", () => ({ createDestinationEvent: (...a: unknown[]) => created(...a) }));
vi.mock("@/lib/db", () => ({ prisma: { account: { findFirst: vi.fn(async () => ({ id: "a1", email: "owner@example.com", refreshToken: "r", accessToken: "a", isDestination: true })), findUnique: vi.fn() } } }));
vi.mock("@/lib/clientConfig", () => ({ OWNER_TIMEZONE: "America/Los_Angeles" }));
vi.mock("@/lib/booking/publicConfig", async (orig) => {
  const real = (await orig()) as { HOST: Record<string, unknown>; OWNER_FIRST_NAME: string };
  return { ...real, HOST: { ...real.HOST, videoLink: "https://zoom.us/j/fixed", githubUrl: "https://github.com/hunterZh37" } };
});

import { createEventTool } from "./tools";

const run = async (input: unknown) =>
  JSON.parse(await (createEventTool() as unknown as { run: (i: unknown) => Promise<string> }).run(input));
const base = { title: "Product review", startISO: "2026-10-02T17:00:00.000Z", endISO: "2026-10-02T17:45:00.000Z" };

beforeEach(() => {
  created.mockReset().mockResolvedValue({ id: "evt1" });
});

describe("create_event with guests", () => {
  it("in person: guests are attendees, the place is the location, body says Where, footer present", async () => {
    const r = await run({ ...base, attendees: [{ email: "t@example.com", name: "Torrey Fields" }, { email: "s@example.com" }], meeting: "in_person", location: "Blue Bottle" });
    expect(r.ok).toBe(true);
    const draft = created.mock.calls[0][1];
    expect(draft.attendeeEmail).toBe("t@example.com");
    expect(draft.attendeeName).toBe("Torrey Fields");
    expect(draft.additionalAttendeeEmails).toEqual(["s@example.com"]);
    expect(draft.location).toBe("Blue Bottle");
    expect(draft.conference).toBe(false);
    expect(draft.description).toContain("Where: Blue Bottle");
    expect(draft.description).not.toMatch(/Join online/);
    expect(draft.description).toContain("GitHub: https://github.com/hunterZh37");
    expect(draft.descriptionHtml).toContain("<strong>Where:</strong>");
    expect(r.invited).toEqual(["t@example.com", "s@example.com"]);
  });

  it("online: the fixed room is the location and the join line; no minted conference", async () => {
    const r = await run({ ...base, attendees: [{ email: "t@example.com" }], meeting: "online" });
    expect(r.ok).toBe(true);
    const draft = created.mock.calls[0][1];
    expect(draft.location).toBe("https://zoom.us/j/fixed");
    expect(draft.conference).toBe(false);
    expect(draft.description).toContain("Join online: https://zoom.us/j/fixed");
    expect(draft.description).not.toMatch(/Where:/);
    expect(r.videoLink).toBe("https://zoom.us/j/fixed");
  });

  it("online with a pasted link uses that link instead of the room", async () => {
    await run({ ...base, attendees: [{ email: "t@example.com" }], meeting: "online", videoLink: "https://meet.google.com/abc" });
    expect(created.mock.calls[0][1].description).toContain("Join online: https://meet.google.com/abc");
  });

  it("refuses in person without a place, and refuses a bad email", async () => {
    expect((await run({ ...base, attendees: [{ email: "t@example.com" }], meeting: "in_person" })).error).toBe("location_required");
    expect((await run({ ...base, attendees: [{ email: "not-an-email" }], meeting: "online" })).error).toBe("invalid_attendee");
    expect(created).not.toHaveBeenCalled();
  });

  it("refuses a join link that is not http(s)", async () => {
    expect((await run({ ...base, attendees: [{ email: "t@example.com" }], meeting: "online", videoLink: "javascript:alert(1)" })).error).toBe("invalid_video_link");
  });

  it("refuses guests without saying in person or online", async () => {
    expect((await run({ ...base, attendees: [{ email: "t@example.com" }] })).error).toBe("meeting_required");
  });

  it("a plain event with no guests behaves as before: free description, minted conference by default", async () => {
    const r = await run({ ...base, description: "notes" });
    expect(r.ok).toBe(true);
    const draft = created.mock.calls[0][1];
    expect(draft.attendeeEmail).toBeUndefined();
    expect(draft.description).toBe("notes");
    expect(draft.conference).toBe(true);
  });
});

describe("create_event online with no room configured", () => {
  it("is refused with a clear message", async () => {
    vi.doMock("@/lib/booking/publicConfig", async (orig) => {
      const real = (await orig()) as { HOST: Record<string, unknown> };
      return { ...real, HOST: { ...real.HOST, videoLink: "" } };
    });
    vi.resetModules();
    const { createEventTool: fresh } = await import("./tools");
    const r = JSON.parse(await (fresh() as unknown as { run: (i: unknown) => Promise<string> }).run({ ...base, attendees: [{ email: "t@example.com" }], meeting: "online" }));
    expect(r.error).toBe("no_video_link");
    vi.doUnmock("@/lib/booking/publicConfig");
  });
});
