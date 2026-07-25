// usePlanningSession (#1642) — the planner's session-lifecycle state machine, extracted verbatim
// from Planning.tsx. Owns the `restarting` flag and the four lifecycle operations:
//   • regenerateWorkspace — rewrite CLAUDE.md + the context baseline for the CURRENT blueprint
//     version WITHOUT touching plan section files (shared by restart + "keep files").
//   • handleRestart       — kill the PTY, regenerate, and re-spawn `claude`. Resume-capable by
//     default (#2396); the destructive ops pass `fresh: true` for a brand-new session (#1240).
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
import { plannerLaunchConfig } from "./plannerLaunch";
import { resolvePlannerSandbox } from "./plannerSandbox";

export interface PlanningSessionDeps {
  termRef: MutableRefObject<Terminal | null>;
  /** The planner tag-scan buffer — cleared on restart so a stale tag can't replay. */
  bufRef: MutableRefObject<string>;
  paneId: string;
  linkedRepos: string[];
  /** Whether the planner runs in the "operate" (existing-system) intro mode (#1286). */
  treatAsExisting: boolean;
  activeProjectName: string;
  activeProjectNumber: number;
  planningPitch: string;
  effectiveProjectId: string;
  /** The blueprint's enabled stage ids — scopes the planner CLAUDE.md (#A). */
  stageIdsFor: (key: string) => string[];
  /** Re-read the baseline signature the backend last wrote (#756). */
  refreshSetupSig: () => void;
  setShowBlueprintModal: Dispatch<SetStateAction<boolean>>;
  setShowClearConfirm: Dispatch<SetStateAction<boolean>>;
  setSwitchOpen: Dispatch<SetStateAction<boolean>>;
}

export interface PlanningSession {
  restarting: boolean;
  handleRestart: (opts?: { fresh?: boolean }) => Promise<void>;
  keepPlanFiles: () => Promise<void>;
  doClearPlan: () => Promise<void>;
  doSwitchBlueprint: (targetId: string) => Promise<void>;
}

export function usePlanningSession(deps: PlanningSessionDeps): PlanningSession {
  const {
    termRef, bufRef, paneId, linkedRepos, treatAsExisting,
    activeProjectName, activeProjectNumber, planningPitch, effectiveProjectId,
    stageIdsFor, refreshSetupSig,
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
      },
      null,
      (e: unknown) => console.error("workspace setup failed:", e),
    );
    refreshSetupSig(); // baseline updated (#756)
    return paths;
  }

  // Relaunch the planner session (#2396). RESUME-CAPABLE by default — the launch mirrors the mount
  // path exactly (`claude --continue || claude` + the fresh-only intro guard + a resume request), so
  // a non-destructive relaunch (sandbox-toggle flip, reopening a project) continues the prior
  // conversation instead of starting over. The destructive ops (clear-plan / switch-blueprint) pass
  // `fresh: true` to launch a genuinely NEW session — plain `claude`, re-greeted with the intro even
  // though history exists (#1240), since the plan that conversation referred to was just wiped.
  async function handleRestart(opts?: { fresh?: boolean }) {
    const fresh = opts?.fresh === true;
    const term = termRef.current;
    if (!term || restarting) return;
    setRestarting(true);
    bufRef.current = "";
    term.clear();
    await safeInvoke("pty_kill", { paneId: paneId }, undefined, console.error);
    const paths = await regenerateWorkspace();
    const token = useAppStore.getState().githubToken;
    const ghEnv: Record<string, string> = token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
    // The intro rides along on every restart: a `fresh` restart always fires it (#1240 — the user
    // wiped the plan, so re-greet even though history exists); the default resume restart keeps the
    // fresh-only guard, so a returning user with history resumes quietly instead of being re-greeted.
    const introMode = plannerIntroMode({ isExisting: treatAsExisting });
    const introText = await safeInvoke<string>("planner_intro_prompt", { mode: introMode }, "",
      (e: unknown) => console.error("planner intro prompt failed:", e));
    // Relaunch on the selected harness (Claude Code or bsc-agent for any LLM, incl. a forced
    // local/ollama provider), carrying the plan-only role gate + provider/model/MCP via BSC_AGENT_*
    // env so a restarted local-model planner keeps the same context, prompt, state, and permissions.
    const launch = plannerLaunchConfig(useAppStore.getState(), ghEnv);
    // bsc-agent (one-shot) never gets stage 1's directive via runtime injection — bake it into the
    // intro so a weak local model begins the stage instead of waiting to be advanced (#qwen).
    let firstStageDirective: string | undefined;
    if (launch.providerId === "bsc-agent") {
      const firstStage = stageIdsFor(effectiveProjectId)[0];
      if (firstStage) {
        firstStageDirective = await safeInvoke<string>(
          "planner_stage_directive", { id: firstStage }, "",
          (e: unknown) => console.error("planner stage directive failed:", e),
        ) || undefined;
      }
    }
    const startupPrompt = composePlannerIntro(introText, introMode, planningPitch ?? "", firstStageDirective) || undefined;
    // #1988: honor the sandbox toggle on a restart too — shared with the mount path (plannerSandbox).
    // This is the path a sandbox-toggle flip relaunches through, so it MUST convert into/out of the cage
    // (a restart used to always spawn on the host, silently dropping a planner out of the sandbox).
    const sandbox = await resolvePlannerSandbox(launch.providerId, paths?.planning_dir ?? "", effectiveProjectId);
    await safeInvoke("pty_create", {
      paneId: paneId,
      cols: term.cols,
      rows: term.rows,
      cwd: sandbox.cwd,
      // Default (resume): the harness's own launch — for Claude the `--continue || claude` chain —
      // with the fresh-only intro guard + resume request, exactly like the mount path (#2396).
      // Destructive (`fresh`): plain `claude` + an always-firing intro, so the session starts over.
      initCmd: fresh && launch.providerId !== "bsc-agent" ? "claude" : launch.initCmd,
      startupPrompt,
      startupPromptFreshOnly: fresh ? false : launch.startupPromptFreshOnly,
      continueSession: fresh ? false : launch.continueSession,
      env: launch.env,
      providerId: launch.providerId,
      wslDistro: sandbox.wslDistro,
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
    store.setPlanningContext(planningPitch, "");
    void handleRestart({ fresh: true }); // destructive — the plan is gone, start a NEW session (#2396)
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
    store.setPlanningContext(planningPitch, "");
    void handleRestart({ fresh: true }); // destructive — new blueprint, start a NEW session (#2396)
  }

  return { restarting, handleRestart, keepPlanFiles, doClearPlan, doSwitchBlueprint };
}
