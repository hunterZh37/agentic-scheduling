import { prisma } from "@/lib/db";
import type { TokenCounts } from "./pricing";
import { totalTokens } from "./pricing";

// Persist one completed turn's token usage, tagged by the PROCESS that spent it.
// Best-effort: usage accounting must NEVER break or slow an agent reply, so all
// failures are swallowed and a zero-token turn writes nothing.

// Bound stored content so a long reply can't bloat the row.
const MAX_CONTENT = 4000;
const clip = (s: string | undefined | null): string | null =>
  s == null ? null : s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) + "…" : s;

/// `content` is captured ONLY for the owner's own private turns (see run.ts) —
/// never for visitor-facing agents, whose text belongs to a third party.
export async function recordTokenUsage(
  process: string,
  model: string,
  counts: TokenCounts,
  content?: { userText?: string; replyText?: string }
): Promise<void> {
  if (totalTokens(counts) === 0) return;
  try {
    await prisma.tokenUsage.create({
      data: {
        process,
        model,
        inputTokens: counts.inputTokens,
        outputTokens: counts.outputTokens,
        cacheReadTokens: counts.cacheReadTokens,
        cacheCreationTokens: counts.cacheCreationTokens,
        userText: clip(content?.userText),
        replyText: clip(content?.replyText),
      },
    });
  } catch (err) {
    console.error("[usage] failed to record token usage:", err);
  }
}
