/// A location field holds one of two things: a PLACE (name or address) or an
/// ONLINE MEETING link. Providers write the second kind in several shapes — a
/// bare URL, a URL after some text ("Zoom: https://…"), or a markdown link
/// ("[Zoom video visit](https://…)", which is how Kaiser's video visits arrive).
/// Only a bare URL used to be recognised, so every other shape was sent to a
/// Google Maps search for the literal text. See docs/REGRESSIONS.md.

const MD_LINK = /^\[([^\]]*)\]\((https?:\/\/[^\s]+)\)$/i;
const EMBEDDED_URL = /https?:\/\/[^\s<>"']+/i;

/// A URL lifted out of prose drags the sentence's punctuation with it. A
/// closing paren is only stripped when it is unbalanced, so a URL that really
/// contains "(…)" survives.
function trimUrl(url: string): string {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (/[.,;:!?'"\]]/.test(last)) u = u.slice(0, -1);
    else if (last === ")" && u.split("(").length <= u.split(")").length - 1) u = u.slice(0, -1);
    else return u;
  }
}

/// The meeting URL inside a location string, if there is one. http(s) only:
/// location text comes from calendar invites, i.e. from other people, so no
/// other scheme (javascript:, data:) may ever become an href.
function meetingUrl(location: string): string | null {
  const v = location.trim();
  const md = MD_LINK.exec(v);
  if (md) return md[2];
  if (/^www\./i.test(v)) return `https://${v}`;
  const m = EMBEDDED_URL.exec(v);
  return m ? trimUrl(m[0]) : null;
}

/// True when the location is an online meeting link rather than a place — the
/// caller shows a video icon instead of a map pin.
export function isMeetingLocation(location: string): boolean {
  return meetingUrl(location) !== null;
}

/// A clickable target for a free-text location: the meeting link when the
/// location carries one, otherwise a Google Maps search for the place.
export function locationHref(location: string): string {
  return (
    meetingUrl(location) ??
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location.trim())}`
  );
}

/// What to SHOW for a location. A markdown link reads as its label ("Zoom video
/// visit") rather than as raw markdown; anything else is shown as written.
export function locationLabel(location: string): string {
  const md = MD_LINK.exec(location.trim());
  if (!md) return location;
  return md[1].trim() || md[2];
}
