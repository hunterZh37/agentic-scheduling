/// Build the occurrence key a follow-up (or cross-off) attaches to.
///
/// Callers pass either the agenda/modal id — which already carries the "event:"
/// prefix (e.g. "event:AAMk...") — or a bare provider event id ("AAMk..."), plus
/// the occurrence's start. Both yield the SAME key, matching the Checkoff store's
/// format: "event:<providerEventId>:<startISO>". Keying by start means each
/// occurrence of a recurring event gets its own follow-up list.
export function followupKey(eventId: string, start: Date): string {
  const providerId = eventId.replace(/^event:/, "");
  return `event:${providerId}:${start.toISOString()}`;
}
