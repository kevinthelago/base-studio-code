// projectPaneData -- maps the real plan store (fleet streams, agent profiles,
// decomposed issues, phases, sections, linked repos) into the shapes the
// ProjectPane (v2) renders. Pure (no React / Tauri) so the mapping is unit-testable,
// keeping the pane a dumb view. ProjectPane re-imports these interfaces, so this
// module is the single source of truth for the pane data contract; the pane
// falls back to its own sample consts when a project has none of this yet.

import type { AgentProfile, Tier, ToolKey } from "../agents/agentProfiles";
import type { FleetPlan } from "./planSections";
import type { PlanIssue } from "./planIssues";
import type { Section } from "./ghStructure";
import type { NodeProgress } from "./ghProgress";
import { resolvePhaseIndex } from "./planIssues";
import { resolveFlow } from "./agentFlow";
import { resolveDirectorDrive } from "./directorDrive";

export type { PlanGrade, IssueGrade, MilestoneGrade, RepoGrade, Letter } from "../../lib/planGrade";
// The render-shape contract lives in projectPane.types (#356, the shared pane
// types). This adapter imports those shapes and re-exports them so existing
// import sites that reach for them via "./projectPaneData" keep working.
import type {
  Posture, Perm, Agent, Repo, Issue, Milestone, PhaseGroup, ContextFile, ProjectPaneData,
  PaneAutomation, PaneSkill,
} from "./projectPane.types";
import type { PlanFeature } from "./featureList";
import { buildSeamGraph as buildPlanSeamGraph } from "../../lib/planSeamGraph";
import { buildMcpServers, type McpInstallState } from "./mcpPaneData";
import type { ExtensionDef } from "../../lib/extensions";

export type {
  Posture, Perm, Flow, Agent, RepoBranch, Repo, SubItem, Issue, Epic, Milestone, PhaseGroup,
  ContextFile, ProjectPaneData, PaneAutomation, PaneSkill, McpServer,
} from "./projectPane.types";

export interface BuildProjectPaneInput {
  fleet?: FleetPlan;
  profiles: AgentProfile[];
  issues: PlanIssue[];
  phases: { name: string; description?: string }[];
  repos: string[];
  /** Full_names cloned into the project hub (clone state) — drives each repo's `cloned`. */
  clonedNames?: string[];
  /** Cron automations proposed for the project (#674). */
  automations?: PaneAutomation[];
  /** Skills/knowledge attached to the project's blueprint, pre-resolved (#674). */
  skills?: PaneSkill[];
  /** The full extensions store + the project key, to build the MCP pane (#878). */
  extensions?: ExtensionDef[];
  projectKey?: string;
  /** Per-server install lifecycle (probe + build button), keyed by extension id (#878). */
  mcpInstallState?: McpInstallState;
  /** Features defined in the Features stage (parsed from features.json) (#…). */
  features?: PlanFeature[];
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
    const profile = s.profile ? input.profiles.find(p => p.id === s.profile) : undefined;
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
      preset: s.preset ?? (profile ? profile.name : "Custom"),
      perm: s.perm ? { ...s.perm } : derivePerm(profile, flow.push),
      flow: { autonomy: flow.autonomy, push: mapPush(flow.push), gate: flow.gate },
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

/** Shared issue derivation used by both the repo-first and phase-first builders:
 *  how an issue attributes to a repo, whether it's closed (live overlay → static
 *  label fallback), the render shape, and a closed-fraction helper. */
function issueHelpers(input: BuildProjectPaneInput) {
  const { phases, repos, progress } = input;
  const phaseNames = phases.map(p => p.name);
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
  return { phaseNames, repoOf, issueClosed, toIssue, pct };
}

/** A stable-ish phase id from its name (the persisted stable id lands in slice 2). */
function phaseSlug(name: string, i: number): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s ? `phase-${s}` : `phase-${i}`;
}

/**
 * Phase-first, PROJECT-SCOPED structure (#497): one {@link PhaseGroup} per phase
 * spanning every repo, with its issues (each carrying `repo`) and a single
 * closed/total/pct rollup. Every phase is shown (the roadmap), even with no issues
 * yet; issues whose phase doesn't resolve fall to a trailing "Unscheduled" group.
 */
function buildPhaseStructure(input: BuildProjectPaneInput): PhaseGroup[] {
  const { phases, issues } = input;
  if (phases.length === 0 && issues.length === 0) return [];
  const { phaseNames, issueClosed, toIssue } = issueHelpers(input);

  const byPhase = new Map<number, PlanIssue[]>();
  const unscheduled: PlanIssue[] = [];
  for (const p of issues) {
    const idx = resolvePhaseIndex(p.phase, phaseNames);
    if (idx === undefined) { unscheduled.push(p); continue; }
    const list = byPhase.get(idx) ?? [];
    list.push(p);
    byPhase.set(idx, list);
  }

  const group = (list: PlanIssue[], id: string, name: string, order: number, doneWhen?: string): PhaseGroup => {
    const total = list.length;
    const closed = list.filter(issueClosed).length;
    return { id, name, doneWhen, order, issues: list.map(toIssue), closed, total, pct: total ? closed / total : 0 };
  };

  const out: PhaseGroup[] = phases.map((ph, i) =>
    group(byPhase.get(i) ?? [], phaseSlug(ph.name, i), ph.name, i, ph.description));
  if (unscheduled.length > 0) {
    out.push(group(unscheduled, "unscheduled", "Unscheduled", phases.length));
  }
  return out;
}

function buildStructure(input: BuildProjectPaneInput): Milestone[] {
  const { phases, issues, repos } = input;
  if (phases.length === 0 && issues.length === 0) return [];
  const { phaseNames, repoOf, toIssue, pct } = issueHelpers(input);

  // Render milestones PER repo: a milestone is a (repo, phase) pair that actually
  // has issues, so the repo-first view shows each repo's own work tree and empty
  // (repo, phase) pairs don't appear.
  const repoOrder: string[] = [...repos];
  for (const p of issues) {
    const r = repoOf(p);
    if (!repoOrder.includes(r)) repoOrder.push(r);
  }

  const out: Milestone[] = [];
  for (const repo of repoOrder) {
    const repoIssues = issues.filter(p => repoOf(p) === repo);
    if (repoIssues.length === 0) continue;
    const byPhase = new Map<number, PlanIssue[]>();
    const unscheduled: PlanIssue[] = [];
    for (const p of repoIssues) {
      const idx = resolvePhaseIndex(p.phase, phaseNames);
      if (idx === undefined) { unscheduled.push(p); continue; }
      const list = byPhase.get(idx) ?? [];
      list.push(p);
      byPhase.set(idx, list);
    }
    phases.forEach((phase, i) => {
      const group = byPhase.get(i) ?? [];
      if (group.length === 0) return;
      const fraction = pct(group);
      out.push({
        id: `${repo}#M${i + 1}`,
        title: phase.name,
        repo,
        pct: fraction,
        state: "doing",
        epics: [{ id: `${repo}#E${i + 1}`, title: "Issues", pct: fraction, issues: group.map(toIssue) }],
      });
    });
    if (unscheduled.length > 0) {
      const fraction = pct(unscheduled);
      out.push({
        id: `${repo}#M0`,
        title: "Unscheduled",
        repo,
        pct: fraction,
        state: "doing",
        epics: [{ id: `${repo}#E0`, title: "Issues", pct: fraction, issues: unscheduled.map(toIssue) }],
      });
    }
  }
  return out;
}


function buildContext(input: BuildProjectPaneInput): ContextFile[] {
  // When the project has an explicit pinned set (user toggles in the pane),
  // it drives `pinned`; otherwise fall back to the confirmed-section default.
  const explicitPins = input.pinned ? new Set(input.pinned) : undefined;
  // Skip empty section files — a created-but-unwritten section would otherwise show as a
  // ghost 0.0k context file (#654).
  return input.sections.filter(s => s.content.trim().length > 0).map(s => {
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
 * pieces: no fleet -> no agents and no repo->agent links; no phases or issues ->
 * empty structure; no sections -> empty context. The pane treats an all-empty
 * result as a signal to fall back to its illustrative sample data.
 */
export function buildProjectPaneData(input: BuildProjectPaneInput): ProjectPaneData {
  return {
    agents: buildAgents(input),
    repos: buildRepos(input),
    structure: buildStructure(input),
    phaseStructure: buildPhaseStructure(input),
    context: buildContext(input),
    director: {
      enabled: input.fleet?.director.enabled ?? false,
      role: input.fleet?.director.role,
      drive: resolveDirectorDrive(input.fleet?.director.drive),
    },
    fleetStrategy: input.fleet?.strategy,
    automations: (input.automations ?? []).map(a => ({ name: a.name, command: a.command, schedule: a.schedule })),
    skills: input.skills ?? [],
    mcpServers: buildMcpServers(input.extensions ?? [], input.projectKey ?? "", input.fleet, input.mcpInstallState),
    features: input.features ?? [],
    seamGraph: buildPlanSeamGraph(input.issues),
  };
}
