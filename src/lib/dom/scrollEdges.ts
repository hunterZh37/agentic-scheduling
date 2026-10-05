"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/// Whether a scroller has content beyond its top or bottom edge. A few pixels
/// of slack so the fade does not flicker on the last pixel of a scroll.
export function scrollEdges(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): {
  above: boolean;
  below: boolean;
} {
  const slack = 4;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= slack) return { above: false, below: false };
  return { above: el.scrollTop > slack, below: el.scrollTop < max - slack };
}

/// Watch a scroll container: given its ref, returns the two edge flags, kept
/// current on scroll, on resize of the scroller or any row, and on rows being
/// added or removed. `dep` exists for one reason: a ref object never changes
/// identity, so when the scroller itself mounts later (an empty state gives
/// way to a list) the effect must be re-run; pass whatever decides that
/// render. Render the flags as data attributes and let CSS draw the fade
/// (`.scrollEdges` in globals.css).
export function useScrollEdges(ref: RefObject<HTMLElement | null>, dep: unknown): { above: boolean; below: boolean } {
  const [edges, setEdges] = useState({ above: false, below: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const next = scrollEdges(el);
      setEdges((prev) => (prev.above === next.above && prev.below === next.below ? prev : next));
    };
    el.addEventListener("scroll", measure, { passive: true });
    // The scroller's own box, and every direct child: a row that wraps to a
    // second line changes scrollHeight without resizing the scroller.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    const observeChildren = () => {
      if (!ro) return;
      ro.disconnect();
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    observeChildren();
    // Rows added or removed below the fold: re-observe and re-measure.
    const mo =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            observeChildren();
            measure();
          })
        : null;
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    const raf = requestAnimationFrame(measure);
    return () => {
      el.removeEventListener("scroll", measure);
      ro?.disconnect();
      mo?.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref, dep]);

  return edges;
}
