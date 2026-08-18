"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./BookingPage.module.css";
import { renderMarkdown } from "@/components/agent/markdown";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

/// Booking-scoped chat wired to the fenced public agent. Free/busy + booking
/// only; the agent physically cannot see the owner's schedule.
export function PublicAgentChat({
  bookerTimezone,
  durationMinutes,
  endpoint = "/api/agent/public",
  intro = `Hi! I can help you find time with ${OWNER_FIRST_NAME}. When are you hoping to meet?`,
  suggestions,
}: {
  bookerTimezone: string;
  durationMinutes: number;
  endpoint?: string;
  intro?: string;
  suggestions?: string[];
}) {
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", text: intro }]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string>("");
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Starter prompts so the visitor isn't staring at an empty box. Clicking one
  // drops it into the input (not auto-sent) so they can tweak it first. The
  // first uses the length they picked, tying the two together.
  const chips = suggestions ?? [
    `Book ${durationMinutes} min this Thursday afternoon`,
    "Any mornings open this week?",
    "What times work on Friday?",
  ];
  const useSuggestion = (s: string) => {
    setDraft(s);
    inputRef.current?.focus();
  };

  useEffect(() => {
    if (!sessionId.current) sessionId.current = crypto.randomUUID();
  }, []);
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const history = [...messages, { role: "user" as const, text }];
    setMessages(history);
    setDraft("");
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionId.current,
          messages: [
            {
              role: "user",
              content: `(My timezone is ${bookerTimezone}. I'd like a ${durationMinutes}-minute meeting unless I say otherwise — use ${durationMinutes} as the duration when checking availability and booking.)`,
            },
            ...history.map((m) => ({ role: m.role, content: m.text })),
          ],
        }),
      });
      const data = await res.json();
      const reply = res.ok ? data.reply : `Sorry — ${data.message ?? data.error ?? "please try again."}`;
      setMessages((m) => [...m, { role: "assistant", text: reply }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "Sorry — I couldn't reach the server." }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.chat}>
      <div className={styles.chatThread} ref={threadRef}>
        {messages.map((m, i) => (
          <div
            key={i}
            className={`${styles.chatRow} ${m.role === "user" ? styles.chatRowUser : styles.chatRowAgent}`}
          >
            <div className={`${styles.chatBubble} ${m.role === "user" ? styles.chatUser : styles.chatAgent}`}>
              {m.role === "assistant" ? renderMarkdown(m.text) : m.text}
            </div>
          </div>
        ))}
        {busy && (
          <div className={`${styles.chatRow} ${styles.chatRowAgent}`}>
            <div
              className={`${styles.chatBubble} ${styles.chatAgent} ${styles.typing}`}
              role="status"
              aria-label="Assistant is typing"
            >
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </div>
          </div>
        )}
      </div>
      {messages.length <= 1 && !busy && (
        <div className={styles.chatSuggestions}>
          {chips.map((s) => (
            <button key={s} className={styles.chatChip} onClick={() => useSuggestion(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className={styles.chatComposer}>
        <input
          ref={inputRef}
          className={styles.chatInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void send()}
          placeholder={busy ? "Thinking…" : "e.g. Book 30 min Thursday afternoon"}
          disabled={busy}
        />
        <button className={styles.chatSend} onClick={() => void send()} disabled={!draft.trim() || busy} aria-label="Send">
          ↑
        </button>
      </div>
    </div>
  );
}
