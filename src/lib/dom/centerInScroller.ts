/// Centre an element inside ONE scroll container by setting that container's
/// own scrollTop. `el.scrollIntoView()` cannot be used for this: it scrolls
/// every scrollable ancestor toward the element, so centring the now-line in
/// the Today list also scrolled the pane behind it, and the list's overscroll
/// containment then kept the pane from ever scrolling back. See
/// docs/REGRESSIONS.md.

interface ScrollerLike {
  scrollTop: number;
  clientHeight: number;
  getBoundingClientRect(): { top: number };
}

interface ElementLike {
  offsetHeight: number;
  getBoundingClientRect(): { top: number };
}

/// The scrollTop that puts `el` in the middle of `list`'s viewport.
export function centeredScrollTop(list: ScrollerLike, el: ElementLike): number {
  const offsetInList = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
  return Math.max(0, Math.round(offsetInList - (list.clientHeight - el.offsetHeight) / 2));
}

/// The closest ancestor that actually scrolls vertically. `getStyle` is
/// injectable so the walk is testable without a DOM.
export function nearestScroller<T extends { parentElement: T | null }>(
  el: { parentElement: T | null },
  getStyle: (n: T) => { overflowY: string }
): T | null {
  let n = el.parentElement;
  while (n) {
    const o = getStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
    n = n.parentElement;
  }
  return null;
}
