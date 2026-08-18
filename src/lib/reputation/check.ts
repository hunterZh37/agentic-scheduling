import { optionalEnv } from "@/lib/env";

/// One security vendor's verdict on the domain.
export interface VendorVerdict {
  vendor: string;
  category: string; // "malicious" | "suspicious" | "harmless" | "undetected"
}

export interface ReputationSnapshot {
  /// Vendors currently flagging the domain (malicious or suspicious), sorted.
  flagged: VendorVerdict[];
  /// Total engines that returned a verdict.
  total: number;
  checkedAt: string;
}

const VT_DOMAIN = "bookwithhunter.com";

/// Fetch per-vendor reputation from VirusTotal. One call covers ~90 engines —
/// including Fortinet and Trellix, whose own lookup pages are CAPTCHA-gated and
/// so can't be checked automatically. Returns null when unconfigured (no key)
/// or on any API failure, so the caller can degrade quietly rather than alert.
export async function fetchReputation(
  domain: string = VT_DOMAIN
): Promise<ReputationSnapshot | null> {
  const key = optionalEnv("VIRUSTOTAL_API_KEY");
  if (!key) return null;

  let res: Response;
  try {
    res = await fetch(`https://www.virustotal.com/api/v3/domains/${encodeURIComponent(domain)}`, {
      headers: { "x-apikey": key },
      // Never serve a cached verdict — the whole point is detecting a change.
      cache: "no-store",
    });
  } catch (err) {
    console.error("[reputation] VirusTotal request failed:", err);
    return null;
  }
  if (!res.ok) {
    console.error(`[reputation] VirusTotal returned ${res.status}`);
    return null;
  }

  const body = (await res.json()) as {
    data?: { attributes?: { last_analysis_results?: Record<string, { category?: string }> } };
  };
  const results = body.data?.attributes?.last_analysis_results ?? {};
  const flagged: VendorVerdict[] = Object.entries(results)
    .filter(([, v]) => v.category === "malicious" || v.category === "suspicious")
    .map(([vendor, v]) => ({ vendor, category: v.category! }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));

  return {
    flagged,
    total: Object.keys(results).length,
    checkedAt: new Date().toISOString(),
  };
}

/// Stable identity of a snapshot for change detection: which vendors flag it and
/// how. Compared against the previous run so the cron only alerts on a CHANGE
/// (a vendor clearing, or a new one appearing) instead of nagging daily.
export function snapshotKey(s: ReputationSnapshot): string {
  return s.flagged.map((f) => `${f.vendor}:${f.category}`).join(",");
}

/// Human-readable diff between two runs, or null when nothing changed.
export function describeChange(
  prev: string | null,
  next: ReputationSnapshot
): string | null {
  const nextKey = snapshotKey(next);
  if (prev === nextKey) return null;

  const prevVendors = new Set(
    (prev ?? "").split(",").filter(Boolean).map((p) => p.split(":")[0])
  );
  const nextVendors = new Set(next.flagged.map((f) => f.vendor));
  const cleared = [...prevVendors].filter((v) => !nextVendors.has(v));
  const added = [...nextVendors].filter((v) => !prevVendors.has(v));

  const lines: string[] = [];
  if (cleared.length) lines.push(`✅ Now CLEAN: ${cleared.join(", ")}`);
  if (added.length) lines.push(`⚠️ Newly flagging: ${added.join(", ")}`);
  lines.push(
    next.flagged.length === 0
      ? `🎉 No vendor is flagging ${VT_DOMAIN} (0 of ${next.total} engines).`
      : `Still flagged by ${next.flagged.length} of ${next.total}: ${next.flagged
          .map((f) => `${f.vendor} (${f.category})`)
          .join(", ")}`
  );
  return lines.join("\n");
}

/// The body of the DAILY digest, sent whether or not anything moved.
///
/// `describeChange` returns null on a quiet day, which is right for an alert and
/// wrong for a report: the owner asked for a daily audit and silence is
/// indistinguishable from a broken cron. This always produces a body, and says
/// plainly when nothing changed.
export function describeDaily(prev: string | null, next: ReputationSnapshot): string {
  const change = describeChange(prev, next);
  if (change) return change;
  return next.flagged.length === 0
    ? `🎉 No vendor is flagging ${VT_DOMAIN} (0 of ${next.total} engines). No change since the last check.`
    : `No change since the last check. Still flagged by ${next.flagged.length} of ${next.total}: ` +
        next.flagged.map((f) => `${f.vendor} (${f.category})`).join(", ");
}

/// Subject line for the daily digest. States the count up front so the inbox is
/// scannable without opening anything.
export function dailySubject(prev: string | null, next: ReputationSnapshot): string {
  const changed = describeChange(prev, next) != null;
  if (next.flagged.length === 0) {
    return changed
      ? `✅ ${VT_DOMAIN} is now clean across all ${next.total} engines`
      : `✅ ${VT_DOMAIN} still clean (0 of ${next.total} flagging)`;
  }
  return changed
    ? `⚠️ Domain reputation CHANGED — ${next.flagged.length} of ${next.total} flagging`
    : `Domain reputation — ${next.flagged.length} of ${next.total} still flagging`;
}

/// A single line fit for WhatsApp — a template variable, an SMS, or a push.
/// The email digest is the long form; this has to survive being read on a lock
/// screen, so it leads with the count and names at most three vendors.
export function whatsappSummary(prev: string | null, next: ReputationSnapshot): string {
  const changed = describeChange(prev, next) != null;
  if (next.flagged.length === 0) {
    return `${VT_DOMAIN}: clean — 0 of ${next.total} engines flagging${changed ? " (changed today)" : ""}.`;
  }
  const names = next.flagged.slice(0, 3).map((f) => f.vendor).join(", ");
  const more = next.flagged.length > 3 ? ` +${next.flagged.length - 3} more` : "";
  return (
    `${VT_DOMAIN}: ${next.flagged.length} of ${next.total} engines flagging` +
    `${changed ? " (CHANGED today)" : " (no change)"} — ${names}${more}.`
  );
}
