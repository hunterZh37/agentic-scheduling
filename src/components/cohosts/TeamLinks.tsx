"use client";

import { useEffect, useState } from "react";
import styles from "./CoHostsManager.module.css";

interface CoHostRow {
  id: string;
  name: string;
  email: string;
}

interface TeamMemberRow {
  kind: "owner" | "cohost";
  name?: string;
}

interface TeamRow {
  id: string;
  slug: string;
  name: string;
  bookingPath: string;
  members: TeamMemberRow[];
}

const ERROR_COPY: Record<string, string> = {
  invalid_name: "Add a name for the link.",
  invalid_slug: "Use only lowercase letters, numbers, and hyphens.",
  reserved_slug: "That link name is reserved. Pick another.",
  slug_taken: "That link name is already in use.",
  no_cohosts: "Pick at least one co-host.",
  unknown_cohost: "One of those co-hosts no longer exists.",
};

/// Turn a display name into a URL slug: lowercase, non-alphanumerics to hyphens,
/// collapsed. "Hunter & Ben" -> "hunter-ben".
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/// Owner-side "booking links" (teams): create a shareable /book/<slug> that
/// offers only times every chosen member is free. Rendered inside CoHostsManager,
/// below the co-hosts list, so members can be picked from the same sheet.
export function TeamLinks({ coHosts }: { coHosts: CoHostRow[] }) {
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<Record<string, string>>({});

  const reload = () =>
    fetch("/api/teams")
      .then((r) => r.json())
      .then((d) => setTeams((d.teams ?? []) as TeamRow[]))
      .finally(() => setLoading(false));

  useEffect(() => {
    void reload();
  }, []);

  const onName = (v: string) => {
    setName(v);
    if (!slugEdited) setSlug(slugify(v));
  };

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const canCreate = name.trim() && slug.trim() && picked.size > 0 && !saving;

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/teams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), slug: slug.trim(), coHostIds: [...picked] }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 201) {
        setName("");
        setSlug("");
        setSlugEdited(false);
        setPicked(new Set());
        await reload();
      } else {
        setError(ERROR_COPY[body.error] ?? "Couldn't create that link.");
      }
    } catch {
      setError("Couldn't create that link.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/teams/${id}`, { method: "DELETE" });
      if (res.ok) setTeams((rows) => rows.filter((t) => t.id !== id));
    } catch {
      /* leave the row; the owner can retry */
    }
  };

  // Save an inline rename (PATCH). No-op when unchanged.
  const renameTeam = async (t: TeamRow) => {
    const next = (nameDraft[t.id] ?? t.name).trim();
    if (!next || next === t.name) return;
    try {
      const res = await fetch(`/api/teams/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (res.ok) {
        setTeams((rows) => rows.map((r) => (r.id === t.id ? { ...r, name: next } : r)));
        setError(null);
      } else {
        setError("Couldn't rename that link.");
      }
    } catch {
      setError("Couldn't rename that link.");
    }
  };

  const copy = async (team: TeamRow) => {
    const url = `${window.location.origin}${team.bookingPath}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(team.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === team.id ? null : cur)), 1500);
    } catch {
      /* clipboard blocked; the link text is still visible to copy by hand */
    }
  };

  return (
    <div>
      <div className={styles.divider} />
      <h3 className={styles.sectionHead}>Booking links</h3>
      <p className={styles.blurb}>
        A shareable link that offers only the times you and the chosen co-hosts are all free.
      </p>

      {coHosts.length === 0 ? (
        <p className={styles.empty}>Add a co-host above to create a shared link.</p>
      ) : (
        <div className={styles.addCard}>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="Link name, e.g. Hunter & Ben"
          />
          <input
            className={styles.input}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugEdited(true);
            }}
            placeholder="url-slug"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <div className={styles.memberPick}>
            {coHosts.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`${styles.memberChip} ${picked.has(c.id) ? styles.memberChipOn : ""}`}
                onClick={() => toggle(c.id)}
              >
                {picked.has(c.id) ? "✓ " : ""}
                {c.name}
              </button>
            ))}
          </div>
          <button className={styles.addBtn} onClick={() => void create()} disabled={!canCreate}>
            {saving ? "Creating…" : "Create booking link"}
          </button>
          {error && <p className={styles.error}>{error}</p>}
        </div>
      )}

      {loading ? null : teams.length === 0 ? (
        <p className={styles.empty}>No booking links yet.</p>
      ) : (
        <ul className={styles.list}>
          {teams.map((t) => (
            <li key={t.id} className={styles.row}>
              <span className={styles.rowMain}>
                <input
                  className={styles.rowNameEdit}
                  value={nameDraft[t.id] ?? t.name}
                  onChange={(e) => setNameDraft((d) => ({ ...d, [t.id]: e.target.value }))}
                  onBlur={() => void renameTeam(t)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  aria-label="Booking link name"
                />
                <span className={styles.linkRow}>
                  <span className={styles.linkPath}>{t.bookingPath}</span>
                  <button className={styles.copyBtn} onClick={() => void copy(t)}>
                    {copiedId === t.id ? "Copied" : "Copy"}
                  </button>
                </span>
              </span>
              <button className={styles.removeBtn} onClick={() => void remove(t.id)} aria-label={`Delete ${t.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
