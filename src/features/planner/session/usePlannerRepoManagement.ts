// usePlannerRepoManagement (#1474) — the planner's headless repo auto-clone, extracted verbatim
// from Planning.tsx. Eagerly clones each linked repo into the project dir as it appears, persisting
// the link in plan.db. The linked set is DB-owned: the planner runs `bsc plan repo add owner/repo`,
// the section poll reflects `plan_list_repos` into `effectiveRepos`, and this effect clones each new
// entry. Side-effect only — returns nothing.

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { bscRun } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";

export function usePlannerRepoManagement(effectiveProjectId: string, effectiveRepos: string[]): void {
  // Eager auto-clone (#508): the visible repo strip was removed from the header, but its clone
  // engine lives on headlessly here. Each linked repo (surfaced via the plan.db poll) is cloned
  // into the project dir as soon as it appears, populating projectLocalRepos → linkedRepos →
  // setup_workspaces, so the planner can read repo contents during planning (triage launch
  // re-clones fail-soft, but that's too late for in-session context). Idempotent on the Rust side.
  const autoCloneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!effectiveProjectId) return;
    const cloned = new Set(useAppStore.getState().projectLocalRepos[effectiveProjectId] ?? []);
    for (const fullName of effectiveRepos) {
      if (cloned.has(fullName) || autoCloneRef.current.has(fullName)) continue;
      autoCloneRef.current.add(fullName);
      invoke<string>("clone_repo", { project: effectiveProjectId, fullName })
        .then(() => {
          useAppStore.getState().addProjectRepo(effectiveProjectId, fullName);
          // Persist the link in the hub's plan.db (#1012) — durable across a store/app-state reset,
          // which the store-only persistence didn't survive.
          void bscRun(effectiveProjectId, ["plan", "repo", "add", fullName]);
        })
        .catch(e => console.error(`clone ${fullName} failed:`, e))
        .finally(() => autoCloneRef.current.delete(fullName));
    }
  }, [effectiveProjectId, effectiveRepos]);
}
