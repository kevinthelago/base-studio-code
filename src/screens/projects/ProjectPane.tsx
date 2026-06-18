// ProjectPane — planning-page right visualizer pane.
// v5: stage-focused one-at-a-time view (#652) with real data (#674).
// Ported from design/project-pane-v4/recommended; now wraps in a 7-stage stepper
// so the planning workflow is one focused phase at a time.
import { useState, useEffect } from "react";
import "./projectPane.css";
import type {
  Posture, Perm, Flow, Agent, Repo, Issue, Milestone, SubItem, ContextFile,
  ProjectPaneData, PaneAutomation, PaneSkill, McpServer,
} from "./projectPaneData";
import type { Section } from "./ghStructure";
import type { FleetPlan } from "./planSections";
import { featureDefined, type PlanFeature } from "./featureList";
import { SeamGraphView } from "./SeamGraphView";
import type { Phase, GatePill, FooterKind } from "./focusedPlan";
import {
  Stepper as FocusedStepper,
  PhaseHeader as FocusedPhaseHeader,
  LockBanner as FocusedLockBanner,
  PhaseFooter as FocusedPhaseFooter,
} from "./FocusedShell";
import { FileIntakePane } from "./FileIntakePane";
import { PurposeView, StagesView, CapabilitiesView, PublishView } from "./BlueprintAuthorViews";
import type { BlueprintSkillItem } from "./blueprintSkills";
import type { McpLibraryItem } from "./blueprintMcp";

/* =================================================================
   types
   ================================================================= */
interface Role { c: string; label: string }
interface Cap { k: string; g: string; label: string }

/* =================================================================
   role palette + caps
   ================================================================= */
const ROLES: Record<string, Role> = {
  planner:  { c: "oklch(0.72 0.10 230)", label: "planner" },
  worker:   { c: "oklch(0.80 0.14 70)",  label: "worker" },
  reviewer: { c: "oklch(0.70 0.12 300)", label: "reviewer" },
  triage:   { c: "oklch(0.72 0.10 195)", label: "triage" },
  tester:   { c: "oklch(0.72 0.13 145)", label: "tester" },
  director: { c: "oklch(0.70 0.14 350)", label: "director" },
};

const CAPS: Cap[] = [
  { k: "read",   g: "R", label: "read files" },
  { k: "edit",   g: "E", label: "edit files" },
  { k: "create", g: "C", label: "create & delete" },
  { k: "run",    g: "$", label: "run commands" },
  { k: "net",    g: "N", label: "network" },
  { k: "push",   g: "⇡", label: "commit & push" },
  { k: "pkg",    g: "P", label: "install packages" },
];

const PRESETS: Record<string, Perm> = {
  Plan:   { read: "allow", edit: "deny",  create: "deny",  run: "ask",   net: "ask",   push: "deny",  pkg: "deny" },
  Build:  { read: "allow", edit: "allow", create: "allow", run: "allow", net: "ask",   push: "ask",   pkg: "ask" },
  Review: { read: "allow", edit: "deny",  create: "deny",  run: "allow", net: "deny",  push: "deny",  pkg: "deny" },
  Triage: { read: "allow", edit: "deny",  create: "ask",   run: "deny",  net: "allow", push: "deny",  pkg: "deny" },
  Full:   { read: "allow", edit: "allow", create: "allow", run: "allow", net: "allow", push: "allow", pkg: "allow" },
};

/* =================================================================
   sample data (used when no real plan data is available)
   ================================================================= */
const AGENTS: Agent[] = [
  { id: "planner", name: "@planner", role: "planner", status: "wait", repo: "acme/payments",
    color: "oklch(0.72 0.10 230)", initial: "P",
    owns: ["docs/**", "specs/**"], issues: ["M1", "M2"],
    preset: "Plan", perm: { ...PRESETS.Plan },
    flow: { autonomy: "confirm", push: "none", gate: "soft" }, ctx: 3 },

  { id: "framer", name: "@framer", role: "worker", status: "run", repo: "acme/payments",
    color: "oklch(0.80 0.14 70)", initial: "F",
    owns: ["crates/ws-server/**"], issues: ["#418", "#416"], focus: true,
    preset: "Build", perm: { ...PRESETS.Build },
    flow: { autonomy: "checkpoint", push: "push-confirm", gate: "hard" }, ctx: 4 },

  { id: "auth", name: "@auth", role: "worker", status: "run", repo: "acme/payments",
    color: "oklch(0.78 0.13 50)", initial: "A",
    owns: ["crates/auth/**", "crates/gh/**"], issues: ["#417", "#413"],
    preset: "Build", perm: { ...PRESETS.Build, push: "allow" },
    flow: { autonomy: "continuous", push: "auto-PR", gate: "hard" }, ctx: 5 },

  { id: "tester", name: "@tester", role: "tester", status: "on", repo: "acme/payments",
    color: "oklch(0.72 0.13 145)", initial: "T",
    owns: ["tests/**"], issues: ["#408"],
    preset: "Review", perm: { ...PRESETS.Review, run: "allow" },
    flow: { autonomy: "continuous", push: "commit-only", gate: "hard" }, ctx: 2 },

  { id: "triage", name: "@triage", role: "triage", status: "on", repo: "both",
    color: "oklch(0.72 0.10 195)", initial: "Δ",
    owns: ["— issues only"], issues: ["board"],
    preset: "Triage", perm: { ...PRESETS.Triage },
    flow: { autonomy: "continuous", push: "none", gate: "soft" }, ctx: 1 },

  { id: "reviewer", name: "@reviewer", role: "reviewer", status: "idle", repo: "acme/web-dashboard",
    color: "oklch(0.70 0.12 300)", initial: "R",
    owns: ["src/**"], issues: ["#414"],
    preset: "Review", perm: { ...PRESETS.Review },
    flow: { autonomy: "checkpoint", push: "commit-only", gate: "hard" }, ctx: 2 },
];

const REPOS: Repo[] = [
  { id: "acme/payments", branch: "main", ahead: 2, behind: 0,
    agents: ["planner", "framer", "auth", "tester"], primary: true,
    branches: [
      { n: "feat/framing-v2",      issue: 418, state: "active", ahead: 5, behind: 2 },
      { n: "feat/webhook-emitter", issue: 416, state: "draft",  ahead: 0, behind: 0 },
      { n: "feat/hmac-mw",         issue: 417, state: "active", ahead: 3, behind: 0 },
      { n: "fix/token-revocation", issue: 413, state: "review", ahead: 2, behind: 1 },
    ] },
  { id: "acme/web-dashboard", branch: "main", ahead: 0, behind: 0,
    agents: ["reviewer", "triage"], primary: false,
    branches: [
      { n: "feat/live-updates", issue: 414, state: "review", ahead: 3, behind: 1 },
      { n: "feat/cutover-flag", issue: 420, state: "draft",  ahead: 0, behind: 0 },
    ] },
];

const STRUCTURE: Milestone[] = [
  { id: "M1", title: "Publisher MVP", repo: "acme/payments", pct: 0.72, state: "doing",
    epics: [
      { id: "E1", title: "Framing v2", pct: 0.7, issues: [
        { n: 418, t: "net: framing v2 + schema regen", state: "doing", owner: "framer",
          ac: 3, branch: "feat/framing-v2", deps: [], sub: [
            { t: "spec the v2 frame shape", done: true },
            { t: "encoder + round-trip tests", done: false },
            { t: "regen schema.json on build", done: false },
          ] },
        { n: 416, t: "worker → webhook emitter", state: "doing", owner: "framer",
          ac: 2, branch: "feat/webhook-emitter", deps: [418], sub: [
            { t: "emit on settlement event", done: false },
            { t: "backpressure + retry", done: false },
          ] },
      ] },
      { id: "E2", title: "Auth surface", pct: 0.5, issues: [
        { n: 417, t: "HMAC verification middleware", state: "doing", owner: "auth",
          ac: 4, branch: "feat/hmac-mw", deps: [], sub: [
            { t: "verify signature header", done: true },
            { t: "timing-safe compare", done: false },
            { t: "key rotation hook", done: false },
          ] },
        { n: 413, t: "tokenized webhook path + revocation", state: "review", owner: "auth",
          ac: 2, branch: "fix/token-revocation", deps: [417], sub: [] },
      ] },
    ] },
  { id: "M2", title: "Dashboard live-update", repo: "acme/web-dashboard", pct: 0.32, state: "doing",
    epics: [
      { id: "E3", title: "Live updates", pct: 0.3, issues: [
        { n: 414, t: "subscribe + render live deliveries", state: "review", owner: "reviewer",
          ac: 3, branch: "feat/live-updates", deps: [], sub: [
            { t: "websocket client hook", done: true },
            { t: "optimistic row updates", done: false },
          ] },
        { n: 420, t: "cutover plan + flag wiring", state: "backlog", owner: "planner",
          ac: 1, branch: "feat/cutover-flag", deps: [413, 414], sub: [] },
      ] },
    ] },
];

function structFor(repoId: string, structure: Milestone[] = STRUCTURE): Milestone[] {
  return structure.filter((m) => m.repo === repoId);
}

const CONTEXT: ContextFile[] = [
  { name: "settlement-webhooks.spec.md", kind: "spec",   tok: "4.1k", pinned: true,  scope: "project", content: "# Settlement webhooks v2\n\nDelivery contract for settlement events." },
  { name: "CLAUDE.md",                   kind: "claude", tok: "1.2k", pinned: true,  scope: "global",  content: "# CLAUDE.md\n\nProject-wide guidance for agents." },
  { name: "blk_71fe · framing v2",       kind: "kb",     tok: "0.8k", pinned: true,  scope: "project", content: "Framing v2 — length-prefixed binary frames." },
  { name: "blk_2199 · sqlite>lmdb",      kind: "kb",     tok: "0.6k", pinned: true,  scope: "project", content: "Decision: SQLite over LMDB." },
  { name: "acme/payments · CLAUDE.md",   kind: "claude", tok: "0.9k", pinned: false, scope: "repo",    content: "# acme/payments\n\nRepo guidance." },
  { name: "docs/architecture.md",        kind: "doc",    tok: "3.4k", pinned: false, scope: "repo",    content: "# Architecture\n\nWS server -> framer -> webhook emitter." },
  { name: "blk_44a1 · retry policy",     kind: "kb",     tok: "0.5k", pinned: false, scope: "project", content: "Retry policy — exponential backoff." },
];

const CTX_KIND: Record<string, string> = {
  spec:   "oklch(0.72 0.10 230)",
  claude: "oklch(0.80 0.14 70)",
  kb:     "oklch(0.70 0.12 300)",
  doc:    "oklch(0.66 0.06 200)",
};

const ISSUE_STATE: Record<string, string> = {
  doing:   "var(--accent)",
  review:  "var(--success)",
  backlog: "var(--fg-dim)",
  done:    "var(--fg-muted)",
};

/* =================================================================
   plan stages (#652)
   ================================================================= */
export interface PlanStage {
  id: string;
  title: string;
  short: string;
  desc: string;
  /** Section keys that must all be confirmed for this stage's gate to be met. */
  requiredConfirmed: string[];
  /** Additional gate: check function beyond key confirmation. */
  extraGate?: (sections: Section[], repos: string[], fleet: FleetPlan | undefined) => boolean;
  /** Optional stages are always visible and never block the advance button. (#676) */
  optional?: boolean;
}

export const PLAN_STAGES: PlanStage[] = [
  {
    id: "context",
    title: "Context",
    short: "Ctx",
    desc: "Goal · scope · stack · architecture",
    requiredConfirmed: ["goal", "scope", "stack", "architecture"],
  },
  {
    id: "repos",
    title: "Repos",
    short: "Repos",
    desc: "Link the repositories",
    requiredConfirmed: [],
    extraGate: (_s, repos) => repos.length > 0,
  },
  {
    id: "ui",
    title: "UI",
    short: "UI",
    desc: "Design the screens",
    requiredConfirmed: [],
    extraGate: (sections) => sections.some(s => s.k === "ux" && s.state !== "pending"),
    optional: true,
  },
  {
    id: "structure",
    title: "Structure",
    short: "Str",
    desc: "Feature workshop · phases · issues",
    requiredConfirmed: [],
    extraGate: (sections) => sections.some(s => s.k === "phases" && s.state !== "pending"),
  },
  {
    id: "permissions",
    title: "Permissions",
    short: "Perm",
    desc: "Agent fleet · profiles",
    requiredConfirmed: [],
    extraGate: (_s, _r, fleet) => (fleet?.streams?.length ?? 0) > 0,
  },
  {
    id: "mcp",
    title: "MCP Servers",
    short: "MCP",
    desc: "External tools the fleet can call",
    requiredConfirmed: [],
    optional: true,
  },
  {
    id: "automations",
    title: "Automations",
    short: "Auto",
    desc: "Cron schedules · on-demand",
    requiredConfirmed: [],
    optional: true,
  },
  {
    id: "skills",
    title: "Skills",
    short: "Skills",
    desc: "Reusable skills library",
    requiredConfirmed: [],
    extraGate: (sections) => sections.some(s => s.k === "skills" && s.state !== "pending"),
    optional: true,
  },
];

type StageState = "done" | "active" | "banked" | "locked";

export function isStageGateMet(
  stage: PlanStage,
  sections: Section[],
  repos: string[],
  fleet: FleetPlan | undefined,
): boolean {
  const requiredMet = stage.requiredConfirmed.every(k =>
    sections.find(s => s.k === k)?.state === "confirmed",
  );
  if (!requiredMet) return false;
  return stage.extraGate ? stage.extraGate(sections, repos, fleet) : true;
}

function stageGateLabel(
  stage: PlanStage,
  sections: Section[],
  repos: string[],
): string {
  if (stage.id === "context") {
    const confirmed = stage.requiredConfirmed.filter(k =>
      sections.find(s => s.k === k)?.state === "confirmed",
    ).length;
    return `${confirmed}/${stage.requiredConfirmed.length} confirmed`;
  }
  if (stage.id === "repos") {
    return repos.length === 0
      ? "no repos linked"
      : `${repos.length} repo${repos.length !== 1 ? "s" : ""} linked`;
  }
  if (stage.id === "ui") {
    return sections.some(s => s.k === "ux" && s.state !== "pending") ? "ux drafted" : "ux pending";
  }
  if (stage.id === "structure") {
    const hasPhases = sections.some(s => s.k === "phases" && s.state !== "pending");
    const hasIssues = sections.some(s => s.k === "issues" && s.state !== "pending");
    const n = (hasPhases ? 1 : 0) + (hasIssues ? 1 : 0);
    return `${n}/2 files`;
  }
  if (stage.id === "permissions") {
    return "";  // shown by agent count in body
  }
  return "";
}

/** A stage has content banked when future-stage sections already have content. */
function hasStageContent(stage: PlanStage, sections: Section[]): boolean {
  const relevant: Record<string, string[]> = {
    context:     ["goal", "scope", "stack", "architecture"],
    repos:       ["repos"],
    ui:          ["ux"],
    structure:   ["phases", "issues"],
    permissions: ["fleet"],
    automations: [],
    skills:      ["skills"],
  };
  const keys = relevant[stage.id] ?? [];
  // Use "pending" as default when a section is absent — absence is not content.
  return keys.some(k => (sections.find(s => s.k === k)?.state ?? "pending") !== "pending");
}

/**
 * Forward navigation: skip optional stages with no content. (#676)
 * Stops at the first non-optional stage or an optional stage that has content.
 */
function nextStageIdx(fromIdx: number, sections: Section[]): number {
  const last = PLAN_STAGES.length - 1;
  let idx = fromIdx + 1;
  while (idx < last) {
    const stage = PLAN_STAGES[idx];
    if (!stage.optional) break;
    if (hasStageContent(stage, sections)) break;
    idx++;
  }
  return Math.min(idx, last);
}

function computeStageStates(
  activeIdx: number,
  sections: Section[],
  repos: string[],
  fleet: FleetPlan | undefined,
): StageState[] {
  return PLAN_STAGES.map((stage, i) => {
    if (i === activeIdx) return "active";
    if (i < activeIdx) return isStageGateMet(stage, sections, repos, fleet) ? "done" : "done";
    // Future stage
    return hasStageContent(stage, sections) ? "banked" : "locked";
  });
}

/* =================================================================
   primitives
   ================================================================= */
function Dot({ s }: { s: string }) {
  return <span className={"sdot " + s} />;
}

function RoleChip({ role, mute }: { role: string; mute?: boolean }) {
  const R = ROLES[role] || { c: "var(--fg-dim)", label: role };
  return (
    <span className="role" style={{
      background: `color-mix(in oklch, ${R.c}, transparent ${mute ? 90 : 84}%)`,
      color: R.c, border: `1px solid color-mix(in oklch, ${R.c}, transparent 72%)`,
    }}>
      <i style={{ background: R.c }} />{R.label}
    </span>
  );
}

function Avatar({ id, sz = 17, agents = AGENTS }: { id: string; sz?: number; agents?: Agent[] }) {
  const a = agents.find((x) => x.id === id);
  const color = a ? a.color : "var(--fg-dim)";
  const initial = a ? a.initial : "?";
  return <span className="av" style={{ width: sz, height: sz, background: color, fontSize: sz * 0.53 }}>{initial}</span>;
}

function PostureBar({ perm }: { perm: Perm }) {
  return (
    <span className="posture" title="read · edit · create · run · net · push · pkg">
      {CAPS.map((c) => (
        <i key={c.k} className={perm[c.k]} title={`${c.label}: ${perm[c.k]}`} />
      ))}
    </span>
  );
}

function Tri({ value, onChange }: { value: Posture; onChange?: (v: Posture) => void }) {
  return (
    <span className="tri">
      {(["allow", "ask", "deny"] as Posture[]).map((v) => (
        <button key={v} className={(value === v ? "on " : "") + v}
          onClick={() => onChange && onChange(v)}>
          {v === "allow" ? "allow" : v === "ask" ? "ask" : "deny"}
        </button>
      ))}
    </span>
  );
}

function FlowBadges({ flow }: { flow: Flow }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      <span className="fbadge" title="autonomy">{flow.autonomy}</span>
      <span className="fbadge" title="push policy">{flow.push}</span>
      <span className={"fbadge" + (flow.gate === "hard" ? " hard" : "")} title="enforcement gate">
        {flow.gate} gate
      </span>
    </span>
  );
}

function Track({ pct, green }: { pct: number; green?: boolean }) {
  return <span className="track" style={{ display: "block" }}>
    <i className={green ? "green" : ""} style={{ width: `${Math.round(pct * 100)}%` }} />
  </span>;
}

export type SyncState = "idle" | "running" | "done" | "error";
function SyncBtn({ label, state = "idle", onClick }: { label: string; state?: SyncState; onClick?: () => void }) {
  if (!onClick) return null;
  const txt = state === "running" ? "syncing…"
    : state === "done" ? "✓ synced"
    : state === "error" ? "↺ retry"
    : label;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); if (state !== "running") onClick(); }}
      disabled={state === "running"}
      style={{
        padding: "2px 9px", borderRadius: 5, whiteSpace: "nowrap",
        cursor: state === "running" ? "default" : "pointer",
        fontFamily: "var(--mono)", fontSize: 9.5,
        opacity: state === "running" ? 0.6 : 1,
        background: state === "done" ? "color-mix(in oklch, var(--success), transparent 84%)"
          : state === "error" ? "transparent"
          : "color-mix(in oklch, var(--accent), transparent 84%)",
        color: state === "done" ? "var(--success)"
          : state === "error" ? "var(--danger)"
          : "var(--accent)",
        border: "1px solid " + (state === "done" ? "color-mix(in oklch, var(--success), transparent 60%)"
          : state === "error" ? "color-mix(in oklch, var(--danger), transparent 50%)"
          : "var(--accent-dim)"),
      }}
    >{txt}</button>
  );
}

function Sec({ title, count, open = true, right, children }: {
  title: string; count?: React.ReactNode; open?: boolean; right?: React.ReactNode; children: React.ReactNode;
}) {
  const [o, setO] = useState(open);
  return (
    <div className="sec">
      <div className="sec-head" onClick={() => setO(!o)}>
        <span className="chev">{o ? "▼" : "▶"}</span>
        <span className="t">{title}</span>
        {count != null && <span className="count">{count}</span>}
        <span className="spacer" />
        {right}
      </div>
      {o && <div className="sec-body">{children}</div>}
    </div>
  );
}

/* =================================================================
   pp-repo.jsx
   ================================================================= */
function BranchChip({ n, mute }: { n: string; mute?: boolean }) {
  return <span style={{
    display: "inline-flex", alignItems: "center", gap: 3,
    fontFamily: "var(--mono)", fontSize: 8.5, padding: "0 5px", borderRadius: 3,
    background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
    color: mute ? "var(--fg-dim)" : "var(--info)", whiteSpace: "nowrap",
  }}>⎇ {n}</span>;
}

/** A labeled stat tile ("2 · repositories"). Matches the design's `.tile`. */
function Tile({ v, k }: { v: number | string; k: string }) {
  return (
    <div className="tile">
      <div className="v">{v}</div>
      <div className="k">{k}</div>
    </div>
  );
}

/** Branch-chip color by lifecycle state (matches the design): review → success,
 *  draft → dim, anything else (active) → info. */
function branchStateColor(state: string): string {
  return state === "review" ? "var(--success)" : state === "draft" ? "var(--fg-dim)" : "var(--info)";
}

function SubList({ sub, pad = 22 }: { sub: SubItem[]; pad?: number }) {
  if (!sub || !sub.length) return null;
  return (
    <div style={{ paddingLeft: pad, marginTop: 5, display: "flex", flexDirection: "column", gap: 3 }}>
      {sub.map((s, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 6,
          fontFamily: "var(--mono)", fontSize: 9.5,
          color: s.done ? "var(--fg-dim)" : "var(--fg-muted)",
        }}>
          <span style={{
            width: 11, height: 11, borderRadius: 3, flex: "0 0 11px",
            border: "1px solid " + (s.done ? "var(--success)" : "var(--border)"),
            background: s.done ? "var(--success)" : "transparent", color: "#1a120a",
            fontSize: 8, lineHeight: "10px", textAlign: "center",
          }}>{s.done ? "✓" : ""}</span>
          <span style={{ textDecoration: s.done ? "line-through" : "none" }}>{s.t}</span>
        </div>
      ))}
    </div>
  );
}

/* =================================================================
   pp-context.jsx
   ================================================================= */
function KindDot({ kind }: { kind: string }) {
  return <span style={{
    width: 6, height: 6, borderRadius: 2, flex: "0 0 6px",
    background: CTX_KIND[kind] || "var(--fg-dim)",
  }} />;
}

function CtxRow({ f, onToggle, onView }: { f: ContextFile; onToggle?: () => void; onView?: () => void }) {
  return (
    <div onClick={onView} style={{
      display: "flex", alignItems: "center", gap: 7, padding: "5px 7px",
      borderRadius: 5, background: f.pinned ? "var(--bg-canvas)" : "transparent",
      border: "1px solid " + (f.pinned ? "var(--border-soft)" : "transparent"),
      cursor: onView ? "pointer" : "default",
    }}>
      <KindDot kind={f.kind} />
      <span style={{
        flex: 1, fontFamily: "var(--mono)", fontSize: 10, color: f.pinned ? "var(--fg)" : "var(--fg-muted)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{f.name}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)" }}>{f.tok}</span>
      <span onClick={(e) => { e.stopPropagation(); onToggle?.(); }} style={{
        cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11,
        color: f.pinned ? "var(--accent)" : "var(--fg-dim)", width: 14, textAlign: "center",
      }}>
        {f.pinned ? "✦" : "+"}
      </span>
    </div>
  );
}

function ContextA({ context = CONTEXT, onTogglePin, onView }: {
  context?: ContextFile[]; onTogglePin?: (name: string) => void; onView?: (f: ContextFile) => void;
}) {
  const [items, setItems] = useState(context);
  useEffect(() => { setItems(context); }, [context]);
  const toggle = (name: string) => {
    setItems(items.map((f) => f.name === name ? { ...f, pinned: !f.pinned } : f));
    onTogglePin?.(name);
  };
  const pinned = items.filter((f) => f.pinned);
  const lib = items.filter((f) => !f.pinned);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 2px 7px" }}>
        <span className="ulabel">pinned to context</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)" }}>✦ {pinned.length}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
          ~{(items.reduce((a, f) => a + parseFloat(f.tok), 0)).toFixed(1)}k tok
        </span>
      </div>
      {pinned.length === 0 ? (
        <div style={{ padding: "12px 4px", textAlign: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
          ✦ pin sections to include them in every agent's context
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
          {pinned.map((f) => <CtxRow key={f.name} f={f} onToggle={() => toggle(f.name)} onView={onView ? () => onView(f) : undefined} />)}
        </div>
      )}
      {lib.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 2px 7px" }}>
            <span className="ulabel">library</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>{lib.length} available</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {lib.map((f) => <CtxRow key={f.name} f={f} onToggle={() => toggle(f.name)} onView={onView ? () => onView(f) : undefined} />)}
          </div>
        </>
      )}
    </div>
  );
}

/* =================================================================
   pp-merged.jsx
   ================================================================= */
function MStateDot({ state }: { state: string }) {
  return <span style={{
    width: 6, height: 6, borderRadius: "50%", flex: "0 0 6px",
    background: ISSUE_STATE[state] || "var(--fg-dim)",
  }} />;
}

function repoRollup(repoId: string, structure: Milestone[] = STRUCTURE): { ms: Milestone[]; iss: Issue[]; pct: number } {
  const ms = structFor(repoId, structure);
  const iss = ms.flatMap((m) => m.epics.flatMap((e) => e.issues));
  const pct = ms.length ? ms.reduce((a, m) => a + m.pct, 0) / ms.length : 0;
  return { ms, iss, pct };
}

function RepoStructure({ structure = STRUCTURE, repos = REPOS, agents = AGENTS }: {
  structure?: Milestone[]; repos?: Repo[]; agents?: Agent[];
}) {
  const [openRepo, setOpenRepo] = useState<string | null>(repos[0]?.id ?? null);
  const [openIss, setOpenIss] = useState<number | string | null>(null);

  if (repos.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◫</span>
        <span>No repositories linked yet — ask Claude to create or link repositories.</span>
      </div>
    );
  }

  return (
    <div>
      <div style={{ padding: "0 2px 10px", fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
        the plan · {repos.length} repos · {structure.length} milestones
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {repos.map((r) => {
          const on = openRepo === r.id;
          const ms = structFor(r.id, structure);
          const issues = ms.flatMap((m) => m.epics.flatMap((e) => e.issues));
          return (
            <div key={r.id} style={{
              borderRadius: 7, overflow: "hidden",
              border: "1px solid " + (r.primary ? "var(--accent-dim)" : "var(--border-soft)"),
              background: "var(--bg-canvas)",
            }}>
              <div onClick={() => setOpenRepo(on ? null : r.id)} style={{ padding: "9px 11px", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ width: 8, fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{on ? "▾" : "▸"}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{r.id}</span>
                  {r.primary && <span style={{
                    fontFamily: "var(--mono)", fontSize: 8.5, padding: "0 5px", borderRadius: 3,
                    background: "color-mix(in oklch, var(--accent), transparent 84%)", color: "var(--accent)",
                  }}>primary</span>}
                  <span style={{ flex: 1 }} />
                  <div style={{ display: "flex" }}>
                    {r.agents.map((id, i) => (
                      <span key={id} style={{ marginLeft: i ? -5 : 0 }}><Avatar id={id} sz={15} agents={agents} /></span>
                    ))}
                  </div>
                </div>
                <div style={{
                  display: "flex", gap: 10, marginTop: 6, paddingLeft: 15,
                  fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)",
                }}>
                  <span>{ms.length} milestone{ms.length !== 1 ? "s" : ""}</span>
                  <span>{issues.length} issue{issues.length !== 1 ? "s" : ""}</span>
                </div>
              </div>

              {on && (
                <div style={{ padding: "4px 10px 10px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
                  {ms.length === 0 ? (
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", padding: "6px 4px" }}>
                      no milestones decomposed yet
                    </div>
                  ) : ms.map((m) => (
                    <div key={m.id} style={{ marginTop: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 4px" }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)" }}>{m.id.split("#")[1]}</span>
                        <span style={{ flex: 1, fontFamily: "var(--sans)", fontSize: 11, color: "var(--fg)" }}>{m.title}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{Math.round(m.pct * 100)}%</span>
                        <span style={{ width: 40 }}><Track pct={m.pct} /></span>
                      </div>
                      <div style={{ borderLeft: "1px solid var(--border-soft)", marginLeft: 6, paddingLeft: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                        {m.epics.flatMap((e) => e.issues).map((is) => {
                          const io = openIss === is.n;
                          return (
                            <div key={is.n} style={{ borderRadius: 6, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                              <div onClick={() => setOpenIss(io ? null : is.n)} style={{ padding: "7px 9px", cursor: "pointer" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <MStateDot state={is.state} />
                                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>#{is.n}</span>
                                  <span style={{ flex: 1, fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{is.t}</span>
                                  <span title={"@" + is.owner}><Avatar id={is.owner} sz={14} agents={agents} /></span>
                                </div>
                                <div style={{ display: "flex", gap: 5, marginTop: 5, paddingLeft: 20, alignItems: "center", flexWrap: "wrap" }}>
                                  <BranchChip n={is.branch} />
                                  <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--success)" }}>✓ {is.ac} AC</span>
                                  {is.sub.length > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>⌱ {is.sub.length} sub</span>}
                                  {is.deps.length > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--accent)" }}>⇠ #{is.deps.join(" #")}</span>}
                                </div>
                              </div>
                              {io && is.sub.length > 0 && (
                                <div style={{ padding: "0 9px 8px", borderTop: "1px solid var(--border-soft)" }}>
                                  <SubList sub={is.sub} pad={4} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =================================================================
   pp-agents.jsx
   ================================================================= */
function Seg({ options, value, onChange, tiny }: {
  options: string[]; value: string; onChange?: (v: string) => void; tiny?: boolean;
}) {
  return (
    <span style={{
      display: "inline-flex", border: "1px solid var(--border-soft)",
      borderRadius: 5, overflow: "hidden", fontFamily: "var(--mono)",
      fontSize: tiny ? 9 : 9.5,
    }}>
      {options.map((o, i) => {
        const on = o === value;
        return (
          <button key={o} onClick={() => onChange && onChange(o)} style={{
            border: 0, borderRight: i < options.length - 1 ? "1px solid var(--border-soft)" : 0,
            background: on ? "color-mix(in oklch, var(--accent), transparent 84%)" : "transparent",
            color: on ? "var(--accent)" : "var(--fg-dim)",
            padding: "2px 7px", cursor: "pointer", whiteSpace: "nowrap",
          }}>{o}</button>
        );
      })}
    </span>
  );
}

function AgentEditor({ a, onPerm, onPreset, onFlow }: {
  a: Agent;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
}) {
  const [perm, setPerm] = useState<Perm>(a.perm);
  const [preset, setPreset] = useState(a.preset);
  const [flow, setFlow] = useState<Flow>(a.flow);
  useEffect(() => { setPerm(a.perm); setPreset(a.preset); setFlow(a.flow); }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: Posture) => {
    const next = { ...perm, [k]: v };
    setPerm(next); setPreset("custom");
    onPerm?.(a.id, next);
  };
  const applyPreset = (p: string) => {
    const next = { ...PRESETS[p] };
    setPreset(p); setPerm(next);
    onPreset?.(a.id, p, next);
  };
  return (
    <>
      <div style={{ padding: "9px 12px", borderTop: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
          <span className="ulabel">preset</span>
          <span style={{ flex: 1 }} />
          {preset === "custom" && <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)" }}>● customized</span>}
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {Object.keys(PRESETS).map((p) => (
            <span key={p} className={"preset" + (preset === p ? " on" : "")}
              onClick={() => applyPreset(p)}>{p}</span>
          ))}
        </div>
      </div>

      <div style={{ padding: "6px 12px 10px", borderTop: "1px solid var(--border-soft)" }}>
        <div className="ulabel" style={{ padding: "5px 0 7px" }}>capabilities</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {CAPS.map((c) => (
            <div key={c.k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 16, textAlign: "center", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>{c.g}</span>
              <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>{c.label}</span>
              <Tri value={perm[c.k]} onChange={(v) => set(c.k, v)} />
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
        <div className="ulabel" style={{ marginBottom: 8 }}>flow</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: "0 0 64px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>autonomy</span>
            <Seg options={["continuous", "checkpoint", "confirm"]} value={flow.autonomy}
              onChange={(v) => { const next = { ...flow, autonomy: v }; setFlow(next); onFlow?.(a.id, next); }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: "0 0 64px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>push</span>
            <Seg options={["auto-PR", "push-confirm", "commit-only", "none"]} value={flow.push}
              onChange={(v) => { const next = { ...flow, push: v }; setFlow(next); onFlow?.(a.id, next); }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: "0 0 64px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>gate</span>
            <Seg options={["soft", "hard"]} value={flow.gate}
              onChange={(v) => { const next = { ...flow, gate: v }; setFlow(next); onFlow?.(a.id, next); }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
              {flow.gate === "hard" ? "blocks on violation" : "warns, continues"}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

function AgentsA({ agents = AGENTS, onPerm, onPreset, onFlow }: {
  agents?: Agent[];
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
}) {
  const [open, setOpen] = useState<string | null>((agents.find((a) => a.focus) ?? agents[0])?.id ?? null);
  const running = agents.filter((a) => a.status === "run").length;
  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "0 2px 8px",
        fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)",
      }}>
        <span>{agents.length} agents · {running} running</span>
        <span style={{ flex: 1 }} />
        <span className="mini">+ agent</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {agents.map((a) => {
          const on = open === a.id;
          return (
            <div key={a.id} style={{
              borderRadius: 6, overflow: "hidden",
              background: "var(--bg-canvas)",
              border: "1px solid " + (on ? "var(--accent-dim)" : "var(--border-soft)"),
            }}>
              <div onClick={() => setOpen(on ? null : a.id)} style={{
                display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8,
                alignItems: "center", padding: "7px 8px", cursor: "pointer",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Dot s={a.status} />
                  <Avatar id={a.id} sz={18} agents={agents} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{a.name}</span>
                    <RoleChip role={a.role} mute />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <PostureBar perm={a.perm} />
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {a.owns[0]}{a.owns.length > 1 ? ` +${a.owns.length - 1}` : ""}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-muted)" }}>{a.preset}</span>
                  <span className={"fbadge" + (a.flow.gate === "hard" ? " hard" : "")}>{a.flow.gate}</span>
                </div>
              </div>

              {on && (
                <>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
                    padding: "7px 10px", borderTop: "1px solid var(--border-soft)",
                    fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)",
                  }}>
                    <span style={{ color: "var(--info)" }}>⎇ {a.repo}</span>
                    <span style={{ color: "var(--fg-dim)" }}>·</span>
                    <span>owns</span>
                    {a.owns.map((o) => <span key={o} className="glob">{o}</span>)}
                    {a.issues.map((i) => <span key={i} style={{ color: "var(--accent)" }}>{i}</span>)}
                  </div>
                  <AgentEditor a={a} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Silence unused-variable warnings for repoRollup and FlowBadges.
void repoRollup;
void FlowBadges;

/* =================================================================
   stage-specific body components (#652 / #674)
   ================================================================= */

/** Repos stage body — lists linked repos with clone status. (#674) */
function ReposStageBody({ repos }: { repos: string[] }) {
  if (repos.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">⎇</span>
        <span>No repositories linked yet.</span>
        <span style={{ fontSize: 9.5 }}>Ask Claude to create or link repos with <code style={{ fontFamily: "var(--mono)", background: "var(--bg-elev)", padding: "0 3px", borderRadius: 2 }}>&lt;repo_link&gt;</code></span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", paddingBottom: 6 }}>
        {repos.length} repo{repos.length !== 1 ? "s" : ""} linked
      </div>
      {repos.map((fullName) => {
        const [owner, name] = fullName.split("/");
        return (
          <div key={fullName} style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 10px", borderRadius: 6,
            background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
          }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: "var(--success)", flex: "0 0 7px" }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{owner}/</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>{name}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)" }}>⎇ main</span>
          </div>
        );
      })}
    </div>
  );
}

/** Placeholder body for stages without a dedicated component yet. */
function PlaceholderStageBody({ stage }: { stage: PlanStage }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">⋯</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
        {stage.desc}
      </span>
      <span style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>
        Ask Claude to complete this stage.
      </span>
    </div>
  );
}

/* =================================================================
   focused mode phase bodies (#652 / #674 / #676 / #677)
   ================================================================= */

function FocusedReposBody({ repos, onLinkRepo }: { repos?: Repo[]; onLinkRepo?: (r: string) => void }) {
  const [input, setInput] = useState("");
  const [linking, setLinking] = useState(false);
  const list = repos ?? [];

  const submit = () => {
    const v = input.trim();
    if (v.includes("/")) { onLinkRepo?.(v); setInput(""); setLinking(false); }
  };

  // The "link another repository" affordance — a dashed dropzone that expands into an
  // owner/repo input on click (matches the design's `.dropzone`).
  const linkAffordance = onLinkRepo && (
    linking ? (
      <div className="repo-linkrow">
        <input
          autoFocus
          aria-label="Link a repository"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") { setLinking(false); setInput(""); }
          }}
          placeholder="owner/repo"
        />
        <button className="mini accent" disabled={!input.includes("/")} onClick={submit}>link</button>
        <button className="mini" onClick={() => { setLinking(false); setInput(""); }}>cancel</button>
      </div>
    ) : (
      <button type="button" className="dropzone" onClick={() => setLinking(true)}>
        ＋ link another repository
      </button>
    )
  );

  if (list.length === 0) {
    return (
      <div className="repos-view">
        <div className="empty-state">
          <span className="empty-icon">⎇</span>
          <span>No repositories linked yet</span>
        </div>
        {linkAffordance}
      </div>
    );
  }

  const cloned = list.filter((r) => r.cloned).length;
  const branchCount = list.reduce((s, r) => s + (r.branches?.length ?? 0), 0);

  return (
    <div className="repos-view">
      <div className="tiles">
        <Tile v={list.length} k="repositories" />
        <Tile v={cloned} k="cloned" />
        <Tile v={branchCount} k="branches" />
      </div>
      {list.map((r) => (
        <div key={r.id} className={"repo-card" + (r.primary ? " primary" : "")}>
          <div className="repo-row">
            <span className="sdot on" />
            <span className="repo-name">{r.id}</span>
            {r.primary && <span className="chip accent">primary</span>}
            <span style={{ flex: 1 }} />
            {r.lang && <span className="chip">{r.lang}</span>}
            {r.cloned !== undefined && (
              <span className="repo-stat" style={{ color: r.cloned ? "var(--success)" : "var(--fg-dim)" }}>
                {r.cloned ? "● cloned" : "○ not cloned"}
              </span>
            )}
          </div>
          {r.desc && <div className="repo-desc">{r.desc}</div>}
          <div className="repo-row repo-branchline">
            <span className="branch-chip">⎇ {r.branch}</span>
            <span className="repo-stat" style={{ color: "var(--success)" }}>↑{r.ahead}</span>
            <span className="repo-stat" style={{ color: "var(--info)" }}>↓{r.behind}</span>
            <span style={{ flex: 1 }} />
            {r.agents.length > 0 && (
              <span className="repo-agents">
                {r.agents.map((id, i) => (
                  <span key={id} style={{ marginLeft: i ? -5 : 0 }}><Avatar id={id} sz={16} /></span>
                ))}
              </span>
            )}
          </div>
          {r.branches && r.branches.length > 0 && (
            <div className="repo-branches">
              {r.branches.map((b) => (
                <span key={b.n} className="branch-chip" style={{ color: branchStateColor(b.state) }}>
                  ⎇ {b.n} <span style={{ color: "var(--fg-dim)" }}>#{b.issue}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      {linkAffordance}
    </div>
  );
}

function FocusedContextBody({ context, onView }: { context?: ContextFile[]; onView?: (f: ContextFile) => void }) {
  const files = context ?? [];
  if (files.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">✦</span>
        <span>No context files yet</span>
      </div>
    );
  }
  const totalTok = files.reduce((s, f) => s + parseFloat(f.tok), 0);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", padding: "0 2px 8px", gap: 8 }}>
        <span className="ulabel">context files</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)" }}>
          {totalTok.toFixed(1)}k / 200k tok
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {files.map((f) => <CtxRow key={f.name} f={f} onView={onView ? () => onView(f) : undefined} />)}
      </div>
    </div>
  );
}

function FocusedAutomationsBody({ automations }: { automations?: PaneAutomation[] }) {
  const list = automations ?? [];
  if (list.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">⏱</span>
        <span>No automations yet</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {list.map((a) => (
        <div key={a.name} style={{
          padding: "8px 10px", borderRadius: 6,
          background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{a.name}</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 3 }}>
            {a.command}{a.schedule ? ` · ${a.schedule}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function FocusedSkillsBody({ skills }: { skills?: PaneSkill[] }) {
  const list = skills ?? [];
  if (list.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◈</span>
        <span>No skills attached</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {list.map((s) => (
        <div key={s.name} style={{
          padding: "8px 10px", borderRadius: 6,
          background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{s.name}</div>
          {s.desc && <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 3 }}>{s.desc}</div>}
        </div>
      ))}
    </div>
  );
}

// The focused MCP Servers stage (#878): the project's MCP servers as one expandable card each
// — transport + install status, an enable toggle, the launch command, and the fleet scope it's
// granted to. A first-party server downloads on assign; its "build" button runs the toolchain
// build (uv/pnpm) before the fleet can use it. An enabled, project-scoped server reaches the
// director AND every worker. Mirrors design/bsc project planner focused → MCPView.
const MCP_TRANSPORT: Record<string, { c: string; label: string }> = {
  stdio: { c: "oklch(0.72 0.10 230)", label: "stdio" },
  http:  { c: "oklch(0.80 0.14 70)",  label: "http" },
};
const MCP_STATUS: Record<McpServer["status"], { c: string; dot: string; label: string }> = {
  ready:       { c: "var(--success)", dot: "on",   label: "ready" },
  downloaded:  { c: "var(--fg-muted)", dot: "idle", label: "downloaded · build to run" },
  available:   { c: "var(--fg-dim)",  dot: "idle", label: "available · download to run" },
  downloading: { c: "var(--info)",    dot: "run",  label: "downloading…" },
  building:    { c: "var(--info)",    dot: "run",  label: "building…" },
  error:       { c: "var(--danger)",  dot: "",     label: "build failed" },
};

function FocusedMcpBody({ servers, onToggle, onBuild, onAdd, onRemove }: {
  servers?: McpServer[];
  onToggle?: (id: string) => void;
  onBuild?: (s: McpServer) => void;
  onAdd?: (input: string) => void;
  onRemove?: (id: string) => void;
}) {
  const list = servers ?? [];
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState("");
  const toggleOpen = (id: string) =>
    setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const ready = list.filter((s) => s.enabled && s.status === "ready").length;
  const errored = list.filter((s) => s.enabled && s.status === "error").length;
  const busy = (s: McpServer) => s.status === "downloading" || s.status === "building";

  const tile = (v: React.ReactNode, k: string, c?: string) => (
    <div style={{ flex: 1, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "8px 11px" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, color: c ?? "var(--fg)" }}>{v}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em", marginTop: 1 }}>{k}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {tile(<>{ready}<span style={{ fontSize: 11, color: "var(--fg-dim)" }}> / {list.length}</span></>, "ready", "var(--success)")}
        {tile(list.filter((s) => s.enabled).length, "enabled")}
        {tile(errored, errored === 1 ? "needs attention" : "need attention", errored ? "var(--danger)" : undefined)}
      </div>

      {list.length === 0 && (
        <div className="empty-state"><span className="empty-icon">⊕</span><span>No MCP servers yet — assign one below or have the planner add it</span></div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.map((s) => {
          const tr = MCP_TRANSPORT[s.transport] ?? MCP_TRANSPORT.stdio;
          const stat = MCP_STATUS[s.status];
          const isOpen = open.has(s.id);
          const isErr = s.enabled && s.status === "error";
          return (
            <div key={s.id} style={{
              borderRadius: 9, background: "var(--bg-canvas)", overflow: "hidden",
              border: "1px solid " + (isErr ? "color-mix(in oklch, var(--danger), transparent 60%)" : isOpen ? "var(--border)" : "var(--border-soft)"),
              opacity: s.enabled ? 1 : 0.72,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 6, display: "grid", placeItems: "center", flex: "0 0 24px",
                  fontFamily: "var(--mono)", fontSize: 12, color: tr.c,
                  border: `1px solid color-mix(in oklch, ${tr.c}, transparent 55%)`,
                }}>{(s.name[0] ?? "?").toUpperCase()}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => toggleOpen(s.id)}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{s.name}</span>
                    {s.official && <span className="chip" style={{ fontSize: 8 }}>official</span>}
                    {!s.official && s.downloadable && <span className="chip" style={{ fontSize: 8 }}>first-party</span>}
                    <span className="chip" style={{ fontSize: 8, color: tr.c, borderColor: `color-mix(in oklch, ${tr.c}, transparent 70%)` }}>{tr.label}</span>
                  </span>
                  {s.desc && <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.desc}</span>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span className={"sdot " + stat.dot} style={s.status === "error" ? { background: "var(--danger)" } : undefined} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: stat.c }}>{stat.label}</span>
                  </span>
                  <span className={"toggle" + (s.enabled ? " on" : "")} title={s.enabled ? "granted to the fleet" : "disabled"} onClick={() => onToggle?.(s.id)} />
                </div>
              </div>

              {isErr && s.err && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 12px 10px" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--danger)" }}>⚠ {s.err}</span>
                  <span style={{ flex: 1 }} />
                  <button className="mini" onClick={() => onBuild?.(s)}>retry build</button>
                </div>
              )}

              {isOpen && (
                <div style={{ padding: "10px 12px 12px", borderTop: "1px solid var(--border-soft)" }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", marginBottom: 4 }}>command</div>
                  <div style={{
                    fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", background: "var(--bg-elev)",
                    border: "1px solid var(--border-soft)", borderRadius: 6, padding: "6px 9px", marginBottom: 11,
                    overflowX: "auto", whiteSpace: "nowrap",
                  }}><span style={{ color: "var(--accent)" }}>$ </span>{s.cmd || "—"}</div>

                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", marginBottom: 6 }}>scope · {s.scope}</div>
                  {s.agents.length > 0 ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 11 }}>
                      {s.agents.map((id) => (
                        <span key={id} style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg)", padding: "2px 8px", borderRadius: 99, background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>@{id}</span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginBottom: 11 }}>not wired yet — enable to grant the fleet access</div>
                  )}

                  <div style={{ display: "flex", gap: 7 }}>
                    {s.downloadable && s.status !== "ready" && (
                      <button className="mini accent" disabled={busy(s)} onClick={() => onBuild?.(s)}>
                        {s.status === "downloading" ? "downloading…" : s.status === "building" ? "building…" : s.status === "available" ? "download + build" : "build"}
                      </button>
                    )}
                    <span style={{ flex: 1 }} />
                    <button className="mini" onClick={() => onRemove?.(s.id)}>remove</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 7 }}>
        <input
          className="input"
          placeholder="＋ add an MCP server — catalog name, command, or remote URL"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onAdd?.(draft.trim()); setDraft(""); } }}
          style={{ flex: 1, height: 28, fontSize: 10.5 }}
        />
        <button className="mini accent" disabled={!draft.trim()} onClick={() => { if (draft.trim()) { onAdd?.(draft.trim()); setDraft(""); } }}>add</button>
      </div>
    </div>
  );
}

// The Features board (#…): one card per user-facing capability the planner has written to
// features.json, with a defined/drafting badge + its owning stream. The "easy way" the user
// curates and watches each feature take shape.
/** Authoring config (#923) threaded from Planning — the live blueprint edits flow back via onChange
 *  (kept in sync with the planner's <blueprint> tag), plus the pickable libraries + publish. */
export interface AuthoringWiring {
  onChange: (bp: NonNullable<ProjectPaneData["authoredBlueprint"]>) => void;
  skillLibrary?: BlueprintSkillItem[];
  mcpLibrary?: McpLibraryItem[];
  onPublish: () => void;
  published: boolean;
}

/** The authoring stages' body (#923): the four interactive editor views (Purpose · Stages ·
 *  Capabilities · Review & publish) over the in-progress blueprint, ported from the design. Holds
 *  the selected-stage cursor for the Stages editor. */
function FocusedAuthoringBody({ bp, phaseKey, wiring }: {
  bp?: ProjectPaneData["authoredBlueprint"]; phaseKey: string; wiring?: AuthoringWiring;
}) {
  const [selStage, setSelStage] = useState<string | null>(null);
  if (!bp || !wiring) {
    return (
      <div className="empty-state">
        <span className="empty-icon">⎙</span>
        <span>As the planner designs the blueprint, it appears here.</span>
      </div>
    );
  }
  const sel = selStage ?? bp.sections?.[0]?.uid ?? null;
  const common = { bp, onChange: wiring.onChange, skillLibrary: wiring.skillLibrary, mcpLibrary: wiring.mcpLibrary };
  switch (phaseKey) {
    case "purpose":        return <PurposeView {...common} />;
    case "bp_stages":      return <StagesView {...common} selectedUid={sel} onSelectStage={setSelStage} />;
    case "bp_capabilities": return <CapabilitiesView {...common} />;
    case "bp_review":      return <PublishView {...common} onPublish={wiring.onPublish} published={wiring.published} />;
    default:               return null;
  }
}

function FocusedFeaturesBody({ features }: { features?: PlanFeature[] }) {
  const list = features ?? [];
  // Auto-expand the first not-yet-defined feature — the one the workshop is actively driving down.
  const firstDrafting = list.find((f) => !featureDefined(f))?.slug;
  const [open, setOpen] = useState<Set<string>>(() => new Set(firstDrafting ? [firstDrafting] : []));
  const toggle = (slug: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });

  if (list.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◇</span>
        <span>No features yet — Claude proposes a starter set you curate</span>
      </div>
    );
  }

  const definedCount = list.filter(featureDefined).length;

  return (
    <div className="features-view">
      <div className="tiles">
        <Tile v={list.length} k="features" />
        <Tile v={definedCount} k="defined" />
        <Tile v={list.length - definedCount} k="drafting" />
      </div>
      {list.map((f) => {
        const done = featureDefined(f);
        const acc = f.acceptance ?? [];
        // The workshop drills each feature down to: behavior + acceptance, build approach, tools,
        // data + deps. A card is expandable once it carries any of that detail.
        const hasDetail = !!(f.approach || f.data || (f.tools && f.tools.length > 0) || acc.length > 0);
        const isOpen = open.has(f.slug);
        return (
          <div key={f.slug} className={"feature-card" + (done ? " done" : "")}>
            <div
              className="feature-head"
              onClick={hasDetail ? () => toggle(f.slug) : undefined}
              style={{ cursor: hasDetail ? "pointer" : "default" }}
            >
              <span className="feature-caret">{hasDetail ? (isOpen ? "▼" : "▶") : ""}</span>
              <span className="sdot" style={{ background: done ? "var(--success)" : "var(--fg-dim)" }} />
              <span className="feature-name">{f.name}</span>
              <span style={{ flex: 1 }} />
              <span className={"feature-badge" + (done ? " done" : "")}>{done ? "✓ defined" : "○ drafting"}</span>
              <span className="feature-stream" title="fleet stream">⑂ {f.stream ?? f.slug}</span>
            </div>
            {f.behavior && <div className="feature-behavior">{f.behavior}</div>}

            {isOpen ? (
              <div className="feature-detail">
                {f.approach && (
                  <div className="feature-field">
                    <span className="feature-flabel">approach</span>
                    <span className="feature-ftext">{f.approach}</span>
                  </div>
                )}
                {f.tools && f.tools.length > 0 && (
                  <div className="feature-field">
                    <span className="feature-flabel">tools</span>
                    <span className="feature-tools">{f.tools.map((t) => <span key={t} className="chip">{t}</span>)}</span>
                  </div>
                )}
                {f.data && (
                  <div className="feature-field">
                    <span className="feature-flabel">data + deps</span>
                    <span className="feature-ftext">{f.data}</span>
                  </div>
                )}
                {acc.length > 0 && (
                  <div className="feature-field col">
                    <span className="feature-flabel">acceptance criteria</span>
                    <div className="feature-acc">
                      {acc.map((a, i) => (
                        <div key={i} className="feature-acc-item">
                          <span className="feature-acc-box" />
                          <span>{a}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              acc.length > 0 && (
                <div className="feature-acc-count">
                  {acc.length} acceptance {acc.length === 1 ? "criterion" : "criteria"}
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}

// The Plan review (#…): the Plan stage's autonomous output — the feature seam/dependency graph
// and the phases — shown for the user to APPROVE (the catch-point for a wrong inferred seam).
function FocusedPlanBody({ data, onApprovePlan }: {
  data?: ProjectPaneData;
  onApprovePlan?: () => void;
}) {
  const phases = data?.phaseStructure ?? [];
  const graph = data?.seamGraph;
  const hasGraph = (graph?.nodes.length ?? 0) > 0;
  if (phases.length === 0 && !hasGraph) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◫</span>
        <span>No plan yet — define the features, then Claude drafts the phases + seams</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {hasGraph && (
        <div>
          <div className="ulabel" style={{ paddingBottom: 6 }}>feature seams</div>
          <SeamGraphView graph={graph!} />
        </div>
      )}
      {phases.length > 0 && (
        <div>
          <div className="ulabel" style={{ paddingBottom: 6 }}>phases</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {phases.map((p) => (
              <div key={p.id} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 10px", borderRadius: 6,
                background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
              }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{p.name}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>{p.total} issue{p.total === 1 ? "" : "s"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {onApprovePlan && (
        <button className="nav-btn primary" onClick={onApprovePlan} style={{ alignSelf: "flex-start" }}>
          ✓ Approve milestones &amp; seams
        </button>
      )}
    </div>
  );
}

// The focused Permissions stage (#817): the fleet's streams as least-privilege agent rows
// (posture bar + per-stream editor), plus the "generate profiles" action that materializes the
// profiles the stage's `profilesComplete` gate requires. Previously a hardcoded "No agents yet"
// stub that never rendered the fleet — so the stage looked empty even with streams planned.
function FocusedPermissionsBody({ data, onPerm, onPreset, onFlow, onGenerateProfiles }: {
  data?: ProjectPaneData;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onGenerateProfiles?: () => void;
}) {
  const agents = data?.agents ?? [];
  if (agents.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◎</span>
        <span>No fleet yet — plan the work streams (fleet.json) first</span>
      </div>
    );
  }
  return (
    <div>
      {onGenerateProfiles && (
        <div style={{
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
          padding: "9px 11px", marginBottom: 8, borderRadius: 8,
          background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
        }}>
          <span style={{ flex: 1, minWidth: 160, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            Each stream runs under a <strong style={{ color: "var(--fg)" }}>least-privilege profile</strong> —
            generate them, then review the posture per stream below.
          </span>
          <button className="mini accent" onClick={onGenerateProfiles} style={{ whiteSpace: "nowrap" }}>
            Generate least-privilege profiles
          </button>
        </div>
      )}
      <AgentsA agents={agents} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} />
    </div>
  );
}

function FocusedPhaseBody({ phase, data, projectId, authoring, onLinkRepo, onApprovePlan, onView, onPerm, onPreset, onFlow, onGenerateProfiles, onToggleMcp, onBuildMcp, onAddMcp, onRemoveMcp }: {
  phase: Phase;
  data?: ProjectPaneData;
  projectId?: string;
  /** Authoring-lifecycle wiring (#923) — present only for a blueprint-authoring project. */
  authoring?: AuthoringWiring;
  onLinkRepo?: (r: string) => void;
  onApprovePlan?: () => void;
  onView?: (f: ContextFile) => void;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onGenerateProfiles?: () => void;
  onToggleMcp?: (id: string) => void;
  onBuildMcp?: (s: McpServer) => void;
  onAddMcp?: (input: string) => void;
  onRemoveMcp?: (id: string) => void;
}) {
  switch (phase.key) {
    case "repos":
      return <FocusedReposBody repos={data?.repos} onLinkRepo={onLinkRepo} />;
    case "context":
      return <FocusedContextBody context={data?.context} onView={onView} />;
    case "ui":
      // The UI stage's drop-in-files surface (#604/#829): stage design assets into the
      // project's `design/` dir for the planner to route. The pipeline-screen registry that
      // hosted this was orphaned by the focused-pane refactor — render it directly here.
      return <FileIntakePane projectKey={projectId ?? ""} />;
    case "features":
      return <FocusedFeaturesBody features={data?.features} />;
    case "structure":
      return <FocusedPlanBody data={data} onApprovePlan={onApprovePlan} />;
    case "permissions":
      return <FocusedPermissionsBody data={data} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} onGenerateProfiles={onGenerateProfiles} />;
    case "mcp":
      return <FocusedMcpBody servers={data?.mcpServers} onToggle={onToggleMcp} onBuild={onBuildMcp} onAdd={onAddMcp} onRemove={onRemoveMcp} />;
    case "automations":
      return <FocusedAutomationsBody automations={data?.automations} />;
    case "skills":
      return <FocusedSkillsBody skills={data?.skills} />;
    // Blueprint-authoring stages (#923): the interactive editor views over the in-progress blueprint.
    case "purpose":
    case "bp_stages":
    case "bp_capabilities":
    case "bp_review":
      return <FocusedAuthoringBody bp={data?.authoredBlueprint} phaseKey={phase.key} wiring={authoring} />;
    default:
      return (
        <div className="empty-state">
          <span className="empty-icon">⋯</span>
          <span>The planner documents this stage.</span>
        </div>
      );
  }
}

/* =================================================================
   stage navigation components (#652)
   ================================================================= */

/** The horizontal stepper rail showing all 7 planning stages. */
function Stepper({ stageStates, activeIdx, onSelect }: {
  stageStates: StageState[];
  activeIdx: number;
  onSelect: (idx: number) => void;
}) {
  return (
    <div className="stepper">
      {PLAN_STAGES.map((stage, i) => {
        const s = stageStates[i];
        const isLast = i === PLAN_STAGES.length - 1;
        return (
          <div key={stage.id} className="stepper-item">
            <button
              className={`stepper-node ${s}`}
              onClick={() => onSelect(i)}
              title={stage.title + " — " + stage.desc}
            >
              {s === "done" && <span className="stepper-check">✓</span>}
            </button>
            <span className={`stepper-label ${i === activeIdx ? "active" : ""}`}>
              {stage.short}
            </span>
            {!isLast && (
              <span className={`stepper-conn ${s === "done" ? "solid" : "dashed"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Phase header showing stage title + descriptive subtitle + gate pill. */
function StageHeader({ stage, gateMet, gateLabel, optional }: {
  stage: PlanStage;
  gateMet: boolean;
  gateLabel: string;
  optional?: boolean;
}) {
  return (
    <div className="stage-header">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 700, color: "var(--fg)" }}>
          {stage.title}
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>
          {stage.desc}
        </span>
        {optional && (
          <span style={{
            fontFamily: "var(--mono)", fontSize: 8.5, padding: "1px 5px", borderRadius: 3,
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            color: "var(--fg-dim)",
          }}>optional</span>
        )}
      </div>
      {gateLabel && (
        <span className={`gate-pill ${gateMet ? "met" : "unmet"}`}>
          {gateMet ? "✓ " : ""}{gateLabel}
        </span>
      )}
    </div>
  );
}

/** Compact banner for a completed (done) stage. */
function DoneBanner({ stage, gateLabel, onClick }: {
  stage: PlanStage;
  gateLabel: string;
  onClick?: () => void;
}) {
  return (
    <div className="stage-banner done" onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      <span className="banner-icon">✓</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", fontWeight: 600 }}>
        {stage.title}
      </span>
      {gateLabel && (
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>
          — {gateLabel}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)" }}>view ▸</span>
    </div>
  );
}

/** Compact banner for a locked (future) stage. */
function LockedBanner({ stage, onClick }: { stage: PlanStage; onClick?: () => void }) {
  return (
    <div className="stage-banner locked" onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      <span className="banner-icon">⋯</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>
        {stage.title}
      </span>
      {stage.optional && (
        <span style={{
          fontFamily: "var(--mono)", fontSize: 8.5, padding: "1px 5px", borderRadius: 3,
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          color: "var(--fg-dim)",
        }}>optional</span>
      )}
      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", opacity: 0.7 }}>
        — {stage.desc}
      </span>
    </div>
  );
}

/** Compact banner for a banked (content ahead of the active stage) stage. */
function BankedBanner({ stage, onClick }: { stage: PlanStage; onClick?: () => void }) {
  return (
    <div className="stage-banner banked" onClick={onClick} style={{ cursor: onClick ? "pointer" : "default" }}>
      <span className="banner-icon">●</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
        {stage.title}
      </span>
      <span className="banked-pill">banked</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
        — content drafted ahead
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--success)" }}>view ▸</span>
    </div>
  );
}

/** Footer advance bar — Back / stage name + gate status / Advance. */
function AdvanceBar({ activeIdx, gateMet, optional, onBack, onAdvance, nextShort }: {
  activeIdx: number;
  gateMet: boolean;
  /** When true, the current stage is optional — advance is always enabled. (#676) */
  optional?: boolean;
  onBack: () => void;
  onAdvance: () => void;
  nextShort?: string;
}) {
  const isFirst = activeIdx === 0;
  const isLast = activeIdx === PLAN_STAGES.length - 1;
  const stage = PLAN_STAGES[activeIdx];
  return (
    <div className="advance-bar">
      <button
        className="advance-btn back"
        onClick={onBack}
        disabled={isFirst}
        style={{ opacity: isFirst ? 0.35 : 1 }}
      >
        ← {isFirst ? "" : PLAN_STAGES[activeIdx - 1].short}
      </button>
      <span style={{
        fontFamily: "var(--mono)", fontSize: 9,
        color: gateMet ? "var(--success)" : optional ? "var(--fg-dim)" : "var(--fg-dim)",
        flex: 1, textAlign: "center",
      }}>
        {stage.title}{gateMet ? " · gate met" : optional ? " · optional" : ""}
      </span>
      <button
        className={"advance-btn fwd" + (gateMet || optional ? " enabled" : "")}
        onClick={onAdvance}
        disabled={isLast || (!gateMet && !optional)}
        title={!gateMet && !optional ? "Complete this stage's gate first" : undefined}
        style={{ opacity: isLast ? 0.35 : 1 }}
      >
        {isLast ? "" : (nextShort ?? PLAN_STAGES[activeIdx + 1].short)} →
      </button>
    </div>
  );
}

/* =================================================================
   section body router (#652) — picks the right component per stage
   ================================================================= */
function StageBody({ stage, data, linkedRepos, context, onTogglePin, onView, onPerm, onPreset, onFlow, syncState, onSyncStructure, onSyncDocs, onSyncLabels }: {
  stage: PlanStage;
  data: { agents: Agent[]; repos: Repo[]; structure: Milestone[]; context: ContextFile[] };
  linkedRepos: string[];
  context: ContextFile[];
  onTogglePin?: (name: string) => void;
  onView?: (f: ContextFile) => void;
  onPerm?: (id: string, perm: Perm) => void;
  onPreset?: (id: string, preset: string, perm: Perm) => void;
  onFlow?: (id: string, flow: Flow) => void;
  syncState?: { structure?: SyncState; docs?: SyncState; labels?: SyncState };
  onSyncStructure?: () => void;
  onSyncDocs?: () => void;
  onSyncLabels?: () => void;
}) {
  switch (stage.id) {
    case "context":
      return (
        <Sec title="Context Files" count={`✦ ${context.filter(f => f.pinned).length} pinned`} open right={<SyncBtn label="Push docs →" state={syncState?.docs} onClick={onSyncDocs} />}>
          <ContextA context={context} onTogglePin={onTogglePin} onView={onView} />
        </Sec>
      );
    case "repos":
      return (
        <Sec title="Repositories" count={linkedRepos.length > 0 ? linkedRepos.length : undefined} open>
          <ReposStageBody repos={linkedRepos} />
        </Sec>
      );
    case "structure":
      return (
        <Sec title="Repository · Structure" count={`${data.repos.length} repos · ${data.structure.length} milestones`} open right={<SyncBtn label="Sync to GitHub →" state={syncState?.structure} onClick={onSyncStructure} />}>
          <RepoStructure structure={data.structure} repos={data.repos} agents={data.agents} />
        </Sec>
      );
    case "permissions":
      return (
        <Sec title="Agents · Permissions" count={`${data.agents.length} · ${data.agents.filter(a => a.status === "run").length} running`} open right={<SyncBtn label="Apply labels →" state={syncState?.labels} onClick={onSyncLabels} />}>
          <AgentsA agents={data.agents} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} />
        </Sec>
      );
    default:
      return (
        <Sec title={stage.title} open>
          <PlaceholderStageBody stage={stage} />
        </Sec>
      );
  }
}

/* =================================================================
   ProjectPane — main export
   ================================================================= */
export function ProjectPane({
  data,
  projectName,
  projectId,
  onPerm,
  onPreset,
  onFlow,
  onTogglePin,
  onSyncStructure,
  onSyncDocs,
  onSyncLabels,
  syncState,
  // new: staged mode (#652)
  sections,
  linkedRepos: linkedReposProp,
  fleet,
  // focused mode: one-phase sequenced rail (#652)
  focus,
  onLinkRepo,
  onApprovePlan,
  onGenerateProfiles,
  onToggleMcp,
  onBuildMcp,
  onAddMcp,
  onRemoveMcp,
}: {
  data?: ProjectPaneData;
  projectName?: string;
  projectId?: string;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onTogglePin?: (name: string) => void;
  onSyncStructure?: () => void;
  onSyncDocs?: () => void;
  onSyncLabels?: () => void;
  syncState?: { structure?: SyncState; docs?: SyncState; labels?: SyncState };
  sections?: Section[];
  linkedRepos?: string[];
  fleet?: FleetPlan;
  /** When provided, renders the sequenced-rail focused mode using FocusedShell (#652). */
  focus?: {
    phases: Phase[];
    selectedIdx: number;
    activeIdx: number;
    onSelect: (i: number) => void;
    pill: GatePill;
    footer: { kind: FooterKind; enabled: boolean };
    onBack: () => void;
    onPrimary: () => void;
    /** The project already has a GitHub board — the publish action reads as "Update GitHub" (#823). */
    published?: boolean;
    /** Blueprint-authoring wiring (#923) — present only for an authoring project; drives the
     *  interactive Purpose/Stages/Capabilities/Review editor views. */
    authoring?: AuthoringWiring;
  };
  /** Callback to link a repository from the focused repos body (#677). */
  onLinkRepo?: (repo: string) => void;
  /** Approve the Plan stage's drafted phases + seams (#…) — confirms the roadmap. */
  onApprovePlan?: () => void;
  /** Materialize least-privilege profiles for every fleet stream (#817) — what the focused
   *  Permissions stage needs to satisfy its `profilesComplete` gate. */
  onGenerateProfiles?: () => void;
  /** MCP stage (#878): toggle a server's fleet grant, download+build it, add a new one
   *  (catalog name / command / URL), or remove it. */
  onToggleMcp?: (id: string) => void;
  onBuildMcp?: (s: McpServer) => void;
  onAddMcp?: (input: string) => void;
  onRemoveMcp?: (id: string) => void;
}) {
  // Determine whether to show the staged view or the legacy flat view.
  // Staged view: when sections prop is provided (real planning session).
  // Legacy flat view: fallback for render without sections (e.g. tests, standalone use).
  const stagedMode = sections !== undefined;

  // Resolve data: use real plan data when provided, fall back to sample data.
  // For #674: when sections are provided, use real (possibly empty) data — no sample fallback.
  const hasData = !!data && (data.agents.length > 0 || data.structure.length > 0 || data.context.length > 0);
  const agents:    Agent[]       = (stagedMode || hasData) ? (data?.agents    ?? []) : AGENTS;
  const repos:     Repo[]        = (stagedMode || hasData) ? (data?.repos      ?? []) : REPOS;
  const structure: Milestone[]   = (stagedMode || hasData) ? (data?.structure  ?? []) : STRUCTURE;
  const context:   ContextFile[] = (stagedMode || hasData) ? (data?.context    ?? []) : CONTEXT;
  const linkedRepos: string[]    = linkedReposProp ?? [];

  // Stage navigation state (#652)
  const [activeStageIdx, setActiveStageIdx] = useState(0);
  const stageStates = stagedMode
    ? computeStageStates(activeStageIdx, sections!, linkedRepos, fleet)
    : PLAN_STAGES.map((_, i) => (i === 0 ? "active" : "locked") as StageState);

  const activeStage = PLAN_STAGES[activeStageIdx];
  const gateMet = stagedMode
    ? isStageGateMet(activeStage, sections!, linkedRepos, fleet)
    : false;
  const gateLabel = stagedMode
    ? stageGateLabel(activeStage, sections!, linkedRepos)
    : "";

  // Context file viewer modal
  const [viewing, setViewing] = useState<ContextFile | null>(null);
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setViewing(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  // The context-file viewer modal — shared by BOTH the focused and full-pane renders so
  // clicking an md file opens it in either (the focused pane previously had no viewer, #…).
  const viewerModal = viewing && (
    <div onClick={() => setViewing(null)} style={{
      position: "fixed", inset: 0, zIndex: 50,
      background: "color-mix(in oklch, var(--bg-canvas), transparent 20%)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(720px, 92vw)", maxHeight: "84vh", display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
        borderRadius: 10, boxShadow: "0 16px 50px rgba(0,0,0,.45)", overflow: "hidden",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "12px 14px",
          borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)",
        }}>
          <KindDot kind={viewing.kind} />
          <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{viewing.name}</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{viewing.tok} · {viewing.scope}</span>
          <span onClick={() => setViewing(null)} style={{ cursor: "pointer", fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-muted)", padding: "0 2px 0 8px" }}>✕</span>
        </div>
        <pre style={{
          margin: 0, padding: "14px 16px", overflow: "auto", flex: 1,
          fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.55, color: "var(--fg-muted)",
          whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>{viewing.content || "(empty)"}</pre>
      </div>
    </div>
  );

  const running = agents.filter((a) => a.status === "run").length;
  const onCount  = agents.filter((a) => a.status === "on").length;
  const idleCount = agents.filter((a) => a.status === "idle").length;
  const pinnedCount = context.filter((c) => c.pinned).length;

  // Shared body data bundle
  const bodyData = { agents, repos, structure, context };

  // Focused mode: sequenced-rail one-phase view (#652)
  if (focus) {
    const selected = focus.phases[focus.selectedIdx];
    const active   = focus.phases[focus.activeIdx];
    const isLocked = focus.selectedIdx > focus.activeIdx;
    return (
      <div className="pp fp">
        <FocusedStepper phases={focus.phases} selectedIdx={focus.selectedIdx} onSelect={focus.onSelect} />
        <FocusedPhaseHeader phase={selected} pill={focus.pill} />
        {isLocked && <FocusedLockBanner activeName={active?.name ?? ""} />}
        <div className="pp-scroll">
          <FocusedPhaseBody phase={selected} data={data} projectId={projectId} authoring={focus.authoring} onLinkRepo={onLinkRepo} onApprovePlan={onApprovePlan} onView={setViewing}
            onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} onGenerateProfiles={onGenerateProfiles}
            onToggleMcp={onToggleMcp} onBuildMcp={onBuildMcp} onAddMcp={onAddMcp} onRemoveMcp={onRemoveMcp} />
        </div>
        <FocusedPhaseFooter phase={selected} action={focus.footer} published={focus.published} onBack={focus.onBack} onPrimary={focus.onPrimary} />
        {viewerModal}
      </div>
    );
  }

  return (
    <div className="pp">
      {/* Pane header */}
      <div style={{
        flex: "0 0 auto", padding: "10px 12px",
        borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: 2,
          background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
        }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)" }}>
          {projectName || (hasData ? "Project" : "Settlement webhooks v2")}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
          {projectId || (hasData ? "" : "prj_2fa")}
        </span>
      </div>

      {/* Fleet pulse strip */}
      <div style={{
        flex: "0 0 auto", padding: "7px 12px", borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 9,
        color: "var(--fg-muted)", background: "var(--bg-panel)",
      }}>
        <span style={{ display: "flex", gap: -4 }}>
          {agents.map((a, i) => (
            <span key={a.id} style={{ marginLeft: i ? -4 : 0 }}>
              <span className="av" style={{ width: 16, height: 16, background: a.color, fontSize: 9 }}>{a.initial}</span>
            </span>
          ))}
        </span>
        {agents.length > 0 ? (
          <>
            <span style={{ color: "var(--accent)" }}>{running} running</span>
            <span style={{ color: "var(--fg-dim)" }}>· {onCount} on · {idleCount} idle</span>
          </>
        ) : (
          <span style={{ color: "var(--fg-dim)", opacity: 0.6 }}>no fleet planned yet</span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--success)" }}>● github</span>
      </div>

      {/* Staged view (new) — shown when sections are provided */}
      {stagedMode ? (
        <>
          {/* Stepper */}
          <Stepper stageStates={stageStates} activeIdx={activeStageIdx} onSelect={setActiveStageIdx} />

          {/* Stage header + gate pill */}
          <StageHeader
            stage={activeStage}
            gateMet={gateMet}
            gateLabel={gateLabel}
            optional={activeStage.optional}
          />

          {/* Scrollable stage content */}
          <div className="pp-scroll">
            {/* Done stages above active — compact banners */}
            {PLAN_STAGES.slice(0, activeStageIdx).map((stage, i) => (
              <DoneBanner
                key={stage.id}
                stage={stage}
                gateLabel={stageGateLabel(stage, sections!, linkedRepos)}
                onClick={() => setActiveStageIdx(i)}
              />
            ))}

            {/* Active stage body */}
            <StageBody
              stage={activeStage}
              data={bodyData}
              linkedRepos={linkedRepos}
              context={context}
              onTogglePin={onTogglePin}
              onView={setViewing}
              onPerm={onPerm}
              onPreset={onPreset}
              onFlow={onFlow}
              syncState={syncState}
              onSyncStructure={onSyncStructure}
              onSyncDocs={onSyncDocs}
              onSyncLabels={onSyncLabels}
            />

            {/* Future stages — banked or locked banners */}
            {PLAN_STAGES.slice(activeStageIdx + 1).map((stage, offset) => {
              const i = activeStageIdx + 1 + offset;
              const s = stageStates[i];
              if (s === "banked") {
                return <BankedBanner key={stage.id} stage={stage} onClick={() => setActiveStageIdx(i)} />;
              }
              return <LockedBanner key={stage.id} stage={stage} onClick={() => setActiveStageIdx(i)} />;
            })}
          </div>

          {/* Footer advance bar — forward nav skips empty optional stages (#676) */}
          {(() => {
            const fwdIdx = nextStageIdx(activeStageIdx, sections!);
            const fwdStage = PLAN_STAGES[fwdIdx];
            return (
              <AdvanceBar
                activeIdx={activeStageIdx}
                gateMet={gateMet}
                optional={activeStage.optional}
                nextShort={fwdIdx !== activeStageIdx + 1 ? fwdStage?.short : undefined}
                onBack={() => setActiveStageIdx(Math.max(0, activeStageIdx - 1))}
                onAdvance={() => setActiveStageIdx(fwdIdx)}
              />
            );
          })()}
        </>
      ) : (
        /* Legacy flat view — used when sections are not provided */
        <div className="pp-scroll">
          <Sec title="Context Files" count={`✦ ${pinnedCount} pinned`} open={false} right={<SyncBtn label="Push docs →" state={syncState?.docs} onClick={onSyncDocs} />}>
            <ContextA context={context} onTogglePin={onTogglePin} onView={setViewing} />
          </Sec>
          <Sec title="Repository · Structure" count={`${repos.length} repos · ${structure.length} milestones`} open right={<SyncBtn label="Sync to GitHub →" state={syncState?.structure} onClick={onSyncStructure} />}>
            <RepoStructure structure={structure} repos={repos} agents={agents} />
          </Sec>
          <Sec title="Agents · Permissions" count={`${agents.length} · ${running} running`} open right={<SyncBtn label="Apply labels →" state={syncState?.labels} onClick={onSyncLabels} />}>
            <AgentsA agents={agents} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} />
          </Sec>
        </div>
      )}

      {/* Context file viewer modal (shared; see viewerModal above) */}
      {viewerModal}
    </div>
  );
}
