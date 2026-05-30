// The always-on coordinator (#199): polls the coordination log and, when auto-wake is on,
// relaunches any session whose deps just landed. Idempotent (the `woke` event), gated on a
// recency window so an app restart can't relaunch long-abandoned parks, and bounded by an
// in-flight set so a slow wake isn't fired twice. Mount once (ConsoleScreen stays mounted
// across screens, so the coordinator runs regardless of the active screen).
import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { ingestCoordLog, wakePromptFor, isFreshlyReady, emptyCoordState } from "./coordination";
import { actuateWake } from "./coordinatorActuate";

const POLL_MS = 3000;
const FRESH_MS = 15 * 60 * 1000;

export function useCoordinator(): void {
  const inFlight = useRef<Set<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !useAppStore.getState().coordAutoWake) return;
      const lines = await invoke<string[]>("read_coord_log", { limit: 1000 }).catch(() => null);
      if (cancelled || !lines) return;
      const { state, ready } = ingestCoordLog(lines, emptyCoordState());
      const now = Date.now();
      for (const w of ready) {
        if (inFlight.current.has(w.session)) continue;
        if (!isFreshlyReady(w, state, now, FRESH_MS)) continue;
        inFlight.current.add(w.session);
        void actuateWake(w.session, wakePromptFor(w, state), useAppStore.getState().wakePane)
          .finally(() => inFlight.current.delete(w.session));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);
}
