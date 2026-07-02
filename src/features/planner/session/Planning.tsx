import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Chip } from "@/shared/ui/data/Chip";
import { BlueprintUpdateModal } from "../blueprints/BlueprintUpdateModal";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { buildGhStructure } from "../github/ghStructure";
import type { Section, SectionState } from "../github/ghStructure";
import {
  ANCHOR_KEYS, SKIPPED_KEY, FEATURES_KEY, titleForTopic, groupTopics,
} from "../stages/planTopics";
import { FLEET_KEY, parseFleetFile } from "../fleet/planFleet";
import { resolveSkills } from "@/features/skills/lib/skills";
import { parseFeaturesFile, featuresSummary, featureDependencyCycle } from "../issues/featureList";
import { parseDependencyManifest, DEPENDENCIES_KEY } from "../issues/dependencies";
import type { FlowAutonomy, FlowPush, FlowGate } from "../fleet/agentFlow";
import { parseIssuesFile } from "../issues/planIssues";
import { ProjectPane } from "../pane/ProjectPane";
import { canLaunchTriage, triageLockReason } from "@/features/github/lib/projectSync";
import { effectiveProjectRepos, localReposFor } from "../list/projectRepos";
import { defaultStageConfig, enabledOrderedStages } from "../stages/planStages";
import { writeBlueprintSkillContext, collectBlueprintSkillIds } from "../blueprints/blueprintSkills";
import { McpDownloadModal } from "../pane/McpDownloadModal";
import { type McpInstallState } from "../lib/mcpPaneData";
import { buildProjectPaneData } from "../pane/projectPaneData";
import { normalizeDeployConfig } from "../lib/deployConfig";
// Blueprint-driven focused-pane model (#652) — restored after the #668 lossy rebase deleted it
// (#776). The progress bar reads the project's BLUEPRINT sections + their declarative gates,
// not a hardcoded stage list.
import { InjectionGateBanner } from "./InjectionGateBanner";
import { mkStage, blueprintCategory, AUTHORING_BLUEPRINT_ID, DEFAULT_BLUEPRINT_ID, type BlueprintStage, type Blueprint } from "../stages/blueprints";
import { BackButton } from "@/shared/ui/controls/BackButton";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { clampIndex } from "../stages/focusedPlan";
import { featureSectionsToIssues } from "../issues/planFeatures";
import { flattenPrompt } from "./plannerConductor";
import { usePlannerPromptDelivery } from "./usePlannerPromptDelivery";
import { usePlannerTagStream } from "./usePlannerTagStream";
import { usePlanSectionPoll } from "./usePlanSectionPoll";
import { usePlannerRepoManagement } from "./usePlannerRepoManagement";
import { usePlanMcpDownloads } from "./usePlanMcpDownloads";
import { usePlanSkillsManagement } from "./usePlanSkillsManagement";
import { usePlanMcpManagement } from "./usePlanMcpManagement";
import { usePlanPublish } from "./usePlanPublish";
import { deriveProjectTitle } from "./projectTitle";
import { usePlannerBlueprint } from "./usePlannerBlueprint";
import { usePlanGates } from "./usePlanGates";
import { usePlanningModals } from "./usePlanningModals";
import { usePlanningSession } from "./usePlanningSession";
import { usePlanningTitle } from "./usePlanningTitle";
import { useCtxRequired } from "./useCtxRequired";
import { usePlanConfirmations } from "./usePlanConfirmations";
import { usePlanFocusedPane } from "./usePlanFocusedPane";
import { useSetupSignature } from "./useSetupSignature";
import { usePlannerTerminal } from "./usePlannerTerminal";
import { usePlannerTunnelSync } from "./usePlannerTunnelSync";
// Planning autopilot (#746) — re-wired into the refactored planner after it was dropped in
// the plannerCore/plannerSync refactor. Pure logic in planAutopilot*.ts; this is the wiring.
import { usePlanAutopilot, type AutopilotDeps } from "./planAutopilotRunner";
import { oneShotComplete } from "@/shared/lib/core/claudeComplete";
import { resolveLlmConfig, hasLlmKey } from "@/shared/lib/core/llmConfig";
import { TERM_THEME } from "./planningTerminal";
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
    reposPublic, repoPublic,
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
    setPlanAgentStreamFlow, setPlanAgentStreamModel,
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
  // The planner's hub dir — owned here so the earlier MCP wiring + the tunnel sync below can read it,
  // but WRITTEN by usePlannerTerminal once setup_workspaces resolves (#801). tunnelRunning now lives
  // inside usePlannerTunnelSync.
  const [planningDir, setPlanningDir] = useState("");

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
  // Memoized like `effectiveRepos` above (#…): a fresh array ref each render re-fired every
  // linkedRepos-keyed effect — notably useSetupSignature's `compute_context_signature` call, whose
  // varying/failing results made the header's "context updated" badge (`contextStale`) flicker.
  const linkedRepos: string[] = useMemo(
    () => localReposFor(projectLocalRepos, effectiveProjectId, activeProjectId).filter(r =>
      effectiveRepos.includes(r),
    ),
    [projectLocalRepos, effectiveProjectId, activeProjectId, effectiveRepos],
  );

  // The planner's headless repo auto-clone (#1474, usePlannerRepoManagement): clones each linked
  // repo (DB-owned, surfaced via the plan.db poll into effectiveRepos) into the project dir.
  usePlannerRepoManagement(effectiveProjectId, effectiveRepos);

  const isExisting = !!activeProjectId;

  // Canonical set of repos for publish/sync — union of project-linked repos (DB-owned) and the
  // store's planningRepo fallback. Feeds both handlePublish and the GitHubStructureCard.
  const publishRepos = [...new Set([
    ...effectiveRepos,
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
    const { project, repos } = groupTopics([...keys]);
    const ordered = [...project, ...repos.flatMap(r => r.keys)];
    return ordered.map(k => {
      const content = savedSections[k] ?? "";
      const state: SectionState = confirmedSet.has(k) ? "confirmed" : (content ? "drafted" : "pending");
      return { k, title: titleForTopic(k), state, content };
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


  // Title + derived GitHub object graph that the structure card renders and the
  // publish flow fills in. Kept in sync with handlePublish's own derivation.
  const goalForTitle = sections.find(s => s.k === "goal")?.content ?? "";
  const projectTitle = deriveProjectTitle(planningTitle, goalForTitle, activeProjectName);

  // Planner session skill-group + live skills refresh (#1474, usePlanSkillsManagement).
  usePlanSkillsManagement(sessionGroupId, projectTitle);

  // Editable project title (#1226 published rename / #1222 draft persist) — usePlanningTitle (#1775).
  // Both keep the FROZEN session key (the new name is display-only).
  const {
    titleEdit, setTitleEdit, renameErr, setRenameErr, commitRename,
    draftTitleErr, setDraftTitleErr, commitDraftTitle,
  } = usePlanningTitle({
    activeProjectId, activeProjectName, activeProjectNumber, activeProjectRepos,
    projectKeyAlias, planningTitle, setPlanningTitle, effectiveProjectId,
  });
  const ghStructure  = buildGhStructure(sections, publishRepos, projectTitle, planFleet[effectiveProjectId]);

  // Mobile-relay projection of the live planning session (#801/#934/#987) — the canonical-plan
  // derivation + every tunnel emit/listen effect — now lives in usePlannerTunnelSync, called once
  // currentStage/planStatusLabel are in scope (below the gate hook).

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
  // progress rail, current-stage, and advance/publish footer all read these. #668 deleted
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
  const planSecs = useMemo<BlueprintStage[]>(() => {
    const bp = blueprints.find(b => b.id === effectiveBlueprintId);
    if (bp) return bp.sections;
    return enabledOrderedStages(stageConfig).map(s => mkStage(s.id));
  }, [blueprints, effectiveBlueprintId, stageConfig]);
  // Context manifest (#1019/#1028, useCtxRequired): the dynamic required-set polled from plan.db,
  // baseline-seeded once per project; the Context gate (`requiredContextConfirmed`) reads it.
  const ctxRequired = useCtxRequired(effectiveProjectId, planSecs);
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
  // stages. `planSecs` + the focused-pane SELECTION (`focusSel` below) stay in this component.
  const {
    injectionGateState, stages, focusActiveIdx, focusGateReady, planComplete, currentStage, planStatusLabel, planReady,
  } = usePlanGates({
    sections, planSecs, ctxRequired, publishRepos, planFleet, planAutomations,
    featureIssues, effectiveProjectId, requiresUi, uiCounts, featureState, featureCycle,
    confirmedSet, skippedSet, planDependencies, sourceCfg, injectionHardGate, planInjectionAck,
    deployCfg, intgCfg, isAuthoring, authoringSig,
  });

  // The focused-pane SELECTION + its derived footer/pill/prompts live in usePlanFocusedPane, called
  // below — after usePlanConfirmations, whose `pendingConfirm` the footer reads (#1490).

  // Mobile-relay projection of the live planning session (#801/#934/#987, usePlannerTunnelSync):
  // the canonical-plan derivation, the message poll, and every tunnel emit/listen effect (file-sync,
  // PTY mirror, plan_state/status, the confirmed/stage/message deltas, and the inbound DRIVE). All
  // no-op unless the relay is live. Called here so currentStage/planStatusLabel (from the gate hook)
  // are in scope.
  usePlannerTunnelSync({
    effectiveProjectId, savedSections, confirmedSet, currentStage, planStatusLabel,
    planningDir, paneId, projectTitle, confirmPlanSection,
  });

  // Stage gate-confirm/skip logic (#1775, usePlanConfirmations): the active stage's pending sections,
  // the confirm-stage primitive (#1068), the auto-advance effect (#1068), and the optional skip (#921).
  const { pendingConfirm, confirmStageKeys, onSkipStage } = usePlanConfirmations({
    stages, focusActiveIdx, sections, planSecs, confirmedSet, featureState, featureCycle,
    effectiveProjectId, paneId, confirmPlanSection, skipPlanSection,
    autoCompleteGates, autoPlanActive: autoPlanWithClaude && llmHasKey,
  });
  // Focused-pane SELECTION + its derived advance-bar/pill/prompt-help (#1490, usePlanFocusedPane).
  // Called here so the footer can read `pendingConfirm` (above) and the gate snapshot (usePlanGates).
  const { setFocusSel, focusSelectedIdx, focusPill, focusFooter, focusStagePrompts } = usePlanFocusedPane({
    stages, focusActiveIdx, planComplete, focusGateReady, pendingConfirm,
    allowGateOverride, planSecs, effectiveProjectId, effectiveBlueprintId,
  });

  // Session-lifecycle (`restarting` + restart/clear/switch) lives in usePlanningSession (#1642) and
  // modal open/close state in usePlanningModals (#1642); both hooks are called below, once the data
  // they read (and the blueprint hook's `setSwitchOpen`) is in scope.

  // Publish / triage / recovery state + callbacks live in usePlanPublish (#1490) — the hook is
  // called below, once all the plan data it reads is in scope.

  // Drag-to-resize the plan-sections panel (#43; the terminal flexes to fill the rest).
  const sectionsPanel  = useDragResize({ initial: 430, min: 300, max: 760, axis: "x", invert: true });
  // The xterm terminal + PTY refs (containerRef, termRef) come from usePlannerTerminal, called below
  // once its inputs (processChunk, stageIdsFor, refreshSetupSig) are in scope.
  // The planner's PTY output buffer (#1474): owns bufRef + autopilotTxRef and a `processChunk` that
  // strips/accumulates/caps the output. bufRef is cleared on restart; autopilotTxRef is the
  // un-consumed copy the autopilot reads. (No longer parses tags — all moved to plan.db, #2017.)
  const { processChunk, bufRef, autopilotTxRef } = usePlannerTagStream();
  const apLastSnapLen  = useRef(0);
  const apLastAnswered = useRef(0);
  // Tracks whether the auto-send of the initial pitch has fired this session


  // ── Planning autopilot (#746) ───────────────────────────────────────────────
  // Driven by the Settings "Automate planning with Claude" toggle. Answers the planner's own
  // discovery questions from the pitch + confirms each stage, driving to a publishable plan for
  // review (never auto-publishes). Progress + frontier read the SAME dynamic blueprint gate the
  // focused pane renders (#1061 retired the legacy PLAN_STAGES gate), so they can't disagree.
  const autopilotProgressPct = useMemo(() => {
    const required = stages.filter(p => !p.optional);
    const done = required.filter(p => p.status === "complete" || p.status === "ahead").length;
    return required.length ? Math.round((done / required.length) * 100) : 0;
  }, [stages]);
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
    // Blueprint section keys ARE the canonical directive ids — pass them straight to setup_workspaces.
    if (bp) return bp.sections.filter(s => s.enabled).map(s => s.key);
    return enabledOrderedStages(st.planStageConfig[key] ?? defaultStageConfig()).map(s => s.id);
  };

  // ── Setup signatures (#175/#756, useSetupSignature #1775) ────────────────────
  // currentSig (live inputs, computed in Rust) vs lastSetupSig (the baseline setup_workspaces last
  // wrote). These feed usePlanningModals' version-mismatch auto-open (the manual header "blueprint
  // updated · review" badge was removed — that prompt lives elsewhere now).
  // refreshSetupSig re-reads the baseline (called after every workspace setup).
  const { currentSig, lastSetupSig, refreshSetupSig } =
    useSetupSignature(effectiveProjectId, linkedRepos, stageIdsFor);

  // The planner's xterm terminal + PTY lifecycle (#1775, usePlannerTerminal): mount/spawn claude in
  // the isolated planning dir, re-fit when shown, and re-sync setup_workspaces when a repo resolves.
  // Owns the terminal; writes the resolved hub dir up via setPlanningDir.
  const { containerRef, termRef } = usePlannerTerminal({
    paneId, visible, effectiveProjectId, linkedRepos, treatAsExisting, isAuthoring,
    activeProjectName, activeProjectNumber, planningPitch, stageIdsFor, refreshSetupSig,
    processChunk, commands, schedules, setPlanningDir,
  });

  // Modal open/close state (#1642, usePlanningModals): the clear-plan confirmation + the
  // blueprint-update modal and its version-mismatch auto-open state machine (#827/#1296).
  const hasExistingPlan = Object.keys(savedSections).length > 0;
  const { showClearConfirm, setShowClearConfirm, showBlueprintModal, setShowBlueprintModal } =
    usePlanningModals({ effectiveProjectId, currentSig, lastSetupSig, hasExistingPlan });

  const autopilotDeps: AutopilotDeps = {
    pitch: planningPitch,
    strategy: "llm",
    snapshot: () => {
      const len = autopilotTxRef.current.length;
      const grew = len > apLastSnapLen.current;
      apLastSnapLen.current = len;
      const plannerAwaiting = !grew && len > apLastAnswered.current;
      // The dynamic blueprint gate (#1061): non-optional stages done = gate met; the frontier is
      // the active stage, and its drafted-but-unconfirmed sections are what the autopilot confirms.
      const required = stages.filter(p => !p.optional);
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
      fireInvoke("pty_write", { paneId, data: `${text}\r` }, console.error);
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
  // it (a multi-line paste just sits in the input), then type it into the planner session.
  //
  // (Was gated behind terminalShows(), which scanned the WHOLE visible terminal — claude's
  // conversation, not just the input bar — so once the planner had discussed a stage, the prompt's
  // text in the scrollback false-matched and it sent a BARE Enter instead of the prompt, swallowing
  // the inject. The "?" helper is the only inject path, so there's no pre-pasted duplicate to guard
  // against — always write the prompt.)
  const sendPrompt = useCallback((prompt: string) => {
    fireInvoke("pty_write", { paneId, data: flattenPrompt(prompt) + "\r" }, console.error);
  }, [paneId]);

  // Drain a queued ad-hoc prompt into the live planner (#1371) — e.g. the file-intake "Route to
  // project" ROUTE_PROMPT. Without this the prompt was set in the store but never delivered, so
  // dropped design files were never routed into the repo.
  usePlannerPromptDelivery(effectiveProjectId, sendPrompt);


  // Planner 2s plan.db + section-file poll (#1474, usePlanSectionPoll).
  usePlanSectionPoll({ visible, projectId: effectiveProjectId, publishRepos, enqueueMcpDownloads, planningDir });


  // Session lifecycle (#1642, usePlanningSession): the `restarting` flag + the regenerate /
  // restart / "keep files" / clear-plan / switch-blueprint operations, moved verbatim. The
  // workspace mount/re-sync effects above stay here (they own the terminal + PTY).
  const { restarting, handleRestart, keepPlanFiles, doClearPlan, doSwitchBlueprint } = usePlanningSession({
    termRef, bufRef, paneId, linkedRepos, treatAsExisting, isAuthoring,
    activeProjectName, activeProjectNumber, planningPitch, effectiveProjectId,
    stageIdsFor, refreshSetupSig,
    setShowBlueprintModal, setShowClearConfirm, setSwitchOpen,
  });

  // Convert an OPEN planner when the sandbox toggle flips (#1988): the launch reads `sandboxConsoles`
  // only at spawn time, so an already-running planner must be RESTARTED to move into (or out of) the
  // sealed distro. Restart on every change after the initial mount; each mounted Planning restarts its
  // OWN pane, so flipping the toggle refreshes every open planner session.
  const sandboxConsoles = useAppStore((s) => s.sandboxConsoles);
  const sandboxInit = useRef(true);
  useEffect(() => {
    if (sandboxInit.current) { sandboxInit.current = false; return; }
    void handleRestart();
    // handleRestart is re-created each render; depend only on the toggle so we restart once per flip.
  }, [sandboxConsoles]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Publish / triage / recovery (#1490) ─────────────────────────────────────
  const {
    handlePublish, launchTriage, handleRecover,
    triaging, triageError, triageNote, recoverable, recovering, publishPhase, setPublishPhase, ghStatus,
    quarantineDialog,
  } = usePlanPublish({
    isAuthoring, githubToken, publishRepos, injectionGateState, sections, planningTitle,
    activeProjectName, planFleet, effectiveProjectId, activeProjectId, activeProjectNumber,
    planFeatures, planDependencies, depManifest, repoPublic, reposPublic, planAuthoredBlueprint,
    paneId, projectTitle, planReady, visible, addProjectRepo, fleetStartProject, importBlueprint,
  });


  return (
    <>
      {/* Header */}
      <Box style={{ padding: "14px 24px 14px 12px", display: "flex", alignItems: "flex-start", gap: 14 }}>
        <Box style={{ flex: 1 }}>
          <Row gap={10}>
            <BackButton variant="icon" onClick={() => setProjectsView("list")} aria-label="Back to Planner" />
            {isExisting
              ? (
                <>
                  <Text as="span" mono size={10} tone="dim">#{activeProjectNumber}</Text>
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
                    className="mono"
                    style={{
                      background: "none", border: "none", outline: "none", padding: 0,
                      margin: 0, fontSize: 16, fontWeight: 600,
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
                  className="mono"
                  style={{
                    background: "none", border: "none", outline: "none",
                    fontSize: 16, fontWeight: 600,
                    color: draftTitleErr ? "var(--danger)" : planningTitle ? "var(--fg)" : "var(--fg-dim)",
                    // Size to the text (snug), with a usable floor and a 400px cap so the status
                    // pill sits right next to the title.
                    width: Math.min(282, Math.max(56, (planningTitle.length || 14) * 9.5 + 16)),
                    padding: 0,
                  }}
                />
              )
            }
            <Chip tone="accent">● {isExisting ? "expanding" : "drafting"}</Chip>
          </Row>
          {autopilot.running && (
            <Text as="div" size={12} tone="accent" style={{ marginTop: 4 }}>
              ⚙ auto-planning · {autopilotProgressPct}%
            </Text>
          )}
        </Box>
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
      </Box>
      {triageError && (
        <Text as="div" mono size={12} tone="danger" style={{ padding: "0 24px 8px" }}>
          ⚠ {triageError}
        </Text>
      )}
      {triageNote && !triageError && (
        <Text as="div" mono size={12} tone="muted" style={{ padding: "0 24px 8px" }}>
          ⏭ {triageNote}
        </Text>
      )}
      {featureCycle.length > 0 && (
        <Text as="div" mono size={12} tone="danger" style={{ padding: "0 24px 8px" }}>
          ⚠ Feature dependency cycle: {featureCycle.join(" → ")} — break it to complete the Features stage.
        </Text>
      )}
      {recoverable > 0 && (
        <Row className="mono" gap={10} style={{ padding: "0 24px 8px", fontSize: 12, color: "var(--fg-muted)" }}>
          <Box as="span">⤓ The plan store is empty — GitHub has {recoverable} published issue{recoverable === 1 ? "" : "s"} for {publishRepos.length === 1 ? "this repo" : "these repos"}.</Box>
          <button
            className="mono"
            onClick={() => void handleRecover()}
            disabled={recovering}
            style={{
              padding: "3px 10px", borderRadius: 6, border: "1px solid var(--border-soft)",
              background: "var(--bg-elev2)", color: "var(--fg)", fontSize: 11,
              cursor: recovering ? "default" : "pointer", opacity: recovering ? 0.6 : 1,
            }}
          >
            {recovering ? "Recovering…" : "Recover from GitHub"}
          </button>
        </Row>
      )}

      {/* Split panel */}
      {/* eslint-disable-next-line no-restricted-syntax -- measured split-panel hosting the PTY terminal region */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden", borderTop: "1px solid var(--border-soft)" }}>
        {/* Claude CLI terminal */}
        <section style={{ flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", borderRight: "1px solid var(--border-soft)" }}>
          {/* eslint-disable-next-line no-restricted-syntax -- PTY terminal mount ref */}
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
        {/* eslint-disable-next-line no-restricted-syntax -- resize drag handle spreads measured handleProps */}
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
              onFlow={(id, f) => setPlanAgentStreamFlow(effectiveProjectId, id, {
                autonomy: f.autonomy as FlowAutonomy,
                push: (f.push === "auto-PR" ? "auto-pr" : f.push) as FlowPush,
                gate: f.gate as FlowGate,
              })}
              onModel={(id, m) => setPlanAgentStreamModel(effectiveProjectId, id, m)}
              onLinkRepo={(repo) => addProjectRepo(effectiveProjectId, repo)}
              onDeployChange={(next) => setPlanDeployConfig(effectiveProjectId, next)}
              onTopology={(t) => setPlanFleetTopology(effectiveProjectId, t)}
              onDirectorDrive={(d) => setPlanFleetDirectorDrive(effectiveProjectId, d)}
              onToggleMcp={onToggleMcp}
              onBuildMcp={onBuildMcp}
              onAddMcp={onAddMcp}
              onRemoveMcp={onRemoveMcp}
              onInject={sendPrompt}
              focus={{
                stages,
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
                // and the selection re-follows to the next live stage.
                onSkip: () => { onSkipStage(); setFocusSel(null); },
                onBack: () => setFocusSel(clampIndex(focusSelectedIdx - 1, stages.length)),
                onPrimary: () => {
                  if (focusFooter.kind === "publish") { void handlePublish(); return; }
                  if (focusFooter.kind === "approve-continue") {
                    // User gate override (#1285): the gate isn't met but the user chose to advance —
                    // force past the active stage (the skip/advance primitive) and tell the planner.
                    if (focusFooter.override) { onSkipStage(); setFocusSel(null); return; }
                    // One-click stage approval: confirm every drafted section the active stage needs,
                    // then tell the planner in a single message. The gate re-evaluates and the
                    // selection re-follows to the next live stage (#807-followup).
                    if (pendingConfirm.length > 0) confirmStageKeys(pendingConfirm);
                  }
                  setFocusSel(null); // re-follow the live stage
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
              <Row className="mono" gap={8} style={{
                padding: "10px 18px", borderBottom: "1px solid var(--border-soft)",
                fontSize: 11,
              }}>
                <Text as="span" style={{
                  color: publishPhase === "done"  ? "var(--success)"
                       : publishPhase === "error" ? "var(--danger)"
                       : "var(--accent)",
                }}>
                  {publishPhase === "running" ? "⟳ publishing…"
                   : publishPhase === "done"  ? "✓ published"
                   : "✗ publish failed"}
                </Text>
                <Spacer />
                {(publishPhase === "done" || publishPhase === "error") && (
                  <button
                    className="mono"
                    onClick={() => setPublishPhase("idle")}
                    style={{
                      padding: "2px 8px", borderRadius: 3, cursor: "pointer",
                      background: "transparent", border: "1px solid var(--border-soft)",
                      color: "var(--fg-dim)", fontSize: 10,
                    }}
                  >← back to plan</button>
                )}
              </Row>

              {/* Live GitHub structure — each node updates as it is created */}
              <Stack gap={10} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "16px 18px" }}>
                <GitHubStructureCard structure={ghStructure} status={ghStatus} />
              </Stack>
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
          <Text as="div" size={12} tone="muted" style={{ marginBottom: 12, lineHeight: 1.6 }}>
            Switch this project to a different blueprint. This re-seeds the plan for the chosen blueprint and
            <b> clears the current plan + progress</b> — this can't be undone. Pick a target:
          </Text>
          <Stack gap={8}>
            {switchTargets.map((bp) => (
              <button key={bp.id} className="btn ghost" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, height: "auto", padding: "10px 12px", textAlign: "left" }}
                onClick={() => void doSwitchBlueprint(bp.id)}>
                <Box as="span" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Text as="span" weight={600} style={{ color: "var(--fg)" }}>{bp.name}</Text>
                  <Chip style={{ fontSize: 9 }}>{blueprintCategory(bp)}</Chip>
                </Box>
                {bp.desc && <Text as="span" size={11} tone="dim" style={{ fontFamily: "var(--sans)" }}>{bp.desc}</Text>}
              </button>
            ))}
          </Stack>
        </Dialog>
      )}

      {/* Triage: confirm + clear stale warden quarantines so a prior run's denied command can't
          immediately re-pause the relaunched worker. Self-rendering (null when no dialog is open). */}
      {quarantineDialog}
    </>
  );
}
