// ProjectsSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import type { Tab } from "@/app/chrome/Tabstrip";
import type { Workspace } from "@/app/chrome/Rail";
import type { AgentStream } from "@/features/planner/fleet/planFleet";
import { newTabId, buildAssignments, buildStreamPrompt, activateAutomations, gridLayout } from "../helpers";
import { buildTriagePrompt, renderTriageDelta } from "../constants";
import { invoke } from "@tauri-apps/api/core";
import type { PlanIssue } from "@/features/planner/issues/planIssues";
import { checkpointDocRelpath, agentCheckpointDocRelpath } from "@/shared/lib/session/checkpoint";
import { projectRepoCwd, projectHubCwd, agentWorktreeCwd, sanitizeProjectKey, findProjectTabIdx, worktreeSlug } from "@/shared/lib/core/projectPaths";
import { fleetPaneId, directorPaneId, triagePaneId, positionalPaneId, findPaneOwnerTab } from "@/app/console/lib/paneIdentity";
import { clearTabStatuses as clearTabStatusesPure } from "@/app/console/lib/paneStatus";
import { repoPromptKey } from "@/shared/lib/session/startupPrompt";
import { resolveDirectorDrive } from "@/features/planner/fleet/directorDrive";
import { personaStreamPrompt } from "@/features/planner/fleet/streamPersona";
import { roleCapability } from "@/shared/lib/session/sessionRoles";
import { MODEL_IDS, type ModelId } from "@/app/console/lib/models";
import { applyCommonsGate } from "@/features/planner/fleet/commonsGate";
import { parseIntake, changedDesignFiles, markRouted, renderDesignDelta, serializeIntake, INTAKE_DIR, INTAKE_MANIFEST } from "@/features/planner/lib/fileIntake";
import { STAGE_DEFS, DEFAULT_BLUEPRINT_ID } from "@/features/planner/stages/blueprints";
import { resolveStreamFlow, resolveStreamProfile } from "@/features/planner/fleet/fleetPolicy";
import { commonsGlobsForStack, stackTagsFromSection } from "@/shared/lib/session/commons";
import { roleProfileId } from "@/shared/lib/session/roleProfile";
import { resolveHooks } from "@/features/mcp/lib/hooks";
import { resolveMcpServers, resolveAllInstalledMcp, resolveStreamMcp } from "@/features/mcp/lib/mcpServers";
import { resolveStartupPrompt } from "@/shared/lib/session/assignments";
import { effectiveSessionSkills, expandGroups } from "@/features/skills/lib/skills";
import { resolveStrategy, strategySettings } from "@/features/planner/lib/integrationStrategy";
import { scriptDocRelpath } from "@/features/planner/session/planningSession";
import { setMapEntry, deleteMapEntry } from "../updateHelpers";
import { deleteProjectScoped, rekeyProjectScoped } from "./projectScopedMaps";
import { effectiveHarness } from "@/shared/lib/core/llmConfig";
import { bscJson } from "@/shared/lib/core/bsc";

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
      wakePane: (paneId, prompt) => {
        let ok = false;
        set((st) => {
          // #4025: resolve the owning tab by IDENTITY, as `resumePaneSession` already does. This used
          // to parse `^t(\d+)p\d+$` out of the pane id — the positional scheme pane identity replaced.
          // Measured on the live coord log: 0 positional ids, 273 identity ids. So it returned false
          // for EVERY session, and since `actuateWake` kills the PTY first, the inbox Wake button
          // killed a parked worker and never brought it back (skipping the `woke` event too, so the
          // log did not even record it).
          const owner = findPaneOwnerTab(st.tabs, paneId);
          if (!owner || st.disabledPanes[paneId]) return {};
          ok = true;
          return {
            paneStartupPromptText: setMapEntry(st.paneStartupPromptText, paneId, prompt),
            paneContinue: setMapEntry(st.paneContinue, paneId, false),
            // A reaped/dormant pane renders the DormantConsole PLACEHOLDER, not a terminal — so the
            // runId bump alone would remount a card with no PTY behind it and the baked prompt would
            // never run. Clearing it is what lets a wake reach a session that was reclaimed.
            dormantPanes: deleteMapEntry(st.dormantPanes, paneId),
            endedPanes: deleteMapEntry(st.endedPanes, paneId),
            tabs: st.tabs.map((t, i) => (i === owner.tabIdx ? { ...t, runId: (t.runId ?? 0) + 1 } : t)),
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
          const newPaneMcpServers        = { ...s.paneMcpServers };
          const newPaneHooks             = { ...s.paneHooks };
          const newPaneSkills            = { ...s.paneSkills };
          const newPaneRoles             = { ...s.paneRoles };
          const newPaneRepos             = { ...s.paneRepos };
          const triageMcp                = resolveMcpServers(s.mcpServers, projectId);
          const triageHooks              = resolveHooks(s.hooks, projectId);
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
                // #3281 local-first: no GitHub token ⇒ triage the plan.db issues via `bsc plan`, not
                // `gh issue list`. (When connected, the GitHub-issue triage is unchanged.)
                newPaneStartupPromptText[key] = buildTriagePrompt(s.restrictToBscIssues, deltas?.[fullName ?? ""], !s.githubToken);
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
              newPaneMcpServers[key] = triageMcp;
              newPaneHooks[key] = triageHooks;
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
            paneMcpServers: newPaneMcpServers,
            paneHooks: newPaneHooks,
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

          // Director-owned commons (#851): derive the repo-root commons set from the project's stack
          // (`stack.md`), then (a) strip those paths from every feature stream's `owns` so no worker
          // owns `.gitignore`/`package.json`/CI config, and (b) gate every feature stream on the
          // commons-landed sentinel so the director scaffolds + lands them first (Phase 0). The
          // commons globs also become the director's scoped writeGlobs below (its only code writes).
          const commonsGlobs = hasDirector
            ? commonsGlobsForStack(stackTagsFromSection(s.planStages[projectKey]?.stack ?? ""))
            : [];
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
          const newPaneMcpServers        = { ...s.paneMcpServers };
          const newPaneHooks             = { ...s.paneHooks };
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
          const fleetAllMcp = resolveAllInstalledMcp(s.mcpServers);
          const fleetHooks = resolveHooks(s.hooks, projectKey);

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
              delete newPaneMcpServers[key];
              delete newPaneHooks[key];
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
                  // Director-owned commons (#851): the director's scoped write boundary is the
                  // commons set. With role `code: "none"` this is the carve-out (sessionRoles
                  // `hasScopedWriteCarveOut`) — it may write EXACTLY these globs (.gitignore,
                  // manifests, CI config) and is denied every other code write; the bsc-scope hook
                  // hard-blocks anything outside them. Empty ⇒ no carve-out, full code:none deny.
                  if (commonsGlobs.length) newPaneRoleGlobs[key] = commonsGlobs;
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
                  newPaneStream[key] = { repo: sess.repo, branch: worktreeSlug(sess.id) };
                  tabPaneNames[i] = sess.name;
                  // Bridge pane id → stream so the coordinator can resolve which pane
                  // produces a contract/issue/file (#199 AC#7).
                  newFleetPaneStreams[key] = sess;
                }
                newPaneContinue[key] = resume;
                // Director (sess === null) sees every installed server; a worker gets the
                // fleet-wide baseline plus its stream's assigned servers (#1054).
                newPaneMcpServers[key] = sess === null ? fleetAllMcp : resolveStreamMcp(s.mcpServers, sess.mcp, projectKey);
                newPaneHooks[key] = fleetHooks;
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
                newPaneRoles[key] = sess === null ? "director" : (persona?.role ?? "worker");
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
                if (sess && sess.repo) newPaneRepos[key] = sess.repo;
                // Bind the pane to its ROLE's default profile: director → Read-only review,
                // worker → Autonomous (trusted) — unless the stream pins an explicit profile. #1854
                // Phase b: a blueprint's fleetPolicy.profile seeds the WORKER default (never the
                // director, sess===null) between the stream's own pin and the role default.
                newPaneProfiles[key] = resolveStreamProfile(
                  sess?.profile,
                  sess === null ? undefined : fleetPolicy?.profile,
                  roleProfileId(newPaneRoles[key]),
                );
                // The worker's owned paths become its role write boundary so edits in
                // its lane auto-approve (dir/ -> dir/** so the subtree matches). #2094: only for a
                // code-WRITING role — a read-only persona stream (reviewer/juror/…) must NOT get a
                // write carve-out from its owns, or the read-only floor would leak.
                if (sess && sess.owns.length && roleCapability(newPaneRoles[key]).code === "write")
                  newPaneRoleGlobs[key] = sess.owns.map((g) => (g.endsWith("/") ? g + "**" : g));
                // #1854 Phase b: the stream's own flow wins; else the blueprint fleetPolicy.flow
                // default; else undefined so the launch path applies DEFAULT_FLOW downstream (only
                // workers carry a flow — the director, sess===null, never does).
                const effFlow = resolveStreamFlow(sess?.flow, fleetPolicy?.flow);
                if (sess && effFlow) newPaneFlows[key] = effFlow;
                // Per-agent model (#…) → the pane's `claude --model` at launch. Director (sess===null)
                // and unset workers fall back to the global `defaultModel` (resolved at pane mount).
                // #2094: the stream's own model wins; else its persona's model (validated as a tier).
                const streamModel = sess?.model ?? (persona?.model && (MODEL_IDS as readonly string[]).includes(persona.model) ? persona.model as ModelId : undefined);
                if (sess && streamModel) newPaneModels[key] = streamModel;
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
            paneMcpServers: newPaneMcpServers,
            paneHooks: newPaneHooks,
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
