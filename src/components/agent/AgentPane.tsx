"use client";

import { useState, useRef, useEffect, type DragEvent as ReactDragEvent } from "react";
import { DateTime } from "luxon";
import styles from "./AgentPane.module.css";
import { renderMarkdown } from "./markdown";
import { interruptedComposerState } from "./interrupt";
import { greetingWord } from "./greeting";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";

// The assistant's name, shown in the header, placeholder and status.
const AGENT_NAME = "Alex";

// A human name for the owner's timezone (e.g. "Eastern Time"), so the header and
// greeting name the actual zone rather than a generic "your timezone".
// `longGeneric` is DST-neutral, so it's identical on the server and client (no
// hydration mismatch); falls back to the IANA city if unavailable.
const OWNER_TZ_LABEL: string = (() => {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: OWNER_TIMEZONE,
      timeZoneName: "longGeneric",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    if (name) return name;
  } catch {
    /* fall through to the city */
  }
  return OWNER_TIMEZONE.split("/").pop()?.replace(/_/g, " ") ?? OWNER_TIMEZONE;
})();

// Alex's health, driven by the last agent turn. Anything but "ok" shows a clear
// status in the header instead of only a buried chat error.
export type AgentStatus = "ok" | "billing" | "auth" | "overloaded" | "error";
const AGENT_STATUS_LABEL: Record<Exclude<AgentStatus, "ok">, string> = {
  billing: "Credits low",
  auth: "Key invalid",
  overloaded: "Overloaded",
  error: "Offline",
};

export type Role = "agent" | "user";
export interface Message {
  id: string;
  role: Role;
  text: string;
  // Data-URL screenshots the owner attached (user messages only).
  images?: string[];
}

export function MessageBubble({ role, text, images }: { role: Role; text: string; images?: string[] }) {
  return (
    <div className={`${styles.bubbleRow} ${role === "user" ? styles.rowUser : styles.rowAgent}`}>
      <div className={`${styles.bubble} ${role === "user" ? styles.user : styles.agent}`}>
        {images && images.length > 0 && (
          <div className={styles.bubbleImages}>
            {images.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={src} alt="attached screenshot" className={styles.bubbleImage} />
            ))}
          </div>
        )}
        {text && (role === "agent" ? renderMarkdown(text) : text)}
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
    text: `${greetingWord(hour)}, ${OWNER_FIRST_NAME}. Ask me to check your availability, book, reschedule, cancel, or add a block. I'll show times in ${OWNER_TZ_LABEL}.`,
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
  onAgentAction,
}: {
  /// Called after each successful agent turn so sibling panes can refetch —
  /// the agent may have created/edited a block, event, or to-do via its tools.
  onAgentAction?: () => void;
}) {
  const [messages, setMessages] = useState<Message[]>(() => [makeWelcome()]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Screenshots the owner attached to the next message (data URLs). Sent with
  // the message so Alex can read them and turn them into actionables.
  const [attached, setAttached] = useState<string[]>([]);
  // Alex's health from the last turn (credits low, key invalid, overloaded).
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("ok");
  // True while a file is being dragged over the pane, for the drop affordance.
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0); // balances dragenter/dragleave on nested children
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const MAX_ATTACHMENTS = 6;

  // Read image files into data URLs and stage them as attachments (deduped,
  // capped). Non-image files are ignored.
  const addFiles = (files: Iterable<File>) => {
    const images = [...files].filter((f) => f.type.startsWith("image/"));
    for (const file of images) {
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === "string" ? reader.result : null;
        if (url) {
          setAttached((prev) => (prev.includes(url) ? prev : [...prev, url].slice(0, MAX_ATTACHMENTS)));
        }
      };
      reader.readAsDataURL(file);
    }
  };
  // Shell-style input history: Up/Down cycle through previously SENT messages.
  // `histIdx` null = editing the live draft; otherwise an index into `history`
  // (oldest→newest). `stashedDraft` holds what was being typed before entering
  // history so Down can restore it.
  const [history, setHistory] = useState<string[]>([]);
  const histIdx = useRef<number | null>(null);
  const stashedDraft = useRef("");

  // Recall a history entry into the input and drop the caret at the end.
  const recall = (value: string) => {
    setDraft(value);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const historyUp = () => {
    if (history.length === 0) return;
    if (histIdx.current === null) {
      stashedDraft.current = draft; // remember the in-progress draft
      histIdx.current = history.length - 1;
    } else {
      histIdx.current = Math.max(0, histIdx.current - 1);
    }
    recall(history[histIdx.current]);
  };

  const historyDown = () => {
    if (histIdx.current === null) return; // not navigating
    histIdx.current += 1;
    if (histIdx.current >= history.length) {
      histIdx.current = null;
      recall(stashedDraft.current); // back to the draft we were typing
    } else {
      recall(history[histIdx.current]);
    }
  };
  // Set when an interrupt restored the draft, so the input can be re-focused
  // once `busy` flips back to false and re-enables it.
  const refocusRef = useRef(false);

  const submit = async (raw: string) => {
    const text = raw.trim();
    const imgs = attached;
    // A message needs either text or at least one screenshot.
    if ((!text && imgs.length === 0) || busy) return;
    // Snapshot the thread BEFORE the optimistic user bubble, so an interrupt can
    // revert to exactly this and hand the text back to the composer.
    const snapshot = messages;
    const userMsg: Message = {
      id: `u-${messages.length}`,
      role: "user",
      text,
      images: imgs.length > 0 ? imgs : undefined,
    };
    const history = [...messages, userMsg];
    setMessages(history);
    setDraft("");
    setAttached([]);
    // Record for Up/Down recall (skip empty / a consecutive duplicate) and reset nav.
    if (text) setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    histIdx.current = null;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // Send the text conversation (excluding the welcome bubble) to the private
    // agent, carrying any attached screenshots so the vision model can read them.
    const payload = history
      .filter((m) => m.id !== "welcome")
      .map((m) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.text,
        ...(m.images && m.images.length > 0 ? { images: m.images } : {}),
      }));

    try {
      const res = await fetch("/api/agent/private", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: payload }),
        signal: controller.signal,
      });
      const data = await res.json();
      const reply = res.ok ? data.reply : (data.message ?? `Sorry — ${data.error ?? "something went wrong."}`);
      setMessages((m) => [...m, { id: `a-${m.length}`, role: "agent", text: reply }]);
      // Drive the header status light: a billing/auth/overload failure flips Alex
      // to a clear "offline" state (see AGENT_STATUS_LABEL) instead of only a
      // buried chat error; a success clears it back to online.
      setAgentStatus(res.ok ? "ok" : ((data.kind as AgentStatus) ?? "error"));
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

  // Drag a screenshot anywhere onto the pane to attach it. dragenter/dragleave
  // fire per child, so a depth counter keeps the highlight from flickering.
  // Detection must be lenient: browsers report a file drag as the "Files" type
  // on some phases and only as file `items` on others, so check BOTH — a strict
  // types-only check made the drop silently rejected in real use.
  const dragHasFiles = (e: ReactDragEvent): boolean => {
    const dt = e.dataTransfer;
    if (Array.from(dt.types ?? []).includes("Files")) return true;
    if (dt.items) {
      for (const it of dt.items) if (it.kind === "file") return true;
    }
    return false;
  };
  // Pull image File objects from a drop, from `files` or (fallback) `items`.
  const imageFilesFromDrop = (e: ReactDragEvent): File[] => {
    const dt = e.dataTransfer;
    const out: File[] = [];
    if (dt.files && dt.files.length > 0) out.push(...Array.from(dt.files));
    else if (dt.items) {
      for (const it of dt.items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out.filter((f) => f.type.startsWith("image/"));
  };
  const onDragEnter = (e: ReactDragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: ReactDragEvent) => {
    // Must preventDefault on EVERY dragover for the browser to fire `drop`.
    if (dragHasFiles(e)) e.preventDefault();
  };
  const onDragLeave = (e: ReactDragEvent) => {
    if (!dragHasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: ReactDragEvent) => {
    const files = imageFilesFromDrop(e);
    if (files.length === 0 && !dragHasFiles(e)) return; // not for us; let it be
    e.preventDefault(); // keep the browser from navigating to the dropped file
    dragDepth.current = 0;
    setDragging(false);
    if (files.length > 0) addFiles(files);
  };

  return (
    <div
      className={styles.root}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragging && (
        <div className={styles.dropHint} aria-hidden="true">
          <div className={styles.dropHintInner}>Drop a screenshot to attach</div>
        </div>
      )}
      <div className={styles.header}>
        <span className={styles.avatar}>A</span>
        <span className={styles.name}>{AGENT_NAME}</span>
        {agentStatus === "ok" ? (
          <span className={styles.online} aria-label="online" />
        ) : (
          // Alex is unavailable: a clear status pill (credits low / key invalid /
          // overloaded) so the problem shows on the dashboard, not just as an
          // error buried in the chat. Amber for the recoverable overload, red
          // otherwise. Title carries the detail.
          <span
            className={`${styles.statusPill} ${agentStatus === "overloaded" ? styles.statusWarn : styles.statusDown}`}
            title="Alex is unavailable. Send a message for details, or check the deployment's Anthropic API key and credits."
          >
            <span className={styles.statusDot} />
            {AGENT_STATUS_LABEL[agentStatus]}
          </span>
        )}
        <span className={styles.tz}>{OWNER_TZ_LABEL}</span>
      </div>

      <div className={styles.thread} role="log" aria-live="polite" aria-relevant="additions">
        {messages.map((m) => (
          <MessageBubble key={m.id} role={m.role} text={m.text} images={m.images} />
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
              aria-label={`${AGENT_NAME} is typing`}
            >
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </div>
          </div>
        )}
      </div>

      <div className={styles.composer}>
        {attached.length > 0 && (
          <div className={styles.attachRow}>
            {attached.map((src, i) => (
              <div key={i} className={styles.thumb}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="attachment" className={styles.thumbImg} />
                <button
                  type="button"
                  className={styles.thumbRemove}
                  onClick={() => setAttached((a) => a.filter((_, j) => j !== i))}
                  aria-label="Remove attachment"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className={styles.composerRow}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = ""; // let the same file be re-picked later
          }}
        />
        <button
          type="button"
          className={styles.attach}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach a screenshot"
          title="Attach a screenshot"
          disabled={busy}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            histIdx.current = null; // typing = a fresh draft, leave history nav
          }}
          onPaste={(e) => {
            // Pasting a screenshot (Cmd/Ctrl+V) attaches it instead of dropping
            // its filename as text.
            const files = [...e.clipboardData.items]
              .filter((it) => it.kind === "file")
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f && f.type.startsWith("image/"));
            if (files.length > 0) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void send();
            } else if (e.key === "ArrowUp") {
              e.preventDefault(); // recall previous input instead of moving caret
              historyUp();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              historyDown();
            }
          }}
          placeholder={busy ? "Thinking… tap ■ or press Esc to stop" : `Ask ${AGENT_NAME}…`}
          disabled={busy}
        />
        <button
          className={styles.send}
          onClick={() => (busy ? abortRef.current?.abort() : send())}
          aria-label={busy ? "Stop" : "Send"}
          disabled={busy ? false : !draft.trim() && attached.length === 0}
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
    </div>
  );
}
