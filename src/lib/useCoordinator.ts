// The always-on coordinator (#199): polls the coordination log and, when auto-wake is on,
// relaunches any session whose deps just landed. Idempotent (the `woke` event), gated on a
// recency window so an app restart can't relaunch long-abandoned parks, and bounded by an
// in-flight set so a slow wake isn't fired twice. Mount once (ConsoleScreen stays mounted
// across screens, so the coordinator runs regardless of the active screen).
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { ingestCoordLog, wakePromptFor, answerWakePrompt, isFreshlyReady, emptyCoordState } from "./coordination";
import { injectWake } from "./coordinatorActuate";

const POLL_MS = 1000;  // snappy: a director answer should wake the worker within ~1s
const FRESH_MS = 15 * 60 * 1000;

export function useCoordinator(): void {
  const inFlight = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      const lines = await invoke<string[]>("read_coord_log", { limit: 1000 }).catch(() => null);
      if (cancelled || !lines) return;
      const { state, ready, answered } = ingestCoordLog(lines, emptyCoordState());
      const now = Date.now();
      // A director answer (#369) always resumes the asking worker, recency-gated — this
      // is independent of the dependency auto-wake toggle, since deferring questions to
      // the director only works if its answer reliably wakes the worker.
      for (const a of answered) {
        if (inFlight.current.has(a.session)) continue;
        if (now - a.at >= FRESH_MS) continue;
        inFlight.current.add(a.session);
        void injectWake(a.session, answerWakePrompt(a))
          .finally(() => inFlight.current.delete(a.session));
      }
      if (!useAppStore.getState().coordAutoWake) return;
      for (const w of ready) {
        if (inFlight.current.has(w.session)) continue;
        if (!isFreshlyReady(w, state, now, FRESH_MS)) continue;
        inFlight.current.add(w.session);
        void injectWake(w.session, wakePromptFor(w, state))
          .finally(() => inFlight.current.delete(w.session));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}
