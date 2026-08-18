import { describe, it, expect } from "vitest";
import { estimateCostUsd, totalTokens, addUsage, zeroCounts } from "./pricing";

describe("pricing", () => {
  it("costs Opus 4.8 input/output at list price", () => {
    // 1M input @ $5 + 1M output @ $25 = $30
    const c = estimateCostUsd(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
      "claude-opus-4-8"
    );
    expect(c).toBeCloseTo(30, 6);
  });

  it("includes cache read/write at their discounted/premium rates", () => {
    const c = estimateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 },
      "claude-opus-4-8"
    );
    // 1M cache-read @ $0.50 + 1M cache-write @ $6.25 = $6.75
    expect(c).toBeCloseTo(6.75, 6);
  });

  it("falls back to the default rate for an unknown model", () => {
    const counts = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(estimateCostUsd(counts, "some-future-model")).toBeCloseTo(5, 6);
  });

  it("totalTokens sums every bucket", () => {
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 })).toBe(10);
  });

  it("addUsage accumulates raw Anthropic usage, tolerating missing fields", () => {
    let acc = zeroCounts();
    acc = addUsage(acc, { input_tokens: 10, output_tokens: 5 });
    acc = addUsage(acc, { input_tokens: 3, cache_read_input_tokens: 100 });
    acc = addUsage(acc, null);
    expect(acc).toEqual({ inputTokens: 13, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 });
  });
});
