// usePoll (#1494) — the one polling primitive. Replaces the ~identical
// `useEffect` + `setInterval` + `clearInterval` + cancelled-guard blocks scattered across the
// app (per-pane token usage, the idle reaper, worker audit, skills refresh, …).
//
// Contract, matching the hand-rolled blocks it replaces:
//  - runs `fn` once immediately, then every `ms` (pass `{ immediate: false }` to skip the first run
//    — e.g. the idle reaper, which must honor its grace window before the first tick);
//  - re-subscribes only when `ms` or `deps` change (the latest `fn` is always called via a ref, so
//    a fresh closure each render does NOT thrash the interval);
//  - on cleanup, clears the interval AND flips the `isCancelled()` the callback receives, so an
//    in-flight async `fn` can bail before it touches state after unmount.

import { useEffect, useRef, type DependencyList } from "react";

interface PollOptions {
  /** Run `fn` once immediately on mount / deps-change. Default true. */
  immediate?: boolean;
}

export function usePoll(
  fn: (isCancelled: () => boolean) => void | Promise<void>,
  ms: number,
  deps: DependencyList = [],
  opts: PollOptions = {},
): void {
  const { immediate = true } = opts;
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  useEffect(() => {
    let cancelled = false;
    let running = false; // #3666: don't RE-ENTER while the previous async run is still pending.
    const isCancelled = () => cancelled;
    const tick = () => {
      // A run that outlasts `ms` must NOT stack: overlapping runs pile invokes into the backend queue
      // (the planner's ~13 `bsc plan` reads per 2s tick jammed every pty_write, #3666). Skip a tick
      // while the previous async run is in flight; a sync (void-returning) `fn` is unaffected.
      if (running) return;
      const r = fnRef.current(isCancelled);
      if (r && typeof (r as Promise<unknown>).then === "function") {
        running = true;
        void (r as Promise<unknown>).finally(() => { running = false; });
      }
    };
    if (immediate) tick();
    const id = setInterval(tick, ms);
    return () => { cancelled = true; clearInterval(id); };
    // `fn` is intentionally read via ref, not a dep; callers declare their own deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, immediate, ...deps]);
}
