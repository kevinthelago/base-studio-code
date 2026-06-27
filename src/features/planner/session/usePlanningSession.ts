// usePlanningSession (#1642) — the planner's session-lifecycle state machine, extracted verbatim
// from Planning.tsx. Owns the `restarting` flag and the four lifecycle operations:
//   • regenerateWorkspace — rewrite CLAUDE.md + the context baseline for the CURRENT blueprint
//     version WITHOUT touching plan section files (shared by restart + "keep files").
//   • handleRestart       — kill the PTY, regenerate, and re-spawn `claude` with a fresh intro (#1240).
//   • keepPlanFiles       — adopt the new blueprint/template version on disk, clearing the staleness
//     WITHOUT wiping plan files or restarting into a destructive reconciliation (#827).
//   • doClearPlan         — delete on-disk plan files FIRST (awaited), wipe the store, unlink repos,
//     then restart with a blank slate (#664).
//   • doSwitchBlueprint   — re-seed the project onto another blueprint, wipe the old on-disk plan
//     files, then restart on the new blueprint (#1281).
//
// STRICTLY behaviour-preserving: the function bodies, the order of their awaited steps, and every
// store/invoke call are moved unchanged — only the closed-over values become hook parameters.

import { useState, type MutableRefObject } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import type { Terminal } from "@xterm/xterm";
import type { Dispatch, SetStateAction } from "react";
import { useAppStore } from "@/store";
import { plannerIntroMode, composePlannerIntro } from "./plannerIntro";

export interface PlanningSessionDeps {
  termRef: MutableRefObject<Terminal | null>;
  /** The planner tag-scan buffer — cleared on restart so a stale tag can't replay. */
  bufRef: MutableRefObject<string>;
  paneId: string;
  linkedRepos: string[];
  /** Whether the planner runs in the "operate" (existing-system) intro mode (#923). */
  treatAsExisting: boolean;
  /** Whether this project DESIGNS a blueprint (use the author intro, #923). */
  isAuthoring: boolean;
  activeProjectName: string;
  activeProjectNumber: number;
  planningPitch: string;
  effectiveProjectId: string;
  /** The blueprint's enabled stage ids — scopes the planner CLAUDE.md (#A). */
  stageIdsFor: (key: string) => string[];
  /** Re-read the baseline signature the backend last wrote (#756). */
  refreshSetupSig: () => void;
  setRepoLinkFullNames: Dispatch<SetStateAction<string[]>>;
  setShowBlueprintModal: Dispatch<SetStateAction<boolean>>;
  setShowClearConfirm: Dispatch<SetStateAction<boolean>>;
  setSwitchOpen: Dispatch<SetStateAction<boolean>>;
}

export interface PlanningSession {
  restarting: boolean;
  handleRestart: () => Promise<void>;
  keepPlanFiles: () => Promise<void>;
  doClearPlan: () => Promise<void>;
  doSwitchBlueprint: (targetId: string) => Promise<void>;
}

export function usePlanningSession(deps: PlanningSessionDeps): PlanningSession {
  const {
    termRef, bufRef, paneId, linkedRepos, treatAsExisting, isAuthoring,
    activeProjectName, activeProjectNumber, planningPitch, effectiveProjectId,
    stageIdsFor, refreshSetupSig, setRepoLinkFullNames,
    setShowBlueprintModal, setShowClearConfirm, setSwitchOpen,
  } = deps;

  const [restarting, setRestarting] = useState(false);

  // Regenerate the on-disk workspace (CLAUDE.md + the context baseline) for the CURRENT blueprint
  // version, WITHOUT touching the plan section files. Shared by the restart flow and the "keep
  // files" choice of the blueprint-update modal (#827). refreshSetupSig() rebaselines the
  // signature so the staleness clears.
  async function regenerateWorkspace(): Promise<{ planning_dir: string } | null> {
    const store = useAppStore.getState();
    const currentAutomations = [
      ...store.commands.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
      ...store.schedules.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
    ];
    const paths = await safeInvoke<{ planning_dir: string } | null>(
      "setup_workspaces",
      {
        repoFullNames: linkedRepos,
        automations: currentAutomations,
        isExisting: treatAsExisting,
        projectName: activeProjectName,
        projectNumber: activeProjectNumber,
        pitch: planningPitch,
        projectKey: effectiveProjectId,
        githubLogin: store.githubUser?.login ?? "",
        githubName:  store.githubUser?.name  ?? "",
        enabledStages: stageIdsFor(effectiveProjectId), // scope the planner CLAUDE.md (#A)
        authoring:   isAuthoring,                       // use the blueprint-author intro (#923)
      },
      null,
      (e: unknown) => console.error("workspace setup failed:", e),
    );
    refreshSetupSig(); // baseline updated (#756)
    return paths;
  }

  async function handleRestart() {
    const term = termRef.current;
    if (!term || restarting) return;
    setRestarting(true);
    bufRef.current = "";
    term.clear();
    await safeInvoke("pty_kill", { paneId: paneId }, undefined, console.error);
    const paths = await regenerateWorkspace();
    const token = useAppStore.getState().githubToken;
    const ghEnv = token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
    // A deliberate restart launches a brand-new `claude` — re-greet with the intro (#1240). No
    // fresh-only guard here: the user explicitly restarted, so fire it even though history exists.
    const introMode = plannerIntroMode({ isAuthoring, isExisting: treatAsExisting });
    const introText = await safeInvoke<string>("planner_intro_prompt", { mode: introMode }, "",
      (e: unknown) => console.error("planner intro prompt failed:", e));
    const startupPrompt = composePlannerIntro(introText, introMode, planningPitch ?? "") || undefined;
    await safeInvoke("pty_create", {
      paneId: paneId,
      cols: term.cols,
      rows: term.rows,
      cwd: paths?.planning_dir ?? "",
      initCmd: "claude",
      startupPrompt,
      env: ghEnv,
    }, undefined, console.error);
    setRestarting(false);
  }

  // "Keep the previous plan files" (#827): adopt the new blueprint/template version on disk and
  // clear the staleness, WITHOUT wiping plan files and WITHOUT restarting the planner into a
  // destructive reconciliation (the prior silent refresh let a fresh planner delete plan files).
  async function keepPlanFiles() {
    setShowBlueprintModal(false);
    await regenerateWorkspace();
  }

  // Clear/reset the plan (#664/#B) — delete the on-disk plan files FIRST (awaited, so the 2s
  // file poll can't re-read + re-populate the store), wipe the store, unlink the repos, then
  // restart the planner with a blank slate. (Restored: the refactor dropped this flow.)
  // Confirmation is the Dialog below (#…), not a native window.confirm.
  async function doClearPlan() {
    setShowClearConfirm(false);
    const store = useAppStore.getState();
    await safeInvoke("clear_project_plan_files", { projectKey: effectiveProjectId }, undefined, console.error);
    store.clearPlan(effectiveProjectId);
    store.setActiveProjectRepos([]);
    setRepoLinkFullNames([]);
    store.setPlanningContext(planningPitch, "");
    void handleRestart();
  }

  // Switch the project to another blueprint (#1281 — any → any other project blueprint, confirmed via
  // the switch modal; applyBlueprintToProject re-seeds the stage config + clears the old progress).
  // Wipe the on-disk plan files for the old stages, then restart the planner on the new blueprint.
  async function doSwitchBlueprint(targetId: string) {
    setSwitchOpen(false);
    const store = useAppStore.getState();
    const before = store.projectBlueprintId[effectiveProjectId];
    store.applyBlueprintToProject(effectiveProjectId, targetId);
    if (store.projectBlueprintId[effectiveProjectId] === before) return; // switch was refused — leave as-is
    await safeInvoke("clear_project_plan_files", { projectKey: effectiveProjectId }, undefined, console.error);
    store.setActiveProjectRepos([]);
    setRepoLinkFullNames([]);
    store.setPlanningContext(planningPitch, "");
    void handleRestart();
  }

  return { restarting, handleRestart, keepPlanFiles, doClearPlan, doSwitchBlueprint };
}
