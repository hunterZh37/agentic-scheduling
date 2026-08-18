/// A clickable target for a free-text location string. Most locations are a
/// place name or address, so we open a Google Maps search for them. Some
/// providers instead stuff a meeting URL into the location field — link
/// straight to that rather than searching Maps for a URL.
export function locationHref(location: string): string {
  const v = location.trim();
  if (/^https?:\/\//i.test(v)) return v;
  if (/^www\./i.test(v)) return `https://${v}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v)}`;
}
