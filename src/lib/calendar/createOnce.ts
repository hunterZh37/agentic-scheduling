import type { Account } from "@prisma/client";
import { createDestinationEvent, type EventDraft } from "./write";
import { listEvents } from "./read";
import { recentWrites } from "@/lib/agent/recentWrites";

/// Write an event at most once. Same calendar, same title (case-insensitive),
/// same start, same end, same guests is never a thing the owner wants twice
/// (owner, 2026-10-02: "Meeting with Yosef" landed twice after one "Done").
/// Two layers: an in-process claim so two identical calls in flight write
/// once, and a calendar lookup so a repeat in a later turn returns the
/// existing event. Guests are part of the identity: asking to invite someone
/// to an event that exists without them is a different request and still
/// writes (update_event cannot add guests), so an invite is never swallowed.
/// Shared by Alex's create_event and the MCP create_event, which used to be
/// two implementations with no guard at all.

export interface CreatedOnce {
  eventId: string;
  videoLink: string | null;
  /// True when nothing was written because the event already existed.
  duplicate: boolean;
}

const norm = (s: string) => s.trim().toLowerCase();

export async function createEventOnce(account: Account, draft: EventDraft): Promise<CreatedOnce | null> {
  const guests = [draft.attendeeEmail, ...(draft.additionalAttendeeEmails ?? [])]
    .filter((e): e is string => !!e)
    .map(norm)
    .sort();
  const key = recentWrites.key([account.email, draft.title, draft.start.toISOString(), draft.end.toISOString(), guests.join(",")]);

  const inFlight = recentWrites.pending(key);
  if (inFlight) {
    const prior = await inFlight;
    if (prior) return { ...prior, duplicate: true };
    // The earlier write failed; fall through and try again.
  }

  return recentWrites.claim(key, async () => {
    try {
      const same = (await listEvents(account, draft.start, draft.end)).find((e) => {
        if (norm(e.title) !== norm(draft.title)) return false;
        if (e.start.getTime() !== draft.start.getTime() || e.end.getTime() !== draft.end.getTime()) return false;
        const have = new Set(e.attendees.map((a) => norm(a.email)));
        return guests.every((g) => have.has(g));
      });
      if (same) return { eventId: same.id, videoLink: same.videoLink ?? null, duplicate: true };
    } catch {
      // The lookup is a guard, not a gate: if the provider cannot be read
      // right now, the write goes ahead as it always did.
    }
    const created = await createDestinationEvent(account, draft);
    return { eventId: created.id, videoLink: created.videoLink ?? null, duplicate: false };
  });
}
