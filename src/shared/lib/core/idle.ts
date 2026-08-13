// Idle scheduling (#graph-health-stops-blocking-first-paint) — run work AFTER the browser has painted,
// for derivations the user cannot see yet.
//
// The case this was written for: the Design Studio computed its graph-health findings in a `useMemo` on
// the render path, so ~121ms of analysis over 459 components ran BEFORE a single node reached the screen —
// twice per open. The findings drive corner badges and a toolbar count, and nothing about the graph's
// structure, layout or interactivity depends on them. Paint first; decorate after.
//
// WHY A TIMEOUT IS NOT OPTIONAL. `requestIdleCallback` with no deadline can be starved indefinitely on a
// busy main thread — which is exactly the condition a graph page is in while it mounts, so the work most
// worth deferring is also the work most likely never to run. The timeout converts "when convenient" into
// "soon, and at the latest by then".

/** How long idle work may wait before it runs regardless. Long enough to clear a first paint, short
 *  enough that a badge never feels missing. */
export const IDLE_TIMEOUT_MS = 200;

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/**
 * Run `fn` once the main thread is idle (or after `timeoutMs`, whichever comes first). Returns a CANCEL
 * function — call it from an effect cleanup so a superseded computation never lands after its inputs
 * changed.
 *
 * Falls back to `setTimeout` where `requestIdleCallback` is absent (jsdom, Safari historically, an
 * embedded shell). The fallback is deliberately not a no-op: the work still has to happen, it just loses
 * the "wait for a genuinely quiet moment" refinement. Degrading to "never computed" would trade a
 * performance win for a missing feature.
 */
export function runWhenIdle(fn: () => void, timeoutMs: number = IDLE_TIMEOUT_MS): () => void {
  const w = globalThis as unknown as IdleWindow;
  if (typeof w.requestIdleCallback === "function") {
    const handle = w.requestIdleCallback(fn, { timeout: timeoutMs });
    return () => w.cancelIdleCallback?.(handle);
  }
  const t = setTimeout(fn, timeoutMs);
  return () => clearTimeout(t);
}
