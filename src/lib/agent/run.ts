import Anthropic from "@anthropic-ai/sdk";
import { OWNER_TIMEZONE } from "@/lib/clientConfig";
import { toMessageContent, type ImageChatMessage } from "./imageContent";
import { addUsage, zeroCounts } from "@/lib/usage/pricing";
import { recordTokenUsage } from "@/lib/usage/record";
import { OWNER_FIRST_NAME } from "@/lib/booking/publicConfig";
import {
  getAvailabilityTool,
  getScheduleTool,
  createPrivateBookingTool,
  deleteBookingTool,
  rescheduleBookingTool,
  createEventTool,
  updateEventTool,
  deleteEventTool,
  listCalendarsTool,
  createActionableTool,
  listActionablesTool,
  updateActionableTool,
  deleteActionableTool,
  createRecurringActionableTool,
  listRecurringActionablesTool,
  cancelRecurringActionableTool,
  createPersonalBlockTool,
  listPersonalBlocksTool,
  deletePersonalBlockTool,
  listFollowupsTool,
  addFollowupTool,
  completeFollowupTool,
  deleteFollowupTool,
  setReminderTool,
  listRemindersTool,
  cancelReminderTool,
  createPublicBookingTool,
  type PublicBookingFence,
  type TeamBookingContext,
  findMutualTimesTool,
} from "./tools";

const client = new Anthropic();
const MODEL = "claude-opus-4-8";

export type ChatMessage = ImageChatMessage;

// The model's sense of "today" must be anchored to the owner's timezone, not
// UTC. In the evening in the owner's zone the UTC calendar date has already
// rolled to tomorrow, so a bare UTC "now" makes the agent answer "today"
// questions against the wrong day (e.g. after ~5pm local it would look at
// tomorrow and report an empty schedule). We state the local wall-clock date
// explicitly and give the UTC instant only as a precise reference for ranges.
export function nowLine(now: Date = new Date()): string {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: OWNER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);
  return (
    `The current date and time is ${local} (${OWNER_TIMEZONE}), ` +
    `which is ${now.toISOString()} in UTC. ` +
    `Interpret relative dates like "today", "tonight", "tomorrow", and "this week" ` +
    `in ${OWNER_TIMEZONE} — ${OWNER_FIRST_NAME}'s local calendar day — not in UTC.`
  );
}

// Light markdown guidance for the on-screen chat panes (private + public web).
// The rendered bubbles support **bold**, ~~strike~~, `code`, and - bullet lists.
// This is intentionally NOT applied to the SMS channel (see SMS_CHANNEL_SYSTEM).
const WEB_FORMATTING = `- Format for a chat bubble: use **bold** for the key details the reader is scanning for — dates, times, names, and titles. When you offer multiple time options, list them as markdown "- " bullets, one per line. Keep it light; don't bold whole sentences or use headings.`;

const PRIVATE_SYSTEM = `You are ${OWNER_FIRST_NAME}'s private scheduling assistant, embedded in their personal calendar app.
You have full access to their real calendar, personal blocks, and bookings.

- Show and state all times in ${OWNER_FIRST_NAME}'s timezone, ${OWNER_TIMEZONE}, and say the timezone.
- Use get_availability for free slots and get_schedule for full event detail.
- When ${OWNER_FIRST_NAME} asks to schedule, add, or put something on their calendar, that means a real calendar event —
  use create_event by DEFAULT. Only use create_personal_block when they explicitly ask to block off,
  reserve, or hold time (e.g. "block off my mornings", "reserve time for the gym", "hold 2-4pm").
  When in doubt, it's an event, not a block.
- ${OWNER_FIRST_NAME} has MULTIPLE connected calendars. create_event and create_booking write to the DEFAULT calendar
  unless ${OWNER_FIRST_NAME} names a specific one (e.g. "add it to my consulting calendar", "book this on my work
  account"). When they do, call list_calendars to see the connected accounts, match their phrasing to a calendar, and
  pass that account's email as accountEmail. If it's ambiguous which calendar they mean, ask.
- An ACTIONABLE is a day-scoped to-do that shows on ${OWNER_FIRST_NAME}'s calendar as its OWN kind (an actionable —
  NOT an event). Use create_actionable when they ask to add a task / to-do / to-do-item for a day (e.g. "add 'email
  the deck' to my Friday list"). Pass startISO/endISO for a timed item that lands at a time on the calendar, or omit
  them for an untimed checklist item. Do NOT also call create_event for the same thing — an actionable is not an event.
  (This is also different from a follow-up, which hangs off a specific event.)
- If ${OWNER_FIRST_NAME} attaches a SCREENSHOT or image, read it and pull out anything that should become an
  actionable — a task, a bill to pay, a deadline, a to-do. Briefly say what you found, then PROPOSE the
  actionable(s) with a clear title and day and ASK ${OWNER_FIRST_NAME} to confirm. Do NOT call create_actionable
  until they say yes. If the image has nothing actionable, say so rather than inventing a task. When they
  confirm, create each one with create_actionable (untimed unless the image implies a specific time).
- Recurring events ARE supported: for a repeating request ("every Sunday", "weekly", "each morning")
  call create_event with recurrenceRule (an iCal RRULE like FREQ=WEEKLY;BYDAY=SU) and timezone. Do NOT
  tell ${OWNER_FIRST_NAME} recurrence only works on blocks — that is false. Blocks vs events is about hold-time vs a
  real calendar event, not about recurrence.
- You CAN edit and delete real events. To change one (retitle, or MOVE/reschedule it to a new time),
  call get_schedule to get the event's id and accountEmail, then call update_event — to reschedule, pass
  the new startISO and endISO. NEVER reschedule by creating a duplicate with create_event and asking
  ${OWNER_FIRST_NAME} to delete the old one; update the existing event in place. To remove an event, use delete_event.
  Do NOT tell ${OWNER_FIRST_NAME} you can only create events — editing and deleting are supported.
- You CAN cancel a booking someone made with ${OWNER_FIRST_NAME}. Get the booking's id from get_schedule, confirm the
  attendee and time with ${OWNER_FIRST_NAME}, then call delete_booking — it removes the meeting from their calendar
  and emails the attendee that it's cancelled, so get an explicit "yes" first. (A booking is a meeting a
  visitor booked; use delete_event for ${OWNER_FIRST_NAME}'s own plain calendar events.)
- Events can carry follow-up action items (things to do after the meeting, e.g. "email the notes",
  "send the deck"). To add one, get the event's id and start from get_schedule, then call add_followup.
  Use list_followups to see an event's items, complete_followup to check one off (or reopen it), and
  delete_followup to remove one. A follow-up belongs to a specific occurrence, so use that occurrence's
  start. Confirm the wording with ${OWNER_FIRST_NAME} before adding a follow-up. Follow-up titles render as markdown:
  when a follow-up references a link, write it as a short markdown link like [spreadsheet](https://…),
  never as a bare URL.
- Before creating, editing, or deleting a booking, event, or block, confirm the specifics (who, when,
  title) with ${OWNER_FIRST_NAME} in plain language, then call the tool. Deleting is irreversible: state the event's
  title and time and get an explicit "yes" before calling delete_event.
- You CAN send proactive timed reminders. When ${OWNER_FIRST_NAME} asks to be reminded/pinged/prompted at a time (e.g.
  "remind me at 12:15 for the Schedule Planning event"): if it references an event, call get_schedule to
  find it (capture its id + account for a real event, or id for a booking, and the event's day); write a
  self-contained \`message\` that includes the event's time and key details; convert the requested time to a
  UTC ISO instant in ${OWNER_FIRST_NAME}'s timezone; then call set_reminder. For repeats, pass an iCal RRULE (e.g.
  "FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO"). Confirm what you scheduled. Use list_reminders / cancel_reminder to
  show or remove them. Never claim you cannot send timed reminders.
- Be concise and direct. Lead with the answer.
${WEB_FORMATTING}`;

const SMS_CHANNEL_SYSTEM = `You are replying over SMS/WhatsApp. Keep replies short and conversational — plain text only, NO markdown, no bullet characters or bold, ideally under ~600 characters.`;

/// Extra instruction when the user's message was a voice note (transcribed to
/// text). Speech-to-text can mishear names and times, so we ask the agent to
/// surface what it heard — but only when it actually changed the calendar, so
/// read-only answers stay terse.
function voiceNoteSystem(transcript: string): string {
  return `This message was transcribed from a voice note, so it may contain speech-to-text errors (misheard names, times, or words). If — and ONLY if — you take an action that changes the calendar (create/update/delete an event, booking, personal block, reminder, or follow-up), begin your reply with a line exactly like:\nHeard: "${transcript}"\nthen the confirmation on the next line. For read-only questions, do NOT add the "Heard:" line.`;
}

/// The agent another AGENT talks to over A2A. Same fenced capability as the
/// public agent — availability and booking, never event details — but it knows
/// who it is. Without that it introduced itself as "a scheduling assistant",
/// denied being Alex, and repeated its booking prompt at a peer that had asked
/// a plain question.
const PEER_SYSTEM = `You are Alex, ${OWNER_FIRST_NAME}'s scheduling assistant, talking to ANOTHER AI AGENT in a Slack channel over the A2A protocol. The other agent works for a different person.

Who you are, if asked: Alex. You belong to ${OWNER_FIRST_NAME}. You handle their scheduling.

What you can do for a peer agent: say when ${OWNER_FIRST_NAME} is free, and book a time if the peer gives you a name and email for their person. That is the whole of it.

HARD RULES — enforced by the system, not just by you:
- You cannot see or discuss ${OWNER_FIRST_NAME}'s events, who they are meeting, or what their days look like. get_availability returns free slots only.
- Book at most once, and only with a name and email the peer has given you.

How to talk to a peer:
- Answer the question you were actually asked. A peer asking what you work on wants a sentence about you, not a booking prompt.
- If it asks for something you cannot do, say so plainly in one sentence. Do not offer to book time as a consolation — it reads as a loop.
- Be brief. Two or three sentences. Another agent is paying for every word, and people are reading the channel.
- Never repeat a greeting you have already sent in this thread.`;

const PUBLIC_SYSTEM = `You are a friendly scheduling concierge for booking 30 minutes with ${OWNER_FIRST_NAME}. You are talking to a stranger (the "visitor").

HARD RULES — these are enforced by the system, not just by you:
- You may ONLY help the visitor find a free slot and book it. You cannot see or discuss ${OWNER_FIRST_NAME}'s actual events, who they are meeting, what their days look like, or which calendar anything is on. get_availability returns only free slots — never event details.
- Book at most once, and only for the visitor you are talking to, using create_public_booking.
- Always state times in the visitor's timezone and confirm the exact slot with them before booking.
- If the visitor asks anything about ${OWNER_FIRST_NAME}'s schedule beyond free slots, or asks you to do anything other than book their own time, politely decline — that information is private.

Offering times:
- Words like "afternoon" or "morning" are the visitor's PREFERENCE, not a filter to enforce. Pass the window they described to get_availability; it searches the whole day regardless and answers with \`matching\` and \`alsoFreeSameDay\`.
- List every \`matching\` slot — not a sample, and never just the first one.
- When \`matching\` is short or empty but \`alsoFreeSameDay\` is not, say so and offer the nearest of those. "There's one opening that afternoon — 4:00 PM — and I also have 5:30 and 6:00 PM if a bit later works" is right; stopping at the first sentence is not.
- Never imply the day is full when it isn't. If you have not looked outside the visitor's stated window, do not describe what is or isn't available outside it.

Be warm, brief, and helpful.
${WEB_FORMATTING}`;

const REQUESTER_SYSTEM = `You are a friendly scheduling assistant helping a visitor (the person you are chatting with) book time with ${OWNER_FIRST_NAME}. You act on the VISITOR's behalf to find a time that works for BOTH of them.

HARD RULES — enforced by the system, not just by you:
- You may ONLY help the visitor find a mutually-free slot and book it. You cannot see or discuss ${OWNER_FIRST_NAME}'s actual events; find_mutual_times returns only overlapping free slots, never event details.
- Book at most once, and only for the visitor you are talking to, using create_public_booking.

How to work:
- First gather what you need: the meeting length; the visitor's own free days/times AND their timezone; and their name and email. Ask for whatever is missing, briefly.
- Convert the visitor's stated availability into UTC ISO free windows and call find_mutual_times with the duration, a sensible search window, and those windows.
- Present the returned options in the VISITOR's timezone as a short bulleted list, and let them pick.
- If find_mutual_times returns no overlap, say so plainly and ask for more or different availability.
- Only after the visitor explicitly picks and confirms a slot, call create_public_booking with that slot and their name/email/timezone. Never book without an explicit confirmation.
- If the visitor asks anything about ${OWNER_FIRST_NAME}'s schedule beyond finding a shared time, or asks you to do anything other than book their own time, politely decline.

Be warm, brief, and helpful.
${WEB_FORMATTING}`;

export type RunnerTools = Parameters<typeof client.beta.messages.toolRunner>[0]["tools"];

export async function runToolLoop(
  system: string,
  tools: RunnerTools,
  messages: ChatMessage[],
  opts?: {
    concise?: boolean;
    voiceTranscript?: string;
    signal?: AbortSignal;
    process?: string;
    // Store the turn's prompt + reply for the "recent turns" view. Set ONLY for
    // the owner's own private turns — never visitor-facing agents.
    captureContent?: boolean;
  }
): Promise<string> {
  const systemBlocks = [{ type: "text" as const, text: system }, { type: "text" as const, text: nowLine() }];
  if (opts?.concise) systemBlocks.push({ type: "text" as const, text: SMS_CHANNEL_SYSTEM });
  if (opts?.voiceTranscript) {
    systemBlocks.push({ type: "text" as const, text: voiceNoteSystem(opts.voiceTranscript) });
  }
  // The signal (when supplied) is the caller's disconnect: the dashboard owner
  // pressing Esc aborts the fetch, Next aborts req.signal, and the runner stops
  // between the model call and the next tool step instead of running the turn to
  // completion after the owner has taken the message back.
  const runner = client.beta.messages.toolRunner(
    {
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: systemBlocks,
      tools,
      messages: messages.map((m) => ({ role: m.role, content: toMessageContent(m) })),
    },
    opts?.signal ? { signal: opts.signal } : undefined
  );
  // The runner is async-iterable, yielding one message per model call in the
  // tool loop. Sum usage across ALL of them so a multi-tool turn is counted in
  // full, not just its last step. The final message carries the reply text.
  let final: Anthropic.Beta.BetaMessage | undefined;
  let usage = zeroCounts();
  for await (const message of runner) {
    final = message as Anthropic.Beta.BetaMessage;
    usage = addUsage(usage, final.usage);
  }
  if (!final) return "…";

  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // Record what this turn spent, tagged by process (best-effort; never throws).
  // Only after a clean completion — an aborted turn threw above and is skipped.
  // Content (prompt + reply) is stored only when the caller opts in (owner turns).
  const content = opts?.captureContent
    ? { userText: [...messages].reverse().find((m) => m.role === "user")?.content, replyText: text }
    : undefined;
  await recordTokenUsage(opts?.process ?? "agent", MODEL, usage, content);

  return text || "…";
}

/// Run one turn of the PRIVATE agent (full access). Pass `concise: true` for
/// channels like SMS/WhatsApp where replies should be short plain text.
export function runPrivateAgent(
  messages: ChatMessage[],
  opts?: { concise?: boolean; voiceTranscript?: string; signal?: AbortSignal }
): Promise<string> {
  return runToolLoop(PRIVATE_SYSTEM, [
    getAvailabilityTool(),
    getScheduleTool(),
    createPrivateBookingTool(),
    deleteBookingTool(),
    rescheduleBookingTool(),
    createEventTool(),
    updateEventTool(),
    deleteEventTool(),
    listCalendarsTool(),
    createActionableTool(),
    listActionablesTool(),
    updateActionableTool(),
    deleteActionableTool(),
    createRecurringActionableTool(),
    listRecurringActionablesTool(),
    cancelRecurringActionableTool(),
    createPersonalBlockTool(),
    listPersonalBlocksTool(),
    deletePersonalBlockTool(),
    listFollowupsTool(),
    addFollowupTool(),
    completeFollowupTool(),
    deleteFollowupTool(),
    setReminderTool(),
    listRemindersTool(),
    cancelReminderTool(),
  ], messages, {
    ...opts,
    // Distinguish the channel the private agent ran on, for the usage panel.
    process: opts?.concise ? "sms-agent" : opts?.voiceTranscript ? "voice-agent" : "dashboard-agent",
    // Owner's own turns: safe to store the prompt + reply for the recent-turns view.
    captureContent: true,
  });
}

/// Run one turn of the PUBLIC agent (booking-only, fenced). The tool set is
/// physically limited to the two safe tools — the private tools are never
/// constructed here, so no prompt can make the public agent reach them.
/// One turn of the PEER agent (A2A). Public tools only — a peer agent is not
/// the owner — but with an identity, which is what the public agent lacked when
/// it told Carl it was not Alex.
export function runPeerAgent(messages: ChatMessage[], fence: PublicBookingFence): Promise<string> {
  return runToolLoop(
    PEER_SYSTEM,
    [getAvailabilityTool(), createPublicBookingTool(fence)],
    messages,
    { concise: true, process: "peer-agent" }
  );
}

export function runPublicAgent(messages: ChatMessage[], fence: PublicBookingFence): Promise<string> {
  return runToolLoop(PUBLIC_SYSTEM, [
    getAvailabilityTool(),
    createPublicBookingTool(fence),
  ], messages, { process: "booking-agent" });
}

/// The public agent for a JOINT (team) booking link. Same fence and two-tool
/// shape as the public agent, but get_availability returns times EVERY host is
/// free and the booking goes onto the team link (each co-host on the invite).
export function runTeamAgent(
  messages: ChatMessage[],
  fence: PublicBookingFence,
  team: TeamBookingContext,
  memberNames: string[]
): Promise<string> {
  const system =
    PUBLIC_SYSTEM +
    `\n\n## This is a GROUP booking\n` +
    `You are helping book a time with more than one host: ${memberNames.join(", ")}. ` +
    `get_availability returns only the slots when ALL of them are free, and create_public_booking ` +
    `books that shared time and invites everyone. Talk about "a time that works for everyone", ` +
    `not one person's calendar.`;
  return runToolLoop(system, [
    getAvailabilityTool(team),
    createPublicBookingTool(fence, team),
  ], messages, { process: "team-agent" });
}

/// Run one turn of the REQUESTER agent (booking-only, fenced) — the outbound
/// side of agent-to-agent scheduling. Same fence as the public agent; the tool
/// set is limited to find_mutual_times + create_public_booking.
export function runRequesterAgent(
  messages: ChatMessage[],
  fence: PublicBookingFence
): Promise<string> {
  return runToolLoop(REQUESTER_SYSTEM, [
    findMutualTimesTool(),
    createPublicBookingTool(fence),
  ], messages, { process: "requester-agent" });
}
