import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { dueAutomations } from "../lib/automations/scheduler";
import { dispatchAutomation } from "../lib/automations/dispatch";

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
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const s = useAppStore.getState();
      const deps = {
        tabs: s.tabs,
        disabledPanes: s.disabledPanes,
        kbBlocks: s.kbBlocks,
        write: (paneId: string, data: string) => invoke<void>("pty_write", { paneId, data }),
        recordRun: s.recordAutomationRun,
        now: () => Date.now(),
      };
      for (const a of dueAutomations(s.automations, Date.now())) {
        if (cancelled) return;
        await dispatchAutomation(a, deps);
      }
    }

    // A beat after mount (so the store has hydrated), then on a fixed interval.
    const initial = setTimeout(tick, 1000);
    const id = setInterval(tick, TICK_MS);
    return () => { cancelled = true; clearTimeout(initial); clearInterval(id); };
  }, []);
}
