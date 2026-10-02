/// The Schedule pane's layout preference, "sections" or "timeline", as an
/// external store over localStorage for useSyncExternalStore: the server and
/// the first client render both see "sections", the stored choice applies on
/// hydration without a state-in-effect, and a change in one tab reaches the
/// others through the storage event.

export type ScheduleView = "sections" | "timeline";

const KEY = "schedule.view";
const listeners = new Set<() => void>();

function read(): ScheduleView {
  try {
    return window.localStorage.getItem(KEY) === "timeline" ? "timeline" : "sections";
  } catch {
    return "sections";
  }
}

export const scheduleView = {
  get: read,
  getServer: (): ScheduleView => "sections",
  set(v: ScheduleView): void {
    try {
      window.localStorage.setItem(KEY, v);
    } catch {
      /* storage blocked: the choice lasts for this page only */
    }
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void): () => void {
    listeners.add(l);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) l();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener("storage", onStorage);
    };
  },
};
