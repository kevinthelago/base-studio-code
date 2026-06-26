// useStageJson (#1530) — the data-collection focused panes' tiny fetch hook, split out of
// dataCollection.ts so that module stays React-free (pure types + parser).
//
// Loads a single planner-written JSON section by file stem (e.g. "collectTargets") for a
// project via `read_plan_sections`, re-reading when either input changes.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseStageJson, type StageJson } from "./dataCollection";

/**
 * Load a single planner-written JSON section by file stem (e.g. "collectTargets")
 * for `projectId`. Re-reads when either changes. A project with no such file yields
 * `{ data: null }` — the pane shows its empty state.
 */
export function useStageJson<T>(projectId: string | undefined, stem: string): StageJson<T> {
  const [state, setState] = useState<StageJson<T>>({ data: null, loading: !!projectId, error: null });

  useEffect(() => {
    if (!projectId) { setState({ data: null, loading: false, error: null }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    invoke<Record<string, string>>("read_plan_sections", { projectKey: projectId })
      .then((sections) => {
        if (!live) return;
        setState({ data: parseStageJson<T>(sections?.[stem]), loading: false, error: null });
      })
      .catch((e) => { if (live) setState({ data: null, loading: false, error: String(e) }); });
    return () => { live = false; };
  }, [projectId, stem]);

  return state;
}
