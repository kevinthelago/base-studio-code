// Staggered terminal instantiation (#3975) — keep the window navigable while a big fleet mounts.
//
// `TerminalView`'s mount effect constructs its terminal SYNCHRONOUSLY (`new Terminal` + `new FitAddon`
// + `term.open()`, each allocating a renderer and touching the DOM). A tab with 29 panes commits all
// 29 in one frame, on the thread that also paints the window — measured as a 6-second gap in the 2s
// perf sampler, i.e. nothing ran at all. It is not a render storm: the same windows report ONE React
// render, so the cost sits outside React entirely.
//
// This admits construction through a shared per-frame budget. The total work is unchanged; it just
// yields between batches, so the main thread can paint and handle input while the fleet comes up.
// 29 panes at 2/frame is ~15 frames (~250ms) of staggered work instead of one long block.
//
// Deliberately not lazy-on-visible: a fleet tab shows every pane at once, so visibility is not a
// useful filter, and deferring a pane the user is looking at is worse than a brief stagger.

/** Terminals admitted per frame once a burst is in flight. Two keeps a 29-pane tab under ~250ms while
 *  leaving most of each frame free for paint + input. */
export const PER_FRAME = 2;

type Waiter = () => void;

const queue: Waiter[] = [];
let pumping = false;

/** The frame scheduler. Injectable so tests can drive frames deterministically instead of waiting on
 *  a real rAF (jsdom's is timer-backed and would make the tests slow AND flaky). */
let schedule: (fn: () => void) => void =
  typeof requestAnimationFrame === "function"
    ? (fn) => { requestAnimationFrame(() => fn()); }
    : (fn) => { setTimeout(fn, 16); };

/** Swap the frame scheduler (tests). Returns the previous one so a test can restore it. */
export function setAdmissionScheduler(fn: (cb: () => void) => void): (cb: () => void) => void {
  const prev = schedule;
  schedule = fn;
  return prev;
}

/** Release up to {@link PER_FRAME} waiters, re-arming while any remain. */
function pump(): void {
  for (let i = 0; i < PER_FRAME; i++) {
    const next = queue.shift();
    if (!next) break;
    // `next` is a promise `resolve`, which cannot throw — so the queue drains regardless of what a
    // CONSUMER's `.then` does with its slot (that rejects the consumer's own chain, not this loop).
    // The guard is belt-and-braces for a future non-resolve waiter, not load-bearing today.
    try { next(); } catch { /* a consumer's failure is its own to report */ }
  }
  if (queue.length > 0) {
    schedule(pump);
    return;
  }
  pumping = false;
}

/**
 * Wait for a slot to construct a terminal. Resolves on a frame where the per-frame budget allows.
 *
 * A lone pane waits one frame (~16ms) — imperceptible, and worth not special-casing: an "first N are
 * immediate" fast path needs a counter that must then decay, and a stale counter would silently
 * un-stagger the next burst. One rule, no state to get wrong.
 */
export function admitTerminal(): Promise<void> {
  return new Promise<void>((resolve) => {
    queue.push(resolve);
    if (!pumping) {
      pumping = true;
      schedule(pump);
    }
  });
}

/** Pending admissions — for tests and diagnostics. */
export function pendingAdmissions(): number {
  return queue.length;
}

/** Drop every pending waiter WITHOUT resolving (tests only; a real drain must never strand a pane). */
export function resetAdmissionsForTest(): void {
  queue.length = 0;
  pumping = false;
}
