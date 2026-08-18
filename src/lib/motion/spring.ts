// Small, dependency-free motion primitives shared by the sheet, pane switch,
// and modal. The point is Apple-style *fluid* motion: animations start from the
// current on-screen value, carry the gesture's release velocity, project
// momentum forward, and resist softly at boundaries. See Apple's "Designing
// Fluid Interfaces" (WWDC 2018) — the formulas below are the ones from its
// sample code, not the physics-textbook approximations.

/// Project where a flick would come to rest, given its release velocity. This is
/// the scroll-deceleration curve iOS uses — a small fast flick throws far, a
/// slow drag barely coasts. `velocity` is px/s; the result is a *displacement*
/// in px to add to the current position.
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/// Progressive resistance past a boundary: the further you pull, the less the
/// surface follows, so it slows to a stop instead of hitting a wall. Returns the
/// damped offset to actually apply for a raw `overshoot` past the edge.
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(overshoot);
  const x = Math.abs(overshoot);
  return (sign * (x * dimension * constant)) / (dimension + constant * x);
}

/// Should a downward drag on a bottom sheet dismiss, or spring back? Dismiss when
/// the gesture is *going* past the halfway line — either already dragged far, or
/// flicked hard enough that its projected resting point clears the threshold.
/// Pure so it can be unit-tested; the hook just feeds it live numbers.
export function shouldDismissSheet(args: {
  offset: number; // current translateY, px (>= 0)
  velocity: number; // release velocity, px/s (+ = downward)
  height: number; // sheet height, px
}): boolean {
  const { offset, velocity, height } = args;
  // A decisive downward flick dismisses regardless of how far it got.
  if (velocity > 900) return true;
  // An upward flick always keeps it, even from low down.
  if (velocity < -300) return false;
  const projected = offset + project(velocity);
  return projected > height * 0.4;
}

type SpringOpts = {
  stiffness?: number;
  damping?: number;
  velocity?: number; // initial velocity, px/s
  onUpdate: (value: number) => void;
  onRest?: () => void;
};

/// Animate a scalar from `from` to `to` with a spring, starting at `velocity`.
/// Interruptible: returns a stop() that cancels the rAF. Defaults are critically
/// damped (no overshoot) — the graceful, non-distracting settle Apple uses for
/// repositioning. Callers wanting bounce lower the damping.
export function animateSpring(from: number, to: number, opts: SpringOpts): () => void {
  const stiffness = opts.stiffness ?? 320;
  const damping = opts.damping ?? 34;
  let value = from;
  let velocity = opts.velocity ?? 0;
  let raf = 0;
  let last = performance.now();
  let stopped = false;

  const step = (now: number) => {
    if (stopped) return;
    // Clamp dt so a backgrounded tab returning doesn't explode the integration.
    const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000));
    last = now;
    const force = -stiffness * (value - to) - damping * velocity;
    velocity += force * dt;
    value += velocity * dt;
    if (Math.abs(value - to) < 0.4 && Math.abs(velocity) < 24) {
      opts.onUpdate(to);
      opts.onRest?.();
      return;
    }
    opts.onUpdate(value);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
  };
}
