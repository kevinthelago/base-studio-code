import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAppStore } from "../../store";
import { sanitizeProjectKey, resolveProjectKey } from "../../lib/projectPaths";
import { ensureGithubProject, canLaunchTriage, triageLockReason } from "../../lib/projectSync";
import { useDragResize } from "../../hooks/useDragResize";
import { buildGhStructure, parsePhases } from "./ghStructure";
import type { Section, SectionState, GhNode, GhRepoNode, GhStructure } from "./ghStructure";
import { buildProgressOverlay } from "./ghProgress";
import type { IssueState, MilestoneState, NodeProgress } from "./ghProgress";
import {
  parsePlanFocus, stripPlanFocus,
  parseStartupScripts, stripStartupScripts, scriptDocRelpath,
  parseAllowCommands, stripAllowCommands,
  parseAgentAssigns, stripAgentAssigns, parseFleetPlan, stripFleetPlan,
} from "./planningSession";
import { parseCommandsFile } from "../../lib/allowedCommands";
import { roleCapability, roleDeniedCommands, roleWriteRules } from "../../lib/sessionRoles";
import {
  ANCHOR_KEYS, SKIPPED_KEY, COMMANDS_KEY, FLEET_KEY, REPOS_KEY, SKILLS_KEY, parseReposFile, titleForKey, groupSections, parseSectionKey,
  parseFleetFile,
} from "./planSections";
import { parseSkillsFile } from "../../lib/skills";
import type { FlowAutonomy, FlowPush, FlowGate } from "./agentFlow";
import { parseIssuesFile, renderIssueBody, resolvePhaseIndex } from "./planIssues";
import { featureSectionsToIssues, featureSlug, parseFeatureSection } from "./planFeatures";
import { parseMcpAssigns, stripMcpAssigns, applyMcpAssign } from "./planExtensions";
import { ProjectPane, type SyncState } from "./ProjectPane";
import { buildProjectPaneData } from "./projectPaneData";

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


interface PlanningRepoCloneState {
  /** Full_names known to be cloned into the project hub. */
  clonedNames: string[];
  /** Full_names with a clone in flight. */
  cloning: Set<string>;
  /** Per-repo clone error message, keyed by full_name. */
  cloneErrors: Record<string, string>;
  /** Retry cloning every repo whose last attempt failed. */
  retryFailed: () => void;
}

/**
 * Auto-clone every linked repo into the app-managed project directory as soon as
 * it appears, reporting per-repo clone status. Headless — the planning header's
 * repo pill surfaces the state (and triggers {@link PlanningRepoCloneState.retryFailed}
 * on click). Idempotent: a repo already cloned or mid-clone is skipped, so it is
 * safe to call with the canonical `publishRepos` set on every render.
 */
function usePlanningRepoClone(projectId: string, repos: string[]): PlanningRepoCloneState {
  const projectLocalRepos = useAppStore(s => s.projectLocalRepos);
  const clonedNames = projectLocalRepos[projectId] ?? [];
  const [cloning, setCloning] = useState<Set<string>>(new Set());
  const [cloneErrors, setCloneErrors] = useState<Record<string, string>>({});
  // Ref guards against starting the same clone twice across renders.
  const cloningRef = useRef<Set<string>>(new Set());

  const clone = (fullName: string) => {
    cloningRef.current.add(fullName);
    setCloning(s => new Set([...s, fullName]));
    setCloneErrors(e => { const n = { ...e }; delete n[fullName]; return n; });
    invoke<string>("clone_repo", { project: projectId, fullName })
      .then(() => useAppStore.getState().addProjectRepo(projectId, fullName))
      .catch(e => setCloneErrors(prev => ({ ...prev, [fullName]: String(e) })))
      .finally(() => {
        cloningRef.current.delete(fullName);
        setCloning(s => { const n = new Set(s); n.delete(fullName); return n; });
      });
  };

  // Auto-clone as soon as a repo appears. Keyed on the joined repo set (not the
  // array identity) so a new repo_link / repos.json entry triggers a pass without
  // re-running every render — and a failed clone is left for explicit retry rather
  // than hammered each render.
  const repoKey = repos.join(",");
  useEffect(() => {
    if (!projectId) return;
    const currentCloned = new Set(useAppStore.getState().projectLocalRepos[projectId] ?? []);
    for (const fullName of repos) {
      if (!currentCloned.has(fullName) && !cloningRef.current.has(fullName)) clone(fullName);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, repoKey]);

  const retryFailed = () => {
    for (const r of repos) {
      if (cloneErrors[r] && !cloning.has(r)) clone(r);
    }
  };

  return { clonedNames, cloning, cloneErrors, retryFailed };
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

// A small {closed}/{total} counter plus a thin progress bar, matching the
// existing mono 9.5px detail styling. Rendered for rollup nodes (milestone /
// repo / project) that carry a `total`.
function ProgressMeter({ closed, total }: { closed: number; total: number }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, closed / total)) : 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ color: "var(--fg-dim)", fontSize: 9.5, fontFamily: "var(--mono)" }}>
        {closed}/{total}
      </span>
      <span style={{
        width: 36, height: 4, borderRadius: 2,
        background: "var(--border-soft)", overflow: "hidden", flexShrink: 0,
      }}>
        <span style={{
          display: "block", height: "100%",
          width: `${Math.round(frac * 100)}%`, background: "var(--accent)",
        }} />
      </span>
    </span>
  );
}

function GhItemRow({ node, state, progress }: { node: GhNode; state: GhItemState; progress?: NodeProgress }) {
  const g = GH_STATUS_GLYPH[state.status];
  // Live progression (#393 Layer 2) takes visual precedence over publish status:
  // a green check + dimmed label for done issues, an inline meter for rollups.
  const isDone = progress?.done === true;
  const hasMeter = progress?.total !== undefined && progress.total > 0;
  const icon  = isDone ? "✓" : g.icon;
  const color = isDone ? "var(--success)" : g.color;
  // Prefer the live issue link (#number) when the overlay carries one.
  const liveUrl = progress?.url;
  const liveNum = progress?.number;
  return (
    <div style={{
      display: "flex", alignItems: "baseline", gap: 8,
      fontFamily: "var(--mono)", fontSize: 10.5,
      opacity: state.status === "planned" && !progress ? 0.6 : 1,
    }}>
      <span style={{ width: 11, textAlign: "center", flexShrink: 0, color }}>{icon}</span>
      <span style={{
        color: state.status === "error" ? "var(--danger)" : isDone ? "var(--fg-dim)" : "var(--fg)",
        textDecoration: isDone ? "line-through" : "none",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>{node.label}</span>
      {hasMeter && <ProgressMeter closed={progress!.closed ?? 0} total={progress!.total!} />}
      {liveUrl && liveNum !== undefined ? (
        <a href={liveUrl} target="_blank" rel="noreferrer"
          style={{ color: "var(--fg-dim)", fontSize: 9.5, textDecoration: "none" }}
          title={liveUrl}>
          #{liveNum} ↗
        </a>
      ) : state.url ? (
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

function GhGroup({ title, count, nodes, status, progress, empty }: {
  title: string; count?: number; nodes: GhNode[]; status: GhStatusMap;
  progress: Record<string, NodeProgress>; empty?: string;
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
              <GhItemRow key={n.id} node={n} state={status[n.id] ?? { status: "planned" }} progress={progress[n.id]} />
            ))}
          </div>
        )
      }
    </div>
  );
}

// Repositories group: each repo row owns its phase tracking issues, indented
// beneath it with a connector so issue ownership is clear at a glance.
function GhReposGroup({ repos, status, progress }: {
  repos: GhRepoNode[]; status: GhStatusMap; progress: Record<string, NodeProgress>;
}) {
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
                <GhItemRow node={r.node} state={status[r.node.id] ?? { status: "planned" }} progress={progress[r.node.id]} />
                {r.issues.length > 0 && (
                  <div style={{
                    display: "flex", flexDirection: "column", gap: 2,
                    paddingLeft: 14, marginLeft: 5,
                    borderLeft: "1px solid var(--border-soft)",
                  }}>
                    {r.issues.map(iss => (
                      <GhItemRow key={iss.id} node={iss} state={status[iss.id] ?? { status: "planned" }} progress={progress[iss.id]} />
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

function GitHubStructureCard({ structure, status, progress }: {
  structure: GhStructure; status: GhStatusMap; progress: Record<string, NodeProgress>;
}) {
  // Overall rollup from the project node the overlay computes (matched issues
  // across every repo). Drives the small "{closed}/{total} issues done" summary.
  const overall = progress["project"];
  return (
    <div style={{
      padding: "12px 14px", borderRadius: 6,
      background: "color-mix(in oklch, var(--info), transparent 92%)",
      border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
      display: "flex", flexDirection: "column", gap: 12,
      flexShrink: 0,
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        color: "var(--info)", textTransform: "uppercase", letterSpacing: ".06em",
        fontFamily: "var(--mono)", fontSize: 10,
      }}>
        <span>github structure</span>
        {overall?.total !== undefined && overall.total > 0 && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            marginLeft: "auto", textTransform: "none", letterSpacing: 0,
          }}>
            <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>
              {overall.closed ?? 0}/{overall.total} issues done
            </span>
            <ProgressMeter closed={overall.closed ?? 0} total={overall.total} />
          </span>
        )}
      </div>
      <GhGroup title="Project board" nodes={[structure.project]} status={status} progress={progress} />
      <GhGroup title="Milestones" count={structure.milestones.length} nodes={structure.milestones} status={status} progress={progress}
        empty="defined by the Phases section" />
      <GhReposGroup repos={structure.repos} status={status} progress={progress} />
      {structure.streams.length > 0 && (
        <GhGroup
          title="Agents"
          count={structure.streams.length}
          nodes={structure.streams.map(s => ({ id: s.id, label: `${s.label} · stream:${s.id.replace(/^stream:/, "")}` }))}
          status={status}
          progress={progress}
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
    planFleet,
    projectKeyAlias,
    pinnedContext,
    setPlanAgentStreamPerm, setPlanAgentStreamPreset, setPlanAgentStreamFlow, setPlanAgentStreamStrategy,
    setPlanDirectorDrive,
    togglePinnedContext,
    addProjectRepo, fleetStartProject, removeDraftProject,
    agentProfiles,
    commands, schedules,
  } = useAppStore();

  // The session key (set once at session entry) is the single source of truth
  // for the planning directory, PTY slot, and plan buckets — identical to the
  // remount key in projects/index.tsx. It is frozen for the session, so the
  // publish flow assigning a GitHub Project id or a title edit cannot move the
  // working directory. The ref fallbacks keep older/in-flight sessions working.
  // Resolve through the alias so a project reached via the board (only
  // `activeProjectId` set = the GitHub node id) maps to the stable folder/data
  // key its plan files live under, instead of an empty node-id key.
  const rawSessionKey = planningSessionKey || activeProjectId || planningTitle || planningPitch;
  // One canonical resolver (#380) — the same helper everything per-project keys off, so
  // a write (addProjectRepo) and a later read (the linked-repo list) never diverge.
  const sessionKeyRef = useRef(resolveProjectKey(rawSessionKey, projectKeyAlias));
  const effectiveProjectId = sessionKeyRef.current;

  // Per-project PTY slot — mirrors the sanitize_project_key() logic in lib.rs so
  // the pane ID and the planning directory always correspond to the same project.
  const paneId = `planning_${effectiveProjectId.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)}`;

  // Prefer activeProjectRepos (populated from board items) but fall back to
  // any previously-cloned repos for this project if the board hasn't loaded yet.
  const effectiveRepos: string[] = activeProjectId
    ? (activeProjectRepos.length > 0
        ? activeProjectRepos
        // Fall back to the canonical (alias-resolved) key, never the raw node id, so reads
        // and writes can't land on divergent projectLocalRepos entries (#380).
        : (projectLocalRepos[effectiveProjectId] ?? []))
    : [];

  // Full_names that are both linked to this project and known to be cloned.
  const linkedRepos: string[] =
    (projectLocalRepos[effectiveProjectId] ?? []).filter(r =>
      effectiveRepos.includes(r)
    );

  // Repos surfaced by <repo_link> tags emitted by Claude during this session.
  const [repoLinkFullNames, setRepoLinkFullNames] = useState<string[]>([]);

  const isExisting = !!activeProjectId;

  // Canonical set of repos for publish/sync — union of project-linked repos,
  // Claude-surfaced repo_link tags, and the store's planningRepo fallback.
  // Feeds both handlePublish and the GitHubStructureCard.
  const publishRepos = [...new Set([
    ...effectiveRepos,
    // The planner's repos.json — the persistent, resume-safe repo registration (a
    // resumed session can't replay a stream-only <repo_link> tag, but it can write this
    // file). This is what makes the right pane reliably show repos across reloads.
    ...parseReposFile((planSections[effectiveProjectId] ?? {})[REPOS_KEY] ?? ""),
    // Repos the planner linked + auto-cloned this project, persisted under the planning
    // session key. effectiveRepos keys off the GitHub board id (empty for a not-yet-published
    // project), so without this the visualizer/publish lose planner-linked repos on reload.
    ...(projectLocalRepos[effectiveProjectId] ?? []),
    ...repoLinkFullNames,
    ...(planningRepo ? [planningRepo] : []),
  ])].filter(Boolean);

  // Auto-clone the canonical repo set into the project hub as it grows; the header
  // repo pill surfaces the per-repo clone status (hover for the list, click to retry).
  const { clonedNames, cloning: cloningRepos, cloneErrors, retryFailed } =
    usePlanningRepoClone(effectiveProjectId, publishRepos);

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

  const sections = useMemo<Section[]>(() => {
    const keys = new Set<string>(ANCHOR_KEYS);
    for (const k of Object.keys(savedSections)) {
      if (k !== SKIPPED_KEY && k !== COMMANDS_KEY && k !== FLEET_KEY && k !== REPOS_KEY && k !== SKILLS_KEY) keys.add(k);
    }
    const { project, repos } = groupSections([...keys]);
    const ordered = [...project, ...repos.flatMap(r => r.keys)];
    return ordered.map(k => {
      const content = savedSections[k] ?? "";
      const state: SectionState = confirmedSet.has(k) ? "confirmed" : (content ? "drafted" : "pending");
      // A per-repo feature section (#177) shows its parsed feature title (the section's
      // heading, else the humanized slug) instead of the raw `feat__slug` topic.
      const slug = featureSlug(k);
      const title = slug ? parseFeatureSection(content, slug).title : titleForKey(k);
      return { k, title, state, content };
    });
  }, [savedSections, confirmedSet]);

  // Tier grouping for rendering, plus a key→section lookup.
  const sectionByKey = useMemo(() => new Map(sections.map(s => [s.k, s])), [sections]);
  const { project: projectKeys, repos: repoGroups } =
    useMemo(() => groupSections(sections.map(s => s.k)), [sections]);
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

  // Sync skills.json (the planner's CRUD channel into the global Skills library —
  // surfaced by the poll like commands.json/fleet.json). Upsert by id/name-slug so
  // a re-emitted definition refines in place. Runs only when the file changes.
  const skillsSyncedRef = useRef("");
  useEffect(() => {
    const raw = savedSections[SKILLS_KEY] ?? "";
    if (raw === skillsSyncedRef.current) return;
    skillsSyncedRef.current = raw;
    const defs = parseSkillsFile(raw);
    if (defs.length) useAppStore.getState().upsertSkills(defs);
  }, [savedSections]);

  // Title + derived GitHub object graph that the structure card renders and the
  // publish flow fills in. Kept in sync with handlePublish's own derivation.
  const goalForTitle = sections.find(s => s.k === "goal")?.content ?? "";
  const projectTitle = planningTitle || goalForTitle.split(/[.!?\n]/)[0].trim() || activeProjectName || "New project";

  // Per-repo feature plans (#177): each `repo__{short}__feat__{slug}` section becomes a
  // synthetic granular issue, so it flows through the existing structure + publish
  // machinery (one GitHub issue per feature, pinned to its phase milestone) — supplementing
  // the per-phase tracking issues. Fold them into the `issues` section the builder reads.
  const featureIssues = useMemo(
    () => featureSectionsToIssues(sections, publishRepos),
    [sections, publishRepos],
  );
  const sectionsForGh = useMemo<Section[]>(() => {
    if (featureIssues.length === 0) return sections;
    const existing = parseIssuesFile(sections.find(s => s.k === "issues")?.content ?? "");
    const merged = JSON.stringify([...existing, ...featureIssues]);
    return [
      ...sections.filter(s => s.k !== "issues"),
      { k: "issues", title: titleForKey("issues"), state: "drafted" as SectionState, content: merged },
    ];
  }, [sections, featureIssues]);

  const ghStructure  = buildGhStructure(sectionsForGh, publishRepos, projectTitle, planFleet[effectiveProjectId]);

  // Live status of each GitHub object, keyed by the ids in buildGhStructure.
  const [ghStatus, setGhStatus] = useState<GhStatusMap>({});
  // Live issue-progression overlay (#393 Layer 2): node id -> NodeProgress
  // reflecting what's actually CLOSED/done on GitHub for a published project.
  // Declared before paneData so the memo below can fold it into the pane data.
  const [ghProgress, setGhProgress] = useState<Record<string, NodeProgress>>({});

  // Real plan data for the ProjectPane (#: wire-in). Maps the fleet, agent
  // profiles, decomposed issues, phases, repos, and sections into the pane's
  // render shapes; the pane falls back to its sample data when this is empty.
  const paneData = useMemo(
    () => buildProjectPaneData({
      fleet:    planFleet[effectiveProjectId],
      profiles: agentProfiles,
      // Hand-authored issues plus the per-repo feature sections (#177) so the pane's
      // issue list matches the structure card and what publish creates.
      issues:   [...parseIssuesFile(sections.find(sec => sec.k === "issues")?.content ?? ""), ...featureIssues],
      phases:   parsePhases(sections.find(sec => sec.k === "phases")?.content ?? ""),
      repos:    publishRepos,
      sections,
      pinned:   pinnedContext[effectiveProjectId],
      // Live GitHub progression (#393 Layer 2) so the always-visible ProjectPane
      // shows real milestone/issue percentages — not 0% — for a published project
      // (#429). Same overlay the publish-time GitHubStructureCard renders.
      progress: ghProgress,
    }),
    [planFleet, effectiveProjectId, agentProfiles, sections, featureIssues, publishRepos, pinnedContext, ghProgress],
  );
  const [restarting, setRestarting] = useState(false);

  const [labelsSync, setLabelsSync] = useState<SyncState>("idle");
  const [triaging, setTriaging] = useState(false);
  type PublishPhase = "idle" | "running" | "done" | "error";
  const [publishPhase, setPublishPhase] = useState<PublishPhase>("idle");

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
  // Tracks whether the auto-send of the initial pitch has fired this session
  const initSentRef    = useRef(false);
  const initSendTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  const confirmedCount     = sections.filter(s => s.state === "confirmed").length;

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

        // Quote-flexible helper: matches " U+0022, " U+201C, " U+201D so LLM
        // smart-quote output doesn't silently break tag detection.
        // q(s) wraps a string in a char-class that matches any of those three.
        const Q = '["“”]';

        let m: RegExpExecArray | null;

        // ── <plan_update section="key">content</plan_update> ─────────────────
        const planRe = new RegExp(
          `<plan_update\\s+section=${Q}(\\w+)${Q}\\s*>([\\s\\S]*?)<\\/plan_update>`,
          'g'
        );
        let foundPlan = false;
        while ((m = planRe.exec(bufRef.current)) !== null) {
          const key     = m[1];
          const content = m[2].trim();
          // Any \w+ key is a valid section (dynamic planner). Persist to the
          // store unless the user already confirmed it — confirmed sections are
          // frozen. The derived `sections`/`skipped` pick the change up on the
          // next render. Read confirmed state fresh (this listener is created
          // once at mount, so a captured set would go stale).
          const confirmed = new Set(useAppStore.getState().planConfirmedSections[projIdSnap] ?? []);
          if (!confirmed.has(key)) {
            useAppStore.getState().setPlanSection(projIdSnap, key, content);
          }
          foundPlan = true;
        }
        if (foundPlan) {
          bufRef.current = bufRef.current.replace(
            new RegExp(`<plan_update\\s+section=${Q}\\w+${Q}\\s*>[\\s\\S]*?<\\/plan_update>`, 'g'),
            ""
          );
        }

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
          // usePlanningRepoClone auto-clones when the repo set grows — no action needed here.
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

        // ── <mcp_assign name="Postgres" /> (#174) ─────────────────────────────
        // Assign an MCP server/extension to this project. Reuses the Extensions
        // subsystem: each assignment adds/enables a catalog-derived ExtensionDef
        // scoped to this project, so the existing resolveExtensions → paneExtensions
        // → .mcp.json launch wiring loads it into every build/triage session (no new
        // store slice). Idempotent — re-emitting the same name just re-scopes it.
        const mcpNames = parseMcpAssigns(bufRef.current);
        if (mcpNames.length > 0) {
          for (const name of mcpNames) {
            applyMcpAssign(useAppStore.getState(), name, projIdSnap);
          }
          bufRef.current = stripMcpAssigns(bufRef.current);
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
          store.setPlanFleetMeta(projIdSnap, fleetMeta.recommended, fleetMeta.reasoning, fleetMeta.strategy);
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
        },
      ).catch((e: unknown) => {
        console.error("workspace setup failed:", e);
        return null;
      });

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
      await invoke("ensure_session_settings", {
        cwd:             paths?.planning_dir ?? "",
        allowedCommands: [],
        deniedCommands:  roleDeniedCommands(plannerCap),
        mcpServers:      null,
        hooks:           null,
        allowToolRules:  plannerWrite.allow,
        denyToolRules:   plannerWrite.deny,
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
  useEffect(() => {
    if (!visible) return;

    const poll = async () => {
      try {
        const result = await invoke<Record<string, string>>("read_plan_sections", { projectKey: effectiveProjectId });
        const entries = Object.entries(result);
        if (entries.length === 0) return;

        const store = useAppStore.getState();
        const saved = store.planSections[effectiveProjectId] ?? {};
        const confirmed = new Set(store.planConfirmedSections[effectiveProjectId] ?? []);

        for (const [key, content] of entries) {
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

  // Live issue-progression overlay (#393 Layer 2). For an already-published
  // project, fetch each repo's GitHub issues + milestone counts and build a
  // node-id -> NodeProgress overlay (done checkmarks, milestone/repo/project
  // rollups) the structure card renders. Polls on a light 30s interval while
  // visible. Cancellation-safe; failed repos are skipped, never fatal.
  // The dep signature is derived from the structure (repo names + milestone +
  // issue node labels) so the effect re-subscribes only when the plan changes,
  // not on every render (ghStructure is a fresh object each pass).
  const ghStructSig = JSON.stringify({
    repos: ghStructure.repos.map(r => [r.node.label, r.issues.map(i => i.label)]),
    ms: ghStructure.milestones.map(m => m.label),
  });
  useEffect(() => {
    const token = useAppStore.getState().githubToken;
    // Skip (and leave whatever overlay is already shown) when there is nothing
    // to fetch for: no linked repos, or no token. NOT gated on isExisting — a
    // project's issues live on its repos whether or not it was opened as a board
    // project, so we resync progress on every page-open (the `visible` dep) as
    // long as there are repos to query. The async refresh below is the only path
    // that calls setGhProgress, so the effect body never cascades a render.
    if (ghStructure.repos.length === 0 || !token) return;
    let cancelled = false;

    const rest = <T,>(path: string) =>
      invoke<T>("github_request", { token, path }).catch(() => null) as Promise<T | null>;

    type GhIssue = {
      title: string; state: string; number: number; html_url: string;
      milestone: { title: string } | null; pull_request?: unknown;
    };
    type GhMilestone = { title: string; open_issues: number; closed_issues: number };

    const refresh = async () => {
      const issuesByRepo: Record<string, IssueState[]> = {};
      const milestonesByRepo: Record<string, MilestoneState[]> = {};
      await Promise.all(ghStructure.repos.map(async repo => {
        const fullName = repo.node.label;
        const [issues, milestones] = await Promise.all([
          rest<GhIssue[]>(`repos/${fullName}/issues?state=all&per_page=100`),
          rest<GhMilestone[]>(`repos/${fullName}/milestones?state=all&per_page=100`),
        ]);
        if (Array.isArray(issues)) {
          issuesByRepo[fullName] = issues
            // GitHub returns PRs in the issues list; the `pull_request` field
            // marks them. Skip so only real issues map to structure nodes.
            .filter(it => !it.pull_request)
            .map(it => ({
              title: it.title,
              state: it.state === "closed" ? "closed" : "open",
              number: it.number,
              url: it.html_url,
              milestone: it.milestone?.title ?? null,
            }));
        }
        if (Array.isArray(milestones)) {
          milestonesByRepo[fullName] = milestones.map(m => ({
            title: m.title,
            open: m.open_issues ?? 0,
            closed: m.closed_issues ?? 0,
          }));
        }
      }));
      if (cancelled) return;
      // Persisted plan-issue -> GitHub-issue links (#393 Layer 1); read fresh so
      // the overlay matches each node to its exact issue NUMBER (title-drift safe).
      const links = useAppStore.getState().issueLinks[effectiveProjectId];
      setGhProgress(buildProgressOverlay(ghStructure, issuesByRepo, milestonesByRepo, links));
    };

    refresh();
    const id = setInterval(() => { if (visible) refresh(); }, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  // ghStructSig captures the parts of ghStructure the overlay keys off, so the
  // effect re-runs when the plan changes without depending on the object identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ghStructSig]);


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
    }).catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedRepos]);


  async function handleRestart() {
    const term = termRef.current;
    if (!term || restarting) return;
    setRestarting(true);
    bufRef.current = "";
    term.clear();
    await invoke("pty_kill", { paneId: paneId }).catch(console.error);
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
      },
    ).catch((e: unknown) => { console.error("restart setup failed:", e); return null; });
    const token = store.githubToken;
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

  // Agents → ensure each fleet stream's `stream:<id>` label exists in every repo.
  async function handleSyncLabels() {
    if (!githubToken || publishRepos.length === 0) return;
    const streams = planFleet[effectiveProjectId]?.streams ?? [];
    if (streams.length === 0) { setLabelsSync("error"); return; }
    const token = githubToken;
    setLabelsSync("running");
    try {
      const post = (path: string, body: unknown) => invoke("github_post", { token, path, body });
      for (const repo of publishRepos) {
        for (const st of streams) {
          // Idempotent: GitHub 422s when the label already exists — ignore it.
          await post(`repos/${repo}/labels`, { name: `stream:${st.id}`, color: "5319e7" }).catch(() => {});
        }
      }
      setLabelsSync("done");
    } catch (e) {
      console.error("sync labels failed:", e);
      setLabelsSync("error");
    }
  }

  // Header button → clone the repos and launch the planned agent fleet (recommended workers + director).
  async function launchTriage() {
    const fleet = planFleet[effectiveProjectId];
    // Mirror the button's gate (#444) so a programmatic / Enter-key path can't launch
    // triage against an unpublished project (no board, no issues to triage).
    if (!canLaunchTriage({
      published: !!activeProjectId,
      hasRepos: publishRepos.length > 0,
      hasFleet: !!fleet && fleet.streams.length > 0,
      busy: triaging,
    })) return;
    setTriaging(true);
    try {
      await Promise.all(publishRepos.map(fullName =>
        invoke<string>("clone_repo", { project: effectiveProjectId, fullName })
          .then(() => addProjectRepo(effectiveProjectId, fullName))
          .catch(e => console.error(`clone ${fullName} failed:`, e)),
      ));
      // Materialize any unassigned / dangling-reference agent profiles before
      // launch so each worker gets its least-privilege profile (#358), then read
      // the fleet back with the now-assigned profile ids.
      useAppStore.getState().generateFleetProfiles(effectiveProjectId);
      const launchPlan = useAppStore.getState().planFleet[effectiveProjectId] ?? fleet;
      // Create each worker's git worktree (idempotent) before the panes spawn,
      // so every agent's cwd exists and it starts in its own checkout+branch.
      // Without this the worktree-based cwd does not exist and the agent lands
      // in a fallback dir (#359).
      await Promise.all(launchPlan.streams.map(st =>
        invoke<string>("ensure_worktree", { projectKey: effectiveProjectId, repo: st.repo, agentId: st.id })
          .catch(e => console.error(`worktree ${st.id} failed:`, e)),
      ));
      // Give the director its standing protocol at the hub (#375) so it answers worker
      // questions via bsc-answer and merges green PRs.
      if (launchPlan.director.enabled) {
        await invoke("ensure_director_protocol", { projectKey: effectiveProjectId })
          .catch(e => console.error("director protocol failed:", e));
      }
      fleetStartProject(projectTitle, launchPlan, effectiveProjectId);
    } catch (e) {
      console.error("fleet launch failed:", e);
    } finally {
      setTriaging(false);
    }
  }

  // Publish the plan to GitHub: repositories → project board → milestones →
  // issues. Every step is idempotent (check-then-create) so re-running acts as a
  // sync. Status is reported through ghStatus, keyed by the buildGhStructure ids,
  // so the GitHubStructureCard reflects each object as it is created.
  async function handlePublish() {
    if (!githubToken || publishRepos.length === 0) return;
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

      // ── 2. Project board — link existing, ADOPT a same-title board, or create ──
      // Routes through ensureGithubProject so a re-sync of an unlinked but already-
      // published project adopts its board instead of minting a duplicate (#444).
      let projectId = activeProjectId;
      {
        const id = "project";
        upd(id, { status: "running" });
        try {
          const ownerLogin = repos[0]?.split("/")[0] || viewerLogin;
          if (!ownerLogin) throw new Error("no owner to create project under");
          const res = await ensureGithubProject(gql, { activeProjectId, ownerLogin, title: projectTitle });
          projectId = res.id;
          if (res.action === "linked") {
            upd(id, { status: "exists", detail: activeProjectNumber ? `#${activeProjectNumber}` : "linked" });
          } else {
            // Adopted an existing same-title board, or created a fresh one — reflect in
            // the store so the projects list + future syncs treat it as existing.
            useAppStore.getState().setActiveProjectMeta(res.id, projectTitle, repos[0] ?? "", res.number, repos);
            upd(id, {
              status: res.action === "adopted" ? "exists" : "created",
              detail: `#${res.number}`,
              url: res.url,
            });
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

      // ── 4. Issues — one GitHub issue per granular PlanIssue (#311), pinned to its
      //      milestone and added to the board, with its labels. Falls back to one
      //      tracking issue per phase when the planner defined none. Idempotent. ──
      // Granular issues authored in issues.json PLUS one synthetic issue per per-repo
      // feature section (#177) — both publish through the same path below.
      const planIssues = [
        ...parseIssuesFile(sections.find(s => s.k === "issues")?.content ?? ""),
        ...featureSectionsToIssues(sections, repos),
      ];
      const phaseNames = phases.map(p => p.name);
      // Persisted plan-issue -> GitHub-issue linkage (#393 Layer 1): structure
      // node id -> { number, url }. Accumulated across all repos, saved once below.
      const linkMap: Record<string, { number: number; url: string }> = {};
      for (const [repoIdx, fullName] of repos.entries()) {
        // Check what already exists BEFORE creating so a re-sync never duplicates.
        // Fail CLOSED: if we can't fetch the repo's issues, skip creating here.
        let existingTitles: string[];
        // title -> { number, url } for the issues already on this repo, so an
        // "already exists" issue can still be linked (#393) by its real number.
        const byTitle = new Map<string, { number: number; url: string }>();
        try {
          const existing = await rest<{ title: string; number: number; html_url: string }[]>(`repos/${fullName}/issues?state=all&per_page=100`);
          existingTitles = existing.map(i => i.title);
          for (const i of existing) byTitle.set(i.title, { number: i.number, url: i.html_url });
        } catch {
          // Fail closed: index every plan issue for THIS repo by its node id so the
          // error surfaces on the right node (granular nodes use `ref ?? idx`).
          if (planIssues.length) {
            const mineFail = planIssues.filter(iss => iss.repo ? iss.repo === fullName : repoIdx === 0);
            for (const [idx, iss] of mineFail.entries()) upd(`issue:${fullName}:${iss.ref ?? idx}`, { status: "error", detail: "couldn't verify existing issues — skipped" });
          } else {
            for (let pi = 0; pi < phases.length; pi++) upd(`issue:${fullName}:${pi}`, { status: "error", detail: "couldn't verify existing issues — skipped" });
          }
          continue;
        }

        if (planIssues.length) {
          // Issues for THIS repo: its declared `repo`, or the default (first) repo.
          const mine = planIssues.filter(iss => iss.repo ? iss.repo === fullName : repoIdx === 0);
          // Ensure every label this repo uses exists (422 if present — harmless).
          for (const name of [...new Set(mine.flatMap(iss => iss.labels))]) {
            await post(`repos/${fullName}/labels`, { name, color: "0e8a16" }).catch(() => {});
          }
          for (const [idx, iss] of mine.entries()) {
            const nodeId = `issue:${fullName}:${iss.ref ?? idx}`;
            if (existingTitles.includes(iss.title)) {
              upd(nodeId, { status: "exists", detail: "already exists" });
              // Link to the existing issue (matched by title) so the overlay can
              // track it by number even if the plan title later drifts.
              const hit = byTitle.get(iss.title);
              if (hit) linkMap[nodeId] = { number: hit.number, url: hit.url };
              continue;
            }
            upd(nodeId, { status: "running" });
            try {
              const body: Record<string, unknown> = { title: iss.title, body: renderIssueBody(iss) };
              const phIdx = resolvePhaseIndex(iss.phase, phaseNames);
              const msNum = phIdx !== undefined ? msNumbers[fullName]?.[phIdx] : undefined;
              if (msNum !== undefined) body.milestone = msNum;
              if (iss.labels.length) body.labels = iss.labels;
              const issue = await post<{ number: number; node_id: string; html_url: string }>(`repos/${fullName}/issues`, body);
              if (projectId && issue.node_id) {
                await gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`, { p: projectId, c: issue.node_id }).catch(() => {});
              }
              linkMap[nodeId] = { number: issue.number, url: issue.html_url };
              upd(nodeId, { status: "created", detail: `#${issue.number}`, url: issue.html_url });
            } catch (e) {
              upd(nodeId, { status: "error", detail: String(e) });
            }
          }
          continue;
        }

        // Legacy fallback: one tracking issue per phase.
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

      // Persist the plan-issue -> GitHub-issue linkage (#393 Layer 1) so the
      // progress overlay can track each node by its real issue number.
      //
      // #393 Layer 3 (plan-edit -> GitHub write-sync) is satisfied today by the
      // *documented allowed-commands flow*, not an in-app PATCH button: with this
      // linkage persisted (node id -> {number,url}), a director/Claude session that
      // has the `gh` write commands permitted reads the plan and pushes edits to the
      // linked issues -- e.g. `gh issue edit <number> --title/--body/--add-label
      // --milestone`, or `gh api -X PATCH repos/{repo}/issues/{number}` -- to bring
      // each GitHub issue back in line with the plan (this is how the board is kept
      // current). A dedicated in-app "Sync plan -> GitHub" action (confirm + dry-run
      // diff + conflict handling) is deferred to a post-0.9.4 follow-up, since it
      // MUTATES live issues and warrants its own scope + review.
      if (Object.keys(linkMap).length) {
        useAppStore.getState().setIssueLinks(effectiveProjectId, linkMap);
      }

      // Published: the draft is now a real GitHub project — promote it out of drafts (#379).
      if (!anyError) removeDraftProject(effectiveProjectId);
      setPublishPhase(anyError ? "error" : "done");
    } catch (e) {
      console.error("publish failed", e);
      setPublishPhase("error");
    }
  }


  return (
    <>
      {/* Section progress — tucked under the window bar: the pill segments are
          twice as tall as the clipping strip and pulled up by half, so only their
          bottom rounded half shows, reading as if they emerge from beneath the
          titlebar. Project tier first, then a divider and each repo's tier so the
          per-repo dynamic sections are visibly accounted for. */}
      <div style={{ height: 6, overflow: "hidden", display: "flex", gap: 6, padding: "0 24px", alignItems: "flex-start", flex: "0 0 auto" }}>
        {(() => {
          const seg = (k: string) => {
            const s = sectionByKey.get(k);
            const tone = s?.state === "confirmed" ? "var(--accent)"
                       : s?.state === "drafted"   ? "color-mix(in oklch, var(--accent), transparent 50%)"
                       : "var(--bg-elev2)";
            const info = parseSectionKey(k);
            const label = info.tier === "repo" ? `${info.repo} · ${titleForKey(k)}` : titleForKey(k);
            return <div key={k} style={{ flex: 1, height: 12, marginTop: -6, borderRadius: 6, background: tone }} title={label} />;
          };
          const divider = (id: string) => (
            <div key={id} title="per-repo sections"
              style={{ flex: "0 0 auto", width: 2, height: 12, marginTop: -6, borderRadius: 1, background: "var(--border)" }} />
          );
          return [
            ...projectKeys.map(seg),
            ...repoGroups.flatMap(g => [divider(`div-${g.repo}`), ...g.keys.map(seg)]),
          ];
        })()}
      </div>

      {/* Header */}
      <div style={{ padding: "12px 24px 0", display: "flex", alignItems: "flex-start", gap: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <button
              onClick={() => setProjectsView("list")}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
                padding: 0, marginRight: 4,
              }}
            >{isExisting ? "← board" : "← projects"}</button>
            <span style={{ color: "var(--border-soft)" }}>·</span>
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
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>
              {confirmedCount}/{sections.length} sections confirmed
            </span>
            <span className="tag amber">● {isExisting ? "expanding" : "drafting"}</span>
            {publishRepos.length > 0 && (() => {
              const clonedSet = new Set(clonedNames);
              const clonedCount = publishRepos.filter(r => clonedSet.has(r)).length;
              const failed = publishRepos.filter(r => cloneErrors[r] && !cloningRepos.has(r));
              const allCloned = clonedCount === publishRepos.length;
              const n = publishRepos.length;
              const noun = `repo${n === 1 ? "" : "s"}`;
              const label =
                failed.length > 0 ? `${n} ${noun} · clone failed`
                : cloningRepos.size > 0 ? `${n} ${noun} · cloning…`
                : allCloned ? `${n} cloned ${noun}`
                : clonedCount > 0 ? `${clonedCount}/${n} cloned`
                : `${n} ${noun}`;
              // Hover lists every repo with its clone status (replaces the old strip list).
              const tip = publishRepos.map(r =>
                `${r}  —  ${clonedSet.has(r) ? "cloned" : cloningRepos.has(r) ? "cloning…" : cloneErrors[r] ? "clone failed" : "not cloned"}`
              ).join("\n");
              return (
                <span
                  className="tag"
                  title={tip + (failed.length ? "\n\nclick to retry failed" : "")}
                  onClick={failed.length ? retryFailed : undefined}
                  style={{
                    cursor: failed.length ? "pointer" : "default",
                    color: failed.length ? "var(--danger)" : allCloned ? "var(--success)" : undefined,
                    borderColor: failed.length ? "var(--danger)" : undefined,
                  }}
                >{label}</span>
              );
            })()}
            {publishRepos.length === 0 && (
              <span className="tag" title="Ask Claude to create or link repositories"
                style={{ color: "var(--fg-dim)", opacity: 0.7 }}>no repos linked</span>
            )}
          </div>
        </div>
        <button className="btn ghost" onClick={() => setProjectsView("list")}>
          save & exit
        </button>
        <button
          className="btn ghost"
          onClick={handlePublish}
          disabled={publishPhase === "running" || !githubToken || publishRepos.length === 0}
          title={!githubToken ? "Sign in to GitHub first" : publishRepos.length === 0 ? "Link a repo first"
            : isExisting ? "Sync this plan to the existing GitHub project (milestones + issues)"
            : "Create the GitHub project, milestones, and issues from this draft"}
        >
          {publishPhase === "running"
            ? (isExisting ? "syncing…" : "creating…")
            : (isExisting ? "Sync to GitHub" : "Create project")}
        </button>
        {(() => {
          // Lock triage until the project is published (#444): no board ⇒ no issues to triage.
          const gate = {
            published: !!activeProjectId,
            hasRepos: publishRepos.length > 0,
            hasFleet: !!planFleet[effectiveProjectId]?.streams.length,
            busy: triaging,
          };
          const lock = triageLockReason(gate);
          return (
            <button
              className="btn primary"
              onClick={launchTriage}
              disabled={!canLaunchTriage(gate)}
              title={lock ?? "Clone the repos and start a triage session"}
            >
              {triaging ? "starting triage…" : "Triage →"}
            </button>
          );
        })()}
      </div>

      {/* Split panel */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden", borderTop: "1px solid var(--border-soft)" }}>
        {/* Claude CLI terminal */}
        <section style={{ flex: "1 1 0", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", borderRight: "1px solid var(--border-soft)" }}>
          <div style={{
            padding: "10px 18px", background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex", alignItems: "center", gap: 8,
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
          }}>
            <span style={{ color: "var(--accent)" }}>▸ planning session</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: "var(--fg-dim)" }}>
              emit{" "}
              <code style={{ color: "var(--fg)", background: "var(--bg-elev)", padding: "0 4px", borderRadius: 3 }}>
                &lt;plan_update section="goal"&gt;…&lt;/plan_update&gt;
              </code>
              {" "}to populate sections →
            </span>
            <button
              onClick={handleRestart}
              disabled={restarting}
              style={{
                padding: "2px 8px", borderRadius: 3, cursor: restarting ? "not-allowed" : "pointer",
                background: "transparent", border: "1px solid var(--border-soft)",
                color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10,
                opacity: restarting ? 0.5 : 1,
              }}
            >{restarting ? "restarting…" : "↺ restart"}</button>
          </div>


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
              projectName={projectTitle}
              projectId={effectiveProjectId}
              onPerm={(id, perm) => setPlanAgentStreamPerm(effectiveProjectId, id, perm)}
              onPreset={(id, preset, perm) => setPlanAgentStreamPreset(effectiveProjectId, id, preset, perm)}
              onFlow={(id, f) => setPlanAgentStreamFlow(effectiveProjectId, id, {
                autonomy: f.autonomy as FlowAutonomy,
                push: (f.push === "auto-PR" ? "auto-pr" : f.push) as FlowPush,
                gate: f.gate as FlowGate,
              })}
              onStrategy={(id, strategy) => setPlanAgentStreamStrategy(effectiveProjectId, id, strategy)}
              onTogglePin={(name) => togglePinnedContext(effectiveProjectId, name)}
              onDirectorDrive={(drive) => setPlanDirectorDrive(effectiveProjectId, drive)}
              onSyncLabels={githubToken && publishRepos.length > 0 ? handleSyncLabels : undefined}
              syncState={{ labels: labelsSync }}
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
                <GitHubStructureCard structure={ghStructure} status={ghStatus} progress={ghProgress} />
              </div>
            </>
          )}
        </aside>
      </div>
    </>
  );
}
