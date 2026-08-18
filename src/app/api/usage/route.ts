import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { estimateCostUsd, totalTokens, type TokenCounts } from "@/lib/usage/pricing";

export const runtime = "nodejs";

// Token-usage summary for the dashboard's Token usage panel: overall totals and
// a per-PROCESS breakdown (dashboard-agent, booking-agent, …), with a rough USD
// cost at list price. Owner-private (gated like the rest of the dashboard API).
// Cost uses the app's default model rate — the only model it calls.
const COST_MODEL = "claude-opus-4-8";

interface ProcessRow extends TokenCounts {
  process: string;
  totalTokens: number;
  calls: number;
  costUsd: number;
}

export async function GET(): Promise<NextResponse> {
  const grouped = await prisma.tokenUsage.groupBy({
    by: ["process"],
    _sum: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheCreationTokens: true,
    },
    _count: { _all: true },
  });

  const byProcess: ProcessRow[] = grouped
    .map((g) => {
      const counts: TokenCounts = {
        inputTokens: g._sum.inputTokens ?? 0,
        outputTokens: g._sum.outputTokens ?? 0,
        cacheReadTokens: g._sum.cacheReadTokens ?? 0,
        cacheCreationTokens: g._sum.cacheCreationTokens ?? 0,
      };
      return {
        process: g.process,
        ...counts,
        totalTokens: totalTokens(counts),
        calls: g._count._all,
        costUsd: estimateCostUsd(counts, COST_MODEL),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totals = byProcess.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      calls: acc.calls + r.calls,
      costUsd: acc.costUsd + r.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, calls: 0, costUsd: 0 }
  );

  // Recent OWNER turns with their content, for the "recent turns" view. Only
  // rows that captured a reply (visitor turns store none).
  const recentRows = await prisma.tokenUsage.findMany({
    where: { replyText: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: {
      id: true,
      process: true,
      userText: true,
      replyText: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheCreationTokens: true,
      createdAt: true,
    },
  });
  const recent = recentRows.map((r) => {
    const counts: TokenCounts = {
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheCreationTokens: r.cacheCreationTokens,
    };
    return {
      id: r.id,
      process: r.process,
      userText: r.userText,
      replyText: r.replyText,
      totalTokens: totalTokens(counts),
      costUsd: estimateCostUsd(counts, COST_MODEL),
      createdAt: r.createdAt.toISOString(),
    };
  });

  return NextResponse.json({ totals, byProcess, recent });
}
