// useLogStream (#3638) — the event-driven replacement for `usePoll` over a `bsc logs` stream. The
// frontend used to poll each unified log stream every ~1s; instead, the backend watcher
// (`observability::log_watch`) emits `logs://<stream>` when a stream file changes, and this hook
// re-reads (via the in-process `logs_*` commands, #3630) ONLY on that event. So reads happen on
// CHANGE, not on a clock — an idle app makes zero log reads.
//
// It keeps `usePoll`'s callback contract (an `isCancelled()` guard) so the pump bodies move over
// unchanged. A slow safety-net interval (default 60s) is the sole remaining "poll", a backstop against
// a missed change event — 60× rarer than the ~1s polls it replaces, and effectively silent.

import { useEffect, useRef, type DependencyList } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { usePoll } from "@/shared/hooks/usePoll";
import { logEventName } from "@/shared/lib/core/logsBridge";

interface LogStreamOptions {
  /** Safety-net re-read interval (ms) — a backstop against a missed change event. Default 60000. */
  safetyMs?: number;
  /** When false, don't subscribe or read at all — the caller-side gate (e.g. page visibility, #3627).
   *  Default true. */
  active?: boolean;
}

/**
 * Re-run `fn` when any of `streams` changes (the `logs://<stream>` event), plus once on mount and on a
 * slow safety-net interval. `fn` gets the same `isCancelled` guard as {@link usePoll}. Pass the read
 * alias(es) the body reads (`"coord"`, `"activity"`, `"audit"`, …) — canonicalized to match the emit.
 *
 * @param streams one stream alias, or several (a body that reads more than one stream re-runs on any).
 * @param fn the read/process body — identical shape to a `usePoll` callback.
 * @param deps re-subscribe deps (like `usePoll`'s).
 * @param opts `safetyMs` (backstop interval) and `active` (caller-side gate).
 */
export function useLogStream(
  streams: string | string[],
  fn: (isCancelled: () => boolean) => void | Promise<void>,
  deps: DependencyList = [],
  opts: LogStreamOptions = {},
): void {
  const { safetyMs = 60_000, active = true } = opts;
  const list = Array.isArray(streams) ? streams : [streams];
  const key = list.join(",");
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });

  // Initial read on mount + a slow backstop poll. `immediate` gives the current state right away;
  // `active:false` short-circuits both this and the subscription below.
  usePoll((isCancelled) => (active ? fnRef.current(isCancelled) : undefined), safetyMs, [key, active, ...deps]);

  // Re-read on any watched stream's change event.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    const uns: UnlistenFn[] = [];
    for (const s of list) {
      void listen(logEventName(s), () => { if (!cancelled) void fnRef.current(isCancelled); })
        .then((un) => { if (cancelled) un(); else uns.push(un); });
    }
    return () => { cancelled = true; uns.forEach((un) => un()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, ...deps]);
}
