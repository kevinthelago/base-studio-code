// Fire one automation into its target pane (#937). Extracted from useScheduler so BOTH
// the scheduler tick and the mobile "run now" path dispatch identically — resolve the
// target pane, build the payload, write it, and record the run. No React here; the host
// (PTY write, store record, clock) is injected so it's unit-testable.

import { resolveTargetPane, dispatchPayload, type Automation, type AutomationRun, type TabLike, type BlockLike } from "./scheduler";
import { log } from "@/shared/lib/core/log";

export interface DispatchDeps {
  tabs: TabLike[];
  disabledPanes: Record<string, boolean>;
  kbBlocks: BlockLike[];
  /** Write into a pane (e.g. invoke("pty_write", …) + a trailing CR is added here). */
  write: (paneId: string, data: string) => Promise<void>;
  recordRun: (id: string, run: AutomationRun) => void;
  now: () => number;
}

/**
 * Dispatch `a` once, recording exactly one run (ok / skipped / fail). Never throws — a
 * write failure is captured as a failed run. Resolves after the run is recorded.
 */
export async function dispatchAutomation(a: Automation, deps: DispatchDeps): Promise<void> {
  const at = deps.now();
  const where = `${a.targetTab} › pane ${a.targetPaneIdx + 1}`;

  const paneId = resolveTargetPane(a.targetTab, a.targetPaneIdx, deps.tabs, deps.disabledPanes);
  if (!paneId) {
    deps.recordRun(a.id, { at, status: "skipped", note: `target ${where} not open` });
    return;
  }

  const payload = dispatchPayload(a, deps.kbBlocks);
  if (payload == null) {
    deps.recordRun(a.id, {
      at, status: "fail",
      note: a.action === "command" ? "empty command" : "knowledge block missing or empty",
    });
    return;
  }

  try {
    await deps.write(paneId, payload + "\r");
    deps.recordRun(a.id, {
      at, status: "ok",
      note: a.action === "command" ? `ran command in ${where}` : `loaded knowledge into ${where}`,
    });
  } catch (e) {
    log.error(`automation ${a.id} dispatch failed: ${e}`);
    deps.recordRun(a.id, { at, status: "fail", note: String(e) });
  }
}
