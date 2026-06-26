// usePlannerRepoManagement (#1474) — the planner's headless repo auto-clone, extracted verbatim
// from Planning.tsx. Owns the `repoLinkFullNames` set (repos surfaced by <repo_link> tags during
// the session) and eagerly clones each linked / surfaced repo into the project dir as it appears,
// persisting the link in plan.db. Returns the set + its setter so the caller can feed the tag
// stream (which appends repo_link names) and reset on restart/clear, and derive publishRepos.

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";

export interface PlannerRepoManagement {
  /** Repos surfaced by <repo_link> tags emitted by Claude during this session. */
  repoLinkFullNames: string[];
  setRepoLinkFullNames: Dispatch<SetStateAction<string[]>>;
}

export function usePlannerRepoManagement(effectiveProjectId: string, effectiveRepos: string[]): PlannerRepoManagement {
  // Repos surfaced by <repo_link> tags emitted by Claude during this session.
  const [repoLinkFullNames, setRepoLinkFullNames] = useState<string[]>([]);

  // Eager auto-clone (#508): the visible repo strip was removed from the header, but its
  // clone engine lives on headlessly here. Each linked / <repo_link>-surfaced repo is cloned
  // into the project dir as soon as it appears, populating projectLocalRepos → linkedRepos →
  // setup_workspaces, so the planner can read repo contents during planning (triage launch
  // re-clones fail-soft, but that's too late for in-session context). Idempotent on the Rust side.
  const autoCloneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!effectiveProjectId) return;
    const repos = [...new Set([...effectiveRepos, ...repoLinkFullNames])];
    const cloned = new Set(useAppStore.getState().projectLocalRepos[effectiveProjectId] ?? []);
    for (const fullName of repos) {
      if (cloned.has(fullName) || autoCloneRef.current.has(fullName)) continue;
      autoCloneRef.current.add(fullName);
      invoke<string>("clone_repo", { project: effectiveProjectId, fullName })
        .then(() => {
          useAppStore.getState().addProjectRepo(effectiveProjectId, fullName);
          // Persist the link in the hub's plan.db (#1012) — durable across a store/app-state reset,
          // which the store-only persistence didn't survive.
          void invoke("plan_add_repo", { projectKey: effectiveProjectId, fullName }).catch(() => {});
        })
        .catch(e => console.error(`clone ${fullName} failed:`, e))
        .finally(() => autoCloneRef.current.delete(fullName));
    }
  }, [effectiveProjectId, effectiveRepos, repoLinkFullNames]);

  return { repoLinkFullNames, setRepoLinkFullNames };
}
