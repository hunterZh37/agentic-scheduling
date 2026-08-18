"use client";

import { useCallback, useEffect, useRef } from "react";
import { animateSpring, rubberband, shouldDismissSheet } from "./spring";
import { haptic } from "./haptics";

/// Find the scroll container the finger is actually on, walking up from the
/// touched node to (and including) the sheet. Returns null when nothing between
/// them scrolls — e.g. a drag that starts on the grab handle or header, which
/// should always dismiss. This is what lets one hook serve both a sheet that IS
/// its own scroller (the detail modal) and one whose scrolling lives in an inner
/// region (the booking times dialog).
function scrollerUnder(node: Element | null, boundary: Element | null): Element | null {
  let el: Element | null = node;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > el.clientHeight + 1) {
      return el;
    }
    if (el === boundary) break;
    el = el.parentElement;
  }
  return null;
}

/// Drag-to-dismiss for the mobile bottom sheet. Attach `ref` to the sheet card
/// (also its scroll container) and spread `handlers` onto it. The gesture:
///   - engages only when the sheet is scrolled to the top and the finger moves
///     down, so scrolling the sheet's own content still works normally;
///   - tracks the finger 1:1, resisting (rubber-band) if pulled upward;
///   - on release, projects the flick's momentum and either throws the sheet
///     closed (calling onDismiss) or springs it back home.
/// Transforms are written imperatively per frame (compositor-friendly, no React
/// re-render), and the whole thing no-ops when `enabled` is false (desktop),
/// leaving the centered dialog untouched.
export function useSheetDrag({ enabled, onDismiss }: { enabled: boolean; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const stopAnim = useRef<(() => void) | null>(null);

  // Live gesture state, kept in a ref so per-frame updates never re-render.
  const drag = useRef({
    active: false,
    committed: false, // past the point where we own the gesture (vs. native scroll)
    startY: 0,
    lastY: 0,
    lastT: 0,
    velocity: 0,
    offset: 0,
    pointerId: -1,
    scroller: null as Element | null,
  });

  const reducedMotion = () =>
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const setOffset = useCallback((y: number) => {
    drag.current.offset = y;
    const el = ref.current;
    if (el) el.style.transform = y === 0 ? "" : `translateY(${y}px)`;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || e.button !== 0) return;
      // Fingers/pens only take over the sheet; a mouse keeps normal behavior.
      if (e.pointerType === "mouse") return;
      stopAnim.current?.();
      stopAnim.current = null;
      const d = drag.current;
      d.active = true;
      d.committed = false;
      d.startY = d.lastY = e.clientY;
      d.lastT = performance.now();
      d.velocity = 0;
      d.pointerId = e.pointerId;
      // Which region (if any) scrolls under this finger — checked before we
      // steal the gesture, so content still scrolls and only a pull from the top
      // (or from non-scrolling chrome) dismisses.
      d.scroller = scrollerUnder(e.target as Element, ref.current);
    },
    [enabled]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (!d.active) return;
      const el = ref.current;
      if (!el) return;
      const dy = e.clientY - d.startY;

      const scrollTop = d.scroller ? d.scroller.scrollTop : 0;
      if (!d.committed) {
        // Only steal the gesture from the scroller once it's at its top and the
        // finger is heading down. Otherwise let content scroll.
        if (dy > 4 && scrollTop <= 0) {
          d.committed = true;
          try {
            el.setPointerCapture(d.pointerId);
          } catch {
            /* capture is best-effort */
          }
        } else if (dy < 0 || scrollTop > 0) {
          // Upward, or scrolling within content — abandon this as a drag.
          d.active = false;
          return;
        } else {
          return;
        }
      }

      // Track velocity over the last move for the release projection.
      const now = performance.now();
      const dt = now - d.lastT;
      if (dt > 0) d.velocity = ((e.clientY - d.lastY) / dt) * 1000;
      d.lastY = e.clientY;
      d.lastT = now;

      // Downward tracks 1:1; upward past home resists (rubber-band).
      const next = dy >= 0 ? dy : rubberband(dy, el.offsetHeight || 600);
      e.preventDefault();
      setOffset(next);
    },
    [setOffset]
  );

  const endDrag = useCallback(() => {
    const d = drag.current;
    if (!d.active) return;
    const el = ref.current;
    d.active = false;
    if (!d.committed || !el) return;
    d.committed = false;
    try {
      el.releasePointerCapture(d.pointerId);
    } catch {
      /* already released */
    }

    const height = el.offsetHeight || 600;
    const dismiss = shouldDismissSheet({ offset: d.offset, velocity: d.velocity, height });

    if (reducedMotion()) {
      // No spring under reduced motion: snap to the decision.
      if (dismiss) onDismiss();
      else setOffset(0);
      return;
    }

    if (dismiss) {
      haptic("commit");
      stopAnim.current = animateSpring(d.offset, height, {
        stiffness: 280,
        damping: 34,
        velocity: Math.max(d.velocity, 300),
        onUpdate: setOffset,
        onRest: onDismiss,
      });
    } else {
      // Spring home, carrying the release velocity so there's no seam. A small
      // tick marks the catch — the sheet grabbing back.
      haptic("select");
      stopAnim.current = animateSpring(d.offset, 0, {
        stiffness: 420,
        damping: 38,
        velocity: d.velocity,
        onUpdate: setOffset,
      });
    }
  }, [onDismiss, setOffset]);

  useEffect(() => () => stopAnim.current?.(), []);

  return {
    ref,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
