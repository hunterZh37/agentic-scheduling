import type { Message } from "./AgentPane";

/// The composer state to restore when the owner interrupts an in-flight agent
/// turn (Esc). The optimistic user bubble is dropped back out of the thread and
/// its text is returned to the input verbatim, so the mistake can be fixed and
/// re-sent instead of being lost — the same "Esc to take it back" affordance as
/// Claude Code. Pure so the contract (text comes back, thread reverts) is pinned
/// by a test even though the component itself has no test harness.
export function interruptedComposerState(
  snapshotBeforeSend: Message[],
  sentText: string
): { messages: Message[]; draft: string } {
  return { messages: snapshotBeforeSend, draft: sentText };
}
