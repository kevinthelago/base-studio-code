// projectPaneData -- maps the real plan store (fleet streams, agent profiles,
// decomposed issues, sections, linked repos) into the shapes the
// ProjectPane (v2) renders. Pure (no React / Tauri) so the mapping is unit-testable,
// keeping the pane a dumb view. ProjectPane re-imports these interfaces, so this
// module is the single source of truth for the pane data contract; the pane
// falls back to its own sample consts when a project has none of this yet.

import type { AgentProfile, Tier, ToolKey } from "@/features/agents/lib/agentProfiles";
import type { FleetPlan, AgentStream } from "../fleet/planFleet";
import type { AgentRelationship } from "../relationship/relationshipGraph";
import type { PlanIssue } from "../issues/planIssues";
import type { Section } from "../github/ghStructure";
import type { NodeProgress } from "../github/ghProgress";
import { resolveFlow } from "../fleet/agentFlow";
import { resolveDirectorDrive } from "../fleet/directorDrive";

// The render-shape contract lives in projectPane.types (#356, the shared pane
// types). This adapter imports those shapes and re-exports them so existing
// import sites that reach for them via "./projectPaneData" keep working.
import type {
  Posture, Perm, Agent, Repo, Issue, Milestone, ContextFile, ProjectPaneData,
  PaneAutomation, PaneSkill,
} from "./projectPane.types";
import type { PlanFeature } from "../issues/featureList";
import type { Blueprint } from "../stages/blueprints";
import type { DeployConfig } from "../lib/deployConfig";
import type { PlanDependency, DependencyRegistry } from "../issues/dependencies";
import { buildMcpServers, type McpInstallState } from "../lib/mcpPaneData";
import type { McpServer as McpServerDef } from "@/features/mcp/lib/mcpServers";

export type {
  Posture, Perm, Flow, Agent, RepoBranch, Repo, SubItem, Issue, Epic, Milestone,
  ContextFile, ProjectPaneData, PaneAutomation, PaneSkill, McpServer,
} from "./projectPane.types";

export interface BuildProjectPaneInput {
  fleet?: FleetPlan;
  profiles: AgentProfile[];
  issues: PlanIssue[];
  repos: string[];
  /** Full_names cloned into the project hub (clone state) — drives each repo's `cloned`. */
  clonedNames?: string[];
  /** Cron automations proposed for the project (#674). */
  automations?: PaneAutomation[];
  /** Skills/knowledge attached to the project's blueprint, pre-resolved (#674). */
  skills?: PaneSkill[];
  /** The full MCP-servers store + the project key, to build the MCP pane (#878). */
  mcpServers?: McpServerDef[];
  projectKey?: string;
  /** Per-server install lifecycle (probe + build button), keyed by extension id (#878). */
  mcpInstallState?: McpInstallState;
  /** Features defined in the Features stage (parsed from features.json) (#…). */
  features?: PlanFeature[];
  /** The in-progress blueprint an authoring project is designing (#923) — passed through to the
   *  pane so the authoring stages can render it. */
  authoredBlueprint?: Blueprint;
  /** Per-project coordination-topology override (#…) — set in the Permissions pane,
   *  wins over the planner's `fleet.json` topology. */
  topologyOverride?: import("../relationship/relationshipGraph").Topology;
  /** Per-project director-drive override (#…) — set in the Permissions pane, wins over
   *  `fleet.json`'s `director.drive`. */
  directorDriveOverride?: import("../fleet/directorDrive").DirectorDrive;
  /** The project's deployment & infrastructure config (#919) — the Deploy stage pane's state. */
  deployConfig?: DeployConfig;
  /** The locked dependency manifest (#1127/#1133) — surfaced in the Deploy pane. */
  dependencies?: PlanDependency[];
  registries?: Record<string, DependencyRegistry>;
  sections: Section[];
  /** Context-file names the project has explicitly pinned in the pane (from the
   *  store). When present it drives each context file's `pinned` instead of the
   *  confirmed-section default. */
  pinned?: string[];
  /** Live GitHub issue-progression overlay (#393 Layer 2), keyed by structure node
   *  id (`issue:{repo}:{ref}`). When present it drives each issue's done-state and
   *  the milestone/epic percentages — reflecting what is actually CLOSED on GitHub
   *  — falling back to the static done/closed label when a node has no live data
   *  (#429). The same overlay the GitHubStructureCard renders, built by
   *  {@link buildProgressOverlay}. */
  progress?: Record<string, NodeProgress>;
}

const AGENT_HUES = [230, 70, 50, 145, 195, 300, 350, 110, 20, 260];
function agentColor(index: number): string {
  const hue = AGENT_HUES[index % AGENT_HUES.length];
  return "oklch(0.74 0.13 " + hue + ")";
}

function initialFor(id: string): string {
  const m = id.match(/[a-z0-9]/i);
  return m ? m[0].toUpperCase() : "?";
}

function mapPush(push: string): string {
  return push === "auto-pr" ? "auto-PR" : push;
}

const DEFAULT_PERM: Perm = {
  read: "allow", edit: "ask", create: "ask", run: "ask", net: "deny", push: "ask", pkg: "deny",
};

function derivePerm(profile: AgentProfile | undefined, push: string): Perm {
  const tier = (k: ToolKey, fallback: Posture): Posture =>
    (profile?.tools?.[k] as Tier | undefined) ?? fallback;
  const pushPosture: Posture =
    push === "none" ? "deny" :
    push === "auto-pr" ? "allow" :
    "ask";
  if (!profile) {
    return { ...DEFAULT_PERM, push: pushPosture };
  }
  const net: Posture = profile.net.allow.length > 0 ? "allow"
    : (profile.tools?.web as Tier | undefined) ?? "deny";
  return {
    read:   tier("read", "ask"),
    edit:   tier("edit", "ask"),
    create: tier("write", "ask"),
    run:    tier("bash", "ask"),
    net,
    push:   pushPosture,
    pkg:    "deny",
  };
}

function buildAgents(input: BuildProjectPaneInput): Agent[] {
  const streams = input.fleet?.streams ?? [];
  return streams.map((s, i) => {
    // The worker's posture is its ROLE's profile (Autonomous trusted), shown read-only — no
    // per-stream perm/preset overrides anymore. An explicit `s.profile` override still resolves.
    const profile = input.profiles.find(p => p.id === (s.profile ?? "pf_auto"));
    const flow = resolveFlow(s.flow);
    return {
      id: s.id,
      name: s.name.startsWith("@") ? s.name : "@" + s.id,
      role: "worker",
      status: "idle",
      repo: s.repo,
      color: agentColor(i),
      initial: initialFor(s.id),
      owns: s.owns,
      issues: s.issues,
      preset: profile ? profile.name : "Autonomous (trusted)",
      perm: derivePerm(profile, flow.push),
      flow: { autonomy: flow.autonomy, push: mapPush(flow.push), gate: flow.gate },
      model: s.model,
      strategy: s.strategy,
      ctx: s.owns.length,
    };
  });
}

function buildRepos(input: BuildProjectPaneInput): Repo[] {
  const streams = input.fleet?.streams ?? [];
  const cloned = new Set(input.clonedNames ?? []);
  const firstIssueNum = (refs: string[]): number => {
    for (const r of refs) { const n = parseInt(String(r).replace(/^#/, ""), 10); if (Number.isFinite(n)) return n; }
    return 0;
  };
  return input.repos.map((fullName, i) => ({
    id: fullName,
    branch: "main",
    ahead: 0,
    behind: 0,
    agents: streams.filter(s => s.repo === fullName).map(s => s.id),
    primary: i === 0,
    cloned: cloned.has(fullName),
    // The planned work for this repo: one branch per stream that owns it (branch = stream
    // id; the issues it owns ride along). Pre-launch these are PLANNED branches; once the
    // fleet runs the live git state replaces them.
    branches: streams.filter(s => s.repo === fullName).map(s => ({
      n: s.id, issue: firstIssueNum(s.issues ?? []), state: "draft", ahead: 0, behind: 0,
    })),
  }));
}

/** Shared issue derivation for the repo-first structure builder: how an issue
 *  attributes to a repo, whether it's closed (live overlay → static label
 *  fallback), the render shape, and a closed-fraction helper. */
function issueHelpers(input: BuildProjectPaneInput) {
  const { repos, progress } = input;
  const firstAgent = input.fleet?.streams[0]?.id ?? "";
  // Attribute each issue to a repo: its explicit `repo`, else the first publish repo.
  const fallbackRepo = repos[0] ?? "";
  const repoOf = (p: PlanIssue): string => p.repo || fallbackRepo;

  // An issue is done when the live GitHub overlay (#393 Layer 2) marks its
  // structure node closed, falling back to a static done/closed label on the plan
  // issue (#429). The node id mirrors buildGhStructure: `issue:{repo}:{ref}`.
  const staticClosed = (p: PlanIssue): boolean =>
    p.labels.some(l => /^(done|closed)$/i.test(l));
  const issueClosed = (p: PlanIssue): boolean =>
    progress?.[`issue:${repoOf(p)}:${p.ref}`]?.done ?? staticClosed(p);
  const toIssue = (p: PlanIssue): Issue => ({
    n: p.ref,
    t: p.title,
    state: issueClosed(p) ? "done" : "backlog",
    owner: p.stream || firstAgent || "",
    ac: p.acceptance.length,
    branch: p.ref,
    deps: p.dependsOn,
    // Acceptance sub-items: when the live overlay marks the issue closed, treat
    // every acceptance criterion as met so the drill-in checklist agrees with the
    // issue's done state; otherwise leave them open (the overlay tracks per-issue,
    // not per-criterion, state).
    sub: p.acceptance.map(a => ({ t: a, done: issueClosed(p) })),
    repo: repoOf(p),
  });
  const pct = (group: PlanIssue[]): number =>
    group.length ? group.filter(issueClosed).length / group.length : 0;
  return { repoOf, issueClosed, toIssue, pct };
}

/**
 * Repo-first structure (#497, #1912): one milestone per repo carrying every issue
 * that attributes to it (its `repo`, or the default repo when unset), with a single
 * closed/total/pct rollup. Milestone phases were removed (#1912), so issues are no
 * longer grouped by roadmap phase — just by repo.
 */
function buildStructure(input: BuildProjectPaneInput): Milestone[] {
  const { issues, repos } = input;
  if (issues.length === 0) return [];
  const { repoOf, toIssue, pct } = issueHelpers(input);

  const repoOrder: string[] = [...repos];
  for (const p of issues) {
    const r = repoOf(p);
    if (!repoOrder.includes(r)) repoOrder.push(r);
  }

  const out: Milestone[] = [];
  for (const repo of repoOrder) {
    const repoIssues = issues.filter(p => repoOf(p) === repo);
    if (repoIssues.length === 0) continue;
    const fraction = pct(repoIssues);
    out.push({
      id: `${repo}#M1`,
      title: "Issues",
      repo,
      pct: fraction,
      state: "doing",
      epics: [{ id: `${repo}#E1`, title: "Issues", pct: fraction, issues: repoIssues.map(toIssue) }],
    });
  }
  return out;
}


function buildContext(input: BuildProjectPaneInput): ContextFile[] {
  // When the project has an explicit pinned set (user toggles in the pane),
  // it drives `pinned`; otherwise fall back to the confirmed-section default.
  const explicitPins = input.pinned ? new Set(input.pinned) : undefined;
  // Skip empty section files — a created-but-unwritten section would otherwise show as a
  // ghost 0.0k context file (#654). Also skip the deprecated `issues` / `issues-phase<n>`
  // sections: issues are no longer an authored plan file — they're generated from the feature
  // DAG at GitHub-publish time (#plan-db), so a stale (often near-empty) issues section must
  // not resurface as a ghost context card.
  return input.sections.filter(s =>
    s.content.trim().length > 0 && s.k !== "issues" && !s.k.startsWith("issues-phase"),
  ).map(s => {
    const kind = s.k === "claude" ? "claude"
      : s.k.includes("spec") ? "spec"
      : "doc";
    const tok = (s.content.length / 1000).toFixed(1) + "k";
    // The displayed filename is the canonical KEY (+ .md) so it matches the on-disk file
    // (`stack.md`), not the human title ("Tech stack.md") which would mislead (#803). The
    // global project guidance file is the uppercase `CLAUDE.md` on disk.
    const name = s.k === "claude" ? "CLAUDE.md" : s.k + ".md";
    return {
      name,
      kind,
      tok,
      pinned: explicitPins ? explicitPins.has(name) : s.state === "confirmed",
      scope: "project",
      content: s.content,
    };
  });
}

/**
 * Build the ProjectPane render data from the real plan store. Robust to missing
 * pieces: no fleet -> no agents and no repo->agent links; no issues -> empty
 * structure; no sections -> empty context. The pane treats an all-empty result as
 * a signal to fall back to its illustrative sample data.
 */
export function buildProjectPaneData(input: BuildProjectPaneInput): ProjectPaneData {
  return {
    agents: buildAgents(input),
    repos: buildRepos(input),
    structure: buildStructure(input),
    context: buildContext(input),
    director: {
      enabled: input.fleet?.director.enabled ?? false,
      role: input.fleet?.director.role,
      drive: resolveDirectorDrive(input.directorDriveOverride ?? input.fleet?.director.drive),
    },
    fleetStrategy: input.fleet?.strategy,
    automations: (input.automations ?? []).map(a => ({ name: a.name, command: a.command, schedule: a.schedule })),
    skills: input.skills ?? [],
    mcpServers: buildMcpServers(input.mcpServers ?? [], input.projectKey ?? "", input.fleet, input.mcpInstallState),
    features: input.features ?? [],
    authoredBlueprint: input.authoredBlueprint,
    deploy: input.deployConfig,
    dependencies: input.dependencies ?? [],
    registries: input.registries ?? {},
    // Coordination topology: the user's per-project override wins over the planner's
    // fleet.json default, falling back to hybrid (#…).
    topology: input.topologyOverride ?? input.fleet?.topology ?? "hybrid",
    relationshipArtifacts: input.fleet?.artifacts ?? [],
    // Use the planner's explicit typed edges when present; otherwise DERIVE them so the
    // graph shows for any planned fleet. The derivation aggregates the granular ISSUE
    // dependency tree (issues.json — the same data the seam graph uses) up to the stream
    // level, so the relationship graph has the same dependency depth (and thus phase
    // layers) as the seam graph, plus any explicit stream-level `dependsOn` (#…).
    relationships: input.fleet?.edges?.length
      ? input.fleet.edges
      : deriveRelationships(effectiveStreams(input), input.issues),
  };
}

/**
 * The streams to render the relationship graph from: the authored fleet when it exists, otherwise
 * derived straight from the features (#plan-db). A feature IS a stream — slug = id, `dependsOn` =
 * the edges — so the stream graph shows in the Structure pane as soon as features are defined,
 * instead of staying blank until the Permissions stage authors `fleet.json`.
 */
function effectiveStreams(input: BuildProjectPaneInput): AgentStream[] {
  if (input.fleet?.streams?.length) return input.fleet.streams;
  return (input.features ?? []).map((f) => ({
    id: f.slug,
    name: f.name || f.slug,
    repo: input.repos[0] ?? "",
    owns: [],
    issues: [],
    dependsOn: f.dependsOn ?? [],
  }));
}

/**
 * Derive cross-stream blocking edges. A dependency between two ISSUES owned by different
 * streams (issue I in stream A `dependsOn` issue J in stream B) becomes a stream edge B→A.
 * This captures the full dependency structure the seam graph shows, aggregated to streams —
 * so the swimlane layers (its "phases") match. Explicit stream-level `dependsOn` is merged in.
 */
function deriveRelationships(streams: AgentStream[], issues: PlanIssue[]): AgentRelationship[] {
  const streamIds = new Set(streams.map((s) => s.id));
  const norm = (r: string) => String(r).replace(/^#/, "").trim();
  // issue ref → owning stream id (the stream's declared issue list, then PlanIssue.stream).
  const ownerOf = new Map<string, string>();
  for (const s of streams) for (const ref of s.issues ?? []) ownerOf.set(norm(ref), s.id);
  for (const i of issues) if (i.stream && streamIds.has(i.stream)) ownerOf.set(norm(i.ref), i.stream);

  const seen = new Set<string>();
  const out: AgentRelationship[] = [];
  const add = (from: string | undefined, to: string) => {
    if (!from || !streamIds.has(from) || !streamIds.has(to) || from === to) return;
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: key, from, to, kind: "blocking", hardness: "blocking", via: "direct" });
  };
  // cross-stream edges from the issue dependency tree
  for (const i of issues) {
    const to = ownerOf.get(norm(i.ref));
    if (!to) continue;
    for (const dep of i.dependsOn ?? []) add(ownerOf.get(norm(dep)), to);
  }
  // plus any explicit stream-level dependsOn
  for (const s of streams) for (const dep of s.dependsOn ?? []) add(norm(dep), s.id);
  return out;
}
