import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "@/store";
import { Dialog } from "@/shared/ui/Dialog";
import { BlueprintUpdateModal } from "../blueprints/BlueprintUpdateModal";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { buildGhStructure, parsePhases } from "../github/ghStructure";
import type { Section, SectionState } from "../github/ghStructure";
import {
  buildSectionConfirmMessage, buildSectionSkipMessage,
} from "./planningSession";
import { roleCapability, roleDeniedCommands, roleWriteRules } from "@/shared/lib/session/sessionRoles";
import {
  ANCHOR_KEYS, SKIPPED_KEY, FLEET_KEY, FEATURES_KEY, titleForKey, groupSections,
  parseFleetFile,
} from "../stages/planSections";
import { resolveSkills } from "@/features/skills/lib/skills";
import { parseFeaturesFile, featuresSummary, featuresAwaitingConfirm, featureDependencyCycle } from "../issues/featureList";
import { parseDependencyManifest, DEPENDENCIES_KEY } from "../issues/dependencies";
import type { FlowAutonomy, FlowPush, FlowGate } from "../fleet/agentFlow";
import { parseIssuesFile } from "../issues/planIssues";
import { ProjectPane } from "../pane/ProjectPane";
import { hubToCanonical } from "@/features/planner/lib/plannerSync";
import { tunnelSetPlanState, tunnelEmitPlanState, tunnelEmitPlanStatus, tunnelEmitPlanEvent } from "@/features/tunnel/lib/tunnelClient";
import type { PlanMessage } from "@/features/tunnel/lib/tunnel";
import { canLaunchTriage, triageLockReason } from "@/features/github/lib/projectSync";
import { githubGraphql } from "@/shared/lib/github/github";
import { planRename, applyRename } from "./renameProject";
import { planDraftCommit } from "./draftTitle";
import { effectiveProjectRepos, localReposFor } from "../list/projectRepos";
import { defaultStageConfig, enabledOrderedStages } from "../stages/planStages";
import { writeBlueprintSkillContext, collectBlueprintSkillIds } from "../blueprints/blueprintSkills";
import { resolveAllInstalledMcp } from "@/features/mcp/lib/mcpServers";
import { toSessionPayloads, mcpAllowRules } from "@/shared/lib/session/sessionConfig";
import { McpDownloadModal } from "../pane/McpDownloadModal";
import { type McpInstallState } from "../lib/mcpPaneData";
import { buildProjectPaneData } from "../pane/projectPaneData";
import { normalizeDeployConfig } from "../lib/deployConfig";
// Blueprint-driven focused-pane model (#652) — restored after the #668 lossy rebase deleted it
// (#776). The progress bar reads the project's BLUEPRINT sections + their declarative gates,
// not a hardcoded stage list.
import { stageConfirmKeys, DISCOVERY_BASELINE } from "../stages/planStageDerive";
import { InjectionGateBanner } from "./InjectionGateBanner";
import { mkSection, blueprintCategory, shouldAutoOpenBlueprintModal, stageDirectiveId, AUTHORING_BLUEPRINT_ID, DEFAULT_BLUEPRINT_ID, type BlueprintSection, type Blueprint } from "../stages/blueprints";
import { plannerIntroMode, composePlannerIntro } from "./plannerIntro";
import { Ic } from "../blueprints/blueprintIcons";
import { clampIndex, gatePill, footerAction, resolveFooter, shouldAutoCompleteGate } from "../stages/focusedPlan";
import { featureSectionsToIssues } from "../issues/planFeatures";
import { flattenPrompt, stagePrompts } from "./plannerConductor";
import { usePlannerPromptDelivery } from "./usePlannerPromptDelivery";
import { usePlannerTagStream } from "./usePlannerTagStream";
import { usePlanSectionPoll } from "./usePlanSectionPoll";
import { usePlannerRepoManagement } from "./usePlannerRepoManagement";
import { usePlanMcpDownloads } from "./usePlanMcpDownloads";
import { usePlanSkillsManagement } from "./usePlanSkillsManagement";
import { usePlanMcpManagement } from "./usePlanMcpManagement";
import { usePlanPublish } from "./usePlanPublish";
import { usePlannerBlueprint } from "./usePlannerBlueprint";
import { usePlanGates } from "./usePlanGates";
// Planning autopilot (#746) — re-wired into the refactored planner after it was dropped in
// the plannerCore/plannerSync refactor. Pure logic in planAutopilot*.ts; this is the wiring.
import { usePlanAutopilot, type AutopilotDeps } from "./planAutopilotRunner";
import { oneShotComplete } from "@/shared/lib/core/claudeComplete";
import { resolveLlmConfig, hasLlmKey } from "@/shared/lib/core/llmConfig";
import { fleetProfilesComplete } from "@/shared/lib/session/profileGen";
import { TERM_THEME, terminalShows } from "./planningTerminal";
import { GitHubStructureCard } from "./GitHubStructureCard";

export function Planning({ visible }: { visible: boolean }) {
  const {
    setProjectsView,
    planningPitch, planningRepo, planningTitle, setPlanningTitle,
    planningSessionKey,
    activeProjectId, activeProjectName, activeProjectNumber,
    githubToken,
    activeProjectRepos,
    projectLocalRepos,
    planSections, planConfirmedSections,
    planAuthoredBlueprint, importBlueprint, setAuthoredBlueprint,
    planDeployConfig, setPlanDeployConfig,
    planSourceConfig, planIntegrationConfig,
    reposPublic, setReposPublic, repoPublic, setRepoPublic,
    injectionHardGate, planInjectionAck, acknowledgePlanInjections,
    planSkippedSections, skipPlanSection,
    planFleet,
    planFleetTopology, setPlanFleetTopology,
    planFleetDirectorDrive, setPlanFleetDirectorDrive,
    projectKeyAlias,
    pinnedContext,
    blueprints, planStageConfig,
    projectBlueprintId, setProjectBlueprintId,
    uiScreens, uiApproved, planAutomations,
    setPlanAgentStreamPerm, setPlanAgentStreamPreset, setPlanAgentStreamFlow, setPlanAgentStreamModel,
    addProjectRepo, fleetStartProject,
    agentProfiles,
    commands, schedules,
    confirmPlanSection,
  } = useAppStore();
  const autoPlanWithClaude = useAppStore(s => s.autoPlanWithClaude);
  const autoCompleteGates = useAppStore(s => s.autoCompleteGates);
  const allowGateOverride = useAppStore(s => s.allowGateOverride);
  // Whether the active API-tier provider can make a call — gates the planning autopilot (#1085).
  const llmHasKey = useAppStore(s => hasLlmKey(resolveLlmConfig(s)));
  const skillDefs = useAppStore(s => s.skills);
  const skillGroups = useAppStore(s => s.skillGroups);
  // The extensions store drives the MCP stage pane (#878); the base dir is read on demand.
  const mcpServers = useAppStore(s => s.mcpServers);

  // The session key (set once at session entry) is the single source of truth
  // for the planning directory, PTY slot, and plan buckets — identical to the
  // remount key in projects/index.tsx. It is frozen for the session, so the
  // publish flow assigning a GitHub Project id or a title edit cannot move the
  // working directory. The ref fallbacks keep older/in-flight sessions working.
  // Resolve through the alias so a project reached via the board (only
  // `activeProjectId` set = the GitHub node id) maps to the stable folder/data
  // key its plan files live under, instead of an empty node-id key.
  const rawSessionKey = planningSessionKey || activeProjectId || planningTitle || planningPitch;
  const sessionKeyRef = useRef(projectKeyAlias[rawSessionKey] ?? rawSessionKey);
  const effectiveProjectId = sessionKeyRef.current;
  // The skills that apply to THIS project (#1056) — the global library filtered to enabled global +
  // project-scoped, mapped to the focused Skills body's shape. Skills the planner authored THIS
  // session live in the per-project session group (`grp-session-<key>`, #1419) — flag those `isNew`
  // so the body renders them first + highlighted. The planner pairs them in with
  // `bsc-skill add --group "$BSC_SESSION_SKILL_GROUP"`; the pane reflects membership via refreshSkills.
  const sessionGroupId = effectiveProjectId ? `grp-session-${effectiveProjectId}` : "";
  const paneSkills = useMemo(() => {
    const authored = new Set(skillGroups.find(g => g.id === sessionGroupId)?.skillIds ?? []);
    return resolveSkills(skillDefs, effectiveProjectId).map(s => ({
      name: s.name,
      kind: "skill" as const,
      desc: s.desc,
      isNew: authored.has(s.id),
    }));
  }, [skillDefs, skillGroups, sessionGroupId, effectiveProjectId]);
  // A project is bound to the blueprint it was CREATED with (#647/#923): `projectBlueprintId`
  // records it, set at creation (handleStartPlanning) — NOT here on open. Opening a project must
  // never adopt the transient global `activeBlueprintId` (the library selection the user changes
  // freely): doing so silently switched an existing project's blueprint just by opening it while a
  // different one was selected (#988). So resolve the project's OWN recorded blueprint, falling back
  // to the DEFAULT (a stable id, never the selection) when it isn't bound.
  // A project with a DESIGNED blueprint (blueprint.json / the <blueprint> tag) IS an authoring
  // project — resolve it to the authoring lifecycle even if its recorded binding is stale (#923).
  const isAuthoredProject = !!planAuthoredBlueprint[effectiveProjectId];
  const effectiveBlueprintId = isAuthoredProject
    ? AUTHORING_BLUEPRINT_ID
    : (projectBlueprintId[effectiveProjectId] ?? DEFAULT_BLUEPRINT_ID);
  // Backfill an EXISTING, unbound project to the DEFAULT (not the active selection) so the switch/
  // reset prompt has a recorded baseline to compare against (#647). Brand-new projects are already
  // bound at creation, so they never reach here unbound; authoring projects are bound by the poll.
  useEffect(() => {
    if (effectiveProjectId && !projectBlueprintId[effectiveProjectId] && !isAuthoredProject) {
      setProjectBlueprintId(effectiveProjectId, DEFAULT_BLUEPRINT_ID);
    }
  }, [effectiveProjectId, projectBlueprintId, setProjectBlueprintId, isAuthoredProject]);

  // Per-project PTY slot — mirrors the sanitize_project_key() logic in lib.rs so
  // the pane ID and the planning directory always correspond to the same project.
  const paneId = `planning_${effectiveProjectId.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)}`;
  // The planner's hub dir (set once setup_workspaces resolves) + whether the relay is live —
  // used to mirror the planner pane + sync the plan over the tunnel (#801).
  const [planningDir, setPlanningDir] = useState("");
  const tunnelRunning = useAppStore((s) => s.tunnelRunning);

  // The repos linked to this project (#833). For a published project that's the board's repos;
  // for an UNPUBLISHED one it's the linked+cloned set persisted under effectiveProjectId — so a
  // repo linked before publish survives a restart instead of needing to be re-linked. Memoized
  // so the headless auto-clone effect below doesn't see a fresh array ref (and re-run) each render.
  const effectiveRepos: string[] = useMemo(
    () => effectiveProjectRepos(activeProjectId, effectiveProjectId, activeProjectRepos, projectLocalRepos),
    [activeProjectId, effectiveProjectId, activeProjectRepos, projectLocalRepos],
  );

  // Full_names that are both linked to this project and known to be cloned. Read the persisted
  // set under BOTH keys (title-derived + node id) so it matches effectiveRepos — otherwise a
  // repo linked under the other key is in effectiveRepos but missing here (#881).
  const linkedRepos: string[] =
    localReposFor(projectLocalRepos, effectiveProjectId, activeProjectId).filter(r =>
      effectiveRepos.includes(r)
    );

  // The planner's headless repo auto-clone (#1474, usePlannerRepoManagement): owns the
  // <repo_link>-surfaced repo set and clones each linked repo into the project dir as it appears.
  const { repoLinkFullNames, setRepoLinkFullNames } = usePlannerRepoManagement(effectiveProjectId, effectiveRepos);

  const isExisting = !!activeProjectId;

  // Context manifest (#1019): the dynamic required-set + confirm state, polled from plan.db. The gate
  // (`requiredContextConfirmed`) reads it; the change-guard avoids churning state every tick; the
  // seeded-set guards the baseline seed so it runs at most once per project per session.
  const [ctxRequired, setCtxRequired] = useState<string[]>([]);
  const ctxRequiredJsonRef = useRef<string>("");
  const ctxSeededRef = useRef<Set<string>>(new Set());
  // Canonical set of repos for publish/sync — union of project-linked repos,
  // Claude-surfaced repo_link tags, and the store's planningRepo fallback.
  // Feeds both handlePublish and the GitHubStructureCard.
  const publishRepos = [...new Set([
    ...effectiveRepos,
    ...repoLinkFullNames,
    ...(planningRepo ? [planningRepo] : []),
  ])].filter(Boolean);

  // Sections are DYNAMIC: derived from whatever section files Claude has written
  // (surfaced via the store), not a fixed list. The store — populated by the
  // <plan_update> tag parser and the 2s file poll — is the single source of
  // truth; deriving here keeps the UI in lockstep as new topics appear. The two
  // anchor keys (goal, phases) are always present because the publish flow keys
  // off them. `_skipped` is handled separately as the coverage record.
  // Memoize the per-project store slices so the derived useMemos below don't
  // recompute every render (the `?? {}` / `?? []` fallbacks would otherwise mint
  // a fresh ref each time the project has no sections yet).
  const savedSections = useMemo(
    () => planSections[effectiveProjectId] ?? {}, [planSections, effectiveProjectId]);
  const confirmedSet  = useMemo(
    () => new Set(planConfirmedSections[effectiveProjectId] ?? []),
    [planConfirmedSections, effectiveProjectId]);
  // Optional stages the user deliberately skipped (#921) — they resolve the stage's gate (so the
  // flow advances) but render as "skipped", not "complete".
  const skippedSet = useMemo(
    () => new Set(planSkippedSections[effectiveProjectId] ?? []),
    [planSkippedSections, effectiveProjectId]);

  const sections = useMemo<Section[]>(() => {
    const keys = new Set<string>(ANCHOR_KEYS);
    for (const k of Object.keys(savedSections)) {
      // `blueprint` is the authored-blueprint JSON (#923), not a discovery section — never a card.
      // `dependencies` is the locked manifest JSON (#1111) — gate-driving, not a prose card.
      if (k !== SKIPPED_KEY && k !== FLEET_KEY && k !== FEATURES_KEY && k !== DEPENDENCIES_KEY && k !== "blueprint") keys.add(k);
    }
    const { project, repos } = groupSections([...keys]);
    const ordered = [...project, ...repos.flatMap(r => r.keys)];
    return ordered.map(k => {
      const content = savedSections[k] ?? "";
      const state: SectionState = confirmedSet.has(k) ? "confirmed" : (content ? "drafted" : "pending");
      return { k, title: titleForKey(k), state, content };
    });
  }, [savedSections, confirmedSet]);

  // (#1457) Command auto-approval is owned by per-agent profiles now — the planner's legacy
  // `commands.json` channel + the per-project/repo allowlist store it fed were retired.

  // (#1412/#1417) The planner now authors skills with `bsc-skill add` (straight into the global
  // skills.db), so there is no skills.json file-poll → library sync here anymore. The Skills-page
  // import (parseSkillsFile + upsertSkills) remains for user-uploaded skill files.

  // Sync fleet.json (the reliable channel — surfaced by the poll as the `fleet`
  // section) into the fleet store. Wholesale-replace, but only when the file's
  // content changes, so a user toggle in the Fleet card isn't clobbered every poll.
  const fleetSyncedRef = useRef("");
  useEffect(() => {
    const raw = savedSections[FLEET_KEY] ?? "";
    if (raw === fleetSyncedRef.current) return;
    fleetSyncedRef.current = raw;
    const fleet = parseFleetFile(raw);
    if (fleet) useAppStore.getState().setPlanFleet(effectiveProjectId, fleet);
  }, [savedSections, effectiveProjectId]);

  // Materialize least-privilege profiles for every stream (#819/#821). The planner writes profile
  // ID references in fleet.json (e.g. `"profile": "engine-spine"`) but cannot create the
  // AgentProfile objects — those live in app state. This reacts to the FLEET DATA itself (not to
  // fleet.json content changing), so it fires for an already-synced project loaded from
  // persistence and after HMR — exactly the cases the content-gated sync effect above misses.
  // Whenever a stream lacks a resolvable profile the gate can't pass, so generate; idempotent, and
  // once every stream resolves, `fleetProfilesComplete` is true and this is a no-op (no loop).
  useEffect(() => {
    const streams = planFleet[effectiveProjectId]?.streams ?? [];
    if (streams.length > 0 && !fleetProfilesComplete(streams, agentProfiles)) {
      useAppStore.getState().generateFleetProfiles(effectiveProjectId);
    }
  }, [planFleet, agentProfiles, effectiveProjectId]);

  // Title + derived GitHub object graph that the structure card renders and the
  // publish flow fills in. Kept in sync with handlePublish's own derivation.
  const goalForTitle = sections.find(s => s.k === "goal")?.content ?? "";
  const projectTitle = planningTitle || goalForTitle.split(/[.!?\n]/)[0].trim() || activeProjectName || "New project";

  // Planner session skill-group + live skills refresh (#1474, usePlanSkillsManagement).
  usePlanSkillsManagement(sessionGroupId, projectTitle);

  // ── Rename a PUBLISHED project (#1226) ──────────────────────────────────────────
  // The published header title is editable; committing on blur/Enter updates the GitHub Project
  // board title AND the local name, KEEPING the frozen session key + on-disk folder (the new name
  // is a display name; a folder re-key is the stable-id refactor, out of scope). `titleEdit` is
  // null unless the user is mid-edit, so the field tracks `activeProjectName` otherwise.
  const [titleEdit, setTitleEdit] = useState<string | null>(null);
  const [renameErr, setRenameErr] = useState<string | null>(null);
  const commitRename = useCallback(async () => {
    // The duplicate guard compares against OTHER projects' frozen keys (the alias values).
    const otherKeys = new Set(
      Object.entries(projectKeyAlias).filter(([nodeId]) => nodeId !== activeProjectId).map(([, k]) => k),
    );
    const plan = planRename(titleEdit ?? "", activeProjectName, activeProjectId, otherKeys);
    setTitleEdit(null);
    if (plan.kind === "noop") { setRenameErr(null); return; }
    if (plan.kind === "error") { setRenameErr(plan.message); return; }
    const st = useAppStore.getState();
    setRenameErr(
      await applyRename(activeProjectId!, plan.title, {
        graphql: githubGraphql,
        setMeta: st.setActiveProjectMeta,
        repo: st.activeProjectRepo,
        number: activeProjectNumber,
        repos: activeProjectRepos,
      }),
    );
  }, [titleEdit, activeProjectName, activeProjectId, activeProjectNumber, activeProjectRepos, projectKeyAlias]);
  const ghStructure  = buildGhStructure(sections, publishRepos, projectTitle, planFleet[effectiveProjectId]);

  // ── Persist a DRAFT title edit (#1222) ──────────────────────────────────────────
  // The title <input> only updated the transient `planningTitle`, so a reopen reverted it (the
  // draft record kept the old name). Commit on blur/Enter to the persisted draft record — keyed by
  // the FROZEN key, so the on-disk folder doesn't move. Empty reverts to the saved name; a name that
  // collides with another project is surfaced (red) and not saved.
  const [draftTitleErr, setDraftTitleErr] = useState<string | null>(null);
  const commitDraftTitle = useCallback(() => {
    const st = useAppStore.getState();
    const draft = st.localDraftProjects[effectiveProjectId];
    if (!draft) { setDraftTitleErr(null); return; } // not an unpublished draft — nothing to persist
    const otherKeys = new Set<string>();
    for (const k of Object.keys(st.localDraftProjects)) if (k !== effectiveProjectId) otherKeys.add(k);
    for (const [nodeId, k] of Object.entries(projectKeyAlias)) if (nodeId !== activeProjectId) otherKeys.add(k);
    const plan = planDraftCommit(planningTitle, draft.title, otherKeys);
    if (plan.kind === "revert") { setPlanningTitle(draft.title); setDraftTitleErr(null); return; }
    if (plan.kind === "noop") { setDraftTitleErr(null); return; }
    if (plan.kind === "error") { setDraftTitleErr(plan.message); return; } // keep the typed value to fix
    st.updateDraftProject(effectiveProjectId, { title: plan.title });
    setDraftTitleErr(null);
  }, [planningTitle, effectiveProjectId, activeProjectId, projectKeyAlias]);

  // ── Mobile relay: connect the planner session (#801) ──────────────────────────
  // The active project's canonical plan (files + the stable proj-<hex> id). Route the JSON
  // manifests to their canonical relpaths; everything else is a `.md` section. commands.json/
  // features.json are outside the canonical-sync contract (isPlanFile), so they're excluded.
  // Shared by the file-sync path (1) and the live-frame emit (1b).
  const canonicalPlan = useMemo(() => {
    if (Object.keys(savedSections).length === 0) return null;
    const md: Record<string, string> = {};
    let phasesJson, issuesJson, fleetJson, reposJson, skippedContent: string | undefined;
    for (const [k, v] of Object.entries(savedSections)) {
      if (k === "phases") phasesJson = v;
      else if (k === "issues") issuesJson = v;
      else if (k === FLEET_KEY) fleetJson = v;
      else if (k === "repos") reposJson = v;
      else if (k === SKIPPED_KEY) skippedContent = v;
      else if (k === FEATURES_KEY || k === DEPENDENCIES_KEY) continue;
      else md[k] = v;
    }
    return hubToCanonical({
      projectTitle: effectiveProjectId,
      sections: md,
      confirmedSections: [...confirmedSet],
      phasesJson, issuesJson, fleetJson, reposJson, skippedContent,
    });
  }, [savedSections, confirmedSet, effectiveProjectId]);

  // (1) Plan-sync — push the canonical plan files so a paired mobile planner reconciles over
  // the relay (E2E) instead of the API. Unchanged async file-sync path.
  useEffect(() => {
    if (!tunnelRunning || !canonicalPlan) return;
    tunnelSetPlanState(canonicalPlan.meta.projectId, canonicalPlan.files).catch(() => {});
  }, [tunnelRunning, canonicalPlan]);

  // (2) PTY mirror — expose the planner pane so a paired phone can view (and, if granted,
  // drive) the live planner terminal. Cleared when the planner unmounts or the relay stops.
  useEffect(() => {
    const setExtra = useAppStore.getState().setTunnelExtraPanes;
    if (!tunnelRunning || !planningDir) { setExtra([]); return; }
    setExtra([{ id: paneId, cwd: planningDir, name: `Planner — ${projectTitle}`, status: "running" as const }]);
    return () => useAppStore.getState().setTunnelExtraPanes([]);
  }, [tunnelRunning, planningDir, paneId, projectTitle]);

  // Real plan data for the ProjectPane (#: wire-in). Maps the fleet, agent
  // profiles, decomposed issues, phases, repos, and sections into the pane's
  // render shapes; the pane falls back to its sample data when this is empty.
  // Features defined in the Features stage (#…) — the planner writes features.json (one entry per
  // user-facing capability / stream); the board renders them and the gate needs all fully defined.
  const planFeatures = useMemo(
    () => parseFeaturesFile(savedSections[FEATURES_KEY] ?? ""),
    [savedSections],
  );
  // The locked dependency manifest (#1111/#1127/#1191) — authored in the Deploy stage via
  // `bsc-plan deps set` and reflected from plan.db into the DEPENDENCIES section by the poll (the
  // libraries + the non-default registries they're sourced from). The Deploy gate counts the deps,
  // publish seeds them into each repo's package.json / Cargo.toml (+ .npmrc / .cargo/config.toml for
  // private sources), and each worker inlines its repo's slice.
  const depManifest = useMemo(
    () => parseDependencyManifest(savedSections[DEPENDENCIES_KEY] ?? ""),
    [savedSections],
  );
  const planDependencies = depManifest.dependencies;
  // Per-server MCP install lifecycle (#878): seeded by a disk probe on mount, advanced by the
  // download/build button. Keyed by extension id so the MCP pane shows real status.
  const [mcpInstallState, setMcpInstallState] = useState<McpInstallState>({});
  // The planner MCP download-confirmation queue (#1474, usePlanMcpDownloads).
  const { enqueueMcpDownloads, mcpDownloads, confirmMcpDownloads, cancelMcpDownloads } = usePlanMcpDownloads();
  // Deploy stage (#919): the project's deployment config — persisted per project, seeded from the
  // linked repos (one proposed service each) until the user/planner fills it in the Deploy pane.
  // normalizeDeployConfig migrates a persisted PRE-rework config (top-level envs/pipeline/config/
  // release/health) into the per-repo shape so the per-service readers never hit `undefined.secrets`
  // (#1425); a missing config falls back to the seeded default.
  const deployCfg = useMemo(
    () => normalizeDeployConfig(planDeployConfig[effectiveProjectId], publishRepos),
    [planDeployConfig, effectiveProjectId, publishRepos],
  );
  // Source stage (#source-pane): the project's migration-source config — declared + connected
  // legacy systems; the `sourcesConnected` gate signal derives from it.
  const sourceCfg = useMemo(
    () => planSourceConfig[effectiveProjectId],
    [planSourceConfig, effectiveProjectId],
  );
  // Integration stage (#1207): the destination/sink + sync strategy; drives destinationDefined/syncDefined.
  const intgCfg = useMemo(
    () => planIntegrationConfig[effectiveProjectId],
    [planIntegrationConfig, effectiveProjectId],
  );
  const paneData = useMemo(
    () => buildProjectPaneData({
      fleet:    planFleet[effectiveProjectId],
      profiles: agentProfiles,
      issues:   parseIssuesFile(sections.find(sec => sec.k === "issues")?.content ?? ""),
      phases:   parsePhases(sections.find(sec => sec.k === "phases")?.content ?? ""),
      repos:    publishRepos,
      sections,
      features: planFeatures,
      authoredBlueprint: planAuthoredBlueprint[effectiveProjectId],
      deployConfig: deployCfg,
      dependencies: planDependencies,
      registries: depManifest.registries,
      pinned:   pinnedContext[effectiveProjectId],
      mcpServers,
      skills: paneSkills,
      projectKey: effectiveProjectId,
      mcpInstallState,
      topologyOverride: planFleetTopology[effectiveProjectId],
      directorDriveOverride: planFleetDirectorDrive[effectiveProjectId],
    }),
    [planFleet, planFleetTopology, planFleetDirectorDrive, effectiveProjectId, agentProfiles, sections, publishRepos, pinnedContext, planFeatures, planAuthoredBlueprint, deployCfg, depManifest, planDependencies, mcpServers, paneSkills, mcpInstallState],
  );

  // Per-repo visibility overrides for THIS project (#1227): the `repoPublic` slice re-keyed by
  // repo full-name, so the Repos cards resolve each card's toggle (override ?? project default).
  const repoOverrides = useMemo(() => {
    const prefix = `${effectiveProjectId}::`;
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(repoPublic)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    return out;
  }, [repoPublic, effectiveProjectId]);

  // The planner MCP install lifecycle (#1474, usePlanMcpManagement). mcpInstallState stays here
  // (it feeds paneData); the hook writes it via setMcpInstallState.
  const { onToggleMcp, onRemoveMcp, onAddMcp, onBuildMcp } = usePlanMcpManagement({
    effectiveProjectId, effectiveBlueprintId, blueprints, planningDir,
    mcpServersUi: paneData.mcpServers, mcpServers, setMcpInstallState, enqueueMcpDownloads,
  });

  // Write the active blueprint's attached SKILLS to the project hub's skills.md (#636 — the write
  // that was built but never wired). inject_skills (Rust) inlines that file into each worker's
  // CLAUDE.local.md and the planner reads it, so this is the skills counterpart to the MCP launch
  // wiring above. No-op when nothing is attached. Re-runs on project / attached-skill-set change.
  const bpSkillKey = useMemo(() => {
    const bp = blueprints.find(b => b.id === effectiveBlueprintId);
    return bp ? collectBlueprintSkillIds(bp).join("\n") : "";
  }, [blueprints, effectiveBlueprintId]);
  useEffect(() => {
    if (!effectiveProjectId) return;
    const store = useAppStore.getState();
    const bp = store.blueprints.find(b => b.id === effectiveBlueprintId);
    if (!bp) return;
    void writeBlueprintSkillContext({ projectKey: effectiveProjectId, blueprint: bp, skills: store.skills })
      .catch((e) => console.warn("writeBlueprintSkillContext failed:", e));
  }, [bpSkillKey, effectiveProjectId, effectiveBlueprintId]);


  // ── Blueprint-driven plan model (#652) — restored (#776) ────────────────────
  // The authoritative plan sections come from the active BLUEPRINT; each carries its own
  // declarative gate over a flat signal bag — NOT a hardcoded stage list. The focused
  // progress rail, current-phase, and advance/publish footer all read these. #668 deleted
  // this whole substrate; the store data (blueprints, ui, automations, pipelines) survived.
  const stageConfig = planStageConfig[effectiveProjectId] ?? defaultStageConfig();
  const requiresUi = stageConfig.enabled.ui;
  const uiCounts = useMemo(() => {
    if (!requiresUi) return { approved: 0, total: 0 };
    const declared = uiScreens[effectiveProjectId] ?? [];
    const approvedSet = new Set(uiApproved[effectiveProjectId] ?? []);
    return { approved: declared.filter((s) => approvedSet.has(s)).length, total: declared.length };
  }, [requiresUi, uiScreens, uiApproved, effectiveProjectId]);
  // Per-repo feature plans (#177) fold into the issue count the gates read.
  const featureIssues = useMemo(
    () => featureSectionsToIssues(sections, publishRepos),
    [sections, publishRepos],
  );
  const featureState = useMemo(() => featuresSummary(planFeatures), [planFeatures]);
  // The feature dependency DAG must stay acyclic (#plan-db) — a cycle is a planning deadlock that
  // holds the Features gate. `[]` when acyclic; otherwise the slugs on the offending cycle.
  const featureCycle = useMemo(() => featureDependencyCycle(planFeatures), [planFeatures]);
  // The blueprint sections (fallback: synthesize built-ins from the enabled stage ids).
  const planSecs = useMemo<BlueprintSection[]>(() => {
    const bp = blueprints.find(b => b.id === effectiveBlueprintId);
    if (bp) return bp.sections;
    return enabledOrderedStages(stageConfig).map(s => mkSection(s.id));
  }, [blueprints, effectiveBlueprintId, stageConfig]);
  // Blueprint/authoring lifecycle derivations (#1474, usePlannerBlueprint) — call before the gate
  // hook so `usePlanGates` can read this hook's isAuthoring/authoringSig.
  const {
    isAuthoring, treatAsExisting, switchTargets, canSwitch,
    switchOpen, setSwitchOpen, authoringSig, authorSkillLib, authorMcpLib,
  } = usePlannerBlueprint({
    blueprints, effectiveBlueprintId, isExisting, planAuthoredBlueprint, effectiveProjectId, skillDefs, mcpServers,
  });
  // Gate/`signals` derivation (#1474, usePlanGates) — the live stageState snapshot, the lint/injection
  // gates, the skip/confirm signal bags, the flat `signals` bag, and the auto-derived focused-pane
  // phases. `planSecs` + the focused-pane SELECTION (`focusSel` below) stay in this component.
  const {
    injectionGateState, phases, focusActiveIdx, focusGateReady, planComplete, currentStage, planStatusLabel, planReady,
  } = usePlanGates({
    sections, planSecs, ctxRequired, publishRepos, planFleet, agentProfiles, planAutomations,
    featureIssues, effectiveProjectId, requiresUi, uiCounts, featureState, featureCycle,
    confirmedSet, skippedSet, planDependencies, sourceCfg, injectionHardGate, planInjectionAck,
    planFeatures, deployCfg, intgCfg, isAuthoring, authoringSig,
  });

  // Focused pane (#652): the SELECTION — auto-follows the active phase (`focusSel` null) or pins to a
  // user pick; reset on project/blueprint switch. `phases`/`focusActiveIdx` come from usePlanGates.
  const [focusSel, setFocusSel] = useState<number | null>(null);
  useEffect(() => { setFocusSel(null); }, [effectiveProjectId, effectiveBlueprintId]);
  const focusSelectedIdx = clampIndex(focusSel ?? focusActiveIdx, phases.length);

  // ── Live planner frames over the tunnel (#934 / #987) ───────────────────────────
  // Project the LIVE planning session (active stage + confirmed sections + files + the
  // conversation) to a paired phone, alongside the async file-sync above. The desktop stays
  // the single source of truth; the phone mirrors these and drives via the inbound listeners.

  // The planner is a PTY running `claude`, so the structured conversation lives in Claude's
  // transcript — poll it (newest 50 turns) while paired so the phone renders the real chat,
  // not the raw terminal. pipelineRuns stays empty: the planner runs no pipelines (those are a
  // fleet surface, #220).
  const [plannerMessages, setPlannerMessages] = useState<PlanMessage[]>([]);
  useEffect(() => {
    if (!tunnelRunning) return;
    let cancelled = false;
    const load = () => invoke<PlanMessage[]>("read_pane_messages", { paneId, limit: 50 })
      .then((m) => { if (!cancelled) setPlannerMessages(m ?? []); })
      .catch(() => {});
    load();
    const id = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tunnelRunning, paneId]);

  // (1b) plan_state — debounced snapshot (replayed to newly-paired clients Rust-side).
  useEffect(() => {
    if (!tunnelRunning || !canonicalPlan) return;
    const id = setTimeout(() => {
      tunnelEmitPlanState(canonicalPlan.meta.projectId, currentStage, [...confirmedSet], canonicalPlan.files, plannerMessages, []).catch(() => {});
    }, 500);
    return () => clearTimeout(id);
  }, [tunnelRunning, canonicalPlan, currentStage, confirmedSet, plannerMessages]);

  // plan_status — cheap header update, un-debounced on stage/status change.
  useEffect(() => {
    if (!tunnelRunning || !canonicalPlan) return;
    tunnelEmitPlanStatus(canonicalPlan.meta.projectId, currentStage, planStatusLabel).catch(() => {});
  }, [tunnelRunning, canonicalPlan, currentStage, planStatusLabel]);

  // plan_event — transient deltas at the transition sites (refs diff prev vs current).
  const prevConfirmedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (tunnelRunning && canonicalPlan) {
      for (const k of confirmedSet) {
        if (!prevConfirmedRef.current.has(k)) {
          tunnelEmitPlanEvent(canonicalPlan.meta.projectId, { kind: "section_confirmed", at: Date.now(), section: k }).catch(() => {});
        }
      }
    }
    prevConfirmedRef.current = new Set(confirmedSet);
  }, [confirmedSet, tunnelRunning, canonicalPlan]);

  const prevStageRef = useRef("");
  useEffect(() => {
    if (tunnelRunning && canonicalPlan && currentStage && currentStage !== prevStageRef.current) {
      tunnelEmitPlanEvent(canonicalPlan.meta.projectId, { kind: "stage_advanced", at: Date.now(), stage: currentStage }).catch(() => {});
    }
    prevStageRef.current = currentStage;
  }, [currentStage, tunnelRunning, canonicalPlan]);

  const prevMsgCountRef = useRef(0);
  useEffect(() => {
    if (tunnelRunning && canonicalPlan && plannerMessages.length > prevMsgCountRef.current) {
      const last = plannerMessages[plannerMessages.length - 1];
      tunnelEmitPlanEvent(canonicalPlan.meta.projectId, { kind: "message_appended", at: last.at || Date.now(), message: last }).catch(() => {});
    }
    prevMsgCountRef.current = plannerMessages.length;
  }, [plannerMessages, tunnelRunning, canonicalPlan]);

  // Inbound DRIVE from the phone (#934): confirm a section, advance a stage, or chat into the
  // planner PTY. Gated Rust-side behind the input grant (a view-only phone can't steer).
  useEffect(() => {
    const subs = [
      listen<{ section: string }>("tunnel://plan-confirm", (e) => confirmPlanSection(effectiveProjectId, e.payload.section)),
      listen<{ stageKey: string }>("tunnel://plan-advance", (e) => confirmPlanSection(effectiveProjectId, e.payload.stageKey)),
      listen<{ text: string }>("tunnel://plan-chat", (e) => { void invoke("pty_write", { paneId, data: e.payload.text + "\r" }); }),
    ];
    return () => { for (const s of subs) void s.then((off) => off()); };
  }, [effectiveProjectId, paneId, confirmPlanSection]);

  // The active stage's drafted sections "approve & continue" confirms in one click (#807-followup)
  // — so the user approves a whole stage at once instead of confirming each discovery file (for
  // which the focused pane has no control). Empty ⇒ nothing pending (gate drives the button).
  const pendingConfirm = useMemo(() => {
    const activeKey = phases[focusActiveIdx]?.key;
    const activeSec = activeKey ? planSecs.find((s) => s.key === activeKey) : undefined;
    const base = stageConfirmKeys(activeKey, sections, !!activeSec?.gateRule, !!activeKey && confirmedSet.has(activeKey));
    // Features (#plan-db): once every feature in the roster is populated, offer the one-click
    // confirm that completes the stage. Until then the gate holds (titles-first → count = N), so a
    // single populated feature can no longer auto-advance.
    if (activeKey === FEATURES_KEY && featuresAwaitingConfirm(featureState, confirmedSet.has(FEATURES_KEY)) && featureCycle.length === 0) {
      return base.includes(FEATURES_KEY) ? base : [...base, FEATURES_KEY];
    }
    return base;
  }, [phases, focusActiveIdx, sections, planSecs, confirmedSet, featureState, featureCycle]);

  // The single stage-completion primitive (#1068): confirm each pending section + tell the planner
  // to continue. Shared by manual "approve & continue" (onPrimary), the planning autopilot, and the
  // auto-complete effect below — one path every gate advances through, so behaviour stays identical
  // whether the user clicks, the autopilot drives, or a gate self-advances.
  const confirmStageKeys = useCallback((keys: string[]) => {
    if (keys.length === 0) return;
    for (const k of keys) confirmPlanSection(effectiveProjectId, k);
    const name = keys.map((k) => titleForKey(k)).join(", ") || "section";
    invoke("pty_write", { paneId, data: buildSectionConfirmMessage(name) + "\r" }).catch(console.error);
  }, [effectiveProjectId, paneId, confirmPlanSection]);

  // Auto-advance gates (#1068): when the global flag is on and the ACTIVE stage has drafted sections
  // awaiting confirmation, confirm them automatically after a short beat — the same action the
  // "approve & continue" button performs, minus the click. View-independent (rides `pendingConfirm`,
  // which tracks the active phase, not the selected one). Default off — an explicit opt-in, so the
  // planner still never self-confirms; the user authorises the app to confirm on gate-readiness.
  // Steps aside while the planning autopilot runs (it owns confirmation). The ref stops a ready set
  // from being re-confirmed on every render.
  const autoConfirmRef = useRef<string>("");
  useEffect(() => {
    if (!shouldAutoCompleteGate(autoCompleteGates, autoPlanWithClaude && llmHasKey, pendingConfirm)) return;
    const key = `${effectiveProjectId}|${pendingConfirm.join(",")}`;
    if (autoConfirmRef.current === key) return;
    const t = setTimeout(() => {
      autoConfirmRef.current = key;
      confirmStageKeys(pendingConfirm);
    }, 800);
    return () => clearTimeout(t);
  }, [autoCompleteGates, autoPlanWithClaude, llmHasKey, pendingConfirm, effectiveProjectId, confirmStageKeys]);
  // #1019: clear the cached manifest on a project switch so a stale set never bleeds across.
  useEffect(() => { setCtxRequired([]); ctxRequiredJsonRef.current = ""; }, [effectiveProjectId]);
  // #1028: poll the Context required-set from plan.db and seed the baseline once per project. The gate
  // reads it to check each required topic's `context/<topic>.md` exists — context files gate on
  // GENERATION, not confirmation, so there's nothing to confirm/mirror.
  useEffect(() => {
    if (!effectiveProjectId) return;
    let alive = true;
    const tick = async () => {
      try {
        const m = await invoke<string[]>("plan_list_discovery", { projectKey: effectiveProjectId });
        if (!alive) return;
        // Seed the baseline once per project/session if the set is empty — a deterministic floor before
        // the planner runs `bsc-plan context require`. The blueprint's context section `requires`
        // overrides the universal baseline (blueprint seeding).
        if ((m?.length ?? 0) === 0 && !ctxSeededRef.current.has(effectiveProjectId)) {
          ctxSeededRef.current.add(effectiveProjectId);
          const requires = planSecs.find(s => s.key === "discovery")?.requires ?? DISCOVERY_BASELINE;
          for (const t of requires) {
            await invoke("plan_require_discovery", { projectKey: effectiveProjectId, topic: t, required: true }).catch(() => {});
          }
          return; // next tick reads the seeded set
        }
        const j = JSON.stringify(m ?? []);
        if (j !== ctxRequiredJsonRef.current) {
          ctxRequiredJsonRef.current = j;
          setCtxRequired(m ?? []);
        }
      } catch { /* plan.db not created until the planner/seed touches context — ignore */ }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [effectiveProjectId, planSecs]);
  // The active phase is an enabled OPTIONAL stage the user hasn't decided yet — so the advance bar
  // offers a "Skip stage" control beside the primary action (#921). `phasesFrom` reports a not-yet
  // -decided optional stage at the frontier as "active"; a decided (done/skipped) one isn't.
  const activeSkippable = phases[focusActiveIdx]?.optional === true && phases[focusActiveIdx]?.status === "active";
  const footerRaw = footerAction(focusSelectedIdx, focusActiveIdx, planComplete, focusGateReady, activeSkippable);
  const onSkipStage = useCallback(() => {
    const phase = phases[focusActiveIdx];
    if (!phase) return;
    skipPlanSection(effectiveProjectId, phase.key);
    // Tell the live planner to drop the skipped stage and move on (mirrors the approve flow).
    invoke("pty_write", { paneId, data: buildSectionSkipMessage(phase.name) + "\r" }).catch(console.error);
  }, [phases, focusActiveIdx, skipPlanSection, effectiveProjectId, paneId]);
  // Let "approve & continue" light up as soon as there are drafted sections to confirm (clicking
  // confirms them, see onPrimary), and — when the user enabled gate override (#1285) — let a blocking
  // gate be force-advanced as a cautionary "override gate & continue".
  const focusFooter = resolveFooter(footerRaw, pendingConfirm.length, allowGateOverride);
  const focusSelPhase = phases[focusSelectedIdx];
  const focusPill = focusSelPhase ? gatePill(focusSelPhase) : "wait";
  // Injectable prompts for the SELECTED stage — the header "?" helper lists them and the user picks
  // one to inject (the app no longer auto-injects). Resolve the section BY KEY (phases is a filtered
  // subset of planSecs, #815).
  const focusStagePrompts = useMemo(
    () => stagePrompts(planSecs.find(s => s.key === focusSelPhase?.key)),
    [planSecs, focusSelPhase]);

  const [restarting, setRestarting] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false); // clear-plan confirmation modal (#…)

  // Publish / triage / recovery state + callbacks live in usePlanPublish (#1490) — the hook is
  // called below, once all the plan data it reads is in scope.

  // The section Claude is currently discussing, driven by <plan_focus> tags.
  // Null until the first focus tag arrives. Highlights the matching card.
  const [, setActiveSection] = useState<string | null>(null);

  const containerRef   = useRef<HTMLDivElement>(null);
  const termRef        = useRef<Terminal | null>(null);
  const fitRef         = useRef<FitAddon | null>(null);
  // Drag-to-resize the plan-sections panel (#43; the terminal flexes to fill the rest).
  const sectionsPanel  = useDragResize({ initial: 430, min: 300, max: 760, axis: "x", invert: true });
  const unlistenData   = useRef<UnlistenFn | null>(null);
  const unlistenExit   = useRef<UnlistenFn | null>(null);
  // The planner's PTY tag-parse stream (#1474): owns bufRef + autopilotTxRef and a `processChunk`
  // that parses + dispatches every structured <tag> the planner emits. bufRef is the tag-scan
  // buffer (cleared on restart); autopilotTxRef is the un-consumed copy the autopilot reads.
  const { processChunk, bufRef, autopilotTxRef } = usePlannerTagStream({
    projectId: effectiveProjectId,
    setActiveSection,
    setRepoLinkFullNames,
  });
  const apLastSnapLen  = useRef(0);
  const apLastAnswered = useRef(0);
  // Tracks whether the auto-send of the initial pitch has fired this session


  // ── Planning autopilot (#746) ───────────────────────────────────────────────
  // Driven by the Settings "Automate planning with Claude" toggle. Answers the planner's own
  // discovery questions from the pitch + confirms each stage, driving to a publishable plan for
  // review (never auto-publishes). Progress + frontier read the SAME dynamic blueprint gate the
  // focused pane renders (#1061 retired the legacy PLAN_STAGES gate), so they can't disagree.
  const autopilotProgressPct = useMemo(() => {
    const required = phases.filter(p => !p.optional);
    const done = required.filter(p => p.status === "complete" || p.status === "ahead").length;
    return required.length ? Math.round((done / required.length) * 100) : 0;
  }, [phases]);
  // `planReady` (from usePlanGates) is `planComplete`: the plan is "ready" — gating the Triage launch
  // (#444/#551/#823) — on the SAME blueprint-driven completion the focused footer publishes on.
  // The blueprint's enabled stage ids — passed to setup_workspaces so the planner's CLAUDE.md
  // is scoped to this project's stages (#542/#667). The refactor stopped passing this, which
  // silently reverted a refactor/transform plan to the greenfield stage set. (#A — restored.)
  const stageIdsFor = (key: string): string[] => {
    const st = useAppStore.getState();
    // Resolve the project's OWN blueprint (#647/#923), falling back to the DEFAULT (never the
    // transient active selection, #988) when it isn't bound — so an existing project keeps its
    // stage set across version / active-blueprint changes instead of adopting the library selection.
    const bpId = st.projectBlueprintId[key] ?? DEFAULT_BLUEPRINT_ID;
    const bp = st.blueprints.find(b => b.id === bpId);
    if (bp) return bp.sections.filter(s => s.enabled).map(stageDirectiveId);
    return enabledOrderedStages(st.planStageConfig[key] ?? defaultStageConfig()).map(s => s.id);
  };

  // ── Context-updated badge (#175/#756) ───────────────────────────────────────
  // currentSig = the live signature of the inputs (computed in Rust so its format/version can't
  // drift from the baseline); lastSetupSig = the baseline setup_workspaces last wrote. When they
  // diverge (you linked a repo / changed the blueprint mid-session, or the planner template
  // version bumped), the "context updated · refresh" badge offers a regenerating restart.
  const [currentSig, setCurrentSig]   = useState<string | null>(null);
  const [lastSetupSig, setLastSetupSig] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    invoke<string>("compute_context_signature", {
      repoFullNames: linkedRepos,
      enabledStages: stageIdsFor(effectiveProjectId),
    }).then(sig => { if (live) setCurrentSig(sig); }).catch(() => { if (live) setCurrentSig(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRepos, effectiveProjectId]);
  // Re-read the baseline the backend last wrote — called on open and after every workspace
  // setup (mount / link / restart), so the badge reflects the most recent regeneration.
  const refreshSetupSig = useCallback(() => {
    invoke<string>("get_context_signature", { projectKey: effectiveProjectId })
      .then(s => setLastSetupSig(s || null)).catch(() => {});
  }, [effectiveProjectId]);
  useEffect(() => { refreshSetupSig(); }, [refreshSetupSig]);
  const contextStale = !!currentSig && !!lastSetupSig && currentSig !== lastSetupSig;

  // Blueprint-update modal (#827): when a project is opened whose blueprint/planner-template
  // VERSION differs from the one it was seeded with AND it already has a plan, surface a modal so
  // the user explicitly chooses go-back / restart / keep — rather than the old silent refresh,
  // which restarted the planner into a destructive reconciliation that deleted plan files.
  //
  // #1296: gate the auto-open on a true template-version mismatch (`shouldAutoOpenBlueprintModal`,
  // which compares only the `v{version}` prefix of the two signatures), NOT the broad `contextStale`
  // flag. `contextStale` also flips on benign setup tweaks (link a repo, enable/
  // disable a stage) — those must keep driving only the quiet "context updated · refresh" badge
  // below, never this destructive restart dialog.
  const [showBlueprintModal, setShowBlueprintModal] = useState(false);
  const [bpModalAutoShown, setBpModalAutoShown] = useState(false);
  const hasExistingPlan = Object.keys(savedSections).length > 0;
  useEffect(() => { setBpModalAutoShown(false); setShowBlueprintModal(false); }, [effectiveProjectId]);
  useEffect(() => {
    if (shouldAutoOpenBlueprintModal({ currentSig, baselineSig: lastSetupSig, hasExistingPlan, alreadyShown: bpModalAutoShown })) {
      setShowBlueprintModal(true);
      setBpModalAutoShown(true);
    }
  }, [currentSig, lastSetupSig, hasExistingPlan, bpModalAutoShown]);

  const autopilotDeps: AutopilotDeps = {
    pitch: planningPitch,
    strategy: "llm",
    snapshot: () => {
      const len = autopilotTxRef.current.length;
      const grew = len > apLastSnapLen.current;
      apLastSnapLen.current = len;
      const plannerAwaiting = !grew && len > apLastAnswered.current;
      // The dynamic blueprint gate (#1061): non-optional phases done = gate met; the frontier is
      // the active phase, and its drafted-but-unconfirmed sections are what the autopilot confirms.
      const required = phases.filter(p => !p.optional);
      const done = required.filter(p => p.status === "complete" || p.status === "ahead").length;
      return {
        planReady: planComplete,
        confirmKeys: pendingConfirm,
        plannerAwaiting,
        working: grew,
        autoPublish: false, // the feature stops at a publishable plan for review
        progress: { done, total: required.length, fraction: required.length ? done / required.length : 0 },
      };
    },
    pendingOutput: () => autopilotTxRef.current.slice(apLastAnswered.current),
    userSim: (system, user) => oneShotComplete(resolveLlmConfig(useAppStore.getState()), system, user),
    sendReply: (text) => {
      invoke("pty_write", { paneId, data: `${text}\r` }).catch(console.error);
      apLastAnswered.current = autopilotTxRef.current.length;
    },
    confirm: (keys) => {
      confirmStageKeys(keys);
      apLastAnswered.current = autopilotTxRef.current.length;
    },
    mockPublish: () => { /* feature stops at publishable (autoPublish=false) — unused */ },
    log: (e) => console.debug("[auto-plan]", e.action, e.detail ?? ""),
  };
  const autopilot = usePlanAutopilot(autopilotDeps, { enabled: autoPlanWithClaude && llmHasKey });

  // Inject a prompt into the planner session on demand (#…). The app no longer AUTO-injects stage
  // prompts (the old "conductor" caused too many problems — it typed over the user, re-sent lost
  // steps, wandered). Instead the focused pane's "?" helper lists each stage's injectable prompts
  // and the USER picks which to inject. Flatten to ONE line so the trailing Enter actually submits
  // it (a multi-line paste just sits in the input); if it's already in the input bar (pasted but
  // unsent), submit it instead of pasting a duplicate.
  const sendPrompt = useCallback((prompt: string) => {
    const line = flattenPrompt(prompt);
    if (terminalShows(termRef.current, line.slice(0, 40))) {
      invoke("pty_write", { paneId, data: "\r" }).catch(console.error); // already there → just submit
    } else {
      invoke("pty_write", { paneId, data: line + "\r" }).catch(console.error);
    }
  }, [paneId]);

  // Drain a queued ad-hoc prompt into the live planner (#1371) — e.g. the file-intake "Route to
  // project" ROUTE_PROMPT. Without this the prompt was set in the store but never delivered, so
  // dropped design files were never routed into the repo.
  usePlannerPromptDelivery(effectiveProjectId, sendPrompt);


  // Mount xterm.js and spawn the planning PTY (once per Planning screen lifecycle).
  // pty_kill is called on unmount so navigating away ends the session cleanly.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el);
    termRef.current = term;
    fitRef.current  = fitAddon;

    term.onData(data => {
      invoke("pty_write", { paneId: paneId, data }).catch(console.error);
    });

    // Capture state at mount time for workspace sync.
    const repoSnapshot    = linkedRepos;  // string[] of full_names
    const treatAsExistingSnap = treatAsExisting;
    const isAuthoringSnap = isAuthoring;
    const projNameSnap    = activeProjectName;
    const projNumberSnap  = activeProjectNumber;
    const pitchSnap       = planningPitch;
    const projIdSnap      = effectiveProjectId;
    const ghLoginSnap     = useAppStore.getState().githubUser?.login ?? "";
    const ghNameSnap      = useAppStore.getState().githubUser?.name  ?? "";
    const automationsSnap = [
      ...commands.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
      ...schedules.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
    ];

    requestAnimationFrame(async () => {
      fitAddon.fit();

      // Subscribe before creating the PTY so we never miss early output.
      unlistenData.current = await listen<string>(`pty_data_${paneId}`, ev => {
        term.write(ev.payload);
        // Parse structured tags out of the stripped output stream (#1474, usePlannerTagStream).
        processChunk(ev.payload);
      });

      unlistenExit.current = await listen<unknown>(`pty_exit_${paneId}`, () => {
        term.write("\r\n\x1b[33m[session ended — navigate away and back to restart]\x1b[0m\r\n");
      });

      // Create the isolated planning workspace directory with settings.json + CLAUDE.md.
      const paths = await invoke<{ planning_dir: string }>(
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
      ).catch((e: unknown) => {
        console.error("workspace setup failed:", e);
        return null;
      });
      refreshSetupSig(); // baseline updated (#756)
      if (paths) setPlanningDir(paths.planning_dir); // for the relay planner-pane mirror (#801)

      // Launch claude inside the isolated planning directory.
      // Inject the stored GitHub token so `gh` CLI and direct API calls work
      // without requiring the user to separately authenticate the gh CLI.
      const token = useAppStore.getState().githubToken;
      const ghEnv = token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
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
      await invoke("ensure_session_settings", {
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
      }).catch((e: unknown) => console.error("planner session settings failed:", e));
      // Planner introduction (#1240): a user-facing kickoff that has the planner OPEN the
      // conversation (introduce itself, sketch the stage journey, summarize capabilities, ask one
      // orienting question) instead of launching into a quiet terminal. Baked into the claude launch
      // arg as a FRESH-ONLY startup prompt — the backend (which knows the conversation history)
      // delivers it only on a genuinely new session and drops it on `--continue` resume, so a
      // returning user isn't re-greeted. For a new project the user's pitch rides along so the
      // planner acknowledges it rather than asking what they're building (replaces the old
      // idle-detection pitch-typing). On failure it's undefined → the launch falls back to initCmd.
      const introMode = plannerIntroMode({ isAuthoring, isExisting: treatAsExistingSnap });
      const introText = await invoke<string>("planner_intro_prompt", { mode: introMode })
        .catch((e: unknown) => { console.error("planner intro prompt failed:", e); return ""; });
      const startupPrompt = composePlannerIntro(introText, introMode, pitchSnap ?? "") || undefined;
      await invoke("pty_create", {
        paneId:  paneId,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     paths?.planning_dir ?? "",
        initCmd: "claude --continue 2>/dev/null || claude",
        startupPrompt,
        startupPromptFreshOnly: true,
        env:     ghEnv,
      }).catch(console.error);
    });

    const ro = new ResizeObserver(() => {
      // No visibility guard: a hidden panel is display:none → zero client size,
      // already skipped below. Guarding on a `visible` ref instead raced with
      // React's commit and dropped the first fit after un-hiding, leaving the
      // terminal smaller than its container.
      const { clientWidth, clientHeight } = el;
      if (clientWidth === 0 || clientHeight === 0) return;
      fitAddon.fit();
      invoke("pty_resize", { paneId: paneId, cols: term.cols, rows: term.rows }).catch(console.error);
    });
    ro.observe(el);

    return () => {
      unlistenData.current?.();
      unlistenExit.current?.();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current  = null;
      invoke("pty_kill", { paneId: paneId }).catch(console.error);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit the terminal when the planning panel becomes visible (hidden → shown).
  // The panel mounts lazily and has variable-height content above the terminal,
  // so a single in-RAF fit can measure before the final layout — and cell metrics
  // are wrong until the mono font loads. Re-fit on the frame, after a short delay,
  // and once fonts are ready so it reliably fills the available space.
  useEffect(() => {
    if (!visible) return;
    const refit = (focusToo: boolean) => {
      const fit = fitRef.current, term = termRef.current, el = containerRef.current;
      if (!fit || !term || !el || el.clientWidth === 0 || el.clientHeight === 0) return;
      fit.fit();
      invoke("pty_resize", { paneId: paneId, cols: term.cols, rows: term.rows }).catch(console.error);
      if (focusToo) term.focus();
    };
    let cancelled = false;
    const raf = requestAnimationFrame(() => refit(true));
    const delayed = setTimeout(() => refit(false), 120);
    document.fonts?.ready?.then(() => { if (!cancelled) refit(false); }).catch(() => {});
    return () => { cancelled = true; cancelAnimationFrame(raf); clearTimeout(delayed); };
  }, [visible]);

  // Planner 2s plan.db + section-file poll (#1474, usePlanSectionPoll).
  usePlanSectionPoll({ visible, projectId: effectiveProjectId, publishRepos, enqueueMcpDownloads });

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
    const paths = await invoke<{ planning_dir: string }>(
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
    ).catch((e: unknown) => { console.error("workspace setup failed:", e); return null; });
    refreshSetupSig(); // baseline updated (#756)
    return paths;
  }

  async function handleRestart() {
    const term = termRef.current;
    if (!term || restarting) return;
    setRestarting(true);
    bufRef.current = "";
    term.clear();
    await invoke("pty_kill", { paneId: paneId }).catch(console.error);
    const paths = await regenerateWorkspace();
    const token = useAppStore.getState().githubToken;
    const ghEnv = token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {};
    // A deliberate restart launches a brand-new `claude` — re-greet with the intro (#1240). No
    // fresh-only guard here: the user explicitly restarted, so fire it even though history exists.
    const introMode = plannerIntroMode({ isAuthoring, isExisting: treatAsExisting });
    const introText = await invoke<string>("planner_intro_prompt", { mode: introMode })
      .catch((e: unknown) => { console.error("planner intro prompt failed:", e); return ""; });
    const startupPrompt = composePlannerIntro(introText, introMode, planningPitch ?? "") || undefined;
    await invoke("pty_create", {
      paneId: paneId,
      cols: term.cols,
      rows: term.rows,
      cwd: paths?.planning_dir ?? "",
      initCmd: "claude",
      startupPrompt,
      env: ghEnv,
    }).catch(console.error);
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
    await invoke("clear_project_plan_files", { projectKey: effectiveProjectId }).catch(console.error);
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
    await invoke("clear_project_plan_files", { projectKey: effectiveProjectId }).catch(console.error);
    store.setActiveProjectRepos([]);
    setRepoLinkFullNames([]);
    store.setPlanningContext(planningPitch, "");
    void handleRestart();
  }

  // ── Publish / triage / recovery (#1490) ─────────────────────────────────────
  const {
    handlePublish, launchTriage, handleRecover,
    triaging, triageError, triageNote, recoverable, recovering, publishPhase, setPublishPhase, ghStatus,
  } = usePlanPublish({
    isAuthoring, githubToken, publishRepos, injectionGateState, sections, planningTitle,
    activeProjectName, planFleet, effectiveProjectId, activeProjectId, activeProjectNumber,
    planFeatures, planDependencies, depManifest, repoPublic, reposPublic, planAuthoredBlueprint,
    paneId, projectTitle, planReady, visible, addProjectRepo, fleetStartProject, importBlueprint,
  });


  return (
    <>
      {/* Header */}
      <div style={{ padding: "14px 24px", display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => setProjectsView("list")}
              title="Back to Planner"
              aria-label="Back to Planner"
              style={{
                width: 30, height: 30, flex: "0 0 30px",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                background: "var(--bg-elev)", border: "1px solid var(--border)",
                borderRadius: "var(--r-md)", cursor: "pointer",
                color: "var(--fg)", padding: 0, marginRight: 2,
              }}
            ><Ic n="chevron_left" size={18} /></button>
            {isExisting
              ? (
                <>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>#{activeProjectNumber}</span>
                  {/* Published title is editable (#1226): blur/Enter commits to the GitHub board + local name. */}
                  <input
                    value={titleEdit ?? activeProjectName}
                    onChange={e => { setTitleEdit(e.target.value); if (renameErr) setRenameErr(null); }}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      else if (e.key === "Escape") { setTitleEdit(null); setRenameErr(null); }
                    }}
                    title={renameErr ?? activeProjectName}
                    aria-label="Project title"
                    style={{
                      background: "none", border: "none", outline: "none", padding: 0,
                      margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600,
                      color: renameErr ? "var(--danger)" : "var(--fg)",
                      // Size to the text, capped — a long name stops at the cap instead of pushing
                      // the status pill away; minWidth:0 lets it shrink in a narrow pane.
                      maxWidth: 282, minWidth: 0,
                      width: Math.min(282, Math.max(56, ((titleEdit ?? activeProjectName).length || 14) * 9.5 + 16)),
                    }}
                  />
                </>
              )
              : (
                <input
                  value={planningTitle}
                  onChange={e => { setPlanningTitle(e.target.value); if (draftTitleErr) setDraftTitleErr(null); }}
                  onBlur={commitDraftTitle}
                  onKeyDown={e => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") (e.target as HTMLInputElement).blur();
                  }}
                  placeholder="project title…"
                  title={draftTitleErr ?? undefined}
                  style={{
                    background: "none", border: "none", outline: "none",
                    fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600,
                    color: draftTitleErr ? "var(--danger)" : planningTitle ? "var(--fg)" : "var(--fg-dim)",
                    // Size to the text (snug), with a usable floor and a 400px cap so the status
                    // pill sits right next to the title.
                    width: Math.min(282, Math.max(56, (planningTitle.length || 14) * 9.5 + 16)),
                    padding: 0,
                  }}
                />
              )
            }
            <span className="tag amber">● {isExisting ? "expanding" : "drafting"}</span>
          </div>
          {autopilot.running && (
            <div style={{ color: "var(--accent)", fontSize: 12, marginTop: 4 }}>
              ⚙ auto-planning · {autopilotProgressPct}%
            </div>
          )}
        </div>
        {contextStale && (
          <button
            className="btn"
            style={{ borderColor: "var(--accent-dim)", color: "var(--accent)" }}
            disabled={restarting}
            onClick={() => setShowBlueprintModal(true)}
            title="The project's blueprint / planner template changed since this session started — choose how to update (#827)"
          >{restarting ? "restarting…" : "blueprint updated · review"}</button>
        )}
        <button className="btn ghost" onClick={handleRestart} disabled={restarting}
          title="Restart the planner session (re-spawns Claude)">
          {restarting ? "restarting…" : "↺ restart"}
        </button>
        <button className="btn ghost danger" onClick={() => setShowClearConfirm(true)} title="Wipe this project's plan and restart the planner (#664)">
          clear plan
        </button>
        {/* Switch the project to a different blueprint (#923 / #1281 — any → any other). */}
        {canSwitch && (
          <button className="btn ghost" onClick={() => setSwitchOpen(true)} title="Switch this project to a different blueprint">
            switch blueprint
          </button>
        )}
        {/* No execution side for an authoring blueprint (#923) — its deliverable is the published
            blueprint gist, so there are no repos to triage / no fleet to launch. */}
        {!isAuthoring && (() => {
          // Full gate (#444/#551): plan complete + published + repos + fleet, not starting.
          const gate = {
            published: !!activeProjectId,
            hasRepos: publishRepos.length > 0,
            hasFleet: !!planFleet[effectiveProjectId]?.streams.length,
            busy: triaging,
            planReady,
          };
          return (
            <button
              className="btn primary"
              onClick={launchTriage}
              disabled={!canLaunchTriage(gate)}
              title={triageLockReason(gate) ?? "Clone the repos and start a triage session"}
            >
              {triaging ? "starting triage…" : "Triage →"}
            </button>
          );
        })()}
      </div>
      {triageError && (
        <div style={{ padding: "0 24px 8px", color: "var(--danger)", fontSize: 12, fontFamily: "var(--mono)" }}>
          ⚠ {triageError}
        </div>
      )}
      {triageNote && !triageError && (
        <div style={{ padding: "0 24px 8px", color: "var(--fg-muted)", fontSize: 12, fontFamily: "var(--mono)" }}>
          ⏭ {triageNote}
        </div>
      )}
      {featureCycle.length > 0 && (
        <div style={{ padding: "0 24px 8px", color: "var(--danger)", fontSize: 12, fontFamily: "var(--mono)" }}>
          ⚠ Feature dependency cycle: {featureCycle.join(" → ")} — break it to complete the Features stage.
        </div>
      )}
      {recoverable > 0 && (
        <div style={{ padding: "0 24px 8px", display: "flex", alignItems: "center", gap: 10, fontSize: 12, fontFamily: "var(--mono)", color: "var(--fg-muted)" }}>
          <span>⤓ The plan store is empty — GitHub has {recoverable} published issue{recoverable === 1 ? "" : "s"} for {publishRepos.length === 1 ? "this repo" : "these repos"}.</span>
          <button
            onClick={() => void handleRecover()}
            disabled={recovering}
            style={{
              padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border-soft)",
              background: "var(--bg-elev2)", color: "var(--fg)", fontFamily: "var(--mono)", fontSize: 11,
              cursor: recovering ? "default" : "pointer", opacity: recovering ? 0.6 : 1,
            }}
          >
            {recovering ? "Recovering…" : "Recover from GitHub"}
          </button>
        </div>
      )}

      {/* Split panel */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden", borderTop: "1px solid var(--border-soft)" }}>
        {/* Claude CLI terminal */}
        <section style={{ flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", borderRight: "1px solid var(--border-soft)" }}>
          <div
            ref={containerRef}
            style={{
              flex: 1, minHeight: 0, overflow: "hidden",
              background: TERM_THEME.background as string,
              display: "flex",
              padding: "6px 4px",
            }}
          />
        </section>

        {/* Drag handle between the terminal and the plan-sections panel (#43). */}
        <div className="resize-x" {...sectionsPanel.handleProps} title="Drag to resize" />

        {/* Plan sections / publish progress panel */}
        <aside style={{ flex: `0 0 ${sectionsPanel.size}px`, display: "flex", flexDirection: "column", background: "var(--bg-panel)", minHeight: 0, overflow: "hidden" }}>
          {/* Plan-injection provenance banner (#1107) — shown above the pane while planning. */}
          {publishPhase === "idle" && (
            <InjectionGateBanner
              gate={injectionGateState}
              onAcknowledge={(sig) => acknowledgePlanInjections(effectiveProjectId, sig)}
            />
          )}
          {publishPhase === "idle" ? (
            <ProjectPane
              data={paneData}
              projectId={effectiveProjectId}
              onPerm={(id, perm) => setPlanAgentStreamPerm(effectiveProjectId, id, perm)}
              onPreset={(id, preset, perm) => setPlanAgentStreamPreset(effectiveProjectId, id, preset, perm)}
              onFlow={(id, f) => setPlanAgentStreamFlow(effectiveProjectId, id, {
                autonomy: f.autonomy as FlowAutonomy,
                push: (f.push === "auto-PR" ? "auto-pr" : f.push) as FlowPush,
                gate: f.gate as FlowGate,
              })}
              onModel={(id, m) => setPlanAgentStreamModel(effectiveProjectId, id, m)}
              onLinkRepo={(repo) => addProjectRepo(effectiveProjectId, repo)}
              reposPublic={reposPublic[effectiveProjectId] ?? false}
              onSetReposPublic={(isPublic) => setReposPublic(effectiveProjectId, isPublic)}
              repoOverrides={repoOverrides}
              onSetRepoPublic={(repoId, isPublic) => setRepoPublic(effectiveProjectId, repoId, isPublic)}
              onDeployChange={(next) => setPlanDeployConfig(effectiveProjectId, next)}
              onTopology={(t) => setPlanFleetTopology(effectiveProjectId, t)}
              onDirectorDrive={(d) => setPlanFleetDirectorDrive(effectiveProjectId, d)}
              onGenerateProfiles={() => useAppStore.getState().generateFleetProfiles(effectiveProjectId)}
              onToggleMcp={onToggleMcp}
              onBuildMcp={onBuildMcp}
              onAddMcp={onAddMcp}
              onRemoveMcp={onRemoveMcp}
              focus={{
                phases,
                selectedIdx: focusSelectedIdx,
                activeIdx: focusActiveIdx,
                onSelect: (i) => setFocusSel(i),
                pill: focusPill,
                footer: focusFooter,
                // Per-stage "?" prompt helper (#…): the user injects a stage prompt on demand
                // (the auto-injecting conductor was removed).
                promptHelp: { prompts: focusStagePrompts, onInject: sendPrompt },
                // The live required-context set (#1061): the Context body names each required file
                // as written/missing so the gate's "why" is visible at a glance.
                requiredContext: ctxRequired,
                // Once a board exists, the publish action reads as "Update GitHub" — a re-sync of
                // the plan, not a first publish (handlePublish sets activeProjectId on create) (#823).
                published: !!activeProjectId,
                // An authoring project publishes a gist, not a GitHub board (#923).
                publishLabel: isAuthoring ? "⎙ Publish blueprint" : undefined,
                // The user deliberately skips the active optional stage (#921); the gate resolves
                // and the selection re-follows to the next live phase.
                onSkip: () => { onSkipStage(); setFocusSel(null); },
                onBack: () => setFocusSel(clampIndex(focusSelectedIdx - 1, phases.length)),
                onPrimary: () => {
                  if (focusFooter.kind === "publish") { void handlePublish(); return; }
                  if (focusFooter.kind === "approve-continue") {
                    // User gate override (#1285): the gate isn't met but the user chose to advance —
                    // force past the active stage (the skip/advance primitive) and tell the planner.
                    if (focusFooter.override) { onSkipStage(); setFocusSel(null); return; }
                    // One-click stage approval: confirm every drafted section the active stage needs,
                    // then tell the planner in a single message. The gate re-evaluates and the
                    // selection re-follows to the next live phase (#807-followup).
                    if (pendingConfirm.length > 0) confirmStageKeys(pendingConfirm);
                  }
                  setFocusSel(null); // re-follow the live phase
                },
                // Blueprint-authoring wiring (#923): the interactive editor views write edits back to
                // the stored blueprint (kept in sync with the planner's <blueprint> tag) + publish.
                authoring: isAuthoring ? {
                  onChange: (bp: Blueprint) => setAuthoredBlueprint(effectiveProjectId, bp),
                  skillLibrary: authorSkillLib,
                  mcpLibrary: authorMcpLib,
                  onPublish: () => { void handlePublish(); },
                  // The focused pane only renders while idle; the publish-progress header takes over
                  // once publishing starts, so "published" is always false within this view.
                  published: false,
                } : undefined,
              }}
            />
          ) : (
            <>
              {/* Publish progress header */}
              <div style={{
                padding: "10px 18px", borderBottom: "1px solid var(--border-soft)",
                display: "flex", alignItems: "center", gap: 8,
                fontFamily: "var(--mono)", fontSize: 11,
              }}>
                <span style={{
                  color: publishPhase === "done"  ? "var(--success)"
                       : publishPhase === "error" ? "var(--danger)"
                       : "var(--accent)",
                }}>
                  {publishPhase === "running" ? "⟳ publishing…"
                   : publishPhase === "done"  ? "✓ published"
                   : "✗ publish failed"}
                </span>
                <div style={{ flex: 1 }} />
                {(publishPhase === "done" || publishPhase === "error") && (
                  <button
                    onClick={() => setPublishPhase("idle")}
                    style={{
                      padding: "2px 8px", borderRadius: 3, cursor: "pointer",
                      background: "transparent", border: "1px solid var(--border-soft)",
                      color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10,
                    }}
                  >← back to plan</button>
                )}
              </div>

              {/* Live GitHub structure — each node updates as it is created */}
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
                <GitHubStructureCard structure={ghStructure} status={ghStatus} />
              </div>
            </>
          )}
        </aside>
      </div>

      {showBlueprintModal && (
        <BlueprintUpdateModal
          busy={restarting}
          onGoBack={() => { setShowBlueprintModal(false); setProjectsView("list"); }}
          onKeep={() => { void keepPlanFiles(); }}
          onRestart={() => { setShowBlueprintModal(false); void doClearPlan(); }}
          onDismiss={() => setShowBlueprintModal(false)}
        />
      )}

      {mcpDownloads.length > 0 && (
        <McpDownloadModal
          items={mcpDownloads}
          onConfirm={() => { void confirmMcpDownloads(); }}
          onCancel={cancelMcpDownloads}
        />
      )}

      {showClearConfirm && (
        <Dialog
          title="Clear this plan?"
          danger
          onDismiss={() => setShowClearConfirm(false)}
          actions={
            <>
              <button className="btn" onClick={() => setShowClearConfirm(false)}>cancel</button>
              <button
                className="btn"
                style={{ borderColor: "var(--danger)", color: "var(--danger)" }}
                onClick={() => void doClearPlan()}
              >clear plan</button>
            </>
          }
        >
          This wipes the entire plan for this project — sections, stage config, the fleet, and the
          on-disk plan files — then restarts the planner with a blank slate. This can't be undone.
        </Dialog>
      )}

      {switchOpen && (
        <Dialog
          title="Switch blueprint"
          onDismiss={() => setSwitchOpen(false)}
          actions={<button className="btn" onClick={() => setSwitchOpen(false)}>cancel</button>}
        >
          <div style={{ marginBottom: 12, color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
            Switch this project to a different blueprint. This re-seeds the plan for the chosen blueprint and
            <b> clears the current plan + progress</b> — this can't be undone. Pick a target:
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {switchTargets.map((bp) => (
              <button key={bp.id} className="btn ghost" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, height: "auto", padding: "10px 12px", textAlign: "left" }}
                onClick={() => void doSwitchBlueprint(bp.id)}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "var(--fg)", fontWeight: 600 }}>{bp.name}</span>
                  <span className="tag" style={{ fontSize: 9 }}>{blueprintCategory(bp)}</span>
                </span>
                {bp.desc && <span style={{ color: "var(--fg-dim)", fontSize: 11, fontFamily: "var(--sans)" }}>{bp.desc}</span>}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </>
  );
}
