import { Provider, type Account } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getValidAccessToken } from "@/lib/oauth/store";
import { Interval } from "@/lib/availability/interval";
import { googleFreeBusy } from "./google";
import { microsoftGetSchedule } from "./microsoft";

export interface AccountBusyError {
  email: string;
  message: string;
}

export interface FanOutResult {
  busy: Interval[];
  /// Accounts that could not be queried (not connected, token failure, API
  /// error). Surfaced so callers can warn rather than silently under-report
  /// conflicts — under-reporting would let a booking land on a real conflict.
  errors: AccountBusyError[];
  /// Accounts actually included in the busy set.
  queried: string[];
}

async function busyForAccount(account: Account, start: Date, end: Date): Promise<Interval[]> {
  const token = await getValidAccessToken(account);
  if (account.provider === Provider.google) {
    return googleFreeBusy(token, ["primary"], start, end);
  }
  return microsoftGetSchedule(token, [account.email], start, end);
}

/// Fan out free/busy queries to every account with checkForConflicts=true.
/// Runs concurrently; a failing account is recorded, not fatal.
export async function fanOutBusy(start: Date, end: Date): Promise<FanOutResult> {
  const accounts = await prisma.account.findMany({
    where: { checkForConflicts: true },
  });

  const settled = await Promise.allSettled(
    accounts.map(async (a) => ({ email: a.email, busy: await busyForAccount(a, start, end) }))
  );

  const busy: Interval[] = [];
  const errors: AccountBusyError[] = [];
  const queried: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      queried.push(r.value.email);
      busy.push(...r.value.busy);
    } else {
      errors.push({
        email: accounts[i].email,
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  });

  return { busy, errors, queried };
}
