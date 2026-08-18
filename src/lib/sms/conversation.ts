import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { ChatMessage } from "@/lib/agent/run";

// Rolling SMS history, persisted per phone number so the stateless SMS channel
// gets multi-turn continuity. We keep only the last MAX_MESSAGES turns — old
// context is trimmed on every write so a long-running thread can't grow the row
// or the agent's prompt without bound.
const MAX_MESSAGES = 12;

function isChatMessage(v: unknown): v is ChatMessage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return (m.role === "user" || m.role === "assistant") && typeof m.content === "string";
}

/// Load the stored history for a phone number, newest-trimmed. Returns [] for
/// an unknown number or if the stored JSON is somehow malformed.
export async function loadConversation(phone: string): Promise<ChatMessage[]> {
  const row = await prisma.smsConversation.findUnique({ where: { phone } });
  if (!row) return [];
  // Prisma types the column as JsonValue; narrow back to ChatMessage[] via the
  // runtime guard (ChatMessage doesn't structurally satisfy JsonValue, so the
  // filter can't infer the cast on its own).
  const raw: unknown[] = Array.isArray(row.messages) ? row.messages : [];
  const messages = raw.filter(isChatMessage);
  return messages.slice(-MAX_MESSAGES);
}

/// Upsert the history for a phone number, trimmed to the last MAX_MESSAGES.
export async function saveConversation(phone: string, messages: ChatMessage[]): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES) as unknown as Prisma.InputJsonValue;
  await prisma.smsConversation.upsert({
    where: { phone },
    create: { phone, messages: trimmed },
    update: { messages: trimmed },
  });
}

/// Clear a phone number's history (the "reset"/"new" command). Safe to call for
/// a number that has no stored conversation.
export async function resetConversation(phone: string): Promise<void> {
  await prisma.smsConversation.deleteMany({ where: { phone } });
}
