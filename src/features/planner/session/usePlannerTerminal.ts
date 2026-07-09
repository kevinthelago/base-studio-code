// usePlannerTerminal (#1775, extracted from Planning.tsx) — owns the planner's xterm.js terminal
// and its PTY lifecycle:
//   • mount — create the terminal + fit addon, subscribe to pty_data/pty_exit, run setup_workspaces
//     (the isolated planning dir + CLAUDE.md), write the plan-only role gate into session settings,
//     and spawn `claude` with the fresh-only intro prompt. pty_kill on unmount ends it cleanly.
//   • re-fit — re-measure when the panel becomes visible (hidden → shown), after a short delay, and
//     once the mono font loads (cell metrics are wrong until then).
//   • re-sync — re-run setup_workspaces when a linked repo resolves after the initial mount.
// This is a behavior-preserving move out of the component; the once-effect deps (and the two
// eslint-disables they require) are reproduced exactly — NO logic change.
import { useEffect, type RefObject, type MutableRefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { roleCapability, roleDeniedCommands, roleWriteRules } from "@/shared/lib/session/sessionRoles";
import { useScreenSession } from "@/shared/lib/session/useScreenSession";
import { resolveAllInstalledMcp, toSessionPayloads, mcpAllowRules } from "@/features/mcp";
import { plannerIntroMode, composePlannerIntro } from "./plannerIntro";
import { plannerLaunchConfig } from "./plannerLaunch";
import { resolvePlannerSandbox } from "./plannerSandbox";
import { TERM_THEME } from "./planningTerminal";
import type { Command, Schedule } from "@/shared/data/mock";

export interface PlannerTerminalOpts {
  paneId: string;
  /** Whether the planning panel is on-screen — drives the re-fit effect. */
  visible: boolean;
  effectiveProjectId: string;
  /** full_names linked + cloned for this project; drives the post-mount workspace re-sync. */
  linkedRepos: string[];
  treatAsExisting: boolean;
  isAuthoring: boolean;
  activeProjectName: string;
  activeProjectNumber: number;
  planningPitch: string;
  /** The blueprint's enabled stage ids for a project key — scopes the planner CLAUDE.md (#A). */
  stageIdsFor: (key: string) => string[];
  /** Re-read the setup baseline after a workspace setup (#756). */
  refreshSetupSig: () => void;
  /** Parse structured <tag>s out of the stripped PTY output stream (#1474, usePlannerTagStream). */
  processChunk: (chunk: string) => void;
  commands: Command[];
  schedules: Schedule[];
  /** Write the resolved planner hub dir up to the owning component (read by the MCP + tunnel wiring,
   *  so the state cell lives in Planning where those earlier hooks can see it) (#801). */
  setPlanningDir: (dir: string) => void;
}

export interface PlannerTerminalHandle {
  /** Host element for the xterm canvas — attach to the terminal container div. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** The live xterm instance (null before mount / after unmount) — read by sendPrompt + restart. */
  termRef: MutableRefObject<Terminal | null>;
}

export function usePlannerTerminal(opts: PlannerTerminalOpts): PlannerTerminalHandle {
  const {
    paneId, visible, effectiveProjectId, linkedRepos, treatAsExisting, isAuthoring,
    activeProjectName, activeProjectNumber, planningPitch, stageIdsFor, refreshSetupSig,
    processChunk, commands, schedules, setPlanningDir,
  } = opts;

  // The whole xterm + PTY lifecycle (terminal literal, subscribe-before-create ordering,
  // ResizeObserver, refit, cleanup) lives in the shared hook; this wrapper owns only the PLANNER
  // launch path (workspace setup → role gate + MCP → intro → sandbox → pty_create), the tag-parse
  // onData hook, and the repo-resync effect below. pty_kill is called on unmount so navigating away
  // ends the session cleanly. The once-effect launch is a behavior-preserving move — NO logic change.
  const { containerRef, termRef } = useScreenSession({
    paneId,
    termTheme: TERM_THEME,
    visible,
    exitBanner: "\r\n\x1b[33m[session ended — navigate away and back to restart]\x1b[0m\r\n",

    // Parse structured tags out of the stripped output stream (#1474, usePlannerTagStream).
    onData: (payload) => processChunk(payload),

    // Capture state at mount time (synchronously, before the RAF) for workspace sync.
    snapshot: () => ({
      repoSnapshot:        linkedRepos, // string[] of full_names
      treatAsExistingSnap: treatAsExisting,
      isAuthoringSnap:     isAuthoring,
      projNameSnap:        activeProjectName,
      projNumberSnap:      activeProjectNumber,
      pitchSnap:           planningPitch,
      projIdSnap:          effectiveProjectId,
      ghLoginSnap:         useAppStore.getState().githubUser?.login ?? "",
      ghNameSnap:          useAppStore.getState().githubUser?.name  ?? "",
      automationsSnap: [
        ...commands.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
        ...schedules.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
      ],
    }),

    launch: async (term, snap) => {
      const {
        repoSnapshot, treatAsExistingSnap, isAuthoringSnap, projNameSnap, projNumberSnap,
        pitchSnap, projIdSnap, ghLoginSnap, ghNameSnap, automationsSnap,
      } = snap;

      // Create the isolated planning workspace directory with settings.json + CLAUDE.md.
      const paths = await safeInvoke<{ planning_dir: string } | null>(
        "setup_workspaces",
        {
          repoFullNames: repoSnapshot,
          automations:   automationsSnap,
          isExisting:    treatAsExistingSnap,
          projectName:   projNameSnap,
          projectNumber: projNumberSnap,
          pitch:         pitchSnap,
          projectKey:    projIdSnap,
          githubLogin:   ghLoginSnap,
          githubName:    ghNameSnap,
          enabledStages: stageIdsFor(projIdSnap), // scope the planner CLAUDE.md to the blueprint (#A)
          authoring:     isAuthoringSnap,         // use the blueprint-author intro (#923)
        },
        null,
        (e: unknown) => console.error("workspace setup failed:", e),
      );
      refreshSetupSig(); // baseline updated (#756)
      if (paths) setPlanningDir(paths.planning_dir); // for the relay planner-pane mirror (#801)

      // Launch claude inside the isolated planning directory.
      // Inject the stored GitHub token so `gh` CLI and direct API calls work
      // without requiring the user to separately authenticate the gh CLI.
      const token = useAppStore.getState().githubToken;
      const ghEnv: Record<string, string> = token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
      // Role gate (#219): the planner is plan-only — write git/gh write denies plus a
      // write-tool deny (#238) into its session settings before claude launches, so it
      // can read for context but neither edit files nor mutate the repo/GitHub
      // (publishing is an explicit, separately-gated step).
      const plannerCap = roleCapability("planner");
      const plannerWrite = roleWriteRules(plannerCap);
      // Expose EVERY installed MCP server to the planner (#1054), project scope ignored: the planner
      // is the assignment hub, so it sees all downloaded servers — it can call them while planning
      // (e.g. research sources for a skill) and assign them to the workers that need them.
      const plannerMcp = toSessionPayloads(resolveAllInstalledMcp(useAppStore.getState().mcpServers), []).mcp;
      // The role gate covers the planner's scoped plan-file writes + git/gh read-only.
      // WebFetch (docs / version / pricing lookups) and Read are added explicitly here so
      // this single role-launch path fully sources the planner's tools — replacing the
      // hardcoded settings.json literal that setup_workspaces used to write (#799).
      await safeInvoke("ensure_session_settings", {
        cwd:             paths?.planning_dir ?? "",
        allowedCommands: [],
        deniedCommands:  roleDeniedCommands(plannerCap),
        mcpServers:      plannerMcp,
        hooks:           null,
        // Auto-approve every MCP server the planner sees (Research/Compliance + any downloaded one)
        // so it can call them while planning — e.g. the Research MCP when grounding a skill — without
        // a per-tool permission prompt. `enabledMcpjsonServers` only trusts the server to LOAD.
        allowToolRules:  [...plannerWrite.allow, "Read", "WebFetch", ...mcpAllowRules(plannerMcp)],
        denyToolRules:   plannerWrite.deny,
        replacePermissions: true,
      }, undefined, (e: unknown) => console.error("planner session settings failed:", e));
      // Planner introduction (#1240): a user-facing kickoff that has the planner OPEN the
      // conversation (introduce itself, sketch the stage journey, summarize capabilities, ask one
      // orienting question) instead of launching into a quiet terminal. Baked into the claude launch
      // arg as a FRESH-ONLY startup prompt — the backend (which knows the conversation history)
      // delivers it only on a genuinely new session and drops it on `--continue` resume, so a
      // returning user isn't re-greeted. For a new project the user's pitch rides along so the
      // planner acknowledges it rather than asking what they're building (replaces the old
      // idle-detection pitch-typing). On failure it's undefined → the launch falls back to initCmd.
      const introMode = plannerIntroMode({ isAuthoring, isExisting: treatAsExistingSnap });
      const introText = await safeInvoke<string>("planner_intro_prompt", { mode: introMode }, "",
        (e: unknown) => console.error("planner intro prompt failed:", e));
      // Run the planner on the selected harness: Claude Code, or bsc-agent (any LLM) when chosen or
      // forced by a local/ollama provider Claude can't drive (#1078). bsc-agent gets the same plan-only
      // role gate, MCP, and provider/model/base-url via BSC_AGENT_* env; context + the intro prompt +
      // plan state come through identically.
      const launch = plannerLaunchConfig(useAppStore.getState(), ghEnv);
      // bsc-agent is a one-shot loop, so it never receives stage 1's directive via runtime injection
      // (Claude does). Bake the first active stage's directive into the intro so a weak local model
      // begins discovery instead of greeting and then waiting to be advanced (#qwen).
      let firstStageDirective: string | undefined;
      if (launch.providerId === "bsc-agent") {
        const firstStage = stageIdsFor(projIdSnap)[0];
        if (firstStage) {
          firstStageDirective = await safeInvoke<string>(
            "planner_stage_directive", { id: firstStage }, "",
            (e: unknown) => console.error("planner stage directive failed:", e),
          ) || undefined;
        }
      }
      const startupPrompt = composePlannerIntro(introText, introMode, pitchSnap ?? "", firstStageDirective) || undefined;
      // #1988: opt-in (off by default) — relocate the hub into the sealed WSL2 distro + spawn INSIDE
      // it when the sandbox toggle is on AND the planner runs on bsc-agent (shared with the restart
      // path so they can't drift; host fallback on failure). Toggling restarts the planner to convert.
      const sandbox = await resolvePlannerSandbox(launch.providerId, paths?.planning_dir ?? "", projIdSnap);
      await safeInvoke("pty_create", {
        paneId:  paneId,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     sandbox.cwd,
        initCmd: launch.initCmd,
        startupPrompt,
        startupPromptFreshOnly: launch.startupPromptFreshOnly,
        continueSession: launch.continueSession,
        env:     launch.env,
        providerId: launch.providerId,
        wslDistro: sandbox.wslDistro,
      }, undefined, console.error);
    },
  });

  // Re-sync CLAUDE.md whenever a repo resolves after the initial mount.
  useEffect(() => {
    if (linkedRepos.length === 0) return;
    const { commands: cmds, schedules: scheds } = useAppStore.getState();
    invoke("setup_workspaces", {
      repoFullNames: linkedRepos,
      automations: [
        ...cmds.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
        ...scheds.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
      ],
      isExisting:    treatAsExisting,
      projectName:   activeProjectName,
      projectNumber: activeProjectNumber,
      pitch:         planningPitch,
      projectKey:    effectiveProjectId,
      githubLogin:   useAppStore.getState().githubUser?.login ?? "",
      githubName:    useAppStore.getState().githubUser?.name  ?? "",
      enabledStages: stageIdsFor(effectiveProjectId), // scope the planner CLAUDE.md (#A)
      authoring:     isAuthoring,                     // use the blueprint-author intro (#923)
    }).then(() => refreshSetupSig()).catch(console.error); // baseline updated (#756)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRepos]);

  return { containerRef, termRef };
}
