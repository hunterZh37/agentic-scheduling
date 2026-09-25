/// To-do list items under an actionable. Pure helpers shared by the API, the
/// carry-forward, the agent tools and the UI, so every surface counts and
/// reconciles a list the same way.
/// Spec: docs/superpowers/specs/2026-09-24-actionable-todo-lists-design.md

export interface ItemRow {
  id: string;
  title: string;
  done: boolean;
}

export interface IncomingItem {
  id?: string;
  title: string;
  done?: boolean;
}

export interface ItemDiff {
  create: { title: string; done: boolean; sortOrder: number }[];
  update: { id: string; title: string; done: boolean; sortOrder: number }[];
  delete: string[];
}

export const ITEM_TITLE_MAX = 200;

/// Reconcile the stored list with a full replacement list from the editor.
/// Position in `incoming` is the new sortOrder. An incoming id the todo does
/// not own is treated as a new item, never as a write to someone else's row.
export function diffItems(existing: ItemRow[], incoming: IncomingItem[]): ItemDiff {
  const owned = new Set(existing.map((e) => e.id));
  const seen = new Set<string>();
  const out: ItemDiff = { create: [], update: [], delete: [] };
  let sortOrder = 0;
  for (const inc of incoming) {
    const title = inc.title.trim().slice(0, ITEM_TITLE_MAX);
    if (!title) continue;
    const done = !!inc.done;
    if (inc.id && owned.has(inc.id) && !seen.has(inc.id)) {
      seen.add(inc.id);
      out.update.push({ id: inc.id, title, done, sortOrder: sortOrder++ });
    } else {
      out.create.push({ title, done, sortOrder: sortOrder++ });
    }
  }
  for (const e of existing) if (!seen.has(e.id)) out.delete.push(e.id);
  return out;
}

export function progress(items: { done: boolean }[]): { done: number; total: number } {
  return { done: items.filter((i) => i.done).length, total: items.length };
}

/// "1 of 3" for the agenda pill and the panel header; null when there is no
/// list, so the caller falls back to the plain "Actionable" tag.
export function progressLabel(p: { done: number; total: number }): string | null {
  return p.total === 0 ? null : `${p.done} of ${p.total}`;
}

// ---- Prisma-facing helpers (kept here so every reader serialises the same) --

/// `include` for a todo query that wants its list in order.
export const withItems = { items: { orderBy: { sortOrder: "asc" as const } } };

interface TodoWithItems {
  items: { id: string; title: string; done: boolean; sortOrder: number }[];
}

/// A todo row with its items, plus the derived progress. Spread onto the row
/// the API returns so `items` and `progress` are always present together.
export function withProgress<T extends TodoWithItems>(todo: T): T & { progress: { done: number; total: number } } {
  return { ...todo, progress: progress(todo.items) };
}

/// Validate a `items` field from a request body: an array of strings (new
/// items) or of `{id?, title, done?}` objects (replacement list). Returns the
/// normalised list or an error message.
export function parseIncomingItems(raw: unknown): { items: IncomingItem[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "items must be an array." };
  const items: IncomingItem[] = [];
  for (const r of raw) {
    if (typeof r === "string") {
      items.push({ title: r });
      continue;
    }
    if (!r || typeof r !== "object" || Array.isArray(r)) return { error: "each item must be a string or an object." };
    const o = r as Record<string, unknown>;
    if (typeof o.title !== "string") return { error: "each item needs a string title." };
    if (o.id !== undefined && typeof o.id !== "string") return { error: "item id must be a string." };
    if (o.done !== undefined && typeof o.done !== "boolean") return { error: "item done must be a boolean." };
    if (o.title.length > ITEM_TITLE_MAX) return { error: `item titles are at most ${ITEM_TITLE_MAX} characters.` };
    items.push({ id: o.id as string | undefined, title: o.title, done: o.done as boolean | undefined });
  }
  return { items };
}
