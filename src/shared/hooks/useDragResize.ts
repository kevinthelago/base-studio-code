import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** Clamp `value` into the inclusive `[min, max]` range. */
export function clampSize(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface DragResizeOptions {
  /** Starting size in px. */
  initial: number;
  /** Lower bound in px. */
  min: number;
  /** Upper bound in px. */
  max: number;
  /** Which axis the handle drags along. */
  axis: "x" | "y";
  /**
   * Invert the delta. Use when the resized panel sits *after* the handle along
   * the axis (e.g. a right-hand panel grows as the pointer moves left).
   */
  invert?: boolean;
}

/**
 * Drag-to-resize state for a splitter handle. Spread `handleProps` onto the
 * divider element; `size` is the live, clamped dimension to apply to the panel.
 *
 * Uses pointer capture on the handle so the drag keeps tracking even when the
 * cursor leaves the thin divider — no global listeners to register or clean up.
 */
export function useDragResize({ initial, min, max, axis, invert = false }: DragResizeOptions) {
  const [size, setSize] = useState(() => clampSize(initial, min, max));
  // Pointer position + panel size captured at drag start; null when not dragging.
  const start = useRef<{ pos: number; size: number } | null>(null);

  const onPointerDown = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    start.current = { pos: axis === "x" ? e.clientX : e.clientY, size };
  }, [axis, size]);

  const onPointerMove = useCallback((e: ReactPointerEvent) => {
    if (!start.current) return;
    const cur = axis === "x" ? e.clientX : e.clientY;
    const delta = (cur - start.current.pos) * (invert ? -1 : 1);
    setSize(clampSize(start.current.size + delta, min, max));
  }, [axis, invert, min, max]);

  const onPointerUp = useCallback((e: ReactPointerEvent) => {
    start.current = null;
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
  }, []);

  return { size, setSize, handleProps: { onPointerDown, onPointerMove, onPointerUp } };
}
