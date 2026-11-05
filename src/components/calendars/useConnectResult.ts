"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { readConnectResult, type ConnectResult } from "@/lib/oauth/connectResult";

/// What the calendar-connect callback reported when it sent the person back to
/// this page (`?oauth=google&status=…`), or null on an ordinary load.
///
/// Read once per mount and held, because the query string is cleaned straight
/// away so a reload or a shared link does not repeat the message. The server
/// render always sees null; the browser's value arrives after hydration, which
/// is what useSyncExternalStore is for.
function createStore() {
  let read = false;
  let value: ConnectResult | null = null;
  return {
    subscribe: () => () => {},
    get: () => {
      if (!read) {
        read = true;
        value = readConnectResult(window.location.search);
      }
      return value;
    },
  };
}

export function useConnectResult(): ConnectResult | null {
  const [store] = useState(createStore);
  const result = useSyncExternalStore(store.subscribe, store.get, () => null);
  useEffect(() => {
    if (!result) return;
    // Keep the router's own history state; only the query string goes.
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }, [result]);
  return result;
}
