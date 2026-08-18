// Token counts and rough USD cost. Pure + testable. Rates are per 1M tokens,
// USD, from Anthropic's list price. Cache reads bill ~0.1x input; cache writes
// ~1.25x input. Only the models this app actually calls need an entry; anything
// else falls back to the Opus 4.8 rate (the app's default model).

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const RATES: Record<string, Rate> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};
const DEFAULT_RATE = RATES["claude-opus-4-8"];

export function rateFor(model: string): Rate {
  return RATES[model] ?? DEFAULT_RATE;
}

/// Rough USD cost for a set of token counts at a model's list price.
export function estimateCostUsd(counts: TokenCounts, model: string): number {
  const r = rateFor(model);
  return (
    (counts.inputTokens * r.input +
      counts.outputTokens * r.output +
      counts.cacheReadTokens * r.cacheRead +
      counts.cacheCreationTokens * r.cacheWrite) /
    1_000_000
  );
}

/// Total billable tokens (everything the model read or wrote).
export function totalTokens(counts: TokenCounts): number {
  return counts.inputTokens + counts.outputTokens + counts.cacheReadTokens + counts.cacheCreationTokens;
}

const ZERO: TokenCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

/// Add a raw Anthropic `usage` object into a running TokenCounts. Tolerant of
/// missing fields. Used to sum a turn's usage across its tool steps.
export function addUsage(
  acc: TokenCounts,
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null | undefined
): TokenCounts {
  if (!usage) return acc;
  return {
    inputTokens: acc.inputTokens + (usage.input_tokens ?? 0),
    outputTokens: acc.outputTokens + (usage.output_tokens ?? 0),
    cacheReadTokens: acc.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
    cacheCreationTokens: acc.cacheCreationTokens + (usage.cache_creation_input_tokens ?? 0),
  };
}

export const zeroCounts = (): TokenCounts => ({ ...ZERO });
