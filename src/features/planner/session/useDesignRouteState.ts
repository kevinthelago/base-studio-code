// useDesignRouteState (#2121) — polls a project's staged design manifest (`design/intake.json`) and
// reports whether any files are staged (`hasFiles`) and whether any staged file has CHANGED since it
// was last routed (content-hash diff via `changedDesignFiles`). Drives the UI stage's conditional
// footer: it offers "route design to project" ONLY when files are staged and the design is
// missing/stale (#2860); with nothing staged it reverts to "approve & continue". Read-only +
// non-fatal — a missing manifest reports no files, nothing changed.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePoll } from "@/shared/hooks/usePoll";
import { parseIntake, changedDesignFiles, INTAKE_DIR } from "../lib/fileIntake";

/** The staged-design snapshot the UI stage footer reads (#2860). */
export interface DesignRouteState {
  /** At least one design file is staged in `design/intake.json`. */
  hasFiles: boolean;
  /** At least one staged file differs from its last-routed hash (new or edited since routed). */
  changed: boolean;
}

/**
 * Whether the UI stage's footer should offer "route design to project" (#2860). True only when the
 * project needs a UI, there ARE staged files to route (`hasFiles`), AND either the design isn't
 * routed yet (`ui` section unconfirmed) or a staged file changed since the last route. **No staged
 * files ⇒ false** — the fix for the dead route button on a fresh UI stage with nothing to route.
 * Pure — unit-tested.
 */
export function uiNeedsRouting(requiresUi: boolean, uiConfirmed: boolean, design: DesignRouteState): boolean {
  return requiresUi && design.hasFiles && (!uiConfirmed || design.changed);
}

/**
 * @param projectKey  the project hub key whose `design/intake.json` is polled.
 * @param active      only poll while the UI stage is relevant (blueprint enables `ui`); false → idle.
 * @returns whether any files are staged and whether any staged file is unrouted/stale.
 */
export function useDesignRouteState(projectKey: string, active: boolean): DesignRouteState {
  const [state, setState] = useState<DesignRouteState>({ hasFiles: false, changed: false });
  usePoll(async (isCancelled) => {
    if (!active || !projectKey) { setState({ hasFiles: false, changed: false }); return; }
    try {
      const files = await invoke<[string, string][]>("read_project_files", { projectKey, subdir: INTAKE_DIR });
      if (isCancelled()) return;
      const manifest = files.find(([rel]) => rel === "intake.json")?.[1];
      const entries = manifest ? parseIntake(manifest) : [];
      setState({ hasFiles: entries.length > 0, changed: changedDesignFiles(entries).length > 0 });
    } catch {
      if (!isCancelled()) setState({ hasFiles: false, changed: false });
    }
  }, 2500, [projectKey, active]);
  return state;
}
