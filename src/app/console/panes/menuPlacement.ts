// Pane-header menu placement (#1374). The pane menu opens from a trigger button and is portaled
// to <body> as a fixed-position element. The old logic measured only vertical space and was
// hard-anchored to the button's RIGHT edge (always opening leftward) without ever measuring the
// menu's width — so a trigger near the left of the screen pushed the menu off the left edge.
//
// `placeMenu` is pure (rects in, coordinates out) so every clip case is unit-testable. It picks a
// top/left that keeps the menu fully on-screen with a margin on all four sides, and caps the
// height to the available vertical space (the menu scrolls past that).

export interface BoxRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** Max height the menu may use (it scrolls beyond this); always ≥ 0. */
  maxHeight: number;
}

export interface PlaceOpts {
  /** Min gap to each viewport edge. */
  margin?: number;
  /** Gap between the trigger and the menu. */
  gap?: number;
}

/**
 * Position a menu relative to its trigger, clamped fully into the viewport.
 *
 * Vertical: open below the trigger when the menu fits there or there's more room below than
 * above; otherwise open above. The returned `maxHeight` caps the menu to the chosen side's space.
 *
 * Horizontal: align the menu's right edge to the trigger's right edge (the established look —
 * opens leftward from a right-side trigger), then clamp `left` into `[margin, vw - width - margin]`
 * so it never clips off either edge. If the menu is wider than the viewport, it pins to `margin`.
 */
export function placeMenu(
  button: BoxRect,
  menu: Size,
  viewport: Viewport,
  opts: PlaceOpts = {},
): MenuPlacement {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 4;
  const vw = viewport.width;
  const vh = viewport.height;

  // ── vertical ──
  const spaceBelow = vh - button.bottom - gap - margin;
  const spaceAbove = button.top - gap - margin;
  let top: number;
  let maxHeight: number;
  if (spaceBelow >= menu.height || spaceBelow >= spaceAbove) {
    // Below: fits, or below simply has more room than above.
    top = button.bottom + gap;
    maxHeight = Math.max(0, spaceBelow);
  } else {
    // Above: anchor the menu's bottom just above the trigger, clamped to the top margin.
    maxHeight = Math.max(0, spaceAbove);
    const h = Math.min(menu.height, maxHeight);
    top = Math.max(margin, button.top - gap - h);
  }

  // ── horizontal ── prefer right-aligned to the trigger, then clamp into the viewport.
  const maxLeft = vw - menu.width - margin;
  let left = button.right - menu.width;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;

  return { left, top, maxHeight };
}
