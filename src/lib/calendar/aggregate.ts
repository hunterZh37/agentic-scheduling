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

/// Fan out free/busy queries to the accounts with checkForConflicts=true that
/// belong to ONE subject: the owner (coHostId=null, the default) or a specific
/// co-host. Runs concurrently; a failing account is recorded, not fatal.
///
/// The coHostId scope is load-bearing, not cosmetic: the public booking page
/// resolves the OWNER's free/busy, and a co-host's connected calendar must
/// never subtract from it. Without this filter, the moment any co-host connects
/// a calendar their busy times would silently shrink the owner's bookable time
/// — the same "someone else's data takes the booking page down" failure the
/// project has already been bitten by once. See docs/REGRESSIONS.md.
export async function fanOutBusy(
  start: Date,
  end: Date,
  coHostId: string | null = null
): Promise<FanOutResult> {
  const accounts = await prisma.account.findMany({
    where: { checkForConflicts: true, coHostId },
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
