// useDockEntrance (#2905) — the session dock's ENTRANCE GROW. Replaces the CSS slide/fade
// (`session-dock-in`, #2837), which animated only transform/opacity: it never changed layout size, so it
// never resized the xterm and needed a fragile post-animation "settle fit". This animates the dock's REAL
// height up into place via the caller's `useDragResize` setter, so the height change itself drives the
// terminal's ResizeObserver fit — no transform, no settle hack.
//
// Runs before paint (useLayoutEffect) so the grow starts small with no full-height flash, and steps by a
// frame COUNT rather than wall-clock so the synchronous `requestAnimationFrame` stub in tests terminates.
// A reduced-motion viewer jumps straight to the resting height.
import { useLayoutEffect } from "react";

/** easeOutCubic — fast start, gentle settle. */
const ease = (x: number): number => 1 - Math.pow(1 - x, 3);
/** Frames the grow spans (~340ms at 60fps). */
const FRAMES = 20;

/**
 * Animate `setSize` from a fraction of `target` up to `target` once, on mount — the dock entrance grow.
 * `setSize` is the `useDragResize` setter (unclamped) and `target` is the resting dock height (px).
 */
export function useDockEntrance(setSize: (n: number) => void, target: number): void {
  useLayoutEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    const from = Math.round(target * 0.35);
    if (reduce || from >= target || typeof requestAnimationFrame !== "function") {
      setSize(target);
      return;
    }
    setSize(from); // before paint (useLayoutEffect) → the grow starts small, no full-height flash
    let frame = 0;
    let raf = 0;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      frame += 1;
      const p = Math.min(1, frame / FRAMES);
      setSize(p >= 1 ? target : Math.round(from + (target - from) * ease(p)));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount
}
