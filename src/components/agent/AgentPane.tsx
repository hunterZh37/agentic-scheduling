"use client";

import { useState, useRef, useEffect } from "react";
import { DateTime } from "luxon";
import styles from "./AgentPane.module.css";
import { renderMarkdown } from "./markdown";
import { interruptedComposerState } from "./interrupt";
import { greetingWord } from "./greeting";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

export type Role = "agent" | "user";
export interface Message {
  id: string;
  role: Role;
  text: string;
}

export function MessageBubble({ role, text }: { role: Role; text: string }) {
  return (
    <div className={`${styles.bubbleRow} ${role === "user" ? styles.rowUser : styles.rowAgent}`}>
      <div className={`${styles.bubble} ${role === "user" ? styles.user : styles.agent}`}>
        {role === "agent" ? renderMarkdown(text) : text}
      </div>
    </div>
  );
}

// Greeting reflects the owner's actual local hour, so an agent that runs their
// day doesn't open with "Morning" at 2pm. Computed per mount; the pane renders
// dynamically (the dashboard is force-dynamic), so server and client agree.
function makeWelcome(): Message {
  const hour = DateTime.now().setZone(OWNER_TIMEZONE).hour;
  return {
    id: "welcome",
    role: "agent",
    text: `${greetingWord(hour)}, ${OWNER_FIRST_NAME}. Ask me to check your availability, book, reschedule, cancel, or add a block. I'll show times in your timezone.`,
  };
}

// Tappable openers for the empty pane, so the product's headline feature isn't
// a blank column with no suggested moves.
const STARTERS = [
  "What's on today?",
  "Am I free Friday afternoon?",
  "Block 2 hours tomorrow morning",
];

/// Private agent chat pane. Phase 6 ships the styled shell + local echo; phase 7
/// wires the real private agent (tool calls + proposal-preview ghosts).
export function AgentPane({
  label = "your timezone",
  onAgentAction,
}: {
  label?: string;
  /// Called after each successful agent turn so sibling panes can refetch —
  /// the agent may have created/edited a block, event, or to-do via its tools.
  onAgentAction?: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>(() => [makeWelcome()]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set when an interrupt restored the draft, so the input can be re-focused
  // once `busy` flips back to false and re-enables it.
  const refocusRef = useRef(false);

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    // Snapshot the thread BEFORE the optimistic user bubble, so an interrupt can
    // revert to exactly this and hand the text back to the composer.
    const snapshot = messages;
    const userMsg: Message = { id: `u-${messages.length}`, role: "user", text };
    const history = [...messages, userMsg];
    setMessages(history);
    setDraft("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // Send the text conversation (excluding the welcome bubble) to the private agent.
    const payload = history
      .filter((m) => m.id !== "welcome")
      .map((m) => ({ role: m.role === "agent" ? "assistant" : "user", content: m.text }));

    try {
      const res = await fetch("/api/agent/private", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload }),
        signal: controller.signal,
      });
      const data = await res.json();
      const reply = res.ok ? data.reply : `Sorry — ${data.message ?? data.error ?? "something went wrong."}`;
      setMessages((m) => [...m, { id: `a-${m.length}`, role: "agent", text: reply }]);
      // The agent may have mutated the schedule (create/edit/delete a block,
      // event, or to-do) via its tools; refresh the other panes so the change
      // shows without a manual reload.
      if (res.ok) onAgentAction?.();
    } catch {
      // An owner-triggered interrupt (Esc) aborts the fetch. Treat that as
      // "take it back", not an error: revert the thread and put the text back in
      // the composer so it can be fixed and re-sent. A genuine network failure
      // still surfaces a message.
      if (controller.signal.aborted) {
        const restored = interruptedComposerState(snapshot, text);
        setMessages(restored.messages);
        setDraft(restored.draft);
        refocusRef.current = true;
      } else {
        setMessages((m) => [...m, { id: `a-${m.length}`, role: "agent", text: "Sorry — I couldn't reach the server." }]);
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const send = () => void submit(draft);

  // While a turn is in flight, Esc anywhere interrupts it (the composer is
  // disabled during "Thinking…", so a document-level listener is what catches
  // the key). Aborting rejects the fetch, which the catch above turns back into
  // an editable draft.
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        abortRef.current?.abort();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  // After an interrupt re-enables the input, restore focus and drop the caret at
  // the end so editing continues where it left off.
  useEffect(() => {
    if (!busy && refocusRef.current) {
      refocusRef.current = false;
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
  }, [busy]);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.avatar}>A</span>
        <span className={styles.name}>Agent</span>
        <span className={styles.online} aria-label="online" />
        <span className={styles.tz}>{label}</span>
      </div>

      <div className={styles.thread} role="log" aria-live="polite" aria-relevant="additions">
        {messages.map((m) => (
          <MessageBubble key={m.id} role={m.role} text={m.text} />
        ))}
        {messages.length === 1 && !busy && (
          <div className={styles.starters}>
            {STARTERS.map((s) => (
              <button key={s} type="button" className={styles.starterChip} onClick={() => void submit(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {busy && (
          <div className={`${styles.bubbleRow} ${styles.rowAgent}`}>
            <div
              className={`${styles.bubble} ${styles.agent} ${styles.typing}`}
              role="status"
              aria-label="Agent is typing"
            >
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </div>
          </div>
        )}
      </div>

      <div className={styles.composer}>
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
          placeholder={busy ? "Thinking… tap ■ or press Esc to stop" : "Ask your agent…"}
          disabled={busy}
        />
        <button
          className={styles.send}
          onClick={() => (busy ? abortRef.current?.abort() : send())}
          aria-label={busy ? "Stop" : "Send"}
          disabled={busy ? false : !draft.trim()}
        >
          {busy ? (
            // Stop the in-flight turn. On a keyboard this is what Esc does; the
            // button is the only interrupt available on touch, where there is
            // no Esc key.
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2.5" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 3.6l6.7 6.7-1.7 1.7-3.8-3.8v12.2h-2.4V8.2l-3.8 3.8L5.3 10.3z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
