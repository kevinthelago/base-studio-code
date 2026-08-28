// ProjectsSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { Tab } from "@/app/chrome/Tabstrip";
import type { Workspace } from "@/app/chrome/Rail";
import type { AgentStream } from "@/features/planner/fleet/planFleet";
import { newTabId, buildAssignments, buildStreamPrompt, activateAutomations, gridLayout } from "@/store/helpers";
import { buildTriagePrompt, renderTriageDelta } from "@/store/constants";
import { invoke } from "@tauri-apps/api/core";
import type { PlanIssue } from "@/features/planner/issues/planIssues";
import { checkpointDocRelpath, agentCheckpointDocRelpath } from "@/shared/lib/session/checkpoint";
import { projectRepoCwd, projectHubCwd, agentWorktreeCwd, sanitizeProjectKey, findProjectTabIdx, worktreeSlug } from "@/shared/lib/core/projectPaths";
import { fleetPaneId, directorPaneId, triagePaneId, positionalPaneId, findPaneOwnerTab, parsePaneIdentity } from "@/app/console/lib/paneIdentity";
import { clearTabStatuses as clearTabStatusesPure } from "@/app/console/lib/paneStatus";
import { repoPromptKey } from "@/shared/lib/session/startupPrompt";
import { resolveDirectorDrive } from "@/features/planner/fleet/directorDrive";
import { personaStreamPrompt } from "@/features/planner/fleet/streamPersona";
import { roleCapability, type SessionRole } from "@/shared/lib/session/sessionRoles";
import type { AgentFlow } from "@/features/planner/fleet/agentFlow";
import { MODEL_IDS, type ModelId, type SessionModel } from "@/app/console/lib/models";
import { applyCommonsGate } from "@/features/planner/fleet/commonsGate";
import { parseIntake, changedDesignFiles, markRouted, renderDesignDelta, serializeIntake, INTAKE_DIR, INTAKE_MANIFEST } from "@/features/planner/lib/fileIntake";
import { STAGE_DEFS, DEFAULT_BLUEPRINT_ID } from "@/features/planner/stages/blueprints";
import { resolveStreamFlow, resolveStreamProfile } from "@/features/planner/fleet/fleetPolicy";
import { commonsGlobsForStack, stackTagsFromSection } from "@/shared/lib/session/commons";
import { roleProfileId } from "@/shared/lib/session/roleProfile";
import { resolveStartupPrompt } from "@/shared/lib/session/assignments";
import { effectiveSessionSkills, expandGroups } from "@/features/skills/lib/skills";
import { resolveStrategy, strategySettings } from "@/features/planner/lib/integrationStrategy";
import { scriptDocRelpath } from "@/features/planner/session/planningSession";
import { setMapEntry, deleteMapEntry } from "@/store/updateHelpers";
import { deleteProjectScoped, rekeyProjectScoped } from "@/store/slices/projectScopedMaps";
import { effectiveHarness } from "@/shared/lib/core/llmConfig";
import { bscJson } from "@/shared/lib/core/bsc";

/**
 * Everything a WORKER stream's pane is wired with that is derived from the stream row itself.
 *
 * ONE COPY, ON PURPOSE. `fleetStartProject` computes this at launch, and the wake path
 * (`the-director-cannot-start-a-stream-that-never-launched`) computes it again when it adopts a stream
 * plan.db names but no session ever ran. A second copy is the drifting-launch-path this codebase has
 * paid for before — the whole reason `fleetStartBridge` builds a FleetPlan and calls the real
 * `fleetStartProject` rather than placing panes itself. So a WOKEN pane is wired exactly like a
 * LAUNCHED one, by construction rather than by two blocks that agree today.
 *
 * The director is deliberately NOT expressible here: its role, profile and cwd come from the project,
 * not from a stream row, and `sess === null` is how the launch says so.
 */
export interface StreamPaneWiring {
  /** #2094: a persona stream launches AS its persona's role; no persona ⇒ the historical worker. */
  role: SessionRole;
  /** The stream's own pin wins, then the blueprint's fleetPolicy default, then the role's profile. */
  profile: string;
  /** Undefined ⇒ the launch path applies DEFAULT_FLOW downstream. */
  flow?: AgentFlow;
  /** Undefined ⇒ the pane falls back to the global `defaultModel` at mount.
   *
   *  This is where the model precedence chain is RESOLVED — the stream's own model first, then the
   *  persona's default. A {@link SessionModel} rather than a tier, because the nearest level (the
   *  stream, set by the director with `bsc plan fleet model`) may name a local model that no tier
   *  catalog contains. The PERSONA fallback below stays tier-validated: a persona's model is picked
   *  from the catalog, so a value outside it there means bad data, not a deliberate local choice. */
  model?: SessionModel;
  /** The write boundary, and ONLY for a code-writing role — a read-only persona stream must not get a
   *  write carve-out from its `owns`, or the read-only floor leaks. */
  roleGlobs?: string[];
  /** Absent for a repo-less stream (a team-derived hub role-actor, #3103). */
  repo?: string;
  /** What the coordinator resolves a pane's repo/branch through. */
  paneStream: { repo: string; branch: string };
}

export function streamPaneWiring(
  sess: AgentStream,
  persona?: { role?: SessionRole; model?: string },
  fleetPolicy?: { profile?: string; flow?: AgentFlow },
): StreamPaneWiring {
  const role: SessionRole = persona?.role ?? "worker";
  const flow = resolveStreamFlow(sess.flow, fleetPolicy?.flow);
  const model = sess.model
    ?? (persona?.model && (MODEL_IDS as readonly string[]).includes(persona.model) ? persona.model as ModelId : undefined);
  return {
    role,
    profile: resolveStreamProfile(sess.profile, fleetPolicy?.profile, roleProfileId(role)),
    ...(flow ? { flow } : {}),
    ...(model ? { model } : {}),
    ...(sess.owns.length && roleCapability(role).code === "write"
      ? { roleGlobs: sess.owns.map((g) => (g.endsWith("/") ? g + "**" : g)) }
      : {}),
    ...(sess.repo ? { repo: sess.repo } : {}),
    paneStream: { repo: sess.repo, branch: worktreeSlug(sess.id) },
  };
}

type ProjectsSlice = Pick<AppStore,
  "deleteLocalProject" | "resetProjectData" | "setActiveProjectRepos" | "defaultStartupPromptDoc" | "setDefaultStartupPromptDoc" | "projectStartupPromptDoc" | "setProjectStartupPromptDoc" | "repoStartupPromptDoc" | "setRepoStartupPromptDoc" | "repoTriagePromptDoc" | "setRepoTriagePromptDoc" | "githubTab" | "setGithubTab" | "githubBoardOpen" | "githubBoardTab" | "openGithubBoard" | "setGithubBoardTab" | "closeGithubBoard" | "wakePane" | "fleetPaneStreams" | "projectsDrawerIssue" | "setProjectsDrawerIssue" | "planningPitch" | "planningRepo" | "planningTitle" | "setPlanningContext" | "setPlanningTitle" | "planningSessionKey" | "setPlanningSession" | "pendingPlannerPrompt" | "requestPlannerPrompt" | "clearPlannerPrompt" | "rekeyProjectData" | "autoTriage" | "setAutoTriage" | "glanceOff" | "setGlanceNodeOff" | "autoKitDispatch" | "setAutoKitDispatch" | "issueLinks" | "setIssueLinks" | "bscBaseDir" | "setBscBaseDir" | "projectLocalRepos" | "localDraftProjects" | "addProjectRepo" | "findTriageTabIdx" | "triageStartProject" | "prepareTriageRun" | "findFleetTabIdx" | "fleetStartProject"
>;

export const createProjectsSlice: StateCreator<AppStore, [], [], ProjectsSlice> = (set, get) => ({
      deleteLocalProject: (keys) =>
        set((s) => {
          // The caller passes every identity form the project's entries may sit under: the
          // name-derived slug (#2409), plus — for grandfathered projects — the raw title and the
          // GitHub node id. Each is dropped as-is (the node-id → key alias is retired; the key is
          // derivable from the name, so there is nothing to resolve through).
          const keySet = new Set(keys.filter(Boolean) as string[]);
          // Every per-project + repo-scoped map to drop is registered in projectScopedMaps.ts
          // (#2712) — `deleteProjectScoped` drops `keySet` from exactly the maps in the `"delete"`
          // op set (guarding each `?? {}` for a missing/null persisted slice, #874).
          // Clear the active project AND the planning session when the deleted project is either.
          // The Planning pane is mounted once (only CSS-hidden); if `planningSessionKey` still points
          // at the deleted project, its `effectiveProjectId` keeps resolving there and it renders
          // against now-gone data → crash. A published delete passes the node id (== activeProjectId),
          // which is why only published deletes hit this (#997).
          const clearActive =
            (s.activeProjectId != null && keySet.has(s.activeProjectId)) ||
            (!!s.planningSessionKey && keySet.has(s.planningSessionKey));
          return {
            ...deleteProjectScoped(s, keySet),
            // Drop the deleted project id from every extension's scope list. `projects` may be
            // undefined (a def added without it, or persisted data predating the field) — guard,
            // or `.filter` throws and crashes the app on delete (#791).
            mcpServers:             (s.mcpServers ?? []).map((e) => ({ ...e, projects: (e.projects ?? []).filter((p) => !keySet.has(p)) })),
            hooks:                  (s.hooks ?? []).map((e) => ({ ...e, projects: (e.projects ?? []).filter((p) => !keySet.has(p)) })),
            // …and from every skill's scope list.
            skills:                 (s.skills ?? []).map((sk) => ({ ...sk, projects: (sk.projects ?? []).filter((p) => !keySet.has(p)) })),
            ...(clearActive
              ? { activeProjectId: null, activeProjectName: "", activeProjectRepo: "", activeProjectNumber: 0, activeProjectRepos: [], planningSessionKey: "", projectsView: "list" as const }
              : {}),
          };
        }),
      resetProjectData: () =>
        set({
          planStages: {}, planConfirmedStages: {}, planSkippedStages: {}, planDeployConfig: {}, planMarketConfig: {}, planTransformations: {},
          planAutomations: {}, planStageConfig: {}, projectBlueprintId: {}, planClassification: {}, uiScreens: {}, uiApproved: {}, stageRuns: {}, stagePreview: {}, planFleet: {}, pinnedContext: {},
          projectLocalRepos: {}, localDraftProjects: {},
          issueLinks: {}, autoTriage: {}, glanceOff: {}, autoKitDispatch: {}, projectStartupPromptDoc: {},
          repoStartupPromptDoc: {}, repoTriagePromptDoc: {}, hiddenProjectIds: [],
          activeProjectId: null, activeProjectName: "", activeProjectRepo: "",
          activeProjectNumber: 0, activeProjectRepos: [],
          planningSessionKey: "", planningTitle: "", planningPitch: "",
          planningRepo: "", projectsView: "list",
        }),
      setActiveProjectRepos: (repos) =>
        set((s) => ({ activeProjectRepos: repos, activeProjectRepo: repos[0] ?? s.activeProjectRepo })),
      defaultStartupPromptDoc: null,
      setDefaultStartupPromptDoc: (doc) => set({ defaultStartupPromptDoc: doc }),
      projectStartupPromptDoc: {},
      setProjectStartupPromptDoc: (projectId, doc) =>
        set((s) => ({ projectStartupPromptDoc: setMapEntry(s.projectStartupPromptDoc, projectId, doc) })),
      // Per-project auto-triage toggle (#2265) — default OFF (surface-only). `false` drops the entry so
      // the map stays sparse (absent ⇒ off), like the other per-project preference maps.
      autoTriage: {},
      setAutoTriage: (projectKey, on) =>
        set((s) => ({ autoTriage: on ? { ...s.autoTriage, [projectKey]: true } : deleteMapEntry(s.autoTriage, projectKey) })),
      // Per-node Glance OFF toggle (#3239) — default ON (absent). Turning ON drops the entry so the map
      // stays sparse (absent ⇒ on), like autoTriage; turning OFF records the deactivated node id.
      glanceOff: {},
      setGlanceNodeOff: (nodeId, off) =>
        set((s) => ({ glanceOff: off ? { ...s.glanceOff, [nodeId]: true } : deleteMapEntry(s.glanceOff, nodeId) })),
      // Per-project kit auto-dispatch toggle (#2277) — default OFF (notify-only). `false` drops the entry
      // so the map stays sparse (absent ⇒ off), like autoTriage.
      autoKitDispatch: {},
      setAutoKitDispatch: (projectKey, on) =>
        set((s) => ({ autoKitDispatch: on ? { ...s.autoKitDispatch, [projectKey]: true } : deleteMapEntry(s.autoKitDispatch, projectKey) })),
      repoStartupPromptDoc: {},
      setRepoStartupPromptDoc: (projectId, repo, doc) =>
        set((s) => ({ repoStartupPromptDoc: setMapEntry(s.repoStartupPromptDoc, repoPromptKey(projectId, repo), doc) })),
      repoTriagePromptDoc: {},
      setRepoTriagePromptDoc: (projectId, repo, doc) =>
        set((s) => ({ repoTriagePromptDoc: setMapEntry(s.repoTriagePromptDoc, repoPromptKey(projectId, repo), doc) })),
      githubTab: "summary",
      setGithubTab: (t) => set({ githubTab: t }),
      githubBoardOpen: false,
      githubBoardTab: "board",
      openGithubBoard: (tab = "board") => set({ githubBoardOpen: true, githubBoardTab: tab }),
      setGithubBoardTab: (t) => set({ githubBoardTab: t }),
      closeGithubBoard: () => set({ githubBoardOpen: false }),
      wakePane: (paneId, prompt, stream) => {
        let ok = false;
        set((st) => {
          /** The per-pane wiring an ADOPTED stream needs, or `{}` when the roster already has it.
           *
           *  `the-director-cannot-start-a-stream-that-never-launched`: everything here is what
           *  `fleetStartProject` would have written for this stream, computed through the SAME
           *  {@link streamPaneWiring} helper. It is not a second launch path — the pieces that are not
           *  stream-derived (cwd, provider, skills) are the same one-line calls the launch makes, and
           *  the cwd is the absolute path RUST resolved (#905), never re-derived here. */
          const adopt = (st2: AppStore, safeKey: string, projectKey: string) => {
            if (!stream) return {};
            const persona = stream.persona ? st2.personas.find((pp) => pp.id === stream.persona) : undefined;
            const fleetPolicy = st2.blueprints.find(
              (b) => b.id === (st2.projectBlueprintId[projectKey] ?? DEFAULT_BLUEPRINT_ID),
            )?.fleetPolicy;
            const w = streamPaneWiring(stream, persona, fleetPolicy);
            const { cwd, ...row } = stream;
            return {
              // The roster entry whose ABSENCE is what refused this wake in the first place.
              fleetPaneStreams: setMapEntry(st2.fleetPaneStreams, paneId, row),
              paneCwds:      setMapEntry(st2.paneCwds, paneId, cwd),
              paneInitCmds:  setMapEntry(st2.paneInitCmds, paneId, "claude"),
              paneStream:    setMapEntry(st2.paneStream, paneId, w.paneStream),
              paneRoles:     setMapEntry(st2.paneRoles, paneId, w.role),
              paneProfiles:  setMapEntry(st2.paneProfiles, paneId, w.profile),
              paneProviders: setMapEntry(st2.paneProviders, paneId, effectiveHarness(st2.llmProvider, st2.fleetHarness ?? "claude")),
              paneCheckpointDocs: setMapEntry(st2.paneCheckpointDocs, paneId, agentCheckpointDocRelpath(safeKey, row.id)),
              paneSkills: setMapEntry(st2.paneSkills, paneId, effectiveSessionSkills(
                st2.skills, projectKey, st2.sessionSkillOverrides[paneId],
                new Set([
                  ...expandGroups([...(st2.sessionSkillGroups[paneId] ?? []), ...(row.groupIds ?? [])], st2.skillGroups),
                  ...(persona?.skills ?? []),
                ]),
              )),
              ...(w.repo      ? { paneRepos:     setMapEntry(st2.paneRepos, paneId, w.repo) } : {}),
              ...(w.roleGlobs ? { paneRoleGlobs: setMapEntry(st2.paneRoleGlobs, paneId, w.roleGlobs) } : {}),
              ...(w.flow      ? { paneFlows:     setMapEntry(st2.paneFlows, paneId, w.flow) } : {}),
              ...(w.model     ? { paneModels:    setMapEntry(st2.paneModels, paneId, w.model) } : {}),
              // The stream's kickoff stays a FALLBACK: TerminalView prefers `paneStartupPromptText`,
              // which the wake below sets to the director's prompt. A never-launched stream that is
              // woken with no prompt would otherwise be told to "re-read your assignment" with nothing
              // to read.
              ...(row.prompt ? { paneStartupPromptDocs: setMapEntry(st2.paneStartupPromptDocs, paneId, scriptDocRelpath(safeKey, row.prompt)) } : {}),
            };
          };
          // #4025: resolve the owning tab by IDENTITY, as `resumePaneSession` already does. This used
          // to parse `^t(\d+)p\d+$` out of the pane id — the positional scheme pane identity replaced.
          // Measured on the live coord log: 0 positional ids, 273 identity ids. So it returned false
          // for EVERY session, and since `actuateWake` kills the PTY first, the inbox Wake button
          // killed a parked worker and never brought it back (skipping the `woke` event too, so the
          // log did not even record it).
          // A WAKE REVIVES A DISABLED PANE. Maintainer's call, 2026-08-26, after being blocked by this
          // three times: "end session simply closes it and doesn't prevent the director from
          // re-starting it".
          //
          // This used to `return {}` here. The rationale lived in a test comment — "the user turned
          // that cell off deliberately" — and it is a reasonable instinct that does not survive
          // contact with how the flag is actually reached: the Glance End button set it (until
          // `ending-a-session-must-not-prevent-the-director-from-waking-it`), it persists across
          // restarts, and the ONLY thing that clears it is a per-pane toggle in the Console pane menu
          // — a surface a director cannot reach at all. So "deliberately off" and "ended twenty
          // minutes ago" were the same state, permanently, with no way back for the tier that needs
          // one.
          //
          // It also contradicted this function, which CLEARS the flag a few lines below ("a pane the
          // app just re-seated must not stay disabled from a previous reap"). That line was
          // unreachable; now it is the point.
          //
          // A wake is not a background reaper quietly restarting things: it is one explicit, targeted,
          // logged act by the director, against one named pane. If a pane should stay off, do not wake
          // it. The pause toggle still stops a running session; it no longer outranks the director.
          let owner = findPaneOwnerTab(st.tabs, paneId);
          let tabs = st.tabs;
          /** Non-empty only when a never-launched stream is being adopted (see below). */
          let adopted: Partial<AppStore> = {};

          // #fleet-wake-reaches-a-session-with-no-pane — the pane may not EXIST yet. A stream whose
          // session was never launched, or whose build tab was closed, has no entry in any tab's
          // `paneIds`, so the lookup above returns null and wake used to refuse. That is precisely the
          // case the director protocol names it for ("a stream still has open issues but its session
          // is not live"), and under the no-app-injection directive it is the ONLY way a stopped node
          // comes back without the user — so wake CREATES the pane rather than declining.
          if (!owner) {
            // `fleetPaneStreams` is the roster of what LAUNCHED, not of what the plan HOLDS — it is
            // written by `fleetStartProject` alone. So a stream plan.db names and no session ever ran
            // has no entry here, and this check used to end the wake: the `never-launched` state, which
            // `bsc fleet list` reports and which sent the director to `bsc fleet start <projectKey>` —
            // a WHOLE-fleet launch, refused outright while any pane is live.
            //
            // Rust reads plan.db (it already does for `fleet start`) and carries the stream row on the
            // wake event for a pane that is not live, so `stream` IS the plan's answer. The refusal the
            // acceptance actually wants survives: Rust resolving NOTHING means plan.db does not name
            // this stream, and an UNKNOWN stream is still an error.
            if (!st.fleetPaneStreams[paneId] && !stream) return {};
            const projectKey = parsePaneIdentity(paneId)?.projectKey;
            if (!projectKey) return {};
            const safeKey = sanitizeProjectKey(projectKey);
            const tabIdx = findProjectTabIdx(st.tabs, safeKey, "build", 0);
            if (tabIdx < 0) return {};   // the build tab is gone entirely — that is a relaunch, not a wake
            adopted = st.fleetPaneStreams[paneId] ? {} : adopt(st, safeKey, projectKey);
            const tab = st.tabs[tabIdx];
            // Append into the first FREE cell if the layout has one, else extend — the pane must have a
            // slot before the runId bump, or the remount renders a grid that does not contain it.
            const paneIds = [...(tab.paneIds ?? [])];
            const free = paneIds.indexOf("");
            if (free >= 0) paneIds[free] = paneId; else paneIds.push(paneId);
            tabs = st.tabs.map((t, i) => (i === tabIdx ? { ...t, paneIds } : t));
            owner = { tab: tabs[tabIdx], tabIdx };
          }

          // THE GRID HAS TO HAVE A CELL FOR EVERY PANE THE TAB HOLDS — and this is checked on BOTH
          // paths, which is the correction. A director-only build tab is `1×1`, so the pane seated
          // beside it sits OUTSIDE the grid: TerminalView never mounts it, `pty_create` never runs, and
          // this function still returns true, so the director is told a worker is coming and none does.
          //
          // Doing it only where the pane is SEATED was not enough. Once seated, the next wake finds an
          // owning tab, takes the early path, and skips the check — so a pane that never fit stayed
          // outside the grid forever, and each wake killed its PTY and remounted a grid without it.
          // That is exactly what turned a `live` worker into a `stopped` one, once per wake.
          //
          // Grown with the same `gridLayout` the launch uses, so a woken tab and a launched tab of the
          // same size lay out identically. ONLY when it does not fit: reshaping a grid the user
          // arranged, to seat a pane that already had a home, would be a second bug.
          const ownerTab = tabs[owner!.tabIdx];
          const held = (ownerTab.paneIds ?? []).length;
          const [cols0, rows0] = (ownerTab.layout ?? "").split("\u00d7").map((n) => Number(n) || 0);
          const grown = held > cols0 * rows0 ? gridLayout(held) : undefined;
          const layout = grown ? `${grown.cols}\u00d7${grown.rows}` : ownerTab.layout;

          ok = true;
          return {
            ...adopted,
            tabs: tabs.map((t, i) => (i === owner!.tabIdx ? { ...t, layout, runId: (t.runId ?? 0) + 1 } : t)),
            paneStartupPromptText: setMapEntry(st.paneStartupPromptText, paneId, prompt),
            // A WAKE RESUMES. `plan_launch` computes `resume: continue_session && has_history`, so
            // leaving this false meant a woken worker could never continue its conversation however
            // much history it had — it re-read its kickoff and started over, losing everything it had
            // worked out. Waking a parked worker is by definition "pick this back up".
            //
            // Distinct from the PTY kill the wake bridge does first ("so the runId-bump remount spawns
            // a FRESH session, not a reconnect"): that is about the PROCESS — a dead shell must be
            // respawned rather than reattached — and says nothing about the CONVERSATION. Killing the
            // shell and resuming the conversation is the combination a wake wants.
            //
            // With no history to continue this still starts fresh and still delivers the prompt:
            // `resume` requires both halves, and the `|| claude` fallback covers a refused --continue.
            paneContinue: setMapEntry(st.paneContinue, paneId, true),
            // A reaped/dormant pane renders the DormantConsole PLACEHOLDER, not a terminal — so the
            // runId bump alone would remount a card with no PTY behind it and the baked prompt would
            // never run. Clearing it is what lets a wake reach a session that was reclaimed.
            dormantPanes: deleteMapEntry(st.dormantPanes, paneId),
            endedPanes: deleteMapEntry(st.endedPanes, paneId),
            // A pane the app just re-seated must not stay disabled from a previous reap.
            disabledPanes: deleteMapEntry(st.disabledPanes, paneId),
          };
        });
        return ok;
      },
      fleetPaneStreams: {},
      projectsDrawerIssue: null,
      setProjectsDrawerIssue: (n) => set({ projectsDrawerIssue: n }),
      planningPitch: "",
      planningRepo: "",
      planningTitle: "",
      setPlanningContext: (pitch, repo) => set({ planningPitch: pitch, planningRepo: repo }),
      setPlanningTitle: (title) => set({ planningTitle: title }),
      planningSessionKey: "",
      setPlanningSession: (key) => set({ planningSessionKey: key }),
      pendingPlannerPrompt: {},
      requestPlannerPrompt: (projectKey, text) =>
        set((s) => ({ pendingPlannerPrompt: setMapEntry(s.pendingPlannerPrompt, projectKey, text) })),
      clearPlannerPrompt: (projectKey) =>
        set((s) => {
          if (!(projectKey in s.pendingPlannerPrompt)) return {};
          return { pendingPlannerPrompt: deleteMapEntry(s.pendingPlannerPrompt, projectKey) };
        }),
      // The store half of the one-time hub relink (#2409, pairs with `relink_project_hub`): move
      // every per-project entry from the legacy key onto the name-derived slug. Target-wins — an
      // entry already under `newKey` is kept and the old one dropped (never clobbered). Console
      // tab/pane state is deliberately NOT rewritten (pane ids embed the key; a relinked project
      // relaunches its fleet, which rebuilds tabs under the new key).
      rekeyProjectData: (oldKey, newKey) =>
        set((s) => {
          if (!oldKey || !newKey || oldKey === newKey) return {};
          // Every per-project + repo-scoped map to move is registered in projectScopedMaps.ts
          // (#2712) — `rekeyProjectScoped` moves `oldKey` → `newKey` (target-wins) across exactly
          // the maps in the `"rekey"` op set, guarding `?? {}` per persisted slice (#874).
          // Extension/skill scope lists: swap the key in place (dedup if both forms were present).
          const scoped = <E extends { projects?: string[] }>(list: E[]): E[] =>
            (list ?? []).map((e) => ({
              ...e,
              projects: [...new Set((e.projects ?? []).map((p) => (p === oldKey ? newKey : p)))],
            }));
          return {
            ...rekeyProjectScoped(s, oldKey, newKey),
            mcpServers:             scoped(s.mcpServers),
            hooks:                  scoped(s.hooks),
            skills:                 scoped(s.skills),
          };
        }),
      issueLinks: {},
      setIssueLinks: (projectKey, links) =>
        set((s) => ({ issueLinks: setMapEntry(s.issueLinks, projectKey, { ...(s.issueLinks[projectKey] ?? {}), ...links }) })),
      bscBaseDir: "",
      setBscBaseDir: (dir) => set({ bscBaseDir: dir }),
      projectLocalRepos: {},
      localDraftProjects: {},
      addProjectRepo: (projectId, fullName) =>
        set((s) => {
          const existing = s.projectLocalRepos[projectId] ?? [];
          if (existing.includes(fullName)) return {};
          return { projectLocalRepos: setMapEntry(s.projectLocalRepos, projectId, [...existing, fullName]) };
        }),
      // Tab identity keys off the ONE name-derived project key (#2409) — the node-id branch of the
      // old canonicalProjectKey is gone (recovery/reuse is derivation, not lookup).
      findTriageTabIdx: (projectName) =>
        findProjectTabIdx(get().tabs, sanitizeProjectKey(projectName), "triage"),
      // #1004: prepare a triage re-run from plan.db — for each repo read the last-run marker and the
      // issues changed since it, render a one-line resume lead (renderTriageDelta), then STAMP a fresh
      // marker so the next run's "since" is now (read-before-write order). Returns fullName → lead for
      // triageStartProject's `deltas`. Failures are per-repo and non-fatal (omitted ⇒ full prompt).
      prepareTriageRun: async (projectKey, repos) => {
        const deltas: Record<string, string> = {};
        await Promise.all(repos.map(async (repo) => {
          try {
            const lastRun = await bscJson<number | null>(projectKey, ["plan", "triage", "last", repo], null);
            const changed = lastRun != null
              ? await bscJson<PlanIssue[]>(projectKey, ["plan", "triage", "changed", repo, "--since", String(lastRun)], [])
              : [];
            deltas[repo] = renderTriageDelta(
              changed.map((c) => ({ ref: c.ref, title: c.title, status: c.status ?? "open" })),
              lastRun ?? null,
            );
            await bscJson<number>(projectKey, ["plan", "triage", "record", repo], 0);
          } catch (e) {
            console.error(`triage delta prep ${repo} failed:`, e);
          }
        }));
        // #2097 — route the design files that CHANGED since the last route as part of triage. Read
        // the project's design manifest, diff content hashes, and if any changed: sync the skeleton,
        // prepend the route lead to the first repo's triage prompt (the routePrompt itself sends UI
        // assets to the owning repo), and stamp the routed hashes. Nothing changed ⇒ no-op (no
        // reroute, no prompt). Non-fatal.
        try {
          const files = await invoke<[string, string][]>("read_project_files", { projectKey, subdir: INTAKE_DIR });
          const manifest = files.find(([rel]) => rel === "intake.json")?.[1];
          const entries = manifest ? parseIntake(manifest) : [];
          const changed = changedDesignFiles(entries);
          if (changed.length > 0 && repos.length > 0) {
            const first = repos[0];
            deltas[first] = renderDesignDelta(changed, STAGE_DEFS.ui.routePrompt ?? "") + (deltas[first] ?? "");
            await invoke("sync_design_to_skeleton", { projectKey });
            await invoke("write_project_file", { projectKey, relpath: INTAKE_MANIFEST, contents: serializeIntake(markRouted(entries)) });
          }
        } catch (e) {
          console.error("triage design-route prep failed:", e);
        }
        return deltas;
      },
      triageStartProject: (projectName, repos, projectId = "", deltas, clonePaths) =>
        set((s) => {
          // A triage tab for this project may already exist (re-run): rebuild it in
          // place at the same index. The caller kills the old panes' sessions first
          // and the bumped runId remounts them, so pty_create launches fresh
          // (resuming via --continue + the checkpoint) instead of reconnecting.
          // Match on the STABLE projectKey (the name-derived key, #2409 — never the node
          // id), so a project rename relabels the tab in place instead of forking a
          // duplicate (#457).
          const tabName = `${projectName} · triage`;
          const tabKey = sanitizeProjectKey(projectName);
          const existingIdx = findProjectTabIdx(s.tabs, tabKey, "triage");
          if (repos.length === 0) return {};
          const newTabIdx = existingIdx >= 0 ? existingIdx : s.tabs.length;
          const runId = existingIdx >= 0 ? (s.tabs[existingIdx].runId ?? 0) + 1 : 0;
          const addedAutos = activateAutomations(s, projectId, tabName);
          const count = Math.min(repos.length, 16);
          const { cols, rows } = gridLayout(count);
          const layout = `${cols}×${rows}`;
          const newPaneCwds     = { ...s.paneCwds };
          const newPaneInitCmds = { ...s.paneInitCmds };
          const newPaneStartupPromptDocs = { ...s.paneStartupPromptDocs };
          const newPaneStartupPromptText = { ...s.paneStartupPromptText };
          const newPaneCheckpointDocs    = { ...s.paneCheckpointDocs };
          const newPaneContinue          = { ...s.paneContinue };
          const newPaneSkills            = { ...s.paneSkills };
          const newPaneRoles             = { ...s.paneRoles };
          const newPaneRepos             = { ...s.paneRepos };
          // Checkpoint docs live beside the repo clones, under the project-name
          // key (always present; projectId defaults to "" for ad-hoc triage).
          const projKey = sanitizeProjectKey(projectName);
          const newDisabledPanes = { ...s.disabledPanes };
          const tabPaneNames: Record<number, string> = {};
          const paneIds: string[] = [];
          const paneCount = cols * rows;
          const assignments = buildAssignments(s);
          for (let i = 0; i < paneCount; i++) {
            // Stable pane identity (#1176): each triage pane is `<projKey>:<repo>:triage`, so a
            // re-run resumes the exact repo's session; an empty cell keeps a positional id.
            const key = i >= count ? positionalPaneId(newTabIdx, i) : triagePaneId(projKey, repos[i] ?? `p${i}`);
            paneIds[i] = key;
            if (i < count) {
              const fullName = repos[i];
              // A real repo — launch claude in its clone, ensure it's enabled. Prefer the
              // Rust-resolved absolute clone dir (#1819, `repo_dir_path`) so the launch never
              // depends on the async-loaded `bscBaseDir` mirror — empty at crash-recovery startup,
              // which yielded an empty cwd → the settings.json writer skipped → permission-less
              // session. Falls back to the `bscBaseDir`-derived path when an entry is absent.
              newPaneCwds[key]     = clonePaths?.[fullName ?? ""] || projectRepoCwd(s.bscBaseDir, projectName, fullName, !!s.activeProjectId);
              newPaneInitCmds[key] = "claude";
              tabPaneNames[i]      = fullName?.split("/")[1] ?? `pane-${i + 1}`;
              // The startup prompt is baked into the claude launch by the backend
              // (reliable). A per-repo triage script (planner-authored,
              // auto-assigned) wins as a document; otherwise the verbatim shared
              // TRIAGE_PROMPT text (which TerminalView prefers over the dev doc
              // chain), with a doc-based fallback (repo→project→global→built-in;
              // "" = built-in default) for if the text is later cleared.
              const triageDoc = s.repoTriagePromptDoc[repoPromptKey(projectId, fullName ?? "")];
              if (triageDoc) {
                newPaneStartupPromptDocs[key] = triageDoc;
              } else {
                // Secure default (#738): triage only bsc-authored issues unless the user opts out.
                // #1004: lead with this repo's since-last-run delta (if prepareTriageRun supplied one)
                // so a re-run resumes from what changed rather than re-ingesting the whole project.
                // #3281 local-first: triage the plan.db items via `bsc plan`, not `gh issue list`.
                //
                // The trigger used to be `!s.githubToken` alone, which read a token's EXISTENCE as
                // consent to write to GitHub — so any project with a token got the `gh` variant and
                // its triage session ran `gh issue edit --add-label` / `gh label create`, creating
                // GitHub state on a project that integrates locally. A token is what lets us READ
                // GitHub; the project's STRATEGY is what says whether we write to it.
                //
                // So local now means either: no token at all, or a strategy that never reaches a
                // remote. Fail-closed on the strategy — an unset one resolves to the default, which
                // is `local`.
                const triageStrategy = resolveStrategy(undefined, s.planFleet[projKey]?.strategy);
                const triageLocal = !s.githubToken || triageStrategy === "local";
                newPaneStartupPromptText[key] = buildTriagePrompt(s.restrictToBscIssues, deltas?.[fullName ?? ""], triageLocal);
                // Resolution moved to the assignments module (#324/#326): startup
                // prompt is the override cascade; reference context accumulates.
                const doc = resolveStartupPrompt(assignments, { projectId, repo: fullName ?? "" });
                newPaneStartupPromptDocs[key] = doc ?? "";
              }
              // Triage resumes the repo's prior conversation (claude --continue)
              // so each pass builds on the last instead of starting cold.
              newPaneContinue[key] = true;
              // Per-repo checkpoint doc: the session writes "where we left off" to
              // it via bsc-checkpoint; the next triage launch composes it onto the
              // prompt. Stable per (project, repo) so successive passes accumulate.
              newPaneCheckpointDocs[key] = checkpointDocRelpath(projKey, fullName ?? "");
              // Per-session skills (#1056): the project-resolved set, layered with this session's
              // override + any task groups toggled onto it (#skills-groups), keyed by the stable
              // triage identity id.
              newPaneSkills[key] = effectiveSessionSkills(
                s.skills, projectId, s.sessionSkillOverrides[key],
                new Set(expandGroups(s.sessionSkillGroups[key] ?? [], s.skillGroups)),
              );
              newPaneRoles[key] = "triage";
              // Bind the triage pane to its repo so its session GH_TOKEN is scoped to it
              // (#158); a repo with an assigned credential triages with that token only.
              if (fullName) newPaneRepos[key] = fullName;
              delete newDisabledPanes[key];
            } else {
              // Empty grid cell (more cells than repos) — start it disabled so it
              // doesn't spawn an idle shell or add rendering load.
              newDisabledPanes[key] = true;
              delete newPaneRepos[key];
            }
          }
          const newTab: Tab = { id: newTabId(), name: tabName, layout, state: "idle", runId, projectKey: tabKey, kind: "triage", seq: 0, paneIds };
          return {
            tabs: existingIdx >= 0
              ? s.tabs.map((t, i) => (i === existingIdx ? newTab : t))
              : [...s.tabs, newTab],
            activeTabIdx: newTabIdx,
            focusedPaneIdx: -1,
            fullscreenPaneIdx: -1,
            paneMenuOpenIdx: -1,
            paneCwds:     newPaneCwds,
            paneInitCmds: newPaneInitCmds,
            paneStartupPromptDocs: newPaneStartupPromptDocs,
            paneStartupPromptText: newPaneStartupPromptText,
            paneCheckpointDocs: newPaneCheckpointDocs,
            paneContinue: newPaneContinue,
            paneSkills: newPaneSkills,
            paneRoles: newPaneRoles,
            paneRepos: newPaneRepos,
            disabledPanes: newDisabledPanes,
            // Bumped runId remounts this tab's panes; clear their old statuses so a
            // prior pass's "run"/"on" doesn't stick on the fresh sessions (#435). Clear by
            // the (reused) tab's identity so its minted triage ids drop too (#1176).
            paneStatus: clearTabStatusesPure(s.paneStatus, existingIdx >= 0 ? s.tabs[existingIdx] : newTab, newTabIdx),
            paneNames: setMapEntry(s.paneNames, newTabIdx, tabPaneNames),
            automations: [...s.automations, ...addedAutos],
            activeWorkspace: "console" as Workspace,
            // TRIAGED (#2541): launching triage marks the project WORKING → it now appears on Glance.
            ...(projectId || tabKey ? { triagedProjects: { ...s.triagedProjects, [projectId || tabKey]: s.triagedProjects[projectId || tabKey] ?? Date.now() } } : {}),
          };
        }),

      findFleetTabIdx: (projectKey) =>
        findProjectTabIdx(get().tabs, sanitizeProjectKey(projectKey), "build", 0),
      fleetStartProject: (projectName, fleet, projectKey, paths) => {
        // Roster rows (paneId/stream/repo/branch/role) collected during the build below and
        // written to the project hub as fleet.roster.tsv so the director's `bsc-fleet` helper
        // can enumerate the fleet + each worker's state (#734).
        const rosterRows: string[] = [];
        set((s) => {
          // The fleet launches into "· build" tabs (plus "· build 2", "· build 3"…
          // when it overflows a tab). A tab holds up to 16 panes (the 4×4 layout
          // limit); there is no fleet-wide cap, so larger fleets spill into more tabs.
          // Each (re-)launch rebuilds its tab(s) in place with a bumped runId (the
          // caller kills the old panes first), like triageStartProject.
          const baseTabName = `${projectName} · build`;
          const hasDirector = fleet.director.enabled;

          // The commons + integration LANES (#851, retasked by #funnel-commons-and-integration-streams):
          // derive the repo-root commons set from the project's stack (`stack.md`), then (a) strip
          // those paths from every feature stream's `owns` so no worker owns `.gitignore`/
          // `package.json`/CI config, (b) gate every feature stream on its repo's commons lane so the
          // commons land first (Phase 0), and (c) materialize the commons + integration lanes as real
          // streams with real worktrees.
          //
          // NOT conditioned on a director any more. It was, because the DIRECTOR used to own the
          // commons and a director-less fleet therefore had no steward; the owner is now a worker, so
          // the commons exist — and have an owner — whether or not this fleet runs a director.
          const commonsGlobs = commonsGlobsForStack(stackTagsFromSection(s.planStages[projectKey]?.stack ?? ""));
          const plan = commonsGlobs.length ? applyCommonsGate(fleet, commonsGlobs) : fleet;
          // #1854 Phase b: the seeding blueprint's fleet POLICY — the DEFAULT per-stream profile +
          // flow this project type declares. Resolved from the project's blueprint (keyed like
          // planStages, above); absent policy ⇒ today's launch defaults apply byte-for-byte. A
          // stream's own profile/flow still wins over the policy (see the resolvers below).
          const fleetPolicy = s.blueprints.find(
            (b) => b.id === (s.projectBlueprintId[projectKey] ?? DEFAULT_BLUEPRINT_ID),
          )?.fleetPolicy;
          const newPaneDirectorDrive     = { ...s.paneDirectorDrive };
          const newPaneDirectorMode      = { ...s.paneDirectorMode };
          const newPaneStream            = { ...s.paneStream };

          // Independents first so the launched wave is what can run now.
          // ALL intended workers are launched across however many build tabs are needed
          // (#479 — no silent drop past the recommended count; recommended is advisory).
          const ordered = [...plan.streams].sort(
            (a, b) => (a.dependsOn.length ? 1 : 0) - (b.dependsOn.length ? 1 : 0),
          );
          const workers = ordered;

          // Flat session list, chunked into tabs of ≤16. `null` marks the director slot.
          const sessions: (AgentStream | null)[] = [...(hasDirector ? [null] : []), ...workers];
          if (sessions.length === 0) return {};

          const CAP = 16;
          const numTabs = Math.ceil(sessions.length / CAP);

          const newPaneCwds              = { ...s.paneCwds };
          const newPaneInitCmds          = { ...s.paneInitCmds };
          const newPaneStartupPromptDocs = { ...s.paneStartupPromptDocs };
          const newPaneStartupPromptText = { ...s.paneStartupPromptText };
          const newPaneContinue          = { ...s.paneContinue };
          const newPaneCheckpointDocs    = { ...s.paneCheckpointDocs };
          const newPaneSkills            = { ...s.paneSkills };
          const newDisabledPanes         = { ...s.disabledPanes };
          const newPaneNames             = { ...s.paneNames };
          const newPaneRoles             = { ...s.paneRoles };
          const newPaneProfiles             = { ...s.paneProfiles };
          // Unified role→profile model: every session gets its ROLE's default profile (director →
          // Read-only review, worker → Autonomous trusted), resolved from {@link roleProfileId}. No
          // per-stream profile generation — a stream may still pin an explicit `profile` id.
          const newPaneProviders            = { ...s.paneProviders };
          const newPaneWslDistro            = { ...s.paneWslDistro };
          const newFleetPaneStreams      = { ...s.fleetPaneStreams };
          const newPaneRoleGlobs            = { ...s.paneRoleGlobs };
          const newPaneRepos                = { ...s.paneRepos };
          const newPaneFlows                = { ...s.paneFlows };
          const newPaneModels               = { ...s.paneModels };
          let   newPaneStatus               = { ...s.paneStatus };

          const safeKey = sanitizeProjectKey(projectKey);
          // MCP exposure is role-aware (#1054): the director sees every installed server (it
          // coordinates the whole fleet), while each worker gets the global servers plus only the
          // servers its stream was assigned. Hooks/skills still share the project scope.
          // Which harness the fleet runs on (#1078 P5): "claude" (default) or "bsc-agent" (any LLM).
          // A local/ollama provider forces bsc-agent (Claude Code can't drive it), so selecting
          // Ollama runs the workers + director on Ollama without the separate harness toggle.
          const fleetHarness = effectiveHarness(s.llmProvider, s.fleetHarness ?? "claude");

          let tabs = s.tabs;
          let firstTabIdx = -1;

          for (let t = 0; t < numTabs; t++) {
            const chunk = sessions.slice(t * CAP, t * CAP + CAP);
            const tabName = t === 0 ? baseTabName : `${baseTabName} ${t + 1}`;
            // Match on the STABLE (projectKey, kind, seq), not the derived name, so a
            // project rename relabels the build tab(s) in place instead of forking a
            // duplicate "· build" tab with its own director — the "two directors" bug (#457).
            const existingIdx = findProjectTabIdx(tabs, safeKey, "build", t);
            const tabIdx = existingIdx >= 0 ? existingIdx : tabs.length;
            if (firstTabIdx < 0) firstTabIdx = tabIdx;
            const runId = existingIdx >= 0 ? (tabs[existingIdx].runId ?? 0) + 1 : 0;
            // Reused tab → bumped runId remounts its panes; clear their old statuses so
            // a prior run's "run"/"on" doesn't persist on the fresh sessions (#435). Clear
            // by the existing tab's identity so its minted director/worker ids drop (#1176) —
            // the per-cell delete below only covers the NEW layout's ids.
            const reusedTab = existingIdx >= 0 ? tabs[existingIdx] : undefined;
            if (reusedTab) newPaneStatus = clearTabStatusesPure(newPaneStatus, reusedTab, tabIdx);
            // Resume only on re-run. Each worker has its OWN worktree (a distinct
            // cwd), so `claude --continue` is unambiguous even for several agents in
            // one repo — the old shared-cwd hazard is gone.
            const resume = existingIdx >= 0;
            const count = chunk.length;
            const { cols, rows } = gridLayout(count);
            const layout = `${cols}×${rows}`;
            const paneCount = cols * rows;
            const tabPaneNames: Record<number, string> = {};
            const paneIds: string[] = [];

            for (let i = 0; i < paneCount; i++) {
              // Stable pane identity (#1176): director / worker get a project-scoped id so state +
              // recovery bind to the exact session, not the grid slot; an empty cell keeps a
              // positional id.
              const sess0 = i < count ? chunk[i] : undefined;
              const key = sess0 === undefined ? positionalPaneId(tabIdx, i)
                : sess0 === null ? directorPaneId(safeKey) : fleetPaneId(safeKey, sess0.id);
              paneIds[i] = key;
              // Clear any stale wiring (and status) from a prior run of this session.
              delete newPaneStatus[key];
              delete newPaneStartupPromptText[key];
              delete newPaneStartupPromptDocs[key];
              delete newPaneCheckpointDocs[key];
              delete newPaneRoles[key];
              delete newPaneProviders[key];
              delete newPaneWslDistro[key];
              delete newPaneProfiles[key];
              delete newFleetPaneStreams[key];
              delete newPaneRoleGlobs[key];
              delete newPaneRepos[key];
              delete newPaneFlows[key];
              delete newPaneModels[key];
              delete newPaneDirectorDrive[key];
              delete newPaneDirectorMode[key];
              delete newPaneStream[key];
              if (i < count) {
                const sess = chunk[i];
                // #2094: a worker stream may launch AS a persona — resolve it (a live reference to the
                // shared library) so its role/prompt/skills/model drive this pane below. Unknown/unset
                // id ⇒ undefined ⇒ the historical plain-worker defaults.
                const persona = sess?.persona ? s.personas.find((p) => p.id === sess.persona) : undefined;
                // The worker half of this pane's wiring, in ONE place — the wake path adopts a
                // never-launched stream through the same helper, so a woken pane is wired identically.
                // `undefined` for the director: its role/profile/cwd come from the project, not a row.
                const wiring = sess === null ? undefined : streamPaneWiring(sess, persona, fleetPolicy);
                if (sess === null) {
                  // Director session at the project root — sees every repo + worktree.
                  // Prefer the Rust-resolved absolute hub path (#905) so the launch never
                  // depends on the async-loaded `bscBaseDir` mirror (empty/malformed → user root).
                  newPaneCwds[key]     = paths?.hubPath || projectHubCwd(s.bscBaseDir, projectKey, !!s.activeProjectId);
                  newPaneInitCmds[key] = "claude";
                  newPaneStartupPromptDocs[key] = scriptDocRelpath(safeKey, "prompts/director-kickoff.md");
                  newPaneCheckpointDocs[key] = agentCheckpointDocRelpath(safeKey, "director");
                  tabPaneNames[i] = "director";
                  newPaneDirectorDrive[key] = resolveDirectorDrive(plan.director.drive);
                  newPaneDirectorMode[key] = strategySettings(resolveStrategy(undefined, plan.strategy)).director;
                  // NO commons carve-out for the director (#funnel-commons-and-integration-streams).
                  // It used to launch with the commons set as its scoped writeGlobs — the one place a
                  // `code: "none"` role could still write. The commons lane owns those globs now, so
                  // the director keeps the full `code: none` deny and ROUTES a commons change to that
                  // lane with `bsc-assign` instead of applying it. Leaving the carve-out here would
                  // give the commons two writers, which is the collision #851 exists to prevent.
                } else {
                  // A REPO-LESS stream is a team-derived hub role-actor (#3103: curator/documentor/…) —
                  // it runs PROJECT-WIDE at the hub (like the director), not in a per-repo worktree. A
                  // repo'd worker runs in its own git worktree on its own branch: prefer the absolute
                  // path ensure_worktree returned (#905) over the bscBaseDir-derived mirror, so an
                  // empty/malformed base dir can't drop the worker at user root.
                  newPaneCwds[key]     = sess.repo
                    ? (paths?.worktreePaths?.[sess.id] || agentWorktreeCwd(s.bscBaseDir, projectKey, sess.repo, sess.id))
                    : (paths?.hubPath || projectHubCwd(s.bscBaseDir, projectKey, !!s.activeProjectId));
                  newPaneInitCmds[key] = "claude";
                  if (sess.prompt) {
                    newPaneStartupPromptDocs[key] = scriptDocRelpath(safeKey, sess.prompt);
                  } else if (persona) {
                    // A persona stream gets its persona-identity kickoff (role-aware), not the
                    // worker-only buildStreamPrompt — so a reviewer/documentor stream isn't briefed
                    // as a code-writing worker (#2094).
                    newPaneStartupPromptText[key] = personaStreamPrompt(persona, sess, resolveStrategy(sess.strategy, plan.strategy));
                  } else {
                    newPaneStartupPromptText[key] = buildStreamPrompt(sess, resolveStrategy(sess.strategy, plan.strategy));
                  }
                  // Per-agent checkpoint doc (keyed by stream id) so each agent keeps
                  // its own "where we left off" note.
                  newPaneCheckpointDocs[key] = agentCheckpointDocRelpath(safeKey, sess.id);
                  newPaneStream[key] = wiring!.paneStream;
                  tabPaneNames[i] = sess.name;
                  // Bridge pane id → stream so the coordinator can resolve which pane
                  // produces a contract/issue/file (#199 AC#7).
                  newFleetPaneStreams[key] = sess;
                }
                newPaneContinue[key] = resume;
                // A pane's MCP set is resolved at LAUNCH from its persona
                // (mcp-servers-belong-to-the-persona), so the fleet no longer precomputes one here.
                // The per-stream `sess.mcp` assignment is gone with it — measured across every plan
                // store on this machine, no stream carried one.
                // Per-session skills (#1056): project-resolved set + this session's override + any
                // task groups toggled onto it (#skills-groups), keyed by the worker/director's
                // stable identity id. The stream's planner-assigned groups (#1338, `sess.groupIds`)
                // are unioned with the session's manually-toggled groups before expansion, so a
                // worker inherits the skill groups the planner picked for its stream.
                newPaneSkills[key] = effectiveSessionSkills(
                  s.skills, projectKey, s.sessionSkillOverrides[key],
                  // #2094: a persona's attached skills (direct skill ids) join the stream's resolved
                  // set alongside the expanded task-groups + session toggles.
                  new Set([
                    ...expandGroups([...(s.sessionSkillGroups[key] ?? []), ...(sess?.groupIds ?? [])], s.skillGroups),
                    ...(persona?.skills ?? []),
                  ]),
                );
                // #2094: a persona stream launches AS its persona's role (documentor/reviewer/…),
                // overriding the default worker; no persona ⇒ the historical worker/director.
                newPaneRoles[key] = wiring?.role ?? "director";
                newPaneProviders[key] = fleetHarness;
                // #1988: when the launch is sandboxed, this pane spawns INSIDE the sealed distro —
                // its cwd (from `paths`) is already distro-native; record the distro so pty_create
                // wraps the spawn in `wsl -d <distro>`. Only meaningful with the bsc-agent harness.
                if (paths?.wslDistro) newPaneWslDistro[key] = paths.wslDistro;
                // One roster row per live session (#734). Director has no repo/branch.
                rosterRows.push(sess === null
                  ? [key, "director", "-", "-", "director"].join("\t")
                  : [key, sess.id, sess.repo, worktreeSlug(sess.id), "worker"].join("\t"));
                // Bind the worker pane to its repo so its session GH_TOKEN is scoped to
                // it (#158). The director spans every repo, so it keeps the global token.
                if (wiring?.repo) newPaneRepos[key] = wiring.repo;
                // Bind the pane to its ROLE's default profile: director → Read-only review,
                // worker → Autonomous (trusted) — unless the stream pins an explicit profile. #1854
                // Phase b: a blueprint's fleetPolicy.profile seeds the WORKER default (never the
                // director, sess===null) between the stream's own pin and the role default.
                newPaneProfiles[key] = wiring?.profile ?? roleProfileId(newPaneRoles[key]);
                // The worker's owned paths become its role write boundary so edits in
                // its lane auto-approve (dir/ -> dir/** so the subtree matches). #2094: only for a
                // code-WRITING role — a read-only persona stream (reviewer/juror/…) must NOT get a
                // write carve-out from its owns, or the read-only floor would leak.
                if (wiring?.roleGlobs) newPaneRoleGlobs[key] = wiring.roleGlobs;
                // #1854 Phase b: the stream's own flow wins; else the blueprint fleetPolicy.flow
                // default; else undefined so the launch path applies DEFAULT_FLOW downstream (only
                // workers carry a flow — the director, sess===null, never does).
                if (wiring?.flow) newPaneFlows[key] = wiring.flow;
                // Per-agent model (#…) → the pane's `claude --model` at launch. Director (sess===null)
                // and unset workers fall back to the global `defaultModel` (resolved at pane mount).
                // #2094: the stream's own model wins; else its persona's model (validated as a tier).
                if (wiring?.model) newPaneModels[key] = wiring.model;
                delete newDisabledPanes[key];
              } else {
                // Empty grid cell — start disabled so it doesn't spawn an idle shell.
                newDisabledPanes[key] = true;
              }
            }

            const newTab: Tab = { id: newTabId(), name: tabName, layout, state: "idle", runId, projectKey: safeKey, kind: "build", seq: t, paneIds };
            tabs = existingIdx >= 0
              ? tabs.map((tb, i) => (i === existingIdx ? newTab : tb))
              : [...tabs, newTab];
            newPaneNames[tabIdx] = tabPaneNames;
          }

          const addedAutos = activateAutomations(s, s.activeProjectId ?? "", baseTabName);
          // #459: structure-aware auto-focus — set focusTarget based on fleet shape:
          // director present → only the director surfaces (workers run dark);
          // no director → all fleet panes queue (fall back to fleet-wide focus).
          const structureFocusTarget = hasDirector ? "director" : "fleet";
          return {
            tabs,
            activeTabIdx: firstTabIdx,
            focusTarget: structureFocusTarget,
            automations: [...s.automations, ...addedAutos],
            focusedPaneIdx: -1,
            fullscreenPaneIdx: -1,
            paneMenuOpenIdx: -1,
            paneCwds: newPaneCwds,
            paneInitCmds: newPaneInitCmds,
            paneStartupPromptDocs: newPaneStartupPromptDocs,
            paneStartupPromptText: newPaneStartupPromptText,
            paneContinue: newPaneContinue,
            paneCheckpointDocs: newPaneCheckpointDocs,
            paneSkills: newPaneSkills,
            paneRoles: newPaneRoles,
            paneProviders: newPaneProviders,
            paneWslDistro: newPaneWslDistro,
            paneProfiles: newPaneProfiles,

            fleetPaneStreams: newFleetPaneStreams,
            paneRoleGlobs: newPaneRoleGlobs,
            paneRepos: newPaneRepos,
            paneFlows: newPaneFlows,
            paneModels: newPaneModels,
            paneDirectorDrive: newPaneDirectorDrive,
            paneDirectorMode: newPaneDirectorMode,
            paneStream: newPaneStream,
            disabledPanes: newDisabledPanes,
            paneStatus: newPaneStatus,
            paneNames: newPaneNames,
            activeWorkspace: "console" as Workspace,
            // TRIAGED (#2541): launching the fleet marks the project WORKING → it now appears on Glance.
            ...(projectKey ? { triagedProjects: { ...s.triagedProjects, [projectKey]: s.triagedProjects[projectKey] ?? Date.now() } } : {}),
          };
        });
        // The caller persists these to the hub (publishFleetRoster) — the store stays
        // Tauri-free. Rows: paneId/stream/repo/branch/role, one per live session (#734).
        return rosterRows;
      },
});
