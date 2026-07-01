// The workflow conductor driver (#220 live wiring): polls the coordination log and, for
// each new stage event (a stage session's `bsc-landed`/`bsc-failed`), advances the
// matching run via driveOnEvent, persists it, and -- on a launch -- relaunches the run's
// dedicated `workflow · <item>` pane for the next stage (kill → mount, so it spawns fresh
// and role-scoped). Idempotent: it only processes NEW log lines, and driveOnEvent ignores
// any event whose run has already moved past that stage. Mount once (ConsoleWorkspace stays
// mounted across screens). Safe to run always — it only ever touches workflow panes.
import { useRef } from "react";
import { safeInvoke } from "../core/safeInvoke";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { parseCoordLine } from "./coordination";
import { driveOnEvent, type WorkflowRegistry } from "./workflowDriver";

const POLL_MS = 3000;

export function useWorkflowConductor(): void {
  const lastCount = useRef(0);
  usePoll(async (isCancelled) => {
    if (isCancelled()) return;
    const lines = await safeInvoke<string[] | null>("read_coord_log", { limit: 2000 }, null);
    if (isCancelled() || !lines) return;
    const runs = useAppStore.getState().workflowRuns;
    if (Object.keys(runs).length === 0) { lastCount.current = lines.length; return; }

    const fresh = lines.slice(lastCount.current);
    lastCount.current = lines.length;
    if (fresh.length === 0) return;

    let reg: WorkflowRegistry = { runs: { ...runs } };
    const toLaunch: string[] = [];
    for (const line of fresh) {
      const ev = parseCoordLine(line);
      if (!ev) continue;
      const { registry, result } = driveOnEvent(reg, ev);
      reg = registry;
      if (result?.kind === "launch" && !toLaunch.includes(result.run.state.item)) {
        toLaunch.push(result.run.state.item);
      }
    }
    // Persist all advanced runs, then relaunch each advanced item's pane for its new
    // stage (kill first so the runId-bump remount spawns a fresh, role-scoped session).
    useAppStore.getState().workflowSetRuns(reg.runs);
    for (const item of toLaunch) {
      const tabs = useAppStore.getState().tabs;
      const idx = tabs.findIndex((t) => t.name === `workflow · ${item}`);
      if (idx >= 0) await safeInvoke("pty_kill", { paneId: `t${idx}p0` }, undefined);
      useAppStore.getState().workflowMount(item);
    }
  }, POLL_MS, []);
}
