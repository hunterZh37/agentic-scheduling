import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across hot reloads in dev to avoid exhausting
// connections. Standard Next.js pattern.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Neon scales the compute to zero when idle; the first connection after that
// must wait a few seconds for it to resume. libpq's default connect timeout is
// short, so a cold start intermittently failed with `P1001: Can't reach
// database server` — hitting the monitor cron, the availability API, and users'
// first load after idle. Give the connection a generous timeout so a cold start
// waits for the wake instead of erroring. Applied in code so we don't depend on
// the deployed DATABASE_URL carrying the param.
function resilientDbUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || /[?&]connect_timeout=/.test(url)) return url;
  return url + (url.includes("?") ? "&" : "?") + "connect_timeout=20";
}

const dbUrl = resilientDbUrl();

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    ...(dbUrl ? { datasources: { db: { url: dbUrl } } } : {}),
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
