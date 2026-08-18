// Seed: a few example calendar accounts (config only, no tokens yet), the
// Settings singleton, and a starter recurring sleep block so day one never
// offers 3am.
//
// Idempotent: safe to re-run. Uses upserts keyed on natural identifiers.

import { PrismaClient, Provider, AuthMethod } from "@prisma/client";
import { DateTime } from "luxon";

const prisma = new PrismaClient();

// The owner's home timezone. Personal blocks are authored in wall-clock local
// time and converted to UTC for storage.
const HOME_TZ = process.env.OWNER_TIMEZONE ?? process.env.HUNTER_TIMEZONE ?? "America/New_York";

const DEFAULT_DESTINATION_EMAIL =
  process.env.DEFAULT_DESTINATION_EMAIL ??
  process.env.OWNER_EMAIL ??
  process.env.HUNTER_EMAIL ??
  "owner@example.com";

// All accounts use per-account OAuth (one consent screen each). authMethod is
// still per-account and flippable to `delegation` later for any domain the
// owner administers, without touching the aggregator (which is auth-method
// agnostic). Replace these placeholders with your own accounts.
const ACCOUNTS: Array<{
  email: string;
  provider: Provider;
  authMethod: AuthMethod;
}> = [
  { email: "google-personal@example.com", provider: Provider.google, authMethod: AuthMethod.oauth },
  { email: "google-work@example.com", provider: Provider.google, authMethod: AuthMethod.oauth },
  { email: "microsoft-outlook@example.com", provider: Provider.microsoft, authMethod: AuthMethod.oauth },
];

async function seedAccounts() {
  for (const a of ACCOUNTS) {
    const isDestination =
      a.email.toLowerCase() === DEFAULT_DESTINATION_EMAIL.toLowerCase();
    await prisma.account.upsert({
      where: { email: a.email },
      update: { provider: a.provider, authMethod: a.authMethod, isDestination },
      create: {
        email: a.email,
        provider: a.provider,
        authMethod: a.authMethod,
        checkForConflicts: true,
        isDestination,
      },
    });
  }
  console.log(`Seeded ${ACCOUNTS.length} accounts (destination: ${DEFAULT_DESTINATION_EMAIL}).`);
}

async function seedSettings() {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { destinationEmail: DEFAULT_DESTINATION_EMAIL },
    create: { id: "singleton", destinationEmail: DEFAULT_DESTINATION_EMAIL },
  });
  console.log("Seeded Settings singleton.");
}

async function seedSleepBlock() {
  // 11pm -> 7am the next morning, daily. Anchored to a fixed reference date in
  // HOME_TZ; the RRULE (FREQ=DAILY) drives all future occurrences. Stored UTC.
  const startLocal = DateTime.fromObject(
    { year: 2026, month: 1, day: 1, hour: 23, minute: 0 },
    { zone: HOME_TZ }
  );
  const endLocal = startLocal.plus({ hours: 8 }); // 23:00 -> 07:00 next day

  const title = "Sleep";
  const existing = await prisma.personalBlock.findFirst({ where: { title } });
  if (existing) {
    console.log("Sleep block already present, skipping.");
    return;
  }
  await prisma.personalBlock.create({
    data: {
      title,
      startTime: startLocal.toUTC().toJSDate(),
      endTime: endLocal.toUTC().toJSDate(),
      timezone: HOME_TZ,
      recurrenceRule: "FREQ=DAILY",
    },
  });
  console.log("Seeded starter Sleep block (23:00–07:00 daily, home tz).");
}

// Staging/e2e only: a token-bearing destination account so createBooking's
// "destination connected" checks pass. The token is a placeholder — every real
// provider write is short-circuited by E2E_STUB_CALENDAR (see calendar/write.ts),
// so no Google/Microsoft call is ever made. checkForConflicts:false keeps it out
// of the free/busy aggregation (its stub token would fail a real read), so
// availability shows open slots for the e2e flow to book.
async function seedStubDestination() {
  if (process.env.E2E_STUB_CALENDAR !== "true") return;
  const email = "e2e-destination@example.com";
  await prisma.account.upsert({
    where: { email },
    update: {
      provider: Provider.google,
      authMethod: AuthMethod.oauth,
      isDestination: true,
      checkForConflicts: false,
      accessToken: "stub",
      refreshToken: "stub",
    },
    create: {
      email,
      provider: Provider.google,
      authMethod: AuthMethod.oauth,
      isDestination: true,
      checkForConflicts: false,
      accessToken: "stub",
      refreshToken: "stub",
    },
  });
  // Make it the sole destination so findFirst({ isDestination: true }) is deterministic.
  await prisma.account.updateMany({
    where: { email: { not: email }, isDestination: true },
    data: { isDestination: false },
  });
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { destinationEmail: email },
    create: { id: "singleton", destinationEmail: email },
  });
  console.log("Seeded stub destination account for E2E (E2E_STUB_CALENDAR).");
}

async function main() {
  await seedAccounts();
  await seedSettings();
  await seedSleepBlock();
  await seedStubDestination();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
