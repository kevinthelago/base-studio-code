// projectPaneData -- maps the real plan store (fleet streams, agent profiles,
// decomposed issues, phases, sections, linked repos) into the shapes the v4
// ProjectPane renders. Pure (no React / Tauri) so the mapping is unit-testable,
// keeping the pane a dumb view. ProjectPane re-imports these interfaces, so this
// module is the single source of truth for the pane data contract; the pane
// falls back to its own sample consts when a project has none of this yet.

import type { AgentProfile, Tier, ToolKey } from "../agents/agentProfiles";
import type { FleetPlan } from "./planSections";
import type { PlanIssue } from "./planIssues";
import type { Section } from "./ghStructure";
import { resolvePhaseIndex } from "./planIssues";
import { resolveFlow } from "./agentFlow";

export type Posture = "allow" | "ask" | "deny";
export type Perm = Record<string, Posture>;
export interface Flow { autonomy: string; push: string; gate: string }

export interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  repo: string;
  color: string;
  initial: string;
  owns: string[];
  issues: string[];
  focus?: boolean;
  preset: string;
  perm: Perm;
  flow: Flow;
  ctx: number;
}

export interface RepoBranch { n: string; issue: number; state: string; ahead: number; behind: number }
export interface Repo {
  id: string;
  branch: string;
  ahead: number;
  behind: number;
  agents: string[];
  primary: boolean;
  branches: RepoBranch[];
}

export interface SubItem { t: string; done: boolean }
export interface Issue {
  n: number | string;
  t: string;
  state: string;
  owner: string;
  ac: number;
  branch: string;
  deps: (number | string)[];
  sub: SubItem[];
}
export interface Epic { id: string; title: string; pct: number; issues: Issue[] }
export interface Milestone { id: string; title: string; repo: string; pct: number; state: string; epics: Epic[] }

export interface ContextFile { name: string; kind: string; tok: string; pinned: boolean; scope: string; content: string }

export interface ProjectPaneData {
  agents: Agent[];
  repos: Repo[];
  structure: Milestone[];
  context: ContextFile[];
}

export interface BuildProjectPaneInput {
  fleet?: FleetPlan;
  profiles: AgentProfile[];
  issues: PlanIssue[];
  phases: { name: string; description?: string }[];
  repos: string[];
  sections: Section[];
  /** Context-file names the project has explicitly pinned in the pane (from the
   *  store). When present it drives each context file's `pinned` instead of the
   *  confirmed-section default. */
  pinned?: string[];
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
      ctx: s.owns.length,
    };
  });
}

function buildRepos(input: BuildProjectPaneInput): Repo[] {
  const streams = input.fleet?.streams ?? [];
  return input.repos.map((fullName, i) => ({
    id: fullName,
    branch: "main",
    ahead: 0,
    behind: 0,
    agents: streams.filter(s => s.repo === fullName).map(s => s.id),
    primary: i === 0,
    branches: [],
  }));
}

function buildStructure(input: BuildProjectPaneInput): Milestone[] {
  const { phases, issues, repos } = input;
  if (phases.length === 0 && issues.length === 0) return [];
  const phaseNames = phases.map(p => p.name);
  const firstAgent = input.fleet?.streams[0]?.id ?? "";
  const issueClosed = (p: PlanIssue): boolean =>
    p.labels.some(l => /^(done|closed)$/i.test(l));
  const toIssue = (p: PlanIssue): Issue => ({
    n: p.ref,
    t: p.title,
    state: issueClosed(p) ? "done" : "backlog",
    owner: p.stream || firstAgent || "",
    ac: p.acceptance.length,
    branch: p.ref,
    deps: p.dependsOn,
    sub: p.acceptance.map(a => ({ t: a, done: false })),
  });
  const pct = (group: PlanIssue[]): number =>
    group.length ? group.filter(issueClosed).length / group.length : 0;
  const byPhase = new Map<number, PlanIssue[]>();
  const unscheduled: PlanIssue[] = [];
  for (const p of issues) {
    const idx = resolvePhaseIndex(p.phase, phaseNames);
    if (idx === undefined) { unscheduled.push(p); continue; }
    const list = byPhase.get(idx) ?? [];
    list.push(p);
    byPhase.set(idx, list);
  }
  const out: Milestone[] = phases.map((phase, i) => {
    const group = byPhase.get(i) ?? [];
    const repoForPhase = group.find(p => p.repo)?.repo ?? repos[0] ?? "";
    const fraction = pct(group);
    return {
      id: "M" + (i + 1),
      title: phase.name,
      repo: repoForPhase,
      pct: fraction,
      state: "doing",
      epics: [{ id: "E" + (i + 1), title: "Issues", pct: fraction, issues: group.map(toIssue) }],
    };
  });
  if (unscheduled.length > 0) {
    const fraction = pct(unscheduled);
    out.push({
      id: "M" + (phases.length + 1),
      title: "Unscheduled",
      repo: unscheduled.find(p => p.repo)?.repo ?? repos[0] ?? "",
      pct: fraction,
      state: "doing",
      epics: [{ id: "E" + (phases.length + 1), title: "Issues", pct: fraction, issues: unscheduled.map(toIssue) }],
    });
  }
  return out;
}

function buildContext(input: BuildProjectPaneInput): ContextFile[] {
  // When the project has an explicit pinned set (user toggles in the pane),
  // it drives `pinned`; otherwise fall back to the confirmed-section default.
  const explicitPins = input.pinned ? new Set(input.pinned) : undefined;
  return input.sections.map(s => {
    const kind = s.k === "claude" ? "claude"
      : s.k.includes("spec") ? "spec"
      : "doc";
    const tok = (s.content.length / 1000).toFixed(1) + "k";
    const name = (s.title || s.k) + ".md";
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
    context: buildContext(input),
  };
}
