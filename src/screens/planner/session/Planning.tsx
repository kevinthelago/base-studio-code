import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../../../store";
import { Dialog } from "../../../components/Dialog";
import { BlueprintUpdateModal } from "../blueprints/BlueprintUpdateModal";
import { sanitizeProjectKey } from "../../../lib/core/projectPaths";
import { useDragResize } from "../../../hooks/useDragResize";
import { buildGhStructure, parsePhases } from "../github/ghStructure";
import type { Section, SectionState, GhNode, GhRepoNode, GhStructure } from "../github/ghStructure";
import {
  parsePlanFocus, stripPlanFocus,
  parseStartupScripts, stripStartupScripts, scriptDocRelpath,
  parseAllowCommands, stripAllowCommands,
  parseAgentAssigns, stripAgentAssigns, parseFleetPlan, stripFleetPlan,
  buildSectionConfirmMessage, buildSectionSkipMessage,
} from "./planningSession";
import { parseCommandsFile } from "../../../lib/session/allowedCommands";
import { roleCapability, roleDeniedCommands, roleWriteRules } from "../../../lib/session/sessionRoles";
import {
  ANCHOR_KEYS, SKIPPED_KEY, COMMANDS_KEY, FLEET_KEY, FEATURES_KEY, SKILLS_KEY, titleForKey, groupSections,
  parseFleetFile, canonicalSectionKey,
} from "../stages/planSections";
import { parseSkillsFile } from "../../../lib/session/skills";
import { parseFeaturesFile, featuresSummary, featuresGateComplete, featuresAwaitingConfirm, featuresAllPhased, featuresToPlanIssues, featureDependencyCycle, type PlanFeature } from "../issues/featureList";
import { buildWorkerScope } from "../fleet/workerScope";
import { resolveIssueAssignee } from "../fleet/fleetAssignee";
import { deriveTopics, buildReadme, communityFiles, type ScaffoldFile } from "../shared/repoScaffold";
import type { FlowAutonomy, FlowPush, FlowGate } from "../fleet/agentFlow";
import { parseIssuesFile, renderIssueBody, resolvePhaseIndex, subIssueLinks, type PlanIssue } from "../issues/planIssues";
import { pruneCompletedStreams, doneIssueRefs } from "../fleet/streamCompletion";
import { recoverIssues, type GitHubIssueLike } from "../issues/recoverIssues";
import { ProjectPane } from "../pane/ProjectPane";
import { publishFleetRoster } from "../../../lib/fleet/fleetRoster";
import { hubToCanonical } from "../../../lib/planner/plannerSync";
import { tunnelSetPlanState } from "../../../lib/tunnel/tunnelClient";
import { canLaunchTriage, triageLockReason, publishBlockReason } from "../../../lib/github/projectSync";
import { effectiveProjectRepos, localReposFor } from "../list/projectRepos";
import { defaultStageConfig, enabledOrderedStages } from "../stages/planStages";
import { applyMcpAssign } from "../shared/planExtensions";
import { applyBlueprintMcp, collectBlueprintMcp } from "../blueprints/blueprintMcp";
import { writeBlueprintSkillContext, collectBlueprintSkillIds } from "../blueprints/blueprintSkills";
import { catalogLink, repoNameFromLink, mcpRepoName } from "../../../lib/session/mcpInstall";
import { resolveAllInstalledMcp } from "../../../lib/session/mcpServers";
import { toSessionPayloads } from "../../../lib/session/sessionConfig";
import { writeProjectMcpContext } from "../shared/mcpContext";
import { McpDownloadModal, type McpDownloadItem } from "../shared/McpDownloadModal";
import { type McpInstallState } from "../shared/mcpPaneData";
import { MCP_CATALOG } from "../../../data/mcpCatalog";
import { buildProjectPaneData } from "../pane/projectPaneData";
import { defaultDeployConfig, deploymentDefined, parseDeployConfigTag } from "../shared/deployConfig";
// Blueprint-driven focused-pane model (#652) — restored after the #668 lossy rebase deleted it
// (#776). The progress bar reads the project's BLUEPRINT sections + their declarative gates,
// not a hardcoded stage list.
import { derivePlanStageState, planStateToSignals, stageConfirmKeys, CONTEXT_BASELINE } from "../stages/planStageDerive";
import { findPlanGaps } from "../grading/lintPlan";
import { mkSection, planSectionsComplete, isAuthoringBlueprint, authoringSignals, canChangeBlueprint, canSwitchBlueprint, blueprintCategory, skippedSignal, confirmedSignal, AUTHORING_BLUEPRINT_ID, DEFAULT_BLUEPRINT_ID, type BlueprintSection, type Blueprint } from "../stages/blueprints";
import { Ic } from "../blueprints/blueprintIcons";
import { coerceBlueprint, blueprintToManifest } from "../blueprints/blueprintShare";
import { resolveBlueprintSkillPayloads, buildSkillLibrary } from "../blueprints/blueprintSkills";
import { buildMcpLibrary } from "../blueprints/blueprintMcp";
import { publishGist } from "../../../lib/planner/gist/gist";
import { phasesFrom, activeIndex, clampIndex, gatePill, footerAction, currentGateReady, shouldAutoCompleteGate } from "../stages/focusedPlan";
import { featureSectionsToIssues } from "../issues/planFeatures";
import { flattenPrompt, stagePrompts } from "./plannerConductor";
// Planning autopilot (#746) — re-wired into the refactored planner after it was dropped in
// the plannerCore/plannerSync refactor. Pure logic in planAutopilot*.ts; this is the wiring.
import { usePlanAutopilot, type AutopilotDeps } from "./planAutopilotRunner";
import { oneShotComplete } from "../../../lib/core/claudeComplete";
import { resolveLlmConfig, hasLlmKey } from "../../../lib/core/llmConfig";
import { fleetProfilesComplete } from "../../../lib/session/profileGen";
import { BSC_ISSUE_LABEL, BSC_ISSUE_LABEL_COLOR, withProvenanceLabel } from "../../../lib/github/issueProvenance";
import type { DataModel } from "../data/dataModel";

// ── <data_model> tag parser (#se-persist) ────────────────────────────────────
// The planner emits <data_model>{"name":"...","entities":[...]}</data_model> to hand
// off an inferred canonical schema. Exported for unit-testing in isolation.

/** Extract and JSON-parse the first <data_model> tag content. Returns null on missing or malformed JSON. */
export function parseDataModelTag(buf: string): DataModel | null {
  const m = /<data_model>([\s\S]*?)<\/data_model>/.exec(buf);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1].trim()) as unknown;
    if (
      parsed !== null && typeof parsed === "object" &&
      "name" in (parsed as object) && "entities" in (parsed as object)
    ) {
      return parsed as DataModel;
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip all <data_model>…</data_model> tags from a buffer. */
export function stripDataModelTags(buf: string): string {
  return buf.replace(/<data_model>[\s\S]*?<\/data_model>/g, "");
}

const TERM_THEME: import("@xterm/xterm").ITheme = {
  background:          "#181a1f",
  foreground:          "#eeeae4",
  cursor:              "#c4923a",
  cursorAccent:        "#181a1f",
  selectionBackground: "#c4923a44",
  black:               "#181a1f", brightBlack:   "#44474f",
  red:                 "#d4554f", brightRed:     "#e06c75",
  green:               "#5fb467", brightGreen:   "#98c379",
  yellow:              "#c4923a", brightYellow:  "#e5c07b",
  blue:                "#5694c7", brightBlue:    "#61afef",
  magenta:             "#9b59b6", brightMagenta: "#c678dd",
  cyan:                "#4aabb5", brightCyan:    "#64d5e4",
  white:               "#939aa4", brightWhite:   "#eeeae4",
};

// Covers all common VT/ANSI escape sequences:
//   CSI  \x1b [ <0x20-0x3f>* <0x40-0x7e>   — includes private ?/>/< params
//   OSC  \x1b ] <text> (\x07 | \x1b\)       — BEL or ST terminator
//   Char-set  \x1b [()][…]
//   Other C1  \x1b <any single byte>         — fallback: ESC + one char
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[\x20-\x3f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[\x40-\x7e])/g;

function stripAnsi(s: string): string {
  return (
    s
      .replace(ANSI_RE, "")  // remove escape sequences
      .replace(/\r/g, "")    // remove lone carriage returns (spinner overwrites)
      // eslint-disable-next-line no-control-regex -- intentional: strip bare ESC bytes from PTY output
      .replace(/\x1b/g, "")  // remove any leftover bare ESC bytes
  );
}

// Read the visible terminal rows (where Claude's input bar lives) and report whether they already
// contain `snippet` — so a re-send doesn't duplicate a prompt that was pasted but never submitted.
// Heuristic: a normalized substring match over the viewport. Best-effort; never throws.
function terminalShows(term: Terminal | null, snippet: string): boolean {
  if (!term || !snippet.trim()) return false;
  try {
    const buf = term.buffer.active;
    let text = "";
    for (let i = 0; i < term.rows; i++) {
      text += " " + (buf.getLine(buf.baseY + i)?.translateToString(true) ?? "");
    }
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    return norm(text).includes(norm(snippet));
  } catch {
    return false;
  }
}

// ── GitHub structure card ─────────────────────────────────────────────────────
//
// A live map of the GitHub objects this plan produces. Each node mirrors a real
// GitHub primitive (repository, project board, milestone, issue) and carries a
// status that the publish flow updates in place so the user can watch each
// object get created.

type GhItemStatus = "planned" | "running" | "created" | "exists" | "skipped" | "error";
interface GhItemState { status: GhItemStatus; detail?: string; url?: string; }
type GhStatusMap = Record<string, GhItemState>;

const GH_STATUS_GLYPH: Record<GhItemStatus, { icon: string; color: string }> = {
  planned: { icon: "○", color: "var(--fg-dim)" },
  running: { icon: "⟳", color: "var(--accent)" },
  created: { icon: "✓", color: "var(--success)" },
  exists:  { icon: "=", color: "var(--info)" },
  skipped: { icon: "–", color: "var(--fg-dim)" },
  error:   { icon: "✗", color: "var(--danger)" },
};

function GhItemRow({ node, state }: { node: GhNode; state: GhItemState }) {
  const g = GH_STATUS_GLYPH[state.status];
  return (
    <div style={{
      display: "flex", alignItems: "baseline", gap: 8,
      fontFamily: "var(--mono)", fontSize: 10.5,
      opacity: state.status === "planned" ? 0.6 : 1,
    }}>
      <span style={{ width: 11, textAlign: "center", flexShrink: 0, color: g.color }}>{g.icon}</span>
      <span style={{
        color: state.status === "error" ? "var(--danger)" : "var(--fg)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{node.label}</span>
      {state.url ? (
        <a href={state.url} target="_blank" rel="noreferrer"
          style={{ color: "var(--fg-dim)", fontSize: 9.5, textDecoration: "none" }}
          title={state.url}>
          {state.detail ?? "open"} ↗
        </a>
      ) : state.detail ? (
        <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>· {state.detail}</span>
      ) : null}
    </div>
  );
}

function GhGroup({ title, count, nodes, status, empty }: {
  title: string; count?: number; nodes: GhNode[]; status: GhStatusMap; empty?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase",
        letterSpacing: ".06em", color: "var(--fg-muted)",
      }}>
        <span>{title}</span>
        {count !== undefined && <span style={{ color: "var(--fg-dim)" }}>{count}</span>}
      </div>
      {nodes.length === 0
        ? <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", opacity: 0.6, paddingLeft: 19 }}>{empty}</div>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 8 }}>
            {nodes.map(n => (
              <GhItemRow key={n.id} node={n} state={status[n.id] ?? { status: "planned" }} />
            ))}
          </div>
        )
      }
    </div>
  );
}

// Repositories group: each repo row owns its phase tracking issues, indented
// beneath it with a connector so issue ownership is clear at a glance.
function GhReposGroup({ repos, status }: { repos: GhRepoNode[]; status: GhStatusMap }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase",
        letterSpacing: ".06em", color: "var(--fg-muted)",
      }}>
        <span>Repositories</span>
        <span style={{ color: "var(--fg-dim)" }}>{repos.length}</span>
      </div>
      {repos.length === 0
        ? <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", opacity: 0.6, paddingLeft: 19 }}>
            none linked — ask Claude to create or link repositories
          </div>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 8 }}>
            {repos.map(r => (
              <div key={r.node.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <GhItemRow node={r.node} state={status[r.node.id] ?? { status: "planned" }} />
                {r.issues.length > 0 && (
                  <div style={{
                    display: "flex", flexDirection: "column", gap: 2,
                    paddingLeft: 14, marginLeft: 5,
                    borderLeft: "1px solid var(--border-soft)",
                  }}>
                    {r.issues.map(iss => (
                      <GhItemRow key={iss.id} node={iss} state={status[iss.id] ?? { status: "planned" }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      }
    </div>
  );
}

function GitHubStructureCard({ structure, status }: { structure: GhStructure; status: GhStatusMap }) {
  return (
    <div style={{
      padding: "12px 14px", borderRadius: 6,
      background: "color-mix(in oklch, var(--info), transparent 92%)",
      border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
      display: "flex", flexDirection: "column", gap: 12,
      flexShrink: 0,
    }}>
      <div style={{
        color: "var(--info)", textTransform: "uppercase", letterSpacing: ".06em",
        fontFamily: "var(--mono)", fontSize: 10,
      }}>
        github structure
      </div>
      <GhGroup title="Project board" nodes={[structure.project]} status={status} />
      <GhGroup title="Milestones" count={structure.milestones.length} nodes={structure.milestones} status={status}
        empty="defined by the Phases section" />
      <GhReposGroup repos={structure.repos} status={status} />
      {structure.streams.length > 0 && (
        <GhGroup
          title="Agents"
          count={structure.streams.length}
          nodes={structure.streams.map(s => ({ id: s.id, label: `${s.label} · stream:${s.id.replace(/^stream:/, "")}` }))}
          status={status}
        />
      )}
    </div>
  );
}

export function Planning({ visible }: { visible: boolean }) {
  const {
    setProjectsView,
    planningPitch, planningRepo, planningTitle, setPlanningTitle,
    planningSessionKey,
    activeProjectId, activeProjectName, activeProjectNumber,
    githubToken,
    kbBlocks,
    activeProjectRepos,
    projectLocalRepos,
    planSections, planConfirmedSections,
    planAuthoredBlueprint, importBlueprint, setAuthoredBlueprint,
    planDeployConfig, setPlanDeployConfig,
    planSkippedSections, skipPlanSection,
    planFleet,
    planFleetTopology, setPlanFleetTopology,
    planFleetDirectorDrive, setPlanFleetDirectorDrive,
    projectKeyAlias,
    pinnedContext,
    blueprints, planStageConfig,
    projectBlueprintId, setProjectBlueprintId,
    uiScreens, uiApproved, planAutomations,
    setPlanAgentStreamPerm, setPlanAgentStreamPreset, setPlanAgentStreamFlow,
    addProjectRepo, fleetStartProject,
    agentProfiles,
    commands, schedules,
    confirmPlanSection,
  } = useAppStore();
  const autoPlanWithClaude = useAppStore(s => s.autoPlanWithClaude);
  const autoCompleteGates = useAppStore(s => s.autoCompleteGates);
  // Whether the active API-tier provider can make a call — gates the planning autopilot (#1085).
  const llmHasKey = useAppStore(s => hasLlmKey(resolveLlmConfig(s)));
  const skillDefs = useAppStore(s => s.skills);
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

  // Repos surfaced by <repo_link> tags emitted by Claude during this session.
  const [repoLinkFullNames, setRepoLinkFullNames] = useState<string[]>([]);

  const isExisting = !!activeProjectId;

  // Eager auto-clone (#508): the visible repo strip was removed from the header, but its
  // clone engine lives on headlessly here. Each linked / <repo_link>-surfaced repo is cloned
  // into the project dir as soon as it appears, populating projectLocalRepos → linkedRepos →
  // setup_workspaces, so the planner can read repo contents during planning (triage launch
  // re-clones fail-soft, but that's too late for in-session context). Idempotent on the Rust side.
  const autoCloneRef = useRef<Set<string>>(new Set());
  // DB poll churn guards (#1020/#1021): the last deploy blob applied per project (skip re-applying an
  // unchanged config) and the set of `<projId>::<mcp-name>` already resolved into the MCP store (so we
  // don't re-apply/re-clone every 2s tick). Keyed by project, so a project switch doesn't reset them.
  const deployAppliedRef = useRef<Record<string, string>>({});
  const mcpAppliedRef = useRef<Set<string>>(new Set());
  // Context manifest (#1019): the dynamic required-set + confirm state, polled from plan.db. The gate
  // (`requiredContextConfirmed`) reads it; the change-guard avoids churning state every tick; the
  // seeded-set guards the baseline seed so it runs at most once per project per session.
  const [ctxRequired, setCtxRequired] = useState<string[]>([]);
  const ctxRequiredJsonRef = useRef<string>("");
  const ctxSeededRef = useRef<Set<string>>(new Set());
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
      if (k !== SKIPPED_KEY && k !== COMMANDS_KEY && k !== FLEET_KEY && k !== FEATURES_KEY && k !== "blueprint") keys.add(k);
    }
    const { project, repos } = groupSections([...keys]);
    const ordered = [...project, ...repos.flatMap(r => r.keys)];
    return ordered.map(k => {
      const content = savedSections[k] ?? "";
      const state: SectionState = confirmedSet.has(k) ? "confirmed" : (content ? "drafted" : "pending");
      return { k, title: titleForKey(k), state, content };
    });
  }, [savedSections, confirmedSet]);

  // Sync the planner's commands.json (the reliable channel — surfaced by the file
  // poll like plan sections, so it can't be lost in the PTY stream) into the
  // per-project/repo command store. Additive: file commands merge in; manual
  // edits and inline-tag adds are preserved. Runs only when the file changes.
  const commandsSyncedRef = useRef("");
  useEffect(() => {
    const raw = savedSections[COMMANDS_KEY] ?? "";
    if (raw === commandsSyncedRef.current) return;
    commandsSyncedRef.current = raw;
    const { project, repos } = parseCommandsFile(raw);
    const store = useAppStore.getState();
    for (const c of project) store.addProjectAllowedCommand(effectiveProjectId, c);
    for (const [repo, list] of Object.entries(repos))
      for (const c of list) store.addRepoAllowedCommand(effectiveProjectId, repo, c);
  }, [savedSections, effectiveProjectId]);

  // Sync the planner's skills.json (the reliable file-poll channel, like commands.json) into the
  // GLOBAL skills library (#404/#1086). The planner proposes new reusable skills and writes the
  // file; this upserts them (by id/name-slug, so a re-emitted skill refines in place) so they
  // become real, reusable, and delivered to the fleet as `.claude/skills/<slug>/SKILL.md` at launch.
  // Without this wire the planner's authored skills were written and discarded. Runs only when the
  // file changes; defaults follow parseSkillsFile (enabled + pinned; global unless the planner
  // scopes `projects`).
  const skillsSyncedRef = useRef("");
  useEffect(() => {
    const raw = savedSections[SKILLS_KEY] ?? "";
    if (raw === skillsSyncedRef.current) return;
    skillsSyncedRef.current = raw;
    const defs = parseSkillsFile(raw);
    if (defs.length) useAppStore.getState().upsertSkills(defs);
  }, [savedSections]);

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
  const ghStructure  = buildGhStructure(sections, publishRepos, projectTitle, planFleet[effectiveProjectId]);

  // ── Mobile relay: connect the planner session (#801) ──────────────────────────
  // (1) Plan-sync — push the active project's canonical plan to the tunnel whenever it
  // changes, so a paired mobile planner reconciles over the relay (E2E) instead of the API.
  useEffect(() => {
    if (!tunnelRunning || Object.keys(savedSections).length === 0) return;
    // Route the JSON manifests to their canonical relpaths; everything else is a `.md`
    // section. commands.json/features.json are outside the canonical-sync contract (see
    // isPlanFile), so they're not sent.
    const md: Record<string, string> = {};
    let phasesJson, issuesJson, fleetJson, reposJson, skippedContent: string | undefined;
    for (const [k, v] of Object.entries(savedSections)) {
      if (k === "phases") phasesJson = v;
      else if (k === "issues") issuesJson = v;
      else if (k === FLEET_KEY) fleetJson = v;
      else if (k === "repos") reposJson = v;
      else if (k === SKIPPED_KEY) skippedContent = v;
      else if (k === COMMANDS_KEY || k === FEATURES_KEY) continue;
      else md[k] = v;
    }
    const { files, meta } = hubToCanonical({
      projectTitle: effectiveProjectId, // sanitized key — derives the stable proj-<hex> id
      sections: md,
      confirmedSections: [...confirmedSet],
      phasesJson, issuesJson, fleetJson, reposJson, skippedContent,
    });
    tunnelSetPlanState(meta.projectId, files).catch(() => {});
  }, [tunnelRunning, savedSections, confirmedSet, effectiveProjectId]);

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
  // Per-server MCP install lifecycle (#878): seeded by a disk probe on mount, advanced by the
  // download/build button. Keyed by extension id so the MCP pane shows real status.
  const [mcpInstallState, setMcpInstallState] = useState<McpInstallState>({});
  // Download-confirmation queue (#1055): the blueprint a project uses and the servers the planner
  // assigns can pull in first-party MCP servers that install from source. Instead of cloning that
  // third-party code silently, we queue each not-yet-installed server here and surface a modal with
  // its repo link; the user confirms before anything downloads. `mcpDownloadSeen` guards against
  // re-queuing the same server (so a re-applied blueprint / poll tick doesn't nag).
  const [mcpDownloads, setMcpDownloads] = useState<McpDownloadItem[]>([]);
  const mcpDownloadSeen = useRef<Set<string>>(new Set());
  // Queue downloadable catalog servers (by name) for the confirmation modal, skipping any already
  // installed or already queued. State-free (refs + functional setState) so it's a stable callback
  // safe to invoke from the blueprint effect AND the plan.db poll without staleness.
  const enqueueMcpDownloads = useCallback(async (names: string[]) => {
    const fresh: McpDownloadItem[] = [];
    for (const name of names) {
      const link = catalogLink(name);
      if (!link) continue; // not a downloadable first-party server
      const key = name.toLowerCase();
      if (mcpDownloadSeen.current.has(key)) continue;
      const repo = repoNameFromLink(link);
      try {
        const r = await invoke<{ downloaded: boolean; built: boolean }>("mcp_status", { name: repo });
        if (r.downloaded && r.built) { mcpDownloadSeen.current.add(key); continue; } // already installed
      } catch { /* not installed → prompt */ }
      mcpDownloadSeen.current.add(key);
      const cat = MCP_CATALOG.find((c) => c.name.toLowerCase() === key);
      fresh.push({ name, repo, link, desc: cat?.desc, install: cat?.install, status: "pending" });
    }
    if (fresh.length) setMcpDownloads((prev) => [...prev, ...fresh]);
  }, []);
  // Download (clone + build) every still-pending/failed queued server, advancing its row status.
  const confirmMcpDownloads = useCallback(async () => {
    const setStatus = (name: string, status: McpDownloadItem["status"]) =>
      setMcpDownloads((p) => p.map((d) => (d.name === name ? { ...d, status } : d)));
    const targets = mcpDownloads.filter((d) => d.status === "pending" || d.status === "error");
    await Promise.all(targets.map(async (it) => {
      setStatus(it.name, "downloading");
      try { await invoke("mcp_clone", { name: it.repo, url: it.link }); }
      catch { setStatus(it.name, "error"); return; }
      setStatus(it.name, "building");
      try {
        const r = await invoke<{ ok: boolean }>("mcp_build", { name: it.repo });
        setStatus(it.name, r.ok ? "ready" : "error");
      } catch { setStatus(it.name, "error"); }
    }));
  }, [mcpDownloads]);
  // Dismiss the modal: drop the queue but keep the seen-set so skipped servers don't immediately
  // re-prompt (the user can still install them later from the MCP screen).
  const cancelMcpDownloads = useCallback(() => setMcpDownloads([]), []);
  // Deploy stage (#919): the project's deployment config — persisted per project, seeded from the
  // linked repos (one proposed service each) until the user/planner fills it in the Deploy pane.
  const deployCfg = useMemo(
    () => planDeployConfig[effectiveProjectId] ?? defaultDeployConfig(publishRepos),
    [planDeployConfig, effectiveProjectId, publishRepos],
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
      pinned:   pinnedContext[effectiveProjectId],
      mcpServers,
      projectKey: effectiveProjectId,
      mcpInstallState,
      topologyOverride: planFleetTopology[effectiveProjectId],
      directorDriveOverride: planFleetDirectorDrive[effectiveProjectId],
    }),
    [planFleet, planFleetTopology, planFleetDirectorDrive, effectiveProjectId, agentProfiles, sections, publishRepos, pinnedContext, planFeatures, planAuthoredBlueprint, deployCfg, mcpServers, mcpInstallState],
  );

  // Probe each downloadable MCP server's on-disk state so the pane opens with real status
  // (downloaded? built?) instead of "available" for already-installed servers.
  useEffect(() => {
    const probe = paneData.mcpServers?.filter(s => s.downloadable) ?? [];
    if (probe.length === 0) return;
    let cancelled = false;
    Promise.all(probe.map(async (s) => {
      try {
        const r = await invoke<{ downloaded: boolean; built: boolean }>("mcp_status", { name: mcpRepoName(s.name) });
        return [s.id, r.built ? "ready" : r.downloaded ? "downloaded" : "available"] as const;
      } catch { return [s.id, "available"] as const; }
    })).then((rows) => {
      if (cancelled) return;
      setMcpInstallState((prev) => {
        const next = { ...prev };
        // Don't clobber an in-flight downloading/building status with a probe result.
        for (const [id, st] of rows) if (next[id] !== "downloading" && next[id] !== "building") next[id] = st;
        return next;
      });
    });
    return () => { cancelled = true; };
    // Re-probe only when the set of downloadable server ids changes.
  }, [paneData.mcpServers?.filter(s => s.downloadable).map(s => s.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scope the active blueprint's attached MCP servers to this project (#897 Phase 2), so the
  // planner + fleet get the tools the blueprint declares. Idempotent (applyMcpAssign enables +
  // scopes existing, or adds). The downloadable (first-party) ones are queued for the
  // download-confirmation modal (#1055) rather than cloned silently. Re-runs when the project or
  // the blueprint's attached-MCP set changes.
  const bpMcpKey = useMemo(() => {
    const bp = blueprints.find(b => b.id === effectiveBlueprintId);
    return bp ? collectBlueprintMcp(bp).join("\n") : "";
  }, [blueprints, effectiveBlueprintId]);
  useEffect(() => {
    if (!effectiveProjectId || !bpMcpKey) return;
    const store = useAppStore.getState();
    const bp = store.blueprints.find(b => b.id === effectiveBlueprintId);
    if (!bp) return;
    void enqueueMcpDownloads(applyBlueprintMcp(store, bp, effectiveProjectId, store.bscBaseDir));
  }, [bpMcpKey, effectiveProjectId, effectiveBlueprintId, enqueueMcpDownloads]);

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
    void writeBlueprintSkillContext({ projectKey: effectiveProjectId, blueprint: bp, skills: store.skills, kb: store.kbBlocks })
      .catch((e) => console.warn("writeBlueprintSkillContext failed:", e));
  }, [bpSkillKey, effectiveProjectId, effectiveBlueprintId]);

  // Write the planner's live extensions.md — the installed MCP servers it can call + the per-worker
  // assignment directive (#1054). Supersedes the static catalogue setup_workspaces used to write;
  // re-runs whenever the installed-server set or the project changes.
  const installedMcpKey = useMemo(
    () => resolveAllInstalledMcp(mcpServers).map((e) => `${e.id}:${e.name}`).join("\n"),
    [mcpServers],
  );
  useEffect(() => {
    if (!effectiveProjectId) return;
    void writeProjectMcpContext({ projectKey: effectiveProjectId, servers: resolveAllInstalledMcp(useAppStore.getState().mcpServers) })
      .catch((e) => console.warn("writeProjectMcpContext failed:", e));
  }, [installedMcpKey, effectiveProjectId]);

  // Keep the planner session's .mcp.json current as servers are downloaded (#1054). Claude loads MCP
  // config at startup, so a newly downloaded server is picked up on the planner's next launch /
  // resume; this keeps the file ready. No-op until the planner dir is known.
  useEffect(() => {
    if (!planningDir) return;
    const cap = roleCapability("planner");
    const write = roleWriteRules(cap);
    const mcp = toSessionPayloads(resolveAllInstalledMcp(useAppStore.getState().mcpServers), []).mcp;
    void invoke("ensure_session_settings", {
      cwd:             planningDir,
      allowedCommands: [],
      deniedCommands:  roleDeniedCommands(cap),
      mcpServers:      mcp,
      hooks:           null,
      allowToolRules:  [...write.allow, "Read", "WebFetch"],
      denyToolRules:   write.deny,
      replacePermissions: true,
    }).catch((e: unknown) => console.warn("planner mcp refresh failed:", e));
  }, [installedMcpKey, planningDir]);

  // ── MCP stage handlers (#878) ──────────────────────────────────────────────
  const onToggleMcp = useCallback((id: string) => useAppStore.getState().toggleMcpServer(id), []);
  const onRemoveMcp = useCallback((id: string) => useAppStore.getState().removeMcpServer(id), []);
  const onAddMcp = useCallback((input: string) => {
    const store = useAppStore.getState();
    // A bare catalog name maps to its template; anything with a scheme is a remote URL; else a
    // stdio command line. New servers are enabled + scoped to this project so the fleet gets them.
    const link = catalogLink(input);
    if (link || MCP_CATALOG.some(c => c.name.toLowerCase() === input.toLowerCase())) {
      const name = MCP_CATALOG.find(c => c.name.toLowerCase() === input.toLowerCase())?.name ?? input;
      applyMcpAssign(store, name, effectiveProjectId, store.bscBaseDir);
      if (link) invoke("mcp_clone", { name: repoNameFromLink(link), url: link }).catch(() => {});
      return;
    }
    const isUrl = /^https?:\/\//i.test(input);
    store.addMcpServer({
      name: input.split(/\s+/)[0].slice(0, 40) || "server", enabled: true, projects: [effectiveProjectId],
      transport: isUrl ? "http" : "stdio",
      ...(isUrl ? { url: input } : { command: input.split(/\s+/)[0], args: input.split(/\s+/).slice(1).join(" ") }),
      env: [],
    });
  }, [effectiveProjectId]);
  const onBuildMcp = useCallback(async (s: { id: string; name: string; status: string }) => {
    const repo = mcpRepoName(s.name);
    const link = catalogLink(s.name);
    // Ensure it's downloaded, then build, tracking status so the pane reflects progress.
    if (link && (s.status === "available")) {
      setMcpInstallState(p => ({ ...p, [s.id]: "downloading" }));
      try { await invoke("mcp_clone", { name: repo, url: link }); }
      catch { setMcpInstallState(p => ({ ...p, [s.id]: "available" })); return; }
    }
    setMcpInstallState(p => ({ ...p, [s.id]: "building" }));
    try {
      const r = await invoke<{ ok: boolean }>("mcp_build", { name: repo });
      setMcpInstallState(p => ({ ...p, [s.id]: r.ok ? "ready" : "error" }));
    } catch {
      setMcpInstallState(p => ({ ...p, [s.id]: "error" }));
    }
  }, []);

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
  // The live snapshot the declarative section gates read.
  const stageState = useMemo(() => {
    const streams = planFleet[effectiveProjectId]?.streams ?? [];
    const issueCount =
      parseIssuesFile(sections.find(s => s.k === "issues")?.content ?? "").length + featureIssues.length;
    return derivePlanStageState({
      sections: sections.map(s => ({ k: s.k, state: s.state })),
      contextRequired: ctxRequired,
      repoCount: publishRepos.length,
      issueCount,
      fleetStreams: streams.length,
      // Match each stream's ASSIGNED profile id (`st.profile`, e.g. `gen_<stream>`), NOT the
      // stream id — generateAgentProfile never produces a profile whose id equals the stream id,
      // so the old `p.id === st.id` check could never pass and the Permissions gate was stuck (#817).
      fleetProfilesComplete: fleetProfilesComplete(streams, agentProfiles),
      automationsAck: (planAutomations[effectiveProjectId]?.length ?? 0) > 0,
      skillsAck: false,
      requiresUi,
      ui: uiCounts,
      // Routing dropped design files to the project completes the UI stage — recorded as a
      // confirmation of the `ui` section so it persists (#837).
      uiRouted: confirmedSet.has("ui"),
      // Features completes ONLY when every feature is populated AND the user has confirmed the set
      // (#plan-db) — `allConfirmed` (all-defined) alone used to auto-advance after a single feature.
      // Folding the user-confirm in here keeps the gate signal (`featuresConfirmed`) unchanged.
      features: { count: featureState.count, allConfirmed: featuresGateComplete(featureState, confirmedSet.has(FEATURES_KEY)) && featureCycle.length === 0 },
    });
  }, [sections, ctxRequired, publishRepos, planFleet, agentProfiles, planAutomations, featureIssues, effectiveProjectId, requiresUi, uiCounts, featureState, featureCycle, confirmedSet]);
  // The blueprint sections (fallback: synthesize built-ins from the enabled stage ids).
  const planSecs = useMemo<BlueprintSection[]>(() => {
    const bp = blueprints.find(b => b.id === effectiveBlueprintId);
    if (bp) return bp.sections;
    return enabledOrderedStages(stageConfig).map(s => mkSection(s.id));
  }, [blueprints, effectiveBlueprintId, stageConfig]);
  // lint-as-gate (#897 Phase 4b — lint-plan folded into the declarative gate). A WRITTEN section
  // (drafted/confirmed; pending ones aren't authored yet) must not carry a deliberate "fill this
  // in later" marker (TODO / TBD / FIXME / XXX / TKTK). Scanned ONLY over sections that belong to
  // the ACTIVE blueprint (so stale files from a prior blueprint can't block), and only those
  // markers — NOT ellipsis or the word "placeholder", which are normal prose and were
  // false-positiving (#918). Surfaced as `hasPlanGaps`; the gate requires it false, absent-safe.
  const hasPlanGaps = useMemo(() => {
    const enabled = new Set(planSecs.map((s) => s.key));
    const written: Record<string, string> = {};
    for (const s of sections) if (s.state !== "pending" && enabled.has(s.k)) written[`${s.k}.md`] = s.content ?? "";
    return findPlanGaps(written).some((g) => g.endsWith("unresolved placeholder"));
  }, [sections, planSecs]);
  // Blueprint-authoring lifecycle (#923): this project DESIGNS a blueprint (the deliverable) rather
  // than building software. The in-progress blueprint arrives via the planner's <blueprint> tag.
  const activeBlueprint = useMemo(() => blueprints.find(b => b.id === effectiveBlueprintId), [blueprints, effectiveBlueprintId]);
  const isAuthoring = isAuthoringBlueprint(activeBlueprint);
  // Blueprint switching (#923): only a greenfield project may switch, and only to a transform/harden
  // lifecycle. Offer the valid targets in a "switch lifecycle" control.
  const switchTargets = useMemo(
    () => blueprints.filter(b => canSwitchBlueprint(activeBlueprint, b)),
    [blueprints, activeBlueprint]);
  const canSwitch = canChangeBlueprint(activeBlueprint) && switchTargets.length > 0;
  const [switchOpen, setSwitchOpen] = useState(false);
  const authoredBp = planAuthoredBlueprint[effectiveProjectId];
  // Signals the authoring stages' gates read (name+category, stage count, validity).
  const authoringSig = useMemo(() => authoringSignals(authoredBp), [authoredBp]);
  // Pickable libraries for the Capabilities stage's skill + MCP pickers.
  const authorSkillLib = useMemo(() => buildSkillLibrary(skillDefs, kbBlocks), [skillDefs, kbBlocks]);
  const authorMcpLib = useMemo(() => buildMcpLibrary(mcpServers), [mcpServers]);
  // User-skipped optional stages (#921) surface as `skipped:<key>` signals so the data-driven
  // gate model (`sectionDone`) treats them as resolved.
  const skipSignals = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const k of skippedSet) out[skippedSignal(k)] = true;
    return out;
  }, [skippedSet]);
  // A gateless ("informational") section is done only once CONFIRMED (#664) — `sectionDone` reads a
  // `confirmed:<key>` signal. Surface those so a confirmed gateless stage (testing, cleanup, the data
  // stages, a user-authored stage, …) reads as complete and the frontier advances (#954).
  const confirmSignals = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const k of confirmedSet) out[confirmedSignal(k)] = true;
    return out;
  }, [confirmedSet]);
  const signals = useMemo(
    () => ({ ...planStateToSignals(stageState), hasPlanGaps, featuresPhased: featuresAllPhased(planFeatures), deploymentDefined: deploymentDefined(deployCfg), ...(isAuthoring ? authoringSig : {}), ...skipSignals, ...confirmSignals }),
    [stageState, hasPlanGaps, planFeatures, deployCfg, isAuthoring, authoringSig, skipSignals, confirmSignals]);

  // Focused pane (#652): one phase at a time. `phases` derive from the blueprint sections +
  // signals; the selection auto-follows the active phase (`focusSel` null) or pins to a user
  // pick; reset on project/blueprint switch.
  const phases = useMemo(() => phasesFrom(planSecs, signals), [planSecs, signals]);
  const focusActiveIdx = useMemo(() => activeIndex(phases), [phases]);
  const [focusSel, setFocusSel] = useState<number | null>(null);
  useEffect(() => { setFocusSel(null); }, [effectiveProjectId, effectiveBlueprintId]);
  const focusSelectedIdx = clampIndex(focusSel ?? focusActiveIdx, phases.length);
  const focusGateReady = useMemo(() => currentGateReady(planSecs, signals), [planSecs, signals]);
  const planComplete = useMemo(() => planSectionsComplete(planSecs, signals), [planSecs, signals]);
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
        const m = await invoke<string[]>("plan_list_context", { projectKey: effectiveProjectId });
        if (!alive) return;
        // Seed the baseline once per project/session if the set is empty — a deterministic floor before
        // the planner runs `bsc-plan context require`. The blueprint's context section `requires`
        // overrides the universal baseline (blueprint seeding).
        if ((m?.length ?? 0) === 0 && !ctxSeededRef.current.has(effectiveProjectId)) {
          ctxSeededRef.current.add(effectiveProjectId);
          const requires = planSecs.find(s => s.key === "context")?.requires ?? CONTEXT_BASELINE;
          for (const t of requires) {
            await invoke("plan_require_context", { projectKey: effectiveProjectId, topic: t, required: true }).catch(() => {});
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
  // Let "approve & continue" light up as soon as there are drafted sections to confirm, even
  // before the gate flips — clicking it performs that confirmation (see onPrimary below).
  const focusFooter = footerRaw.kind === "approve-continue" && !footerRaw.enabled && pendingConfirm.length > 0
    ? { ...footerRaw, enabled: true }
    : footerRaw;
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

  const [triaging, setTriaging] = useState(false);
  const [triageError, setTriageError] = useState<string | null>(null); // launch-failure surfacing (#551)
  const [triageNote, setTriageNote] = useState<string | null>(null);   // progress-gated relaunch summary (#1004)
  // GitHub→plan.db recovery (#plan-db): how many planner-published issues GitHub holds when the
  // local plan.db is empty (machine switch / data loss), and whether a recovery is in flight.
  const [recoverable, setRecoverable] = useState(0);
  const [recovering, setRecovering] = useState(false);
  type PublishPhase = "idle" | "running" | "done" | "error";
  const [publishPhase, setPublishPhase] = useState<PublishPhase>("idle");
  // Live status of each GitHub object, keyed by the ids in buildGhStructure.
  const [ghStatus, setGhStatus] = useState<GhStatusMap>({});

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
  // Accumulated stripped output used to scan for complete <plan_update> tags
  const bufRef         = useRef("");
  // Autopilot (#746): an un-consumed copy of the planner's raw output (bufRef is drained by
  // the tag parsers), for idle-detection + the user-sim.
  const autopilotTxRef = useRef("");
  const apLastSnapLen  = useRef(0);
  const apLastAnswered = useRef(0);
  // Tracks whether the auto-send of the initial pitch has fired this session
  const initSentRef    = useRef(false);
  const initSendTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);


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
  // The plan is "ready" when every non-optional stage's gate is met — gates the Triage launch
  // (#444/#551) the same way the autopilot decides the plan is publishable.
  // Triage unlocks on the SAME completion the focused footer publishes on — the blueprint-driven
  // gate (planComplete). The legacy PLAN_STAGES check used different per-section confirmed-state
  // criteria and could stay false after the blueprint plan was done, leaving triage locked even
  // though the footer offered Publish (#823). The blueprint is the authoritative section model.
  const planReady = planComplete;
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
    if (bp) return bp.sections.filter(s => s.enabled).map(s => s.key);
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
      kbIds:         kbBlocks.map(b => b.id),
      enabledStages: stageIdsFor(effectiveProjectId),
    }).then(sig => { if (live) setCurrentSig(sig); }).catch(() => { if (live) setCurrentSig(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRepos, kbBlocks, effectiveProjectId]);
  // Re-read the baseline the backend last wrote — called on open and after every workspace
  // setup (mount / link / restart), so the badge reflects the most recent regeneration.
  const refreshSetupSig = useCallback(() => {
    invoke<string>("get_context_signature", { projectKey: effectiveProjectId })
      .then(s => setLastSetupSig(s || null)).catch(() => {});
  }, [effectiveProjectId]);
  useEffect(() => { refreshSetupSig(); }, [refreshSetupSig]);
  const contextStale = !!currentSig && !!lastSetupSig && currentSig !== lastSetupSig;

  // Blueprint-update modal (#827): when a project is opened whose blueprint/template version
  // differs from the one it was seeded with (contextStale) AND it already has a plan, surface a
  // modal so the user explicitly chooses go-back / restart / keep — rather than the old silent
  // refresh, which restarted the planner into a destructive reconciliation that deleted plan files.
  const [showBlueprintModal, setShowBlueprintModal] = useState(false);
  const [bpModalAutoShown, setBpModalAutoShown] = useState(false);
  const hasExistingPlan = Object.keys(savedSections).length > 0;
  useEffect(() => { setBpModalAutoShown(false); setShowBlueprintModal(false); }, [effectiveProjectId]);
  useEffect(() => {
    if (contextStale && hasExistingPlan && !bpModalAutoShown) {
      setShowBlueprintModal(true);
      setBpModalAutoShown(true);
    }
  }, [contextStale, hasExistingPlan, bpModalAutoShown]);

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
    const kbSnapshot      = kbBlocks;
    const repoSnapshot    = linkedRepos;  // string[] of full_names
    const isExistingSnap  = isExisting;
    const isAuthoringSnap = isAuthoring;
    const projNameSnap    = activeProjectName;
    const projNumberSnap  = activeProjectNumber;
    const pitchSnap       = planningPitch;
    const projIdSnap      = effectiveProjectId;
    // True only for brand-new sessions — no prior plan sections saved for this project
    const isFreshSession  = !isExisting && Object.keys(planSections[effectiveProjectId] ?? {}).length === 0;
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

        // Parse structured tags out of the stripped output stream.
        bufRef.current += stripAnsi(ev.payload);
        autopilotTxRef.current += stripAnsi(ev.payload); // un-consumed copy for the autopilot (#746)

        // Quote-flexible helper: matches " U+0022, " U+201C, " U+201D so LLM
        // smart-quote output doesn't silently break tag detection.
        // q(s) wraps a string in a char-class that matches any of those three.
        const Q = '["“”]';

        let m: RegExpExecArray | null;

        // Discovery/context section CONTENT now lives in `context/<topic>.md` files the planner
        // writes (read by the section poll + by workers) — the single channel (#1019). The redundant
        // `<plan_update section>` stream tag is retired; its required-set + confirm state moved to the
        // plan.db context manifest (`bsc-plan context` + the manifest poll above).

        // ── <plan_focus section="key" /> ─────────────────────────────────────
        // Marks the section Claude is currently discussing. The last focus tag
        // in this chunk wins (Claude emits one per section as it advances). Any
        // key is accepted — the focused section may not exist as a card yet.
        const focusKeys = parsePlanFocus(bufRef.current);
        if (focusKeys.length > 0) {
          setActiveSection(focusKeys[focusKeys.length - 1]);
          bufRef.current = stripPlanFocus(bufRef.current);
        }

        // ── <repo_link full_name="owner/repo" /> ─────────────────────────────
        const repoLinkRe = new RegExp(
          `<repo_link\\s+full_name=${Q}([^\\u0022\\u201c\\u201d]+)${Q}\\s*\\/>`,'g'
        );
        let foundLink = false;
        while ((m = repoLinkRe.exec(bufRef.current)) !== null) {
          const fullName = m[1];
          setRepoLinkFullNames(prev =>
            prev.includes(fullName) ? prev : [...prev, fullName]
          );
          // The headless auto-clone effect clones repos as repoLinkFullNames grows — no action needed here.
          foundLink = true;
        }
        if (foundLink) {
          bufRef.current = bufRef.current.replace(
            new RegExp(`<repo_link\\s+full_name=${Q}[^\\u0022\\u201c\\u201d]+${Q}\\s*\\/>`, 'g'),
            ""
          );
        }

        // ── <kb_assign id="block-id" /> ───────────────────────────────────────
        const kbAssignRe = new RegExp(`<kb_assign\\s+id=${Q}([^\\u0022\\u201c\\u201d]+)${Q}\\s*\\/>`, 'g');
        let foundKb = false;
        while ((m = kbAssignRe.exec(bufRef.current)) !== null) {
          useAppStore.getState().addPlanKbAssignment(projIdSnap, m[1].trim());
          foundKb = true;
        }
        if (foundKb) {
          bufRef.current = bufRef.current.replace(
            new RegExp(`<kb_assign\\s+id=${Q}[^\\u0022\\u201c\\u201d]+${Q}\\s*\\/>`, 'g'), ""
          );
        }

        // ── <automation_assign name="..." command="..." … /> ──────────────────
        const autoAssignRe = /<automation_assign([^/]*)\s*\/>/g;
        let foundAuto = false;
        while ((m = autoAssignRe.exec(bufRef.current)) !== null) {
          const attrs  = m[1];
          // Each attr value may use straight or curly quotes
          const attrRe = (k: string) => new RegExp(`\\b${k}=${Q}([^\\u0022\\u201c\\u201d]*)${Q}`);
          const nameM  = attrRe("name").exec(attrs);
          const cmdM   = attrRe("command").exec(attrs);
          const schedM = attrRe("schedule").exec(attrs);
          const descM  = attrRe("description").exec(attrs);
          if (nameM && cmdM) {
            useAppStore.getState().addPlanAutomation(projIdSnap, {
              name:        nameM[1],
              command:     cmdM[1],
              schedule:    schedM?.[1],
              description: descM?.[1],
            });
          }
          foundAuto = true;
        }
        if (foundAuto) {
          bufRef.current = bufRef.current.replace(/<automation_assign[^/]*\/>/g, "");
        }

        // ── <startup_script repo="owner/repo" mode="dev|triage" path="..." /> ──
        // Registers a per-repo starting script the planner wrote to prompts/.
        // The path is relative to the project dir; resolve it to a unified-store
        // relpath and auto-assign so opening that repo's console (dev) or triage
        // pane uses it. projectId = the planning session key (matches what the
        // board passes to quick start / triage for existing projects).
        const scripts = parseStartupScripts(bufRef.current);
        if (scripts.length > 0) {
          const key = sanitizeProjectKey(projIdSnap);
          const store = useAppStore.getState();
          for (const sc of scripts) {
            const relpath = scriptDocRelpath(key, sc.path);
            if (sc.mode === "triage") store.setRepoTriagePromptDoc(projIdSnap, sc.repo, relpath);
            else                      store.setRepoStartupPromptDoc(projIdSnap, sc.repo, relpath);
          }
          bufRef.current = stripStartupScripts(bufRef.current);
        }

        // ── <allow_command cmd="cargo" [repo="owner/repo"] /> ─────────────────
        // Adds a shell command to the project's (or a repo's) auto-approve list,
        // so the repo's console/triage sessions can run it without a prompt.
        const allowCmds = parseAllowCommands(bufRef.current);
        if (allowCmds.length > 0) {
          const store = useAppStore.getState();
          for (const a of allowCmds) {
            if (a.repo) store.addRepoAllowedCommand(projIdSnap, a.repo, a.cmd);
            else        store.addProjectAllowedCommand(projIdSnap, a.cmd);
          }
          bufRef.current = stripAllowCommands(bufRef.current);
        }

        // ── <fleet_plan recommended="N" reasoning="…" director="true" … /> ─────
        // The fleet-level header: optimal concurrent session count + reasoning +
        // whether a director session is recommended. fleet.json is authoritative;
        // this is the fast path for immediate display before the next poll.
        const fleetMeta = parseFleetPlan(bufRef.current);
        if (fleetMeta) {
          const store = useAppStore.getState();
          store.setPlanFleetMeta(projIdSnap, fleetMeta.recommended, fleetMeta.reasoning, fleetMeta.strategy); // #C
          store.setPlanDirector(projIdSnap, fleetMeta.director, fleetMeta.directorRole);
          bufRef.current = stripFleetPlan(bufRef.current);
        }

        // ── <agent_assign id="…" repo="…" owns="…" issues="…" … /> ────────────
        // One per work stream. Merged by id so a re-emitted tag refines in place.
        const agentStreams = parseAgentAssigns(bufRef.current);
        if (agentStreams.length > 0) {
          const store = useAppStore.getState();
          for (const st of agentStreams) store.addPlanAgentStream(projIdSnap, st);
          bufRef.current = stripAgentAssigns(bufRef.current);
        }

        // MCP assignments moved to plan.db (#1021) — the planner now records them with `bsc-plan mcp
        // add`, and the DB poll below resolves each into the MCP-servers store. (Was a <mcp_assign> tag.)

        // Authored blueprint moved to plan.db (#1022) — the planner now records it with `bsc-plan
        // blueprint set`, and the DB poll below coerces it into the authored blueprint + pins the
        // authoring binding. (Was a <blueprint> stream tag + a blueprint.json file.)

        // Deploy config moved to plan.db (#1020) — the planner now records it with `bsc-plan deploy
        // set`, and the DB poll below coerces it into planDeployConfig. (Was a <deploy_config> tag.)

        // ── <data_model>{"name":"...","entities":[...]}</data_model> ──────────
        // Persists the planner's inferred Data Model as datamodel.json in the project
        // hub (#se-persist). `refined` starts false; the source pane sets it to true
        // once the user confirms/refines the model interactively.
        const dm = parseDataModelTag(bufRef.current);
        if (dm) {
          invoke("data_persist_model", {
            projectKey: projIdSnap,
            model: dm,
            refined: false,
          }).catch((e: unknown) => console.warn("data_persist_model failed:", e));
          bufRef.current = stripDataModelTags(bufRef.current);
        }

        // Cap buffer to prevent unbounded growth while preserving any partial
        // in-progress tag that hasn't received its closing counterpart yet.
        const MAX_BUF = 120_000;
        if (bufRef.current.length > MAX_BUF) {
          const lastTagStart = bufRef.current.lastIndexOf("<");
          bufRef.current = bufRef.current.slice(
            lastTagStart > 0 && lastTagStart > bufRef.current.length - MAX_BUF
              ? lastTagStart
              : bufRef.current.length - MAX_BUF
          );
        }
      });

      unlistenExit.current = await listen<unknown>(`pty_exit_${paneId}`, () => {
        term.write("\r\n\x1b[33m[session ended — navigate away and back to restart]\x1b[0m\r\n");
      });

      // Create isolated workspace directories with settings.json + CLAUDE.md,
      // and sync all KB blocks to disk so the planner can Read them via ../kb/.
      const paths = await invoke<{ kb_dir: string; planning_dir: string }>(
        "setup_workspaces",
        {
          kbBlocks: kbSnapshot.map(b => ({
            id:      b.id,
            title:   b.title,
            tags:    b.tags,
            content: b.content,
          })),
          repoFullNames: repoSnapshot,
          automations:   automationsSnap,
          isExisting:    isExistingSnap,
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
        allowToolRules:  [...plannerWrite.allow, "Read", "WebFetch"],
        denyToolRules:   plannerWrite.deny,
        replacePermissions: true,
      }).catch((e: unknown) => console.error("planner session settings failed:", e));
      await invoke("pty_create", {
        paneId:  paneId,
        cols:    term.cols,
        rows:    term.rows,
        cwd:     paths?.planning_dir ?? "",
        initCmd: "claude --continue 2>/dev/null || claude",
        env:     ghEnv,
      }).catch(console.error);

      // For brand-new sessions, send the pitch automatically once Claude has
      // had time to finish its startup banner and reach the input prompt.
      // The 3-second delay is intentionally generous — bytes written to a PTY
      // are buffered by the kernel, so they arrive at Claude regardless of
      // whether we race with its banner. We just want to avoid sending before
      // Claude switches the terminal into raw (interactive) mode.
      if (isFreshSession && pitchSnap && !initSentRef.current) {
        initSendTimer.current = setTimeout(() => {
          if (!initSentRef.current) {
            initSentRef.current = true;
            invoke("pty_write", { paneId, data: `${pitchSnap}\r` }).catch(console.error);
          }
        }, 3000);
      }
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
      if (initSendTimer.current !== null) clearTimeout(initSendTimer.current);
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

  // Poll the section files Claude writes every 2 seconds while visible. Each
  // documented topic is its own file ({key}.md / phases.json / _skipped.md);
  // read_plan_sections returns them all dynamically, keyed by file stem. Writing
  // to the store drives the derived `sections`/`skipped` — confirmed sections
  // stay frozen. This file poll is more reliable than the raw <plan_update>
  // stream and is what surfaces brand-new topics as their own cards.
  const lastBpJsonRef = useRef<string>("");
  useEffect(() => {
    if (!visible) return;
    lastBpJsonRef.current = ""; // reset the blueprint.json change-guard on project switch

    const poll = async () => {
      try {
        const store = useAppStore.getState();
        const saved = store.planSections[effectiveProjectId] ?? {};
        const confirmed = new Set(store.planConfirmedSections[effectiveProjectId] ?? []);

        // Issues are owned by plan.db now (#plan-db) — the canonical store, not an issues.json
        // file. Read them straight from the DB and reflect into the "issues" section so every
        // downstream consumer (publish, structure card, grading, the mobile mirror) is unchanged.
        try {
          const dbIssues = await invoke<PlanIssue[]>("plan_list_issues", { projectKey: effectiveProjectId });
          const json = JSON.stringify(dbIssues ?? []);
          if (json !== (saved["issues"] ?? "")) store.setPlanSection(effectiveProjectId, "issues", json);
        } catch { /* plan.db not created until the planner adds its first issue — ignore */ }

        // Features are DB-owned too (#plan-db) — titles-first roster in plan.db, not a features.json
        // file. Reflect them into the "features" section so the Features board + gate read unchanged.
        try {
          const dbFeatures = await invoke<PlanFeature[]>("plan_list_features", { projectKey: effectiveProjectId });
          const json = JSON.stringify(dbFeatures ?? []);
          if (json !== (saved[FEATURES_KEY] ?? "")) store.setPlanSection(effectiveProjectId, FEATURES_KEY, json);
        } catch { /* plan.db not created until the planner registers its first feature — ignore */ }

        // Linked repos are DB-owned too (#1012) — restore them from the hub's plan.db into the store
        // so a zustand/app-state reset can't lose the links (the store-only persistence proved fragile).
        try {
          const dbRepos = await invoke<string[]>("plan_list_repos", { projectKey: effectiveProjectId });
          for (const r of dbRepos ?? []) store.addProjectRepo(effectiveProjectId, r);
        } catch { /* plan.db not created until the first repo is linked — ignore */ }

        // Phases are DB-owned too (#1017) — reflect the roadmap (name + description, in order) from
        // plan.db into the "phases" section so the structure card + publish (parsePhases) read it
        // unchanged. Only override on a non-empty DB so the migration doesn't wipe a legacy phases.json.
        try {
          const dbPhases = await invoke<{ name: string; description: string }[]>("plan_list_phases", { projectKey: effectiveProjectId });
          const json = JSON.stringify(dbPhases ?? []);
          if ((dbPhases?.length ?? 0) > 0 && json !== (saved["phases"] ?? "")) store.setPlanSection(effectiveProjectId, "phases", json);
        } catch { /* plan.db not created until the planner adds a phase — ignore */ }

        // Fleet (streams + per-stream permissions/flows + director/topology) is DB-owned too (#1018) —
        // reflect it from plan.db into the "fleet" section so the fleet sync effect (parseFleetFile →
        // setPlanFleet) reads it unchanged. Only override on a non-null fleet so a legacy fleet.json isn't wiped.
        try {
          const dbFleet = await invoke<unknown | null>("plan_get_fleet", { projectKey: effectiveProjectId });
          if (dbFleet) {
            const json = JSON.stringify(dbFleet);
            if (json !== (saved[FLEET_KEY] ?? "")) store.setPlanSection(effectiveProjectId, FLEET_KEY, json);
          }
        } catch { /* plan.db not created until the planner sets the fleet — ignore */ }

        // Deploy config is DB-owned (#1020) — coerce the stored blob through the same parseDeployConfigTag
        // the old <deploy_config> tag used and push it into planDeployConfig, so the `deploy` gate clears
        // from the plan. Skip an unchanged blob so we don't churn the store every tick.
        try {
          const dbDeploy = await invoke<unknown | null>("plan_get_deploy", { projectKey: effectiveProjectId });
          if (dbDeploy) {
            const raw = JSON.stringify(dbDeploy);
            if (raw !== deployAppliedRef.current[effectiveProjectId]) {
              deployAppliedRef.current[effectiveProjectId] = raw;
              const cfg = parseDeployConfigTag(raw, publishRepos);
              if (cfg) store.setPlanDeployConfig(effectiveProjectId, cfg);
            }
          }
        } catch { /* plan.db not created until the planner sets deploy — ignore */ }

        // MCP assignments are DB-owned (#1021) — resolve each assigned catalog name into the MCP-servers
        // store (idempotent). First-party servers are queued for the download-confirmation modal
        // (#1055) instead of cloned silently. The applied-set guards against re-applying the same name
        // every 2s tick (and the modal's seen-set guards against re-prompting).
        try {
          const dbMcp = await invoke<string[]>("plan_list_mcp", { projectKey: effectiveProjectId });
          const toDownload: string[] = [];
          for (const name of dbMcp ?? []) {
            const key = `${effectiveProjectId}::${name.toLowerCase()}`;
            if (mcpAppliedRef.current.has(key)) continue;
            mcpAppliedRef.current.add(key);
            applyMcpAssign(store, name, effectiveProjectId, store.bscBaseDir);
            if (catalogLink(name)) toDownload.push(name);
          }
          if (toDownload.length) void enqueueMcpDownloads(toDownload);
        } catch { /* plan.db not created until the planner assigns an MCP server — ignore */ }

        // Authored blueprint is DB-owned (#1022) — the authoring planner records it with `bsc-plan
        // blueprint set`; coerce the stored JSON into the in-progress blueprint (the same coerceBlueprint
        // the import path uses) so the authoring panes render the stages it designed. Guard on the JSON
        // changing so a 2s re-read can't clobber a live UI edit, and pin the binding to the authoring
        // lifecycle so it can't revert to default on restart (#923).
        try {
          const dbBp = await invoke<unknown | null>("plan_get_blueprint", { projectKey: effectiveProjectId });
          if (dbBp) {
            const raw = JSON.stringify(dbBp);
            if (raw !== lastBpJsonRef.current) {
              lastBpJsonRef.current = raw;
              try {
                const parsed = coerceBlueprint(dbBp, { allowEmptySections: true });
                if (parsed) {
                  store.setAuthoredBlueprint(effectiveProjectId, parsed);
                  if (store.projectBlueprintId[effectiveProjectId] !== AUTHORING_BLUEPRINT_ID) {
                    store.setProjectBlueprintId(effectiveProjectId, AUTHORING_BLUEPRINT_ID);
                  }
                }
              } catch { /* mid-write / invalid shape — ignore, the planner re-writes */ }
            }
          }
        } catch { /* plan.db not created until the planner sets the blueprint — ignore */ }

        const result = await invoke<Record<string, string>>("read_plan_sections", { projectKey: effectiveProjectId });
        const entries = Object.entries(result);

        for (const [rawKey, content] of entries) {
          // Canonicalize the file stem (e.g. "Tech stack" → "stack") so a title-named file
          // still satisfies the gate (#…).
          const key = canonicalSectionKey(rawKey);
          if (key === "issues" || key === FEATURES_KEY || key === "phases" || key === FLEET_KEY || key === "blueprint") continue; // DB-owned (#plan-db/#1017/#1018/#1022) — sourced from plan.db above, not a file
          if (content && content !== (saved[key] ?? "") && !confirmed.has(key)) {
            store.setPlanSection(effectiveProjectId, key, content);
          }
        }
      } catch {
        // plans dir may not exist yet — ignore
      }
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, effectiveProjectId]);

  // Re-sync CLAUDE.md whenever a repo resolves after the initial mount.
  // kbBlocks is captured via ref to avoid including it in deps (it's large and
  // stable — we don't want to re-run on every KB edit).
  const kbBlocksRef = useRef(kbBlocks);
  useEffect(() => { kbBlocksRef.current = kbBlocks; }, [kbBlocks]);

  useEffect(() => {
    if (linkedRepos.length === 0) return;
    const { commands: cmds, schedules: scheds } = useAppStore.getState();
    invoke("setup_workspaces", {
      kbBlocks: kbBlocksRef.current.map(b => ({
        id: b.id, title: b.title, tags: b.tags, content: b.content,
      })),
      repoFullNames: linkedRepos,
      automations: [
        ...cmds.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
        ...scheds.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
      ],
      isExisting:    isExisting,
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
  async function regenerateWorkspace(): Promise<{ kb_dir: string; planning_dir: string } | null> {
    const store = useAppStore.getState();
    const currentAutomations = [
      ...store.commands.map(c => ({ id: c.id, name: c.name, command: c.cmd, schedule: null })),
      ...store.schedules.map(sc => ({ id: sc.id, name: sc.name, command: sc.detail, schedule: sc.when })),
    ];
    const paths = await invoke<{ kb_dir: string; planning_dir: string }>(
      "setup_workspaces",
      {
        kbBlocks: kbBlocks.map(b => ({ id: b.id, title: b.title, tags: b.tags, content: b.content })),
        repoFullNames: linkedRepos,
        automations: currentAutomations,
        isExisting,
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
    await invoke("pty_create", {
      paneId: paneId,
      cols: term.cols,
      rows: term.rows,
      cwd: paths?.planning_dir ?? "",
      initCmd: "claude",
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

  // Switch the project to a transform/harden lifecycle (#923 — greenfield → transform|harden only;
  // applyBlueprintToProject enforces the rule + re-seeds the stage config + clears the old progress).
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

  // Publish the plan to GitHub: repositories → project board → milestones →
  // issues. Every step is idempotent (check-then-create) so re-running acts as a
  // sync. Status is reported through ghStatus, keyed by the buildGhStructure ids,
  // so the GitHubStructureCard reflects each object as it is created.
  // Header button → clone the repos and launch the planned agent fleet (recommended workers + director).
  async function launchTriage() {
    const fleet = planFleet[effectiveProjectId];
    // Pre-flight gate (#444/#551) — mirror the button's gate so a programmatic / Enter-key
    // path can't launch against an unpublished or plan-incomplete project. (Restored: the
    // refactor had weakened this to a repos/fleet-only check.)
    if (!canLaunchTriage({
      published: !!activeProjectId,
      hasRepos: publishRepos.length > 0,
      hasFleet: !!fleet && fleet.streams.length > 0,
      busy: triaging,
      planReady,
    })) return;
    setTriageError(null);
    setTriageNote(null);
    setTriaging(true);
    try {
      await Promise.all(publishRepos.map(fullName =>
        invoke<string>("clone_repo", { project: effectiveProjectId, fullName })
          .then(() => addProjectRepo(activeProjectId ?? effectiveProjectId, fullName))
          .catch(e => console.error(`clone ${fullName} failed:`, e)),
      ));
      // Materialize any unassigned / dangling-reference agent profiles before
      // launch so each worker gets its least-privilege profile (#358), then read
      // the fleet back with the now-assigned profile ids.
      useAppStore.getState().generateFleetProfiles(effectiveProjectId);
      const fullPlan = useAppStore.getState().planFleet[effectiveProjectId] ?? fleet;
      // Progress-gated relaunch (#1004): read each issue's status from plan.db and DON'T restart a
      // worker whose issues are all complete/verified — it already finished. Prune those streams (their
      // worktrees/branches persist untouched); launch only the streams with outstanding work, plus the
      // director if enabled. On a first launch nothing is done, so every stream stays active.
      const dbIssues = await invoke<PlanIssue[]>("plan_list_issues", { projectKey: effectiveProjectId })
        .catch(() => [] as PlanIssue[]);
      const { active, skipped } = pruneCompletedStreams(fullPlan.streams, doneIssueRefs(dbIssues));
      const launchPlan = { ...fullPlan, streams: active };
      if (active.length === 0 && !launchPlan.director.enabled) {
        setTriageError("Every worker's issues are already complete — nothing to relaunch.");
        return;
      }
      if (skipped.length > 0) {
        setTriageNote(`Skipped ${skipped.length} completed worker${skipped.length === 1 ? "" : "s"} `
          + `(${skipped.map(s => s.id).join(", ")}) — relaunching ${active.length}.`);
      }
      // Create each worker's git worktree FAIL-CLOSED (#551/#359): if any can't be created,
      // abort the launch so no agent starts in a fallback dir. (Restored: the refactor had
      // weakened this to a non-fatal .catch that let the launch continue.)
      const worktreeResults = await Promise.all(launchPlan.streams.map(st =>
        // Seed each worktree's CLAUDE.local.md with the worker's SCOPE (owns/issues/deps),
        // not the full plan — the worktree lives outside the hub so the planner spec is no
        // longer an ancestor (#844).
        invoke<string>("ensure_worktree", { projectKey: effectiveProjectId, repo: st.repo, agentId: st.id, scopeMd: buildWorkerScope(st) })
          .then(path => ({ id: st.id, path, err: null as string | null }))
          .catch(e => ({ id: st.id, path: null as string | null, err: String(e) })),
      ));
      const failed = worktreeResults.filter(r => r.err || !r.path);
      if (failed.length > 0) {
        setTriageError(`launch failed — ${failed[0].id}: ${failed[0].err ?? "empty path"}`);
        return;
      }
      // Carry the authoritative absolute paths into fleetStartProject (#905) so each pane's
      // cwd comes from the Rust backend, not the async-loaded `bscBaseDir` mirror (which, when
      // empty/malformed, silently drops every session at the user's home dir). Workers use the
      // worktree path ensure_worktree just returned; the director uses the hub dir.
      const worktreePaths: Record<string, string> = {};
      for (const r of worktreeResults) if (r.path) worktreePaths[r.id] = r.path;
      const hubPath = await invoke<string>("project_dir_path", { projectKey: effectiveProjectId }).catch(() => "");
      // Give the director its standing protocol at the hub (#375) so it gets the bsc-fleet
      // roster instruction + answers worker questions (the refactor dropped this call; #734).
      if (launchPlan.director.enabled) {
        await invoke("ensure_director_protocol", { projectKey: effectiveProjectId })
          .catch(e => console.error("director protocol failed:", e));
      }
      const roster = fleetStartProject(projectTitle, launchPlan, effectiveProjectId, { hubPath, worktreePaths });
      publishFleetRoster(effectiveProjectId, roster); // #734: hub fleet.roster.tsv for bsc-fleet
    } catch (e) {
      console.error("fleet launch failed:", e);
    } finally {
      setTriaging(false);
    }
  }

  // Publish an AUTHORING project's deliverable (#923): land the designed blueprint in the library,
  // then ship it to a gist per the chosen visibility — "local" stays library-only, "private-gist" is
  // secret, "catalog" is public. No repos/board/milestones/issues/fleet.
  async function publishAuthoredBlueprint() {
    const bp = planAuthoredBlueprint[effectiveProjectId];
    const valid = bp ? coerceBlueprint(bp) : null;
    if (!valid) { setPublishPhase("error"); return; }
    const visibility = valid.visibility ?? "private-gist";
    if (visibility !== "local" && !githubToken) { setPublishPhase("error"); return; }
    setGhStatus({ blueprint: { status: "running" } });
    setPublishPhase("running");
    try {
      const store = useAppStore.getState();
      // Land it in the local library so it's editable + re-publishable, and record which blueprint
      // seeded this project so re-opening resolves to it.
      const newId = importBlueprint(valid);
      store.setProjectBlueprintId(effectiveProjectId, newId);
      if (visibility === "local") {
        setGhStatus({ blueprint: { status: "created", detail: `${valid.name} · saved to library` } });
        setPublishPhase("done");
        invoke("pty_write", { paneId, data: `[Blueprint "${valid.name}" saved to your local library.]\r` }).catch(console.error);
        return;
      }
      // Bundle attached skill/KB content so the share is self-contained; MCP stays by reference.
      const bundled = resolveBlueprintSkillPayloads(valid, store.skills, kbBlocks);
      const res = await publishGist(githubToken, blueprintToManifest(valid, bundled), { public: visibility === "catalog" });
      setGhStatus({ blueprint: { status: "created", detail: valid.name, url: res.htmlUrl } });
      setPublishPhase("done");
      const kind = visibility === "catalog" ? "public" : "secret";
      invoke("pty_write", { paneId, data: `[Blueprint published to a ${kind} gist: ${res.htmlUrl}]\r` }).catch(console.error);
    } catch (e) {
      setGhStatus({ blueprint: { status: "error", detail: String(e) } });
      setPublishPhase("error");
    }
  }

  async function handlePublish() {
    if (isAuthoring) { await publishAuthoredBlueprint(); return; }
    // Don't fail silently (#969): surface WHY publish can't proceed, so the user isn't left thinking
    // they published when nothing happened (which then leaves the fleet-launch button locked with no
    // explanation). The common case is a blueprint with no Repos stage ⇒ no repo ever linked.
    const blocked = publishBlockReason({ hasToken: !!githubToken, repoCount: publishRepos.length });
    if (blocked) { setTriageError(blocked); return; }
    setTriageError(null);
    const token = githubToken;

    const repos       = publishRepos;
    const noRepo      = repos.length === 0;
    const phases      = parsePhases(sections.find(s => s.k === "phases")?.content ?? "");
    const goalContent = sections.find(s => s.k === "goal")?.content ?? "";
    const projectTitle = planningTitle || goalContent.split(/[.!?\n]/)[0].trim() || activeProjectName || "New project";
    const projectDesc  = goalContent.split(/\n/)[0].slice(0, 350);
    const fleet        = planFleet[effectiveProjectId];

    // Seed every node as "planned" so the card shows the full structure upfront.
    // Issues are namespaced per repo so each repo tracks its own phase issues.
    const status: GhStatusMap = {};
    status["project"] = { status: "planned" };
    phases.forEach((_, i) => { status[`ms:${i}`] = { status: "planned" }; });
    repos.forEach(r => {
      status[`repo:${r}`] = { status: "planned" };
      phases.forEach((_, i) => { status[`issue:${r}:${i}`] = { status: "planned" }; });
    });
    (fleet?.streams ?? []).forEach(st => { status[`stream:${st.id}`] = { status: "planned" }; });
    setGhStatus({ ...status });
    setPublishPhase("running");

    let anyError = false;
    const upd = (id: string, patch: Partial<GhItemState>) => {
      status[id] = { ...(status[id] ?? { status: "planned" }), ...patch };
      if (patch.status === "error") anyError = true;
      setGhStatus({ ...status });
    };

    const gql = (query: string, variables: unknown) =>
      invoke<Record<string, unknown>>("github_graphql", { token, query, variables });
    const rest = <T,>(path: string) => invoke<T>("github_request", { token, path });
    const post = <T,>(path: string, body: unknown) => invoke<T>("github_post", { token, path, body });
    const put = (path: string, body: unknown) => invoke("github_put", { token, path, body });

    try {
      // ── 1. Repositories — verify each exists; create if missing ───────────
      const repoNodeIds: Record<string, string> = {};
      let viewerLogin = "";
      try {
        const v = await gql(`{ viewer { login } }`, null) as { viewer?: { login?: string } };
        viewerLogin = v.viewer?.login ?? "";
      } catch { /* non-fatal: fall back to org repo path */ }

      for (const fullName of repos) {
        const id = `repo:${fullName}`;
        const [owner, name] = fullName.split("/");
        upd(id, { status: "running" });
        try {
          const existing = await rest<{ node_id: string; html_url: string }>(`repos/${fullName}`).catch(() => null);
          if (existing?.node_id) {
            repoNodeIds[fullName] = existing.node_id;
            upd(id, { status: "exists", detail: "on github", url: existing.html_url });
          } else {
            const path = owner.toLowerCase() === viewerLogin.toLowerCase() ? "user/repos" : `orgs/${owner}/repos`;
            const created = await post<{ node_id: string; html_url: string }>(path, {
              name, private: true, description: projectDesc,
            });
            repoNodeIds[fullName] = created.node_id;
            upd(id, { status: "created", detail: "created", url: created.html_url });
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 1b. Repo presentation (#848): topics from the stack + a thorough README
      //        with CI/version badges + the standard community-health files. Files are
      //        created only when ABSENT (never clobber a hand-written one); a repo with
      //        no workflows simply omits CI badges; any failure is surfaced, not fatal. ──
      {
        const stackText = sections.find(s => s.k === "stack")?.content ?? "";
        const topics = deriveTopics(stackText);
        for (const fullName of repos) {
          const id = `scaffold:${fullName}`;
          upd(id, { status: "running" });
          try {
            if (topics.length) await put(`repos/${fullName}/topics`, { names: topics }).catch(() => {});
            // CI badges reference the repo's actual workflow files (graceful — none yet ⇒ none).
            const wfs = await rest<{ name: string }[]>(`repos/${fullName}/contents/.github/workflows`).catch(() => []);
            const workflows = (Array.isArray(wfs) ? wfs : []).map(w => w.name).filter(n => /\.ya?ml$/i.test(n));
            const files: ScaffoldFile[] = [
              { path: "README.md", content: buildReadme({ fullName, description: projectDesc, stackText, workflows }) },
              ...communityFiles(projectTitle),
            ];
            let wrote = 0;
            for (const f of files) {
              const path = `repos/${fullName}/contents/${f.path}`;
              const exists = await rest<{ sha?: string }>(path).then(r => !!r?.sha).catch(() => false);
              if (exists) continue; // don't clobber an existing file
              const content = btoa(unescape(encodeURIComponent(f.content)));
              await put(path, { message: `docs: scaffold ${f.path}`, content }).catch(() => {});
              wrote++;
            }
            upd(id, wrote
              ? { status: "created", detail: `${topics.length} topics · ${wrote} file${wrote === 1 ? "" : "s"}` }
              : { status: "exists", detail: topics.length ? `${topics.length} topics · files present` : "already scaffolded" });
          } catch (e) {
            upd(id, { status: "error", detail: String(e) });
          }
        }
      }

      // ── 2. Project board — reuse existing or create a Projects v2 board ───
      let projectId = activeProjectId;
      {
        const id = "project";
        upd(id, { status: "running" });
        try {
          if (projectId) {
            upd(id, { status: "exists", detail: activeProjectNumber ? `#${activeProjectNumber}` : "linked" });
          } else {
            const ownerLogin = repos[0]?.split("/")[0] || viewerLogin;
            if (!ownerLogin) throw new Error("no owner to create project under");
            const ownerData = await gql(
              `query($login:String!){ repositoryOwner(login:$login){ id } }`,
              { login: ownerLogin },
            ) as { repositoryOwner?: { id?: string } };
            const ownerId = ownerData.repositoryOwner?.id;
            if (!ownerId) throw new Error(`could not resolve owner '${ownerLogin}'`);
            const created = await gql(
              `mutation($ownerId:ID!,$title:String!){
                 createProjectV2(input:{ownerId:$ownerId,title:$title}){ projectV2 { id number url } }
               }`,
              { ownerId, title: projectTitle },
            ) as { createProjectV2?: { projectV2?: { id: string; number: number; url: string } } };
            const pv = created.createProjectV2?.projectV2;
            if (!pv) throw new Error("project not created");
            projectId = pv.id;
            // Reflect in the store so the projects list + future syncs treat it as existing.
            useAppStore.getState().setActiveProjectMeta(pv.id, projectTitle, repos[0] ?? "", pv.number, repos);
            // Stable-key bridge (#…): map the new board's node id → this project's folder key, so
            // opening it from the board later resolves to the SAME on-disk hub instead of keying
            // fresh state under the node id (the split that scattered repos/plan across two keys).
            useAppStore.getState().setProjectKeyAlias(pv.id, effectiveProjectId);
            // Mark the hub published (#922): write projects/<key>/.published in place. Unlike the
            // old promote-rename, this can't fail while the planner holds the hub as its cwd, and
            // the hub never moves — so Claude's --continue history survives.
            invoke("mark_published", { projectKey: effectiveProjectId }).catch((e) => console.warn("mark_published failed (Projects page reconciles it):", e));
            // Drop the store's draft entry so the project can't linger as a ghost draft card now
            // that it's published (the key-based dedup also excludes it, this keeps the map clean).
            useAppStore.getState().removeDraftProject(effectiveProjectId);
            upd(id, { status: "created", detail: `#${pv.number}`, url: pv.url });
          }
          // Link every repo to the board (idempotent server-side).
          for (const fullName of repos) {
            const repoNodeId = repoNodeIds[fullName];
            if (projectId && repoNodeId) {
              await gql(
                `mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){ repository { id } } }`,
                { p: projectId, r: repoNodeId },
              ).catch(() => { /* already linked — ignore */ });
            }
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 3. Milestones — one per phase in every repo ───────────────────────
      // Existing milestones per repo for idempotency; remember each repo's
      // milestone number per phase so that repo's issues can be assigned to it.
      // Existing milestones per repo (matched by the stable phase name). Fail
      // CLOSED: if a repo's fetch fails, record it and skip creating milestones
      // there rather than risk duplicates.
      const existingMs: Record<string, Map<string, number>> = {};
      const msFetchFailed = new Set<string>();
      if (!noRepo) {
        await Promise.all(repos.map(async r => {
          try {
            const list = await rest<{ title: string; number: number }[]>(
              `repos/${r}/milestones?state=all&per_page=100`,
            );
            existingMs[r] = new Map(list.map(m => [m.title, m.number]));
          } catch {
            msFetchFailed.add(r);
            existingMs[r] = new Map();
          }
        }));
      }
      // repo full_name → phase index → milestone number
      const msNumbers: Record<string, Record<number, number>> = {};
      for (let pi = 0; pi < phases.length; pi++) {
        const ph = phases[pi];
        const id = `ms:${pi}`;
        if (noRepo) { upd(id, { status: "skipped", detail: "no repo linked" }); continue; }
        upd(id, { status: "running" });
        try {
          let created = 0, existed = 0, unverified = 0;
          for (const r of repos) {
            if (!msNumbers[r]) msNumbers[r] = {};
            if (msFetchFailed.has(r)) { unverified++; continue; } // couldn't verify — skip
            const existingNum = existingMs[r]?.get(ph.name);
            if (existingNum !== undefined) {
              msNumbers[r][pi] = existingNum;
              existed++;
              continue;
            }
            const ms = await post<{ number: number }>(`repos/${r}/milestones`, {
              title: ph.name, description: ph.description ?? "",
            });
            msNumbers[r][pi] = ms.number;
            created++;
          }
          const suffix = repos.length > 1 ? ` · ${repos.length} repos` : "";
          if (created === 0 && existed === 0 && unverified > 0) {
            upd(id, { status: "error", detail: `couldn't verify existing milestones — skipped${suffix}` });
          } else {
            const parts: string[] = [];
            if (created)    parts.push(`${created} created`);
            if (existed)    parts.push(`${existed} existed`);
            if (unverified) parts.push(`${unverified} unverified`);
            upd(id, {
              status: created === 0 ? "exists" : "created",
              detail: (parts.length ? parts.join(", ") : "already exists") + suffix,
            });
          }
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      // ── 4. Issues — generated from the FEATURES (one issue per feature, #plan-db): issues are
      //      never authored during planning, so publish is where they come into existence. Each is
      //      pinned to its milestone + added to the board. Falls back to one tracking issue per
      //      phase when there are no features. Idempotent. ──
      const planIssues = featuresToPlanIssues(parseFeaturesFile(sections.find(s => s.k === "features")?.content ?? ""));
      // Materialize them into the plan store too, so the fleet/director have issues to coordinate on
      // (the execution substrate) — publish populates the DB issues table from the DB features.
      for (const iss of planIssues) {
        await invoke("plan_upsert_issue", { projectKey: effectiveProjectId, issue: iss }).catch((e) => console.warn(`plan_upsert_issue ${iss.ref}: ${e}`));
      }
      const phaseNames = phases.map(p => p.name);
      for (const [repoIdx, fullName] of repos.entries()) {
        // Check what already exists BEFORE creating so a re-sync never duplicates.
        // Fail CLOSED: if we can't fetch the repo's issues, skip creating here.
        let existingTitles: string[];
        try {
          const existing = await rest<{ title: string }[]>(`repos/${fullName}/issues?state=all&per_page=100`);
          existingTitles = existing.map(i => i.title);
        } catch {
          if (planIssues.length) {
            for (const iss of planIssues) upd(`issue:${fullName}:${iss.ref}`, { status: "error", detail: "couldn't verify existing issues — skipped" });
          } else {
            for (let pi = 0; pi < phases.length; pi++) upd(`issue:${fullName}:${pi}`, { status: "error", detail: "couldn't verify existing issues — skipped" });
          }
          continue;
        }

        if (planIssues.length) {
          // Issues for THIS repo: its declared `repo`, or the default (first) repo.
          const mine = planIssues.filter(iss => iss.repo ? iss.repo === fullName : repoIdx === 0);
          // Ensure every label this repo uses exists (422 if present — harmless).
          // Provenance label first (#738) — every app-created issue carries it.
          await post(`repos/${fullName}/labels`, { name: BSC_ISSUE_LABEL, color: BSC_ISSUE_LABEL_COLOR }).catch(() => {});
          for (const name of [...new Set(mine.flatMap(iss => iss.labels))]) {
            await post(`repos/${fullName}/labels`, { name, color: "0e8a16" }).catch(() => {});
          }
          // ref → created GitHub node id, so feature parents + their sub-issues can be linked.
          const nodeByRef: Record<string, string> = {};
          for (const iss of mine) {
            const id = `issue:${fullName}:${iss.ref}`;
            if (existingTitles.includes(iss.title)) { upd(id, { status: "exists", detail: "already exists" }); continue; }
            upd(id, { status: "running" });
            try {
              const body: Record<string, unknown> = { title: iss.title, body: renderIssueBody(iss) };
              const phIdx = resolvePhaseIndex(iss.phase, phaseNames);
              const msNum = phIdx !== undefined ? msNumbers[fullName]?.[phIdx] : undefined;
              if (msNum !== undefined) body.milestone = msNum;
              body.labels = withProvenanceLabel(iss.labels); // provenance stamp (#738)
              const issue = await post<{ number: number; node_id: string; html_url: string }>(`repos/${fullName}/issues`, body);
              if (issue.node_id) nodeByRef[iss.ref] = issue.node_id;
              if (projectId && issue.node_id) {
                await gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`, { p: projectId, c: issue.node_id }).catch(() => {});
              }
              // Assign the issue to its owning stream's GitHub login (#847), defaulting to the
              // publishing account. Done as a follow-up POST AFTER the issue exists, so an
              // invalid / no-access login (a 422) is skipped gracefully and never loses the issue.
              const assignee = resolveIssueAssignee(iss.stream, fleet?.streams ?? [], viewerLogin);
              if (assignee) {
                await post(`repos/${fullName}/issues/${issue.number}/assignees`, { assignees: [assignee] }).catch(() => {});
              }
              upd(id, { status: "created", detail: `#${issue.number}`, url: issue.html_url });
            } catch (e) {
              upd(id, { status: "error", detail: String(e) });
            }
          }
          // Nest each feature's sub-issues under their parent (#…) via GraphQL addSubIssue.
          // Best-effort + idempotent: only links pairs created in THIS run; an already-linked
          // pair (or an API that doesn't support sub-issues) errors harmlessly.
          for (const { parent, child } of subIssueLinks(mine, nodeByRef)) {
            await gql(
              `mutation($p:ID!,$c:ID!){ addSubIssue(input:{issueId:$p,subIssueId:$c}){ issue { id } } }`,
              { p: parent, c: child },
            ).catch(() => {});
          }
          continue;
        }

        // Legacy fallback: one tracking issue per phase.
        await post(`repos/${fullName}/labels`, { name: BSC_ISSUE_LABEL, color: BSC_ISSUE_LABEL_COLOR }).catch(() => {}); // #738
        for (let pi = 0; pi < phases.length; pi++) {
          const ph    = phases[pi];
          const id    = `issue:${fullName}:${pi}`;
          const title = `[${ph.name}] ${projectTitle}`;
          const marker = `[${ph.name}]`;
          if (existingTitles.some(t => t.startsWith(marker))) {
            upd(id, { status: "exists", detail: "already exists" });
            continue;
          }
          upd(id, { status: "running" });
          try {
            const body: Record<string, unknown> = {
              title,
              body: `## ${ph.name}

${ph.description ?? ""}

---
_Auto-generated by base-studio-code planner._`,
              labels: [BSC_ISSUE_LABEL], // provenance stamp (#738)
            };
            const msNum = msNumbers[fullName]?.[pi];
            if (msNum !== undefined) body.milestone = msNum;
            const issue = await post<{ number: number; node_id: string; html_url: string }>(`repos/${fullName}/issues`, body);
            if (projectId && issue.node_id) {
              await gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`, { p: projectId, c: issue.node_id }).catch(() => {});
            }
            upd(id, { status: "created", detail: `#${issue.number}`, url: issue.html_url });
          } catch (e) {
            upd(id, { status: "error", detail: String(e) });
          }
        }
      }

      // ── 5. Stream labels — tag each fleet stream's owned issues with `stream:<id>`
      //      so ownership is visible on GitHub and the board. Ensure the label, then
      //      apply it to each owned issue resolvable by number. Idempotent. ───────
      for (const st of fleet?.streams ?? []) {
        const id    = `stream:${st.id}`;
        const label = `stream:${st.id}`;
        upd(id, { status: "running" });
        try {
          // Create the label (the request 422s if it already exists — harmless).
          await post(`repos/${st.repo}/labels`, { name: label, color: "5319e7" }).catch(() => {});
          const nums = st.issues
            .map(ref => parseInt(ref.replace(/[^0-9]/g, ""), 10))
            .filter(n => Number.isFinite(n) && n > 0);
          let applied = 0;
          for (const n of nums) {
            await post(`repos/${st.repo}/issues/${n}/labels`, { labels: [label] });
            applied++;
          }
          upd(id, applied > 0
            ? { status: "created", detail: `${applied} issue${applied === 1 ? "" : "s"} labeled` }
            : { status: "exists",  detail: "label ready · no numbered issues" });
        } catch (e) {
          upd(id, { status: "error", detail: String(e) });
        }
      }

      setPublishPhase(anyError ? "error" : "done");
    } catch (e) {
      console.error("publish failed", e);
      setPublishPhase("error");
    }
  }

  // GitHub → plan.db recovery (#plan-db). The mirror of handlePublish: pull each repo's
  // planner-published issues back into the plan store so a lost or machine-switched plan.db
  // rehydrates from the durable GitHub copy. Paginates issues (state=all), drops PRs, and upserts
  // each reconstructed PlanIssue (ref/dependsOn from the hidden marker, phase from the milestone,
  // stream from the label, status from open/closed). The 2s section poll reflects the DB afterward.
  async function handleRecover() {
    if (!githubToken || publishRepos.length === 0 || recovering) return;
    setRecovering(true);
    setTriageError(null);
    const token = githubToken;
    const rest = <T,>(path: string) => invoke<T>("github_request", { token, path });
    try {
      let total = 0;
      for (const repo of publishRepos) {
        const rows: GitHubIssueLike[] = [];
        for (let page = 1; page <= 20; page++) {
          const batch = await rest<GitHubIssueLike[]>(`repos/${repo}/issues?state=all&per_page=100&page=${page}`)
            .catch(() => [] as GitHubIssueLike[]);
          if (!batch || batch.length === 0) break;
          rows.push(...batch);
          if (batch.length < 100) break; // last page
        }
        for (const iss of recoverIssues(rows, repo)) {
          await invoke("plan_upsert_issue", { projectKey: effectiveProjectId, issue: iss }).catch(() => {});
          total++;
        }
      }
      setRecoverable(0);
      if (total === 0) setTriageError("recover — GitHub had no planner-published issues for these repos");
    } catch (e) {
      setTriageError(`recover failed — ${String(e)}`);
    } finally {
      setRecovering(false);
    }
  }

  // Offer recovery when the local plan.db is empty but GitHub holds planner-published issues (the
  // machine-switch / data-loss case). Probes the first repo for issues carrying the ref marker and
  // surfaces the banner; the recovery itself stays user-initiated.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!visible || !githubToken || publishRepos.length === 0) { setRecoverable(0); return; }
      const dbIssues = await invoke<PlanIssue[]>("plan_list_issues", { projectKey: effectiveProjectId })
        .catch(() => [] as PlanIssue[]);
      if (cancelled) return;
      if ((dbIssues?.length ?? 0) > 0) { setRecoverable(0); return; } // db already populated — nothing to recover
      const rows = await invoke<GitHubIssueLike[]>("github_request", {
        token: githubToken, path: `repos/${publishRepos[0]}/issues?state=all&per_page=100`,
      }).catch(() => [] as GitHubIssueLike[]);
      if (cancelled) return;
      // Count only planner-published issues — those with a ref marker (a recovered ref isn't "#<n>").
      setRecoverable(recoverIssues(rows ?? [], publishRepos[0]).filter((i) => !i.ref.startsWith("#")).length);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, githubToken, publishRepos.join(","), effectiveProjectId]);


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
                  <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600 }}>{activeProjectName}</h2>
                </>
              )
              : (
                <input
                  value={planningTitle}
                  onChange={e => setPlanningTitle(e.target.value)}
                  placeholder="project title…"
                  style={{
                    background: "none", border: "none", outline: "none",
                    fontFamily: "var(--mono)", fontSize: 16, fontWeight: 600,
                    color: planningTitle ? "var(--fg)" : "var(--fg-dim)",
                    width: Math.max(160, (planningTitle.length || 14) * 9 + 20),
                    minWidth: 160, maxWidth: 400,
                    padding: 0,
                  }}
                />
              )
            }
            <span className="tag amber">● {isExisting ? "expanding" : "drafting"}</span>
            {publishRepos.length === 1 && <span className="tag">{publishRepos[0]}</span>}
            {publishRepos.length > 1 && (
              <span className="tag" title={publishRepos.join("\n")}>{publishRepos.length} repos</span>
            )}
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
        <button className="btn ghost" onClick={() => setProjectsView("list")}>
          save & exit
        </button>
        <button className="btn ghost danger" onClick={() => setShowClearConfirm(true)} title="Wipe this project's plan and restart the planner (#664)">
          clear plan
        </button>
        {/* Greenfield → transform/harden lifecycle switch (#923). */}
        {canSwitch && (
          <button className="btn ghost" onClick={() => setSwitchOpen(true)} title="Move this project to a transform or harden lifecycle">
            switch lifecycle
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
              onLinkRepo={(repo) => addProjectRepo(effectiveProjectId, repo)}
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
                  // One-click stage approval: confirm every drafted section the active stage needs,
                  // then tell the planner in a single message. The gate re-evaluates and the
                  // selection re-follows to the next live phase (#807-followup).
                  if (focusFooter.kind === "approve-continue" && pendingConfirm.length > 0) {
                    confirmStageKeys(pendingConfirm);
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
          title="Switch lifecycle"
          onDismiss={() => setSwitchOpen(false)}
          actions={<button className="btn" onClick={() => setSwitchOpen(false)}>cancel</button>}
        >
          <div style={{ marginBottom: 12, color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
            Move this project on to a new lifecycle. This re-seeds the plan for the chosen lifecycle and
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
