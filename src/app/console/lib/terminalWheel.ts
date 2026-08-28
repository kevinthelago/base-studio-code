// Wheel containment for a terminal (#a-terminal-at-the-end-of-its-scrollback-still-zooms-the-graph).
//
// A wheel gesture that starts inside a terminal must never reach an ancestor that zooms — in Glance a
// terminal morph renders INSIDE `GraphCanvas` (`GlanceStreamMorph` → `GlanceChatDock` → `TerminalSlot`),
// and the canvas owns a non-passive wheel listener that turns every wheel it sees into a zoom.
//
// WHY THE CANVAS-SIDE GUARD CANNOT DO THIS, though it looks like it should. `overScrollableChild` in
// `@/shared/ui/layouts/useGraphViewport` yields the wheel to a descendant that scrolls, detected by
// BEHAVIOUR: `overflowY: auto|scroll|overlay` AND `scrollHeight > clientHeight`. That is the right test
// for a natively scrolling child, and the terminal is not one:
//
//   • xterm 6 scrolls SYNTHETICALLY. It wraps the terminal in VS Code's `SmoothScrollableElement`
//     (`.xterm-scrollable-element`) and paints a drawn scrollbar, so no element on the ancestor chain
//     ever reports real overflow. The guard asks a question the DOM answers "no" to, always.
//   • `.xterm-viewport` — the one element that still declares `overflow-y` — is built as a SIBLING of
//     `.xterm-screen` (xterm appends both to the same fragment), and the wheel target is inside
//     `.xterm-screen`. A target → ancestor walk cannot reach it even in principle.
//   • For the same reason `overscroll-behavior: contain` on `.xterm-viewport` is inert: there is no
//     native scroll for the browser to chain.
//
// WHAT MADE IT LOOK FIXED. `SmoothScrollableElement` calls `preventDefault()` + `stopPropagation()` only
// when the wheel ACTUALLY MOVED it — `alwaysConsumeMouseWheel` and `consumeMouseWheelIfScrollbarIsNeeded`
// are both unset (xterm's option literal passes neither, and its `_getChangeOptions()` supplies only
// scroll sensitivity and scrollbar width). So mid-scroll the gesture is consumed and the canvas never
// hears it — and at the TOP or BOTTOM of the scrollback xterm stops consuming, the wheel bubbles, and the
// graph zooms out from under a reader who has not changed what their hand is doing. That asymmetry is why
// the bug reads as "only at the end", and why two rounds of canvas-side fixes could not reach it.
//
// So the knowledge lives HERE, next to the `Terminal`, rather than in shared graph code that would have
// to name xterm to learn it.

/** The slice of xterm's `Terminal` this reads. Structural on purpose: it is the whole contract, so a test
 *  can stand one up without a renderer — which matters because jsdom cannot host a real xterm. */
export interface TerminalWheelState {
  /** Viewport height in rows. */
  rows: number;
  buffer: { active: { length: number; type: string } };
}

/**
 * Does this terminal own a wheel gesture over it?
 *
 * Two cases, and the exclusions are as deliberate as the inclusions:
 *
 *  • **There is scrollback** (`buffer.length > rows`) — the user is reading, and the gesture belongs to
 *    the terminal for its whole duration, including the notch that lands on the last line. Containment is
 *    not conditional on there being room LEFT: a direction-aware guard is what produced the original bug,
 *    because reaching the end handed the rest of the gesture to the canvas mid-read.
 *  • **The alternate buffer is active** — a full-screen application (vim, less, a TUI) owns its viewport
 *    by definition. It has no scrollback, so the first case would miss it and a wheel over a running TUI
 *    would zoom the graph.
 *
 * And NOT otherwise: a pane with nothing to scroll and no application in it does not claim the gesture, so
 * the wheel still zooms the canvas over a short log. That "a short log still feels like a canvas" case was
 * deliberate, it never depended on the direction check that was removed, and it survives here.
 */
export function terminalOwnsWheel(term: TerminalWheelState): boolean {
  const buf = term.buffer.active;
  return buf.type === "alternate" || buf.length > term.rows;
}

/**
 * Stop wheel gestures the terminal owns from reaching an ancestor. Returns the disposer.
 *
 * `stopPropagation`, never `preventDefault`: xterm's own scroll handling lives on a DESCENDANT of `el` and
 * has therefore already run by the time this fires, so cancelling the event here would break scrolling
 * outright. And never `stopImmediatePropagation` — other listeners on `el` itself (focus tracking, the
 * clipboard bridge) must still see it.
 *
 * The listener is passive-safe (it never calls `preventDefault`), so it is registered without options.
 */
export function containTerminalWheel(el: HTMLElement, term: TerminalWheelState): () => void {
  const onWheel = (e: WheelEvent) => {
    if (terminalOwnsWheel(term)) e.stopPropagation();
  };
  el.addEventListener("wheel", onWheel);
  return () => el.removeEventListener("wheel", onWheel);
}
