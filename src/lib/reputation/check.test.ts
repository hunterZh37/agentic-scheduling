import { describe, it, expect } from "vitest";
import { snapshotKey, describeChange, type ReputationSnapshot, describeDaily, dailySubject, whatsappSummary } from "./check";

const snap = (flagged: Array<[string, string]>): ReputationSnapshot => ({
  flagged: flagged.map(([vendor, category]) => ({ vendor, category })),
  total: 94,
  checkedAt: "2026-08-03T16:00:00Z",
});

describe("snapshotKey", () => {
  it("is stable for the same verdicts", () => {
    const a = snap([["Fortinet", "malicious"], ["Trellix", "suspicious"]]);
    const b = snap([["Fortinet", "malicious"], ["Trellix", "suspicious"]]);
    expect(snapshotKey(a)).toBe(snapshotKey(b));
  });

  it("changes when a vendor's category changes", () => {
    expect(snapshotKey(snap([["Fortinet", "malicious"]]))).not.toBe(
      snapshotKey(snap([["Fortinet", "suspicious"]]))
    );
  });
});

describe("describeChange", () => {
  it("returns null when nothing changed (no daily nagging)", () => {
    const s = snap([["Fortinet", "malicious"]]);
    expect(describeChange(snapshotKey(s), s)).toBeNull();
  });

  it("reports a vendor clearing — the outcome we are waiting for", () => {
    const before = snapshotKey(snap([["Fortinet", "malicious"], ["Trellix", "malicious"]]));
    const msg = describeChange(before, snap([["Trellix", "malicious"]]));
    expect(msg).toContain("Now CLEAN");
    expect(msg).toContain("Fortinet");
  });

  it("reports a newly flagging vendor", () => {
    const before = snapshotKey(snap([["Fortinet", "malicious"]]));
    const msg = describeChange(before, snap([["Fortinet", "malicious"], ["Sophos", "malicious"]]));
    expect(msg).toContain("Newly flagging");
    expect(msg).toContain("Sophos");
  });

  it("celebrates a fully clean result", () => {
    const before = snapshotKey(snap([["Fortinet", "malicious"]]));
    const msg = describeChange(before, snap([]));
    expect(msg).toContain("No vendor is flagging");
  });

  it("treats an empty baseline as a change once vendors appear", () => {
    expect(describeChange("", snap([["Fortinet", "malicious"]]))).toContain("Newly flagging");
  });
});

describe("daily digest", () => {
  const snap = (flagged: Array<{ vendor: string; category: string }>) => ({
    flagged,
    total: 91,
  });

  // The owner asked why no audit arrived. The cron had run and returned 200 —
  // it simply had nothing to report, and change-only alerting made "quiet day"
  // and "cron is broken" look identical from the inbox.
  it("still produces a body when nothing changed", () => {
    const s = snap([{ vendor: "Fortinet", category: "malicious" }]);
    const key = snapshotKey(s as never);
    expect(describeChange(key, s as never)).toBeNull(); // the old behaviour: silence
    const daily = describeDaily(key, s as never);
    expect(daily).toMatch(/no change/i);
    expect(daily).toContain("Fortinet");
    expect(daily).toContain("91");
  });

  it("says so plainly when clean and unchanged", () => {
    const s = snap([]);
    const daily = describeDaily(snapshotKey(s as never), s as never);
    expect(daily).toMatch(/no vendor is flagging/i);
    expect(daily).toMatch(/no change/i);
  });

  it("keeps the change description when something did move", () => {
    const before = "Fortinet:malicious,Trellix:phishing";
    const after = snap([{ vendor: "Fortinet", category: "malicious" }]);
    const daily = describeDaily(before, after as never);
    expect(daily).toMatch(/Now CLEAN: Trellix/);
    expect(daily).not.toMatch(/no change/i);
  });

  describe("subject line", () => {
    it("flags a change up front", () => {
      const after = snap([{ vendor: "Fortinet", category: "malicious" }]);
      expect(dailySubject("Fortinet:malicious,Trellix:phishing", after as never)).toMatch(/CHANGED/);
    });

    it("is calm on a quiet day but still states the count", () => {
      const s = snap([{ vendor: "Fortinet", category: "malicious" }]);
      const subject = dailySubject(snapshotKey(s as never), s as never);
      expect(subject).not.toMatch(/CHANGED/);
      expect(subject).toMatch(/1 of 91 still flagging/);
    });

    it("celebrates only the transition to clean, not every clean day", () => {
      const clean = snap([]);
      expect(dailySubject("Fortinet:malicious", clean as never)).toMatch(/now clean/i);
      expect(dailySubject(snapshotKey(clean as never), clean as never)).toMatch(/still clean/i);
    });
  });
});

describe("whatsappSummary", () => {
  const snap = (vendors: string[]) => ({
    flagged: vendors.map((v) => ({ vendor: v, category: "malicious" })),
    total: 91,
  });

  // A lock-screen line, not the email digest: count first, a few names, done.
  it("leads with the count and marks a quiet day", () => {
    const s = snap(["Fortinet"]);
    const line = whatsappSummary(snapshotKey(s as never), s as never);
    expect(line).toMatch(/1 of 91 engines flagging \(no change\)/);
    expect(line).toContain("Fortinet");
  });

  it("shouts when something moved", () => {
    const line = whatsappSummary("Fortinet:malicious,Trellix:phishing", snap(["Fortinet"]) as never);
    expect(line).toMatch(/CHANGED today/);
  });

  it("caps the vendor list so it stays readable", () => {
    const many = snap(["A", "B", "C", "D", "E"]);
    const line = whatsappSummary(snapshotKey(many as never), many as never);
    expect(line).toContain("A, B, C");
    expect(line).toContain("+2 more");
    expect(line).not.toContain("D,");
  });

  it("says clean plainly", () => {
    const clean = snap([]);
    expect(whatsappSummary(snapshotKey(clean as never), clean as never)).toMatch(
      /clean — 0 of 91/
    );
  });
});
