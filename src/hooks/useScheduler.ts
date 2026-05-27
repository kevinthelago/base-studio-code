import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { dueAutomations, resolveTargetPane, dispatchPayload } from "../lib/scheduler";
import { log } from "../lib/log";

/** How often the scheduler checks for due automations. */
const TICK_MS = 20_000;

/**
 * The Automations runtime (#142): a frontend tick that fires due, armed
 * automations and dispatches them into their target console pane via pty_write,
 * recording each run. Mounted once at the app root, so it runs regardless of the
 * active screen — but only while the app is open (which is also the only time
 * the target panes exist). Each fire reschedules itself (recordAutomationRun
 * recomputes nextRunAt), so a single tick fires a due automation exactly once.
 */
export function useScheduler() {
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const s = useAppStore.getState();
      for (const a of dueAutomations(s.automations, Date.now())) {
        const at = Date.now();
        const where = `${a.targetTab} › pane ${a.targetPaneIdx + 1}`;

        const paneId = resolveTargetPane(a.targetTab, a.targetPaneIdx, s.tabs, s.disabledPanes);
        if (!paneId) {
          s.recordAutomationRun(a.id, { at, status: "skipped", note: `target ${where} not open` });
          continue;
        }

        const payload = dispatchPayload(a, s.kbBlocks);
        if (payload == null) {
          s.recordAutomationRun(a.id, {
            at, status: "fail",
            note: a.action === "command" ? "empty command" : "knowledge block missing or empty",
          });
          continue;
        }

        try {
          await invoke("pty_write", { paneId, data: payload + "\r" });
          if (cancelled) return;
          s.recordAutomationRun(a.id, {
            at, status: "ok",
            note: a.action === "command" ? `ran command in ${where}` : `loaded knowledge into ${where}`,
          });
        } catch (e) {
          log.error(`automation ${a.id} dispatch failed: ${e}`);
          s.recordAutomationRun(a.id, { at, status: "fail", note: String(e) });
        }
      }
    }

    // A beat after mount (so the store has hydrated), then on a fixed interval.
    const initial = setTimeout(tick, 1000);
    const id = setInterval(tick, TICK_MS);
    return () => { cancelled = true; clearTimeout(initial); clearInterval(id); };
  }, []);
}
