import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { dueAutomations } from "./lib/scheduler";
import { dispatchAutomation } from "./lib/dispatch";

/** How often the scheduler checks for due automations. */
const TICK_MS = 20_000;

/**
 * The Automations runtime (#142): a frontend tick that fires due, armed
 * automations and dispatches them into their target console pane via pty_write,
 * recording each run. Mounted once at the app root, so it runs regardless of the
 * active screen — but only while the app is open (which is also the only time
 * the target panes exist). Each fire reschedules itself (recordAutomationRun
 * recomputes nextRunAt), so a single tick fires a due automation exactly once.
 *
 * The per-automation dispatch is shared with the mobile "run now" path (#937) via
 * {@link dispatchAutomation}.
 */
export function useScheduler() {
  const tick = useCallback(async (isCancelled: () => boolean) => {
    const s = useAppStore.getState();
    const deps = {
      tabs: s.tabs,
      disabledPanes: s.disabledPanes,
      write: (paneId: string, data: string) => invoke<void>("pty_write", { paneId, data }),
      recordRun: s.recordAutomationRun,
      now: () => Date.now(),
    };
    for (const a of dueAutomations(s.automations, Date.now())) {
      if (isCancelled()) return;
      await dispatchAutomation(a, deps);
    }
  }, []);

  // A beat after mount (so the store has hydrated): the first tick. usePoll runs the rest on the
  // fixed interval (immediate:false — the grace tick covers mount, so the first interval tick is at TICK_MS).
  useEffect(() => {
    let cancelled = false;
    const initial = setTimeout(() => void tick(() => cancelled), 1000);
    return () => { cancelled = true; clearTimeout(initial); };
  }, [tick]);

  usePoll(tick, TICK_MS, [], { immediate: false });
}
