"use client";

import { useRef, useState } from "react";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";

interface Persona {
  name: string;
  goal: string;
  timezone: string;
  durationMinutes: number;
  availability: string;
}
type Ev =
  | { type: "persona"; persona: Persona }
  | { type: "message"; agent: "A" | "B"; text: string }
  | { type: "tool"; agent: "A"; name: string; summary: string }
  | { type: "result"; startISO: string; endISO: string }
  | { type: "booked" }
  | { type: "booking_failed"; message: string }
  | { type: "no_agreement" }
  | { type: "error"; message: string }
  | { type: "done" };

const fmt = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
  }).format(new Date(iso));

export default function DemoPage() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [running, setRunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const clearDemo = async () => {
    setClearing(true);
    setCleanupMsg(null);
    try {
      const res = await fetch("/api/demo-cleanup", { method: "POST" });
      if (res.status === 401) {
        setCleanupMsg(`Sign in as ${OWNER_FIRST_NAME} to clear demo bookings.`);
      } else if (res.ok) {
        const { deleted } = await res.json();
        setCleanupMsg(`Cleared ${deleted} demo booking${deleted === 1 ? "" : "s"}.`);
      } else {
        setCleanupMsg("Couldn't clear demo bookings — try again.");
      }
    } catch {
      setCleanupMsg("Couldn't reach the server.");
    } finally {
      setClearing(false);
    }
  };

  const start = () => {
    esRef.current?.close();
    setEvents([]);
    setRunning(true);
    const es = new EventSource("/api/agent/demo");
    esRef.current = es;
    es.onmessage = (m) => {
      const ev: Ev = JSON.parse(m.data);
      setEvents((prev) => [...prev, ev]);
      if (ev.type === "done") {
        es.close();
        setRunning(false);
      }
    };
    es.onerror = () => {
      es.close();
      setRunning(false);
    };
  };

  const persona = (events.find((e) => e.type === "persona") as Extract<Ev, { type: "persona" }> | undefined)?.persona;
  const hostTz = OWNER_TIMEZONE;

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 4 }}>Agent ↔ Agent negotiation</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        Watch a requester&apos;s scheduling agent negotiate a meeting with {OWNER_FIRST_NAME}&apos;s agent, live.
        (Demo — books a tagged [Demo] event on {OWNER_FIRST_NAME}&apos;s calendar; clear anytime.)
      </p>

      <button
        onClick={start}
        disabled={running}
        style={{ padding: "10px 18px", borderRadius: 8, border: "none", background: running ? "#888" : "#2563eb", color: "#fff", fontSize: 15, cursor: running ? "default" : "pointer" }}
      >
        {running ? "Negotiating…" : events.length ? "Run again" : "Start negotiation"}
      </button>
      <button
        onClick={clearDemo}
        disabled={clearing}
        style={{ marginLeft: 12, padding: "10px 14px", borderRadius: 8, border: "1px solid #cbd5e1", background: "transparent", color: "#475569", fontSize: 14, cursor: clearing ? "default" : "pointer" }}
      >
        {clearing ? "Clearing…" : "Clear demo bookings"}
      </button>
      {cleanupMsg && <p style={{ marginTop: 8, fontSize: 13, color: "#475569" }}>{cleanupMsg}</p>}

      {persona && (
        <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: "#f1f5f9", color: "#334155", fontSize: 14 }}>
          <strong>{persona.name}&apos;s agent</strong> wants {persona.goal} — free {persona.availability} ({persona.timezone}).
        </div>
      )}

      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {events.map((ev, i) => {
          if (ev.type === "message") {
            const isA = ev.agent === "A";
            return (
              <div key={i} style={{ display: "flex", justifyContent: isA ? "flex-start" : "flex-end" }}>
                <div style={{ maxWidth: "80%", padding: "8px 12px", borderRadius: 12, background: isA ? "#e0e7ff" : "#dcfce7", color: "#111" }}>
                  <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 2 }}>
                    {isA ? `${OWNER_FIRST_NAME}'s agent` : `${persona?.name ?? "Requester"}'s agent`}
                  </div>
                  {ev.text}
                </div>
              </div>
            );
          }
          if (ev.type === "tool") {
            return (
              <div key={i} style={{ fontSize: 12, color: "#64748b", paddingLeft: 4 }}>
                🔧 {OWNER_FIRST_NAME}&apos;s agent: {ev.summary}
              </div>
            );
          }
          if (ev.type === "result") {
            return (
              <div key={i} style={{ padding: 12, borderRadius: 8, background: "#eef2ff", color: "#3730a3", fontWeight: 600 }}>
                🤝 Agreed: {fmt(ev.startISO, hostTz)}
                {persona ? ` (${fmt(ev.startISO, persona.timezone)} for ${persona.name})` : ""}
              </div>
            );
          }
          if (ev.type === "booked") {
            return (
              <div key={i} style={{ padding: 12, borderRadius: 8, background: "#dcfce7", color: "#166534", fontWeight: 600 }}>
                ✅ Booked on {OWNER_FIRST_NAME}&apos;s calendar (tagged [Demo], no alert sent).
              </div>
            );
          }
          if (ev.type === "booking_failed") {
            return (
              <div key={i} style={{ padding: 12, borderRadius: 8, background: "#fef9c3", color: "#854d0e" }}>
                ⚠️ Agreed, but the booking failed: {ev.message}
              </div>
            );
          }
          if (ev.type === "no_agreement") {
            return <div key={i} style={{ padding: 12, borderRadius: 8, background: "#fef9c3", color: "#854d0e" }}>The agents couldn&apos;t find a shared time this round.</div>;
          }
          if (ev.type === "error") {
            return <div key={i} style={{ padding: 12, borderRadius: 8, background: "#fee2e2", color: "#991b1b" }}>{ev.message}</div>;
          }
          return null;
        })}
      </div>
    </main>
  );
}
