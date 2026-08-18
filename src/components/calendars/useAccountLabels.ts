"use client";

import { useEffect, useState } from "react";

/// A connected calendar as the UI should refer to it.
///
/// `email` is the identity — it keys the account's stable colour and must never
/// be substituted. `label` is what a person reads: the alias they set in the
/// Calendars manager, falling back to the address.
export interface AccountLabel {
  email: string;
  label: string;
}

/// Map the /api/accounts payload to display labels. Pure, so it can be tested
/// without rendering: the fallback is the whole point of the alias feature.
export function toAccountLabels(
  rows: Array<{ email: string; displayName?: string | null }>
): AccountLabel[] {
  return rows.map((a) => ({ email: a.email, label: a.displayName?.trim() || a.email }));
}

/// The connected calendars, named the way the owner named them.
///
/// Renaming a calendar to "consulting" used to change it in the Calendars
/// manager and nowhere else, because every other view fetched /api/accounts and
/// mapped straight to `a.email`, discarding `displayName`. An alias that only
/// applies where you typed it is not an alias. One hook, so a new view cannot
/// quietly reintroduce the raw address.
export function useAccountLabels(): AccountLabel[] {
  const [accounts, setAccounts] = useState<AccountLabel[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        setAccounts(toAccountLabels(d.accounts ?? []));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return accounts;
}
