import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import { runToolLoop, type RunnerTools, type ChatMessage } from "./run";
import { runFindMutualTimes, type FindMutualTimesArgs } from "./mutualSlots";
import type { RequesterPersona } from "./personas";
import { bookDemoMeeting, type BookOutcome, type DemoSlot } from "./demoBooking";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";

export type NegotiationEvent =
  | { type: "persona"; persona: RequesterPersona }
  | { type: "message"; agent: "A" | "B"; text: string }
  | { type: "tool"; agent: "A"; name: string; summary: string }
  | { type: "result"; startISO: string; endISO: string }
  | { type: "booked" }
  | { type: "booking_failed"; message: string }
  | { type: "no_agreement" }
  | { type: "error"; message: string }
  | { type: "done" };

interface AgentAResult {
  text: string;
  toolEvents: { name: string; summary: string }[];
  confirmed?: { startISO: string; endISO: string };
}

export interface NegotiationDeps {
  runAgentA?: (messages: ChatMessage[]) => Promise<AgentAResult>;
  runAgentB?: (persona: RequesterPersona, messages: ChatMessage[]) => Promise<string>;
  bookMeeting?: (persona: RequesterPersona, slot: DemoSlot) => Promise<BookOutcome>;
  maxTurns?: number;
}

// NOTE: no nowLine() here — runToolLoop prepends the current date itself.
const A_SYSTEM = `You are ${OWNER_FIRST_NAME}'s scheduling agent. You are negotiating with another person's scheduling agent to find one meeting time that works for both.
- Use find_mutual_times to check ${OWNER_FIRST_NAME}'s REAL availability before proposing: pass the meeting duration, a sensible search window, and the requester's stated free windows converted to UTC. Only propose times that tool returns.
- Keep each message short and conversational — you are talking to another agent, not a person.
- When you and the other agent have clearly agreed on ONE specific slot both have accepted, call confirm_meeting with that slot (UTC). Do not call it before there is a clear mutual agreement.`;

function bSystem(p: RequesterPersona): string {
  return `You are ${p.name}'s scheduling agent. Your goal: secure ${p.goal} with ${OWNER_FIRST_NAME}.
- ${p.name} is free ${p.availability} (${p.timezone}). Propose concrete times within that availability and this coming week.
- Open the conversation, respond to ${OWNER_FIRST_NAME}'s agent's counter-proposals, and accept a good time when offered.
- Keep each message short and conversational. Do NOT invent ${OWNER_FIRST_NAME}'s availability — let their agent tell you what works.`;
}

type Turn = { agent: "A" | "B"; text: string };

function labelFor(agent: "A" | "B", persona: RequesterPersona): string {
  return agent === "A" ? `${OWNER_FIRST_NAME}'s agent` : `${persona.name}'s agent`;
}

/// Render the shared transcript as a single user message telling `me` to write
/// the next line. Simple and role-safe (always one user message).
function renderTurnPrompt(transcript: Turn[], me: "A" | "B", persona: RequesterPersona): ChatMessage[] {
  const convo = transcript.length
    ? `Conversation so far:\n${transcript.map((t) => `${labelFor(t.agent, persona)}: ${t.text}`).join("\n")}\n\n`
    : "";
  const who = labelFor(me, persona);
  const instr = transcript.length === 0
    ? `You are ${who}. Start the conversation: reach out to ${OWNER_FIRST_NAME}'s agent to schedule the meeting.`
    : `You are ${who}. Write your next message in this negotiation (only your message, no prefix).`;
  return [{ role: "user", content: `${convo}${instr}` }];
}

function demoFindMutualTimesTool(onTool: (summary: string) => void) {
  return betaTool({
    name: "find_mutual_times",
    description:
      `Find times that work for BOTH ${OWNER_FIRST_NAME} and the requester. Pass the meeting ` +
      "duration, the search window, and the requester's OWN free windows (UTC ISO). " +
      `Returns mutually-free slots plus ${OWNER_FIRST_NAME}'s timezone. Free/busy overlap only.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        durationMinutes: { type: "number" },
        windowStartISO: { type: "string" },
        windowEndISO: { type: "string" },
        requesterFreeSlots: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { startISO: { type: "string" }, endISO: { type: "string" } },
            required: ["startISO", "endISO"],
          },
        },
        requesterTimezone: { type: "string" },
      },
      required: ["durationMinutes", "windowStartISO", "windowEndISO", "requesterFreeSlots", "requesterTimezone"],
    },
    run: async (input) => {
      const args = input as unknown as FindMutualTimesArgs;
      onTool(`checking ${OWNER_FIRST_NAME}'s availability for ${args.durationMinutes} min`);
      return runFindMutualTimes(args);
    },
  });
}

function confirmMeetingTool(onConfirm: (slot: { startISO: string; endISO: string }) => void) {
  return betaTool({
    name: "confirm_meeting",
    description:
      "Call ONLY once you and the other agent have clearly agreed on one specific slot both accepted. " +
      "Provide the agreed slot in UTC ISO. This finalizes the (demo) meeting.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { startISO: { type: "string" }, endISO: { type: "string" } },
      required: ["startISO", "endISO"],
    },
    run: async (input) => {
      const rec = input as { startISO: string; endISO: string };
      const slot = { startISO: String(rec.startISO), endISO: String(rec.endISO) };
      onConfirm(slot); // dry-run: record only, no createBooking
      return JSON.stringify({ ok: true, ...slot });
    },
  });
}

async function defaultRunAgentA(messages: ChatMessage[]): Promise<AgentAResult> {
  const toolEvents: { name: string; summary: string }[] = [];
  let confirmed: { startISO: string; endISO: string } | undefined;
  const tools: RunnerTools = [
    demoFindMutualTimesTool((summary) => toolEvents.push({ name: "find_mutual_times", summary })),
    confirmMeetingTool((slot) => { confirmed = slot; }),
  ];
  const text = await runToolLoop(A_SYSTEM, tools, messages);
  return { text, toolEvents, confirmed };
}

async function defaultRunAgentB(persona: RequesterPersona, messages: ChatMessage[]): Promise<string> {
  return runToolLoop(bSystem(persona), [], messages);
}

/// Orchestrate the two-agent negotiation, emitting an event per step. Agent B
/// (the requester) opens; Agent A (the owner's) responds and confirms. On
/// confirmation we emit `result`, then book via `bookMeeting` (a real, tagged,
/// alert-suppressed booking by default) and emit `booked`/`booking_failed`.
/// `runAgentA`/`runAgentB`/`bookMeeting` are injectable so the loop is
/// unit-testable without the live model or a real booking.
export async function runNegotiation(
  persona: RequesterPersona,
  emit: (e: NegotiationEvent) => void,
  deps: NegotiationDeps = {}
): Promise<void> {
  const runAgentA = deps.runAgentA ?? defaultRunAgentA;
  const runAgentB = deps.runAgentB ?? defaultRunAgentB;
  const bookMeeting = deps.bookMeeting ?? bookDemoMeeting;
  const maxTurns = deps.maxTurns ?? 10;

  emit({ type: "persona", persona });
  const transcript: Turn[] = [];
  let confirmed = false;

  try {
    for (let turn = 0; turn < maxTurns && !confirmed; turn++) {
      if (turn % 2 === 0) {
        // Agent B (requester) — opens and negotiates.
        const text = await runAgentB(persona, renderTurnPrompt(transcript, "B", persona));
        emit({ type: "message", agent: "B", text });
        transcript.push({ agent: "B", text });
      } else {
        // Agent A (the owner's) — checks real availability, proposes, confirms.
        const r = await runAgentA(renderTurnPrompt(transcript, "A", persona));
        for (const te of r.toolEvents) emit({ type: "tool", agent: "A", name: te.name, summary: te.summary });
        emit({ type: "message", agent: "A", text: r.text });
        transcript.push({ agent: "A", text: r.text });
        if (r.confirmed) {
          emit({ type: "result", startISO: r.confirmed.startISO, endISO: r.confirmed.endISO });
          const outcome = await bookMeeting(persona, r.confirmed);
          if (outcome.ok) emit({ type: "booked" });
          else emit({ type: "booking_failed", message: outcome.error });
          confirmed = true;
        }
      }
    }
    if (!confirmed) emit({ type: "no_agreement" });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : "Unknown error" });
  } finally {
    emit({ type: "done" });
  }
}
