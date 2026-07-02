// useDesignRouteState (#2121) — polls a project's staged design manifest (`design/intake.json`) and
// reports whether any staged file has CHANGED since it was last routed (content-hash diff via
// `changedDesignFiles`). Drives the UI stage's conditional footer: while the design is missing/stale
// the footer offers "route design to project"; once routed-and-current it reverts to "approve &
// continue". Read-only + non-fatal — a missing manifest simply reports "nothing changed".
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePoll } from "@/shared/hooks/usePoll";
import { parseIntake, changedDesignFiles, INTAKE_DIR } from "../lib/fileIntake";

/**
 * @param projectKey  the project hub key whose `design/intake.json` is polled.
 * @param active      only poll while the UI stage is relevant (blueprint enables `ui`); false → idle.
 * @returns whether at least one staged design file differs from its last-routed hash.
 */
export function useDesignRouteState(projectKey: string, active: boolean): boolean {
  const [changed, setChanged] = useState(false);
  usePoll(async (isCancelled) => {
    if (!active || !projectKey) { setChanged(false); return; }
    try {
      const files = await invoke<[string, string][]>("read_project_files", { projectKey, subdir: INTAKE_DIR });
      if (isCancelled()) return;
      const manifest = files.find(([rel]) => rel === "intake.json")?.[1];
      const entries = manifest ? parseIntake(manifest) : [];
      setChanged(changedDesignFiles(entries).length > 0);
    } catch {
      if (!isCancelled()) setChanged(false);
    }
  }, 2500, [projectKey, active]);
  return changed;
}
