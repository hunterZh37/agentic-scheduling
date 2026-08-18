"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/// Eases its own height whenever `trigger` changes, so swapping the content
/// inside (e.g. the booking page's Pick-a-time ↔ Ask-the-assistant panels, which
/// are different heights) glides from the old height to the new one instead of
/// the container snapping. It animates the real `height` with the Web Animations
/// API, so it needs no fixed sizes and stays interruptible — a fast re-toggle
/// cancels the in-flight animation and re-aims from wherever it currently is.
/// Reduced motion skips the animation entirely.
export function AnimatedHeight({
  trigger,
  className,
  children,
}: {
  trigger: unknown;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prevHeight = useRef<number | null>(null);
  const anim = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // If a height animation is mid-flight, its current on-screen value is where
    // the next one should start — read it before cancelling so a fast toggle
    // redirects seamlessly rather than jumping to the old target first.
    const running = anim.current?.playState === "running";
    const live = running ? el.getBoundingClientRect().height : null;
    anim.current?.cancel();

    const to = el.offsetHeight; // natural height of the freshly-swapped content
    const from = running ? live! : prevHeight.current;
    prevHeight.current = to;

    if (from == null || Math.abs(from - to) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const prevOverflow = el.style.overflow;
    el.style.overflow = "hidden";
    const a = el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      // --dur-slow / --ease-emphasized, inlined (WAAPI can't read CSS vars).
      duration: 340,
      easing: "cubic-bezier(.32,.72,0,1)",
    });
    anim.current = a;
    a.onfinish = a.oncancel = () => {
      el.style.overflow = prevOverflow;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  // Keep the baseline current when the content resizes for its own reasons
  // (slots load, the chat grows), so the NEXT trigger animates from the true
  // height rather than a stale one.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!anim.current || anim.current.playState !== "running") {
        prevHeight.current = el.offsetHeight;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
