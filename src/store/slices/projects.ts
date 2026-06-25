// ProjectsSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import type { Tab } from "@/app/chrome/Tabstrip";
import type { Screen } from "@/app/chrome/Rail";
import type { AgentStream } from "@/features/planner/stages/planSections";
import { WORKFLOW_PRESETS } from "@/shared/lib/fleet/workflow";
import { startRun } from "@/shared/lib/fleet/conductor";
import { newTabId, buildAssignments, buildStreamPrompt, activateAutomations, mountState } from "../helpers";
import { buildTriagePrompt, renderTriageDelta } from "../constants";
import { invoke } from "@tauri-apps/api/core";
import type { PlanIssue } from "@/features/planner/issues/planIssues";
import { checkpointDocRelpath, agentCheckpointDocRelpath } from "@/shared/lib/session/checkpoint";
import { projectRepoCwd, projectHubCwd, agentWorktreeCwd, sanitizeProjectKey, canonicalProjectKey, findProjectTabIdx, worktreeSlug } from "@/shared/lib/core/projectPaths";
import { fleetPaneId, directorPaneId, triagePaneId, positionalPaneId } from "@/app/console/lib/paneIdentity";
import { clearTabStatuses as clearTabStatusesPure } from "@/app/console/lib/paneStatus";
import { repoPromptKey } from "@/shared/lib/session/startupPrompt";
import { resolveAllowedCommands } from "@/shared/lib/session/allowedCommands";
import { resolveDirectorDrive } from "@/features/planner/fleet/directorDrive";
import { applyCommonsGate } from "@/features/planner/fleet/commonsGate";
import { commonsGlobsForStack, stackTagsFromSection } from "@/shared/lib/session/commons";
import { resolveHooks } from "@/features/extensions/lib/hooks";
import { resolveMcpServers, resolveAllInstalledMcp, resolveStreamMcp } from "@/features/extensions/lib/mcpServers";
import { resolveReferenceContext, resolveStartupPrompt } from "@/shared/lib/session/assignments";
import { effectiveSessionSkills, expandGroups } from "@/features/skills/lib/skills";
import { resolveStrategy, strategySettings } from "@/features/planner/shared/integrationStrategy";
import { scriptDocRelpath } from "@/features/planner/session/planningSession";

type ProjectsSlice = Pick<AppStore,
  "deleteLocalProject" | "resetProjectData" | "setActiveProjectRepos" | "defaultStartupPromptDoc" | "setDefaultStartupPromptDoc" | "projectStartupPromptDoc" | "setProjectStartupPromptDoc" | "repoStartupPromptDoc" | "setRepoStartupPromptDoc" | "refContextDefault" | "refContextProject" | "refContextRepo" | "toggleReferenceContext" | "repoTriagePromptDoc" | "setRepoTriagePromptDoc" | "githubTab" | "setGithubTab" | "githubBoardOpen" | "githubBoardTab" | "openGithubBoard" | "setGithubBoardTab" | "closeGithubBoard" | "wakePane" | "fleetPaneStreams" | "workflowRuns" | "workflowStart" | "workflowClear" | "workflowMount" | "workflowSetRuns" | "projectsDrawerIssue" | "setProjectsDrawerIssue" | "planningPitch" | "planningRepo" | "planningTitle" | "setPlanningContext" | "setPlanningTitle" | "planningSessionKey" | "setPlanningSession" | "pendingPlannerPrompt" | "requestPlannerPrompt" | "clearPlannerPrompt" | "projectKeyAlias" | "setProjectKeyAlias" | "issueLinks" | "setIssueLinks" | "bscBaseDir" | "setBscBaseDir" | "projectLocalRepos" | "localDraftProjects" | "addProjectRepo" | "findTriageTabIdx" | "triageStartProject" | "prepareTriageRun" | "findFleetTabIdx" | "fleetStartProject"
>;

export const createProjectsSlice: StateCreator<AppStore, [], [], ProjectsSlice> = (set, get) => ({
      deleteLocalProject: (keys) =>
        set((s) => {
          // Resolve each passed key (project title OR GitHub node id) to its data key via the alias,
          // so the per-project maps — keyed by the sanitized slug (`effectiveProjectId`) — are
          // actually dropped, not just the raw title/id. Deleting a PUBLISHED project passes its node
          // id; without this the slug-keyed planSections/planFleet/… leak (#997).
          const keySet = new Set(
            keys.flatMap((k) => (k ? [k, s.projectKeyAlias[k]] : [])).filter(Boolean) as string[],
          );
          // Drop entries whose key is the project key. `m ?? {}` guards a slice that's
          // missing/null in a long-lived persisted store — `Object.entries(undefined)`
          // would throw and (without a boundary) crash the whole app on delete (#874).
          const byKey = <T,>(m: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => !keySet.has(k)));
          // Drop repo-scoped entries (`<projectKey>::<repo>`) for this project.
          const byRepoKey = <T,>(m: Record<string, T>): Record<string, T> =>
            Object.fromEntries(Object.entries(m ?? {}).filter(([k]) => !keySet.has(k.split("::")[0])));
          // Clear the active project AND the planning session when the deleted project is either.
          // The Planning pane is mounted once (only CSS-hidden); if `planningSessionKey` still points
          // at the deleted project, its `effectiveProjectId` keeps resolving there and it renders
          // against now-gone data → crash. A published delete passes the node id (== activeProjectId),
          // which is why only published deletes hit this (#997).
          const clearActive =
            (s.activeProjectId != null && keySet.has(s.activeProjectId)) ||
            (!!s.planningSessionKey && keySet.has(s.planningSessionKey));
          return {
            planSections:           byKey(s.planSections),
            planConfirmedSections:  byKey(s.planConfirmedSections),
            planAuthoredBlueprint:  byKey(s.planAuthoredBlueprint),
            planDeployConfig:       byKey(s.planDeployConfig),
            planSkippedSections:    byKey(s.planSkippedSections),
            planKbAssignments:      byKey(s.planKbAssignments),
            planAutomations:        byKey(s.planAutomations),
            planStageConfig:        byKey(s.planStageConfig),
            projectBlueprintId:     byKey(s.projectBlueprintId),
            uiScreens:              byKey(s.uiScreens),
            uiApproved:             byKey(s.uiApproved),
            planFleet:              byKey(s.planFleet),
            pinnedContext:          byKey(s.pinnedContext),
            projectKeyAlias:        byKey(s.projectKeyAlias),
            issueLinks:             byKey(s.issueLinks),
            // Drop the deleted project id from every extension's scope list. `projects` may be
            // undefined (a def added without it, or persisted data predating the field) — guard,
            // or `.filter` throws and crashes the app on delete (#791).
            mcpServers:             (s.mcpServers ?? []).map((e) => ({ ...e, projects: (e.projects ?? []).filter((p) => !keySet.has(p)) })),
            hooks:                  (s.hooks ?? []).map((e) => ({ ...e, projects: (e.projects ?? []).filter((p) => !keySet.has(p)) })),
            // …and from every skill's scope list.
            skills:                 (s.skills ?? []).map((sk) => ({ ...sk, projects: (sk.projects ?? []).filter((p) => !keySet.has(p)) })),
            projectStartupPromptDoc: byKey(s.projectStartupPromptDoc),
            projectLocalRepos:      byKey(s.projectLocalRepos),
        localDraftProjects:     byKey(s.localDraftProjects),
            projectAllowedCommands: byKey(s.projectAllowedCommands),
            repoStartupPromptDoc:   byRepoKey(s.repoStartupPromptDoc),
            repoTriagePromptDoc:    byRepoKey(s.repoTriagePromptDoc),
            repoAllowedCommands:    byRepoKey(s.repoAllowedCommands),
            refContextProject:      byKey(s.refContextProject),
            refContextRepo:         byRepoKey(s.refContextRepo),
            ...(clearActive
              ? { activeProjectId: null, activeProjectName: "", activeProjectRepo: "", activeProjectNumber: 0, activeProjectRepos: [], planningSessionKey: "", projectsView: "list" as const }
              : {}),
          };
        }),
      resetProjectData: () =>
        set({
          planSections: {}, planConfirmedSections: {}, planAuthoredBlueprint: {}, planSkippedSections: {}, planDeployConfig: {}, planKbAssignments: {},
          planAutomations: {}, planStageConfig: {}, projectBlueprintId: {}, uiScreens: {}, uiApproved: {}, stageRuns: {}, stagePreview: {}, sectionGrades: {}, planFleet: {}, pinnedContext: {},
          projectLocalRepos: {}, localDraftProjects: {}, projectAllowedCommands: {},
          projectKeyAlias: {}, issueLinks: {}, repoAllowedCommands: {}, projectStartupPromptDoc: {},
          repoStartupPromptDoc: {}, repoTriagePromptDoc: {}, hiddenProjectIds: [],
          refContextDefault: [], refContextProject: {}, refContextRepo: {},
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
        set((s) => ({ projectStartupPromptDoc: { ...s.projectStartupPromptDoc, [projectId]: doc } })),
      repoStartupPromptDoc: {},
      setRepoStartupPromptDoc: (projectId, repo, doc) =>
        set((s) => ({ repoStartupPromptDoc: { ...s.repoStartupPromptDoc, [repoPromptKey(projectId, repo)]: doc } })),
      refContextDefault: [],
      refContextProject: {},
      refContextRepo: {},
      toggleReferenceContext: (level, key, doc) =>
        set((s) => {
          const toggle = (list: string[]): string[] =>
            list.includes(doc) ? list.filter((d) => d !== doc) : [...list, doc];
          if (level === "default") return { refContextDefault: toggle(s.refContextDefault) };
          if (level === "project") {
            const k = key ?? "";
            return { refContextProject: { ...s.refContextProject, [k]: toggle(s.refContextProject[k] ?? []) } };
          }
          const k = key ?? "";
          return { refContextRepo: { ...s.refContextRepo, [k]: toggle(s.refContextRepo[k] ?? []) } };
        }),
      repoTriagePromptDoc: {},
      setRepoTriagePromptDoc: (projectId, repo, doc) =>
        set((s) => ({ repoTriagePromptDoc: { ...s.repoTriagePromptDoc, [repoPromptKey(projectId, repo)]: doc } })),
      githubTab: "summary",
      setGithubTab: (t) => set({ githubTab: t }),
      githubBoardOpen: false,
      githubBoardTab: "board",
      openGithubBoard: (tab = "board") => set({ githubBoardOpen: true, githubBoardTab: tab }),
      setGithubBoardTab: (t) => set({ githubBoardTab: t }),
      closeGithubBoard: () => set({ githubBoardOpen: false }),
      wakePane: (paneId, prompt) => {
        const m = /^t(\d+)p\d+$/.exec(paneId);
        if (!m) return false;
        const tabIdx = Number(m[1]);
        let ok = false;
        set((st) => {
          if (tabIdx < 0 || tabIdx >= st.tabs.length || st.disabledPanes[paneId]) return {};
          ok = true;
          return {
            paneStartupPromptText: { ...st.paneStartupPromptText, [paneId]: prompt },
            paneContinue: { ...st.paneContinue, [paneId]: false },
            tabs: st.tabs.map((t, i) => (i === tabIdx ? { ...t, runId: (t.runId ?? 0) + 1 } : t)),
          };
        });
        return ok;
      },
      fleetPaneStreams: {},
      workflowRuns: {},
      workflowStart: (presetKey, item) =>
        set((s) => {
          const pipeline = WORKFLOW_PRESETS[presetKey];
          const id = item.trim();
          if (!pipeline || !id) return {};
          return mountState(s, id, startRun(pipeline, id).run);
        }),
      workflowClear: (item) =>
        set((s) => {
          const runs = { ...s.workflowRuns };
          delete runs[item];
          return { workflowRuns: runs };
        }),
      workflowMount: (item) =>
        set((s) => {
          const run = s.workflowRuns[item];
          return run ? mountState(s, item, run) : {};
        }),
      workflowSetRuns: (runs) => set({ workflowRuns: runs }),
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
        set((s) => ({ pendingPlannerPrompt: { ...s.pendingPlannerPrompt, [projectKey]: text } })),
      clearPlannerPrompt: (projectKey) =>
        set((s) => {
          if (!(projectKey in s.pendingPlannerPrompt)) return {};
          const next = { ...s.pendingPlannerPrompt };
          delete next[projectKey];
          return { pendingPlannerPrompt: next };
        }),
      projectKeyAlias: {},
      setProjectKeyAlias: (nodeId, key) =>
        set((s) => (nodeId && key && !s.projectKeyAlias[nodeId]
          ? { projectKeyAlias: { ...s.projectKeyAlias, [nodeId]: key } }
          : {})),
      issueLinks: {},
      setIssueLinks: (projectKey, links) =>
        set((s) => ({ issueLinks: { ...s.issueLinks, [projectKey]: { ...(s.issueLinks[projectKey] ?? {}), ...links } } })),
      bscBaseDir: "",
      setBscBaseDir: (dir) => set({ bscBaseDir: dir }),
      projectLocalRepos: {},
      localDraftProjects: {},
      addProjectRepo: (projectId, fullName) =>
        set((s) => {
          const existing = s.projectLocalRepos[projectId] ?? [];
          if (existing.includes(fullName)) return {};
          return { projectLocalRepos: { ...s.projectLocalRepos, [projectId]: [...existing, fullName] } };
        }),
      findTriageTabIdx: (projectName, projectId = "") =>
        findProjectTabIdx(get().tabs, canonicalProjectKey(projectName, projectId), "triage"),
      // #1004: prepare a triage re-run from plan.db — for each repo read the last-run marker and the
      // issues changed since it, render a one-line resume lead (renderTriageDelta), then STAMP a fresh
      // marker so the next run's "since" is now (read-before-write order). Returns fullName → lead for
      // triageStartProject's `deltas`. Failures are per-repo and non-fatal (omitted ⇒ full prompt).
      prepareTriageRun: async (projectKey, repos) => {
        const deltas: Record<string, string> = {};
        await Promise.all(repos.map(async (repo) => {
          try {
            const lastRun = await invoke<number | null>("plan_triage_last_run", { projectKey, repo });
            const changed = lastRun != null
              ? await invoke<PlanIssue[]>("plan_issues_changed_since", { projectKey, repo, since: lastRun })
              : [];
            deltas[repo] = renderTriageDelta(
              changed.map((c) => ({ ref: c.ref, title: c.title, status: c.status ?? "open" })),
              lastRun ?? null,
            );
            await invoke("plan_triage_record_run", { projectKey, repo });
          } catch (e) {
            console.error(`triage delta prep ${repo} failed:`, e);
          }
        }));
        return deltas;
      },
      triageStartProject: (projectName, repos, projectId = "", deltas) =>
        set((s) => {
          // A triage tab for this project may already exist (re-run): rebuild it in
          // place at the same index. The caller kills the old panes' sessions first
          // and the bumped runId remounts them, so pty_create launches fresh
          // (resuming via --continue + the checkpoint) instead of reconnecting.
          // Match on the STABLE projectKey, not the derived name, so a project rename
          // relabels the tab in place instead of forking a duplicate (#457).
          const tabName = `${projectName} · triage`;
          const tabKey = canonicalProjectKey(projectName, projectId);
          const existingIdx = findProjectTabIdx(s.tabs, tabKey, "triage");
          if (repos.length === 0) return {};
          const newTabIdx = existingIdx >= 0 ? existingIdx : s.tabs.length;
          const runId = existingIdx >= 0 ? (s.tabs[existingIdx].runId ?? 0) + 1 : 0;
          const addedAutos = activateAutomations(s, projectId, tabName);
          const count = Math.min(repos.length, 16);
          const cols = count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
          const rows = Math.ceil(count / cols);
          const layout = `${cols}×${rows}`;
          const newPaneCwds     = { ...s.paneCwds };
          const newPaneInitCmds = { ...s.paneInitCmds };
          const newPaneStartupPromptDocs = { ...s.paneStartupPromptDocs };
          const newPaneStartupPromptText = { ...s.paneStartupPromptText };
          const newPaneReferenceDocs     = { ...s.paneReferenceDocs };
          const newPaneCheckpointDocs    = { ...s.paneCheckpointDocs };
          const newPaneContinue          = { ...s.paneContinue };
          const newPaneAllowedCommands   = { ...s.paneAllowedCommands };
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
              // A real repo — launch claude in its clone, ensure it's enabled. Draft projects
              // live under draft/ (#904); a published project (has a board id) under projects/.
              newPaneCwds[key]     = projectRepoCwd(s.bscBaseDir, projectName, fullName, !!s.activeProjectId);
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
                newPaneStartupPromptText[key] = buildTriagePrompt(s.restrictToBscIssues, deltas?.[fullName ?? ""]);
                // Resolution moved to the assignments module (#324/#326): startup
                // prompt is the override cascade; reference context accumulates.
                const doc = resolveStartupPrompt(assignments, { projectId, repo: fullName ?? "" });
                newPaneStartupPromptDocs[key] = doc ?? "";
              }
              // Reference-context docs (#326): injected as background context for
              // this pane regardless of which startup prompt won above. Keyed by
              // the sanitized project key (projKey) so KB-page project assignments
              // — which use the same key — resolve here.
              const refDocs = resolveReferenceContext(assignments, { projectId: projKey, repo: fullName ?? "" });
              if (refDocs.length > 0) newPaneReferenceDocs[key] = refDocs;
              newPaneAllowedCommands[key] = resolveAllowedCommands(
                s.allowedCommands,
                s.projectAllowedCommands[projectId],
                s.repoAllowedCommands[repoPromptKey(projectId, fullName ?? "")],
              );
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
            paneReferenceDocs: newPaneReferenceDocs,
            paneCheckpointDocs: newPaneCheckpointDocs,
            paneContinue: newPaneContinue,
            paneAllowedCommands: newPaneAllowedCommands,
            paneMcpServers: newPaneMcpServers,
            paneHooks: newPaneHooks,
            paneSkills: newPaneSkills,
            paneRoles: newPaneRoles,
            paneRepos: newPaneRepos,
            disabledPanes: newDisabledPanes,
            // Bumped runId remounts this tab's panes; clear their old statuses so a
            // prior pass's "run"/"on" doesn't stick on the fresh sessions (#435).
            paneStatus: clearTabStatusesPure(s.paneStatus, newTabIdx),
            paneNames: { ...s.paneNames, [newTabIdx]: tabPaneNames },
            automations: [...s.automations, ...addedAutos],
            activeScreen: "console" as Screen,
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
            ? commonsGlobsForStack(stackTagsFromSection(s.planSections[projectKey]?.stack ?? ""))
            : [];
          const plan = commonsGlobs.length ? applyCommonsGate(fleet, commonsGlobs) : fleet;
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
          const newPaneReferenceDocs     = { ...s.paneReferenceDocs };
          const newPaneContinue          = { ...s.paneContinue };
          const newPaneCheckpointDocs    = { ...s.paneCheckpointDocs };
          const newPaneAllowedCommands   = { ...s.paneAllowedCommands };
          const newPaneMcpServers        = { ...s.paneMcpServers };
          const newPaneHooks             = { ...s.paneHooks };
          const newPaneSkills            = { ...s.paneSkills };
          const newDisabledPanes         = { ...s.disabledPanes };
          const newPaneNames             = { ...s.paneNames };
          const newPaneRoles             = { ...s.paneRoles };
          const newPaneProfiles             = { ...s.paneProfiles };
          const newPaneProviders            = { ...s.paneProviders };
          const newFleetPaneStreams      = { ...s.fleetPaneStreams };
          const newPaneRoleGlobs            = { ...s.paneRoleGlobs };
          const newPaneRepos                = { ...s.paneRepos };
          const newPaneFlows                = { ...s.paneFlows };
          const newPaneModels               = { ...s.paneModels };
          let   newPaneStatus               = { ...s.paneStatus };

          const safeKey = sanitizeProjectKey(projectKey);
          const projectCmds = resolveAllowedCommands(s.allowedCommands, s.projectAllowedCommands[projectKey], undefined);
          // MCP exposure is role-aware (#1054): the director sees every installed server (it
          // coordinates the whole fleet), while each worker gets the global servers plus only the
          // servers its stream was assigned. Hooks/skills still share the project scope.
          // Which harness the fleet runs on (#1078 P5): "claude" (default) or "bsc-agent" (any LLM).
          const fleetHarness = s.fleetHarness ?? "claude";
          const fleetAllMcp = resolveAllInstalledMcp(s.mcpServers);
          const fleetHooks = resolveHooks(s.hooks, projectKey);
          // Reference-context assignments resolved per pane below (#326).
          const fleetAssignments = buildAssignments(s);

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
            // a prior run's "run"/"on" doesn't persist on the fresh sessions (#435).
            newPaneStatus = clearTabStatusesPure(newPaneStatus, tabIdx);
            // Resume only on re-run. Each worker has its OWN worktree (a distinct
            // cwd), so `claude --continue` is unambiguous even for several agents in
            // one repo — the old shared-cwd hazard is gone.
            const resume = existingIdx >= 0;
            const count = chunk.length;
            const cols = count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
            const rows = Math.ceil(count / cols);
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
              delete newPaneReferenceDocs[key];
              delete newPaneCheckpointDocs[key];
              delete newPaneMcpServers[key];
              delete newPaneHooks[key];
              delete newPaneRoles[key];
              delete newPaneProviders[key];
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
                if (sess === null) {
                  // Director session at the project root — sees every repo + worktree.
                  // Prefer the Rust-resolved absolute hub path (#905) so the launch never
                  // depends on the async-loaded `bscBaseDir` mirror (empty/malformed → user root).
                  newPaneCwds[key]     = paths?.hubPath || projectHubCwd(s.bscBaseDir, projectKey, !!s.activeProjectId);
                  newPaneInitCmds[key] = "claude";
                  newPaneStartupPromptDocs[key] = scriptDocRelpath(safeKey, "prompts/director-kickoff.md");
                  newPaneAllowedCommands[key] = projectCmds;
                  newPaneCheckpointDocs[key] = agentCheckpointDocRelpath(safeKey, "director");
                  // Project-level reference context for the director (no repo
                  // scope). Keyed by the sanitized project key (safeKey) to match
                  // the KB page's project assignments.
                  {
                    const refDocs = resolveReferenceContext(fleetAssignments, { projectId: safeKey });
                    if (refDocs.length > 0) newPaneReferenceDocs[key] = refDocs;
                  }
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
                  // Worker runs in its own git worktree on its own branch. Prefer the
                  // absolute path ensure_worktree returned (#905) over the bscBaseDir-derived
                  // mirror, so an empty/malformed base dir can't drop the worker at user root.
                  newPaneCwds[key]     = paths?.worktreePaths?.[sess.id] || agentWorktreeCwd(s.bscBaseDir, projectKey, sess.repo, sess.id);
                  newPaneInitCmds[key] = "claude";
                  if (sess.prompt) {
                    newPaneStartupPromptDocs[key] = scriptDocRelpath(safeKey, sess.prompt);
                  } else {
                    newPaneStartupPromptText[key] = buildStreamPrompt(sess, resolveStrategy(sess.strategy, plan.strategy));
                  }
                  newPaneAllowedCommands[key] = resolveAllowedCommands(
                    s.allowedCommands,
                    s.projectAllowedCommands[projectKey],
                    s.repoAllowedCommands[repoPromptKey(projectKey, sess.repo)],
                  );
                  // Per-agent checkpoint doc (keyed by stream id) so each agent keeps
                  // its own "where we left off" note.
                  newPaneCheckpointDocs[key] = agentCheckpointDocRelpath(safeKey, sess.id);
                  // Repo-scoped reference context for this worker (#326). Keyed by
                  // the sanitized project key (safeKey) to match KB-page assignments.
                  {
                    const refDocs = resolveReferenceContext(fleetAssignments, { projectId: safeKey, repo: sess.repo });
                    if (refDocs.length > 0) newPaneReferenceDocs[key] = refDocs;
                  }
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
                  new Set(expandGroups(
                    [...(s.sessionSkillGroups[key] ?? []), ...(sess?.groupIds ?? [])], s.skillGroups,
                  )),
                );
                newPaneRoles[key] = sess === null ? "director" : "worker";
                newPaneProviders[key] = fleetHarness;
                // One roster row per live session (#734). Director has no repo/branch.
                rosterRows.push(sess === null
                  ? [key, "director", "-", "-", "director"].join("\t")
                  : [key, sess.id, sess.repo, worktreeSlug(sess.id), "worker"].join("\t"));
                // Bind the worker pane to its repo so its session GH_TOKEN is scoped to
                // it (#158). The director spans every repo, so it keeps the global token.
                if (sess && sess.repo) newPaneRepos[key] = sess.repo;
                if (sess && sess.profile) newPaneProfiles[key] = sess.profile;
                // The worker's owned paths become its role write boundary so edits in
                // its lane auto-approve (dir/ -> dir/** so the subtree matches).
                if (sess && sess.owns.length) newPaneRoleGlobs[key] = sess.owns.map((g) => (g.endsWith("/") ? g + "**" : g));
                if (sess && sess.flow) newPaneFlows[key] = sess.flow;
                // Per-agent model (#…) → the pane's `claude --model` at launch. Director (sess===null)
                // and unset workers fall back to the global `defaultModel` (resolved at pane mount).
                if (sess && sess.model) newPaneModels[key] = sess.model;
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
            paneReferenceDocs: newPaneReferenceDocs,
            paneContinue: newPaneContinue,
            paneCheckpointDocs: newPaneCheckpointDocs,
            paneAllowedCommands: newPaneAllowedCommands,
            paneMcpServers: newPaneMcpServers,
            paneHooks: newPaneHooks,
            paneSkills: newPaneSkills,
            paneRoles: newPaneRoles,
            paneProviders: newPaneProviders,
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
            activeScreen: "console" as Screen,
          };
        });
        // The caller persists these to the hub (publishFleetRoster) — the store stays
        // Tauri-free. Rows: paneId/stream/repo/branch/role, one per live session (#734).
        return rosterRows;
      },
});
