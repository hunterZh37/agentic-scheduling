"use client";

import { useEffect, useState } from "react";
import shell from "@/components/settings/SettingsManager.module.css";
import styles from "./TokenUsagePanel.module.css";

interface ProcessRow {
  process: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  calls: number;
  costUsd: number;
}
interface Totals extends Omit<ProcessRow, "process"> {}
interface RecentTurn {
  id: string;
  process: string;
  userText: string | null;
  replyText: string | null;
  totalTokens: number;
  costUsd: number;
  createdAt: string;
}
interface UsageData {
  totals: Totals;
  byProcess: ProcessRow[];
  recent: RecentTurn[];
}

// Compact relative time: "just now", "5m", "3h", "2d".
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Human labels for the internal process tags.
const PROCESS_LABEL: Record<string, { name: string; sub: string }> = {
  "dashboard-agent": { name: "Dashboard", sub: "Alex, in the app" },
  "booking-agent": { name: "Booking page", sub: "visitor chat" },
  "team-agent": { name: "Team booking", sub: "joint link chat" },
  "sms-agent": { name: "SMS / WhatsApp", sub: "text channel" },
  "voice-agent": { name: "Voice notes", sub: "spoken commands" },
  "peer-agent": { name: "Agent-to-agent", sub: "peer scheduling" },
  "requester-agent": { name: "Outbound", sub: "agent-to-agent" },
  agent: { name: "Other", sub: "uncategorized" },
};
const labelFor = (p: string) => PROCESS_LABEL[p] ?? { name: p, sub: "" };

// Alex's replies are markdown; this view is a plain-text preview, so drop the
// most common markers so "**Pacific**" reads as "Pacific", not with the stars.
const stripMd = (s: string): string =>
  s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");

const fmtTokens = (n: number) => n.toLocaleString();
const fmtCost = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

/// Owner-only panel: how many tokens each process has spent, and a rough cost.
/// Mirrors the other manager sheets.
export function TokenUsagePanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/usage")
      .then((r) => r.json())
      .then((d) => setData(d as UsageData))
      .catch(() => setError(true));
  }, []);

  return (
    <div className={shell.overlay} onClick={onClose}>
      <div className={shell.sheet} onClick={(e) => e.stopPropagation()}>
        <button className={shell.close} onClick={onClose} aria-label="Close">
          ×
        </button>
        <h3 className={shell.title}>Token usage</h3>

        {error ? (
          <p className={styles.empty}>Couldn&apos;t load usage.</p>
        ) : !data ? (
          <p className={styles.empty}>Loading…</p>
        ) : data.totals.totalTokens === 0 ? (
          <p className={styles.empty}>No token usage recorded yet. It appears here as soon as the assistant runs.</p>
        ) : (
          <>
            <div className={styles.stats}>
              <div className={styles.stat}>
                <span className={styles.statValue}>{fmtTokens(data.totals.totalTokens)}</span>
                <span className={styles.statLabel}>tokens</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{fmtCost(data.totals.costUsd)}</span>
                <span className={styles.statLabel}>est. cost</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statValue}>{fmtTokens(data.totals.calls)}</span>
                <span className={styles.statLabel}>{data.totals.calls === 1 ? "turn" : "turns"}</span>
              </div>
            </div>

            <div className={styles.table}>
              {data.byProcess.map((r) => (
                <div key={r.process} className={styles.row}>
                  <span className={styles.proc}>{labelFor(r.process).name}</span>
                  <span className={styles.tokens}>{fmtTokens(r.totalTokens)}</span>
                  <span className={styles.cost}>{fmtCost(r.costUsd)}</span>
                </div>
              ))}
            </div>

            <p className={styles.footnote}>Estimated at list price; your actual bill may differ.</p>

            {data.recent.length > 0 && (
              <div className={styles.recent}>
                <div className={styles.recentHead}>Recent turns</div>
                {data.recent.map((t) => {
                  const open = expanded === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={styles.turn}
                      onClick={() => setExpanded(open ? null : t.id)}
                      aria-expanded={open}
                    >
                      <span className={styles.turnMeta}>
                        <span>{ago(t.createdAt)}</span>
                        <span className={styles.turnTokens}>{fmtTokens(t.totalTokens)} tok · {fmtCost(t.costUsd)}</span>
                      </span>
                      {open && t.userText && <span className={styles.turnPrompt}>You: {t.userText}</span>}
                      <span className={open ? styles.turnReplyFull : styles.turnReply}>
                        {t.replyText ? stripMd(t.replyText) : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
