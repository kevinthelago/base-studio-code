// ProjectPane — the planning page right visualizer pane.
// Ported faithfully from design/project-pane-v4/recommended/* (the AssembledPane
// composition: pane header + fleet-pulse strip + three collapsible sections —
// Context Files, Repository · Structure, Agents · Permissions). Styling lives in
// projectPane.css and uses the app's design tokens.
import { useState, useEffect } from "react";
import "./projectPane.css";
import { type DirectorDrive, DIRECTOR_DRIVES } from "./directorDrive";
import {
  type IntegrationStrategy, INTEGRATION_STRATEGIES, STRATEGY_LABEL,
  resolveStrategy, strategySettings,
} from "./integrationStrategy";
import type {
  Posture, Perm, Flow, Agent, Repo, Issue, Milestone, PhaseGroup, SubItem, ContextFile,
  ProjectPaneData,
} from "./projectPane.types";

/* =================================================================
   types -- the render shapes live in projectPane.types.ts (#356, the shared
   pane-types module). ProjectPane and the projectPaneData adapter both import
   them so real plan data and the sample fallback share one contract. Local
   Role/Cap describe this file's palette tables only.
   ================================================================= */
interface Role { c: string; label: string }
interface Cap { k: string; g: string; label: string }

/* =================================================================
   data
   ================================================================= */
// ── role palette ───────────────────────────────────────────────
const ROLES: Record<string, Role> = {
  planner:  { c: "oklch(0.72 0.10 230)", label: "planner" },
  worker:   { c: "oklch(0.80 0.14 70)",  label: "worker" },
  reviewer: { c: "oklch(0.70 0.12 300)", label: "reviewer" },
  triage:   { c: "oklch(0.72 0.10 195)", label: "triage" },
  tester:   { c: "oklch(0.72 0.13 145)", label: "tester" },
  director: { c: "oklch(0.70 0.14 350)", label: "director" },
};

// ── the 7 permission capabilities (order matters; used as columns) ──
const CAPS: Cap[] = [
  { k: "read",   g: "R", label: "read files" },
  { k: "edit",   g: "E", label: "edit files" },
  { k: "create", g: "C", label: "create & delete" },
  { k: "run",    g: "$", label: "run commands" },
  { k: "net",    g: "N", label: "network" },
  { k: "push",   g: "⇡", label: "commit & push" },
  { k: "pkg",    g: "P", label: "install packages" },
];

// presets → per-cap posture
const PRESETS: Record<string, Perm> = {
  Plan:   { read: "allow", edit: "deny",  create: "deny",  run: "ask",   net: "ask",   push: "deny",  pkg: "deny" },
  Build:  { read: "allow", edit: "allow", create: "allow", run: "allow", net: "ask",   push: "ask",   pkg: "ask" },
  Review: { read: "allow", edit: "deny",  create: "deny",  run: "allow", net: "deny",  push: "deny",  pkg: "deny" },
  Triage: { read: "allow", edit: "deny",  create: "ask",   run: "deny",  net: "allow", push: "deny",  pkg: "deny" },
  Full:   { read: "allow", edit: "allow", create: "allow", run: "allow", net: "allow", push: "allow", pkg: "allow" },
};

// ── the fleet ──────────────────────────────────────────────────
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

// ── repos ──────────────────────────────────────────────────────
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

// ── github structure: milestone → epic → issue → sub-issue ─────
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

// helper: the milestones planned for a given repo
function structFor(repoId: string, structure: Milestone[] = STRUCTURE): Milestone[] {
  return structure.filter((m) => m.repo === repoId);
}

// ── context files ──────────────────────────────────────────────
const CONTEXT: ContextFile[] = [
  { name: "settlement-webhooks.spec.md", kind: "spec",   tok: "4.1k", pinned: true,  scope: "project", content: "# Settlement webhooks v2\n\nDelivery contract for settlement events: emit on settle, retry with backoff, sign each payload with an HMAC header.\n\n## Frame\n{ id, type, ts, payload }" },
  { name: "CLAUDE.md",                   kind: "claude", tok: "1.2k", pinned: true,  scope: "global",  content: "# CLAUDE.md\n\nProject-wide guidance for agents. Build with the existing primitives; keep changes minimal and tested." },
  { name: "blk_71fe · framing v2",       kind: "kb",     tok: "0.8k", pinned: true,  scope: "project", content: "Framing v2 — length-prefixed binary frames, schema regenerated on build, round-trip tested." },
  { name: "blk_2199 · sqlite>lmdb",      kind: "kb",     tok: "0.6k", pinned: true,  scope: "project", content: "Decision: SQLite over LMDB for the local store — simpler ops, sufficient throughput, easy backups." },
  { name: "acme/payments · CLAUDE.md",   kind: "claude", tok: "0.9k", pinned: false, scope: "repo",    content: "# acme/payments\n\nRepo guidance: the HMAC middleware owns request verification; never log raw signatures." },
  { name: "docs/architecture.md",        kind: "doc",    tok: "3.4k", pinned: false, scope: "repo",    content: "# Architecture\n\nWS server -> framer -> webhook emitter. The auth surface verifies HMAC + tokens; the dashboard subscribes for live updates." },
  { name: "blk_44a1 · retry policy",     kind: "kb",     tok: "0.5k", pinned: false, scope: "project", content: "Retry policy — exponential backoff, max 6 attempts, jitter, dead-letter after exhaustion." },
];
const CTX_KIND: Record<string, string> = {
  spec:   "oklch(0.72 0.10 230)",
  claude: "oklch(0.80 0.14 70)",
  kb:     "oklch(0.70 0.12 300)",
  doc:    "oklch(0.66 0.06 200)",
};

// state dot color for issues
const ISSUE_STATE: Record<string, string> = {
  doing:   "var(--accent)",
  review:  "var(--success)",
  backlog: "var(--fg-dim)",
  done:    "var(--fg-muted)",
};

/* =================================================================
   primitives (pp-data.jsx)
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

// posture mini-bar: 7 cells
function PostureBar({ perm }: { perm: Perm }) {
  return (
    <span className="posture" title="read · edit · create · run · net · push · pkg">
      {CAPS.map((c) => (
        <i key={c.k} className={perm[c.k]} title={`${c.label}: ${perm[c.k]}`} />
      ))}
    </span>
  );
}

// tri-state Allow/Ask/Deny
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

// flow badges trio
function FlowBadges({ flow }: { flow: Flow; compact?: boolean }) {
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

// per-section sync button (lives in a Sec's `right` slot)
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

// collapsible section shell
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
   pp-repo.jsx — SubList + BranchChip
   ================================================================= */
function BranchChip({ n, mute }: { n: string; mute?: boolean }) {
  return <span style={{
    display: "inline-flex", alignItems: "center", gap: 3,
    fontFamily: "var(--mono)", fontSize: 8.5, padding: "0 5px", borderRadius: 3,
    background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
    color: mute ? "var(--fg-dim)" : "var(--info)", whiteSpace: "nowrap",
  }}>⎇ {n}</span>;
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
      <div style={{
        display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)",
        fontSize: 9, color: "var(--fg-dim)", cursor: "pointer",
      }}>
        <span style={{ width: 11, textAlign: "center" }}>+</span> sub-issue
      </div>
    </div>
  );
}

/* =================================================================
   pp-context.jsx — KindDot, CtxRow, ContextA
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

// VARIANT A — Pinned vs Library, two sections
function ContextA({ context = CONTEXT, onTogglePin, onView }: {
  context?: ContextFile[]; onTogglePin?: (name: string) => void; onView?: (f: ContextFile) => void;
}) {
  // Local items give a snappy toggle; onTogglePin (when supplied) persists to the
  // store. Re-seed from the prop when the persisted context changes so the local
  // copy reflects store-driven pins on the next build.
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
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>~6.7k tok</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
        {pinned.map((f) => <CtxRow key={f.name} f={f} onToggle={() => toggle(f.name)} onView={onView ? () => onView(f) : undefined} />)}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 2px 7px" }}>
        <span className="ulabel">library</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>{lib.length} available</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {lib.map((f) => <CtxRow key={f.name} f={f} onToggle={() => toggle(f.name)} onView={onView ? () => onView(f) : undefined} />)}
      </div>
    </div>
  );
}

/* =================================================================
   pp-merged.jsx — MStateDot, repoRollup, RepoStructure
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

// REPO-FIRST — a collapsible repository card holding its own work tree:
// milestones (the phases decomposed for THAT repo) → issues → acceptance sub-list.
// Mirrors the design's RepoA variant; reuses structFor/MStateDot/SubList/etc.
function RepoStructure({ structure = STRUCTURE, repos = REPOS, agents = AGENTS }: {
  structure?: Milestone[]; repos?: Repo[]; agents?: Agent[];
}) {
  const [openRepo, setOpenRepo] = useState<string | null>(repos[0]?.id ?? null);
  const [openIss, setOpenIss] = useState<number | string | null>(null);
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
              {/* repo header — collapsible */}
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
                      {/* milestone header */}
                      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 4px" }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)" }}>{m.id.split("#")[1]}</span>
                        <span style={{ flex: 1, fontFamily: "var(--sans)", fontSize: 11, color: "var(--fg)" }}>{m.title}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{Math.round(m.pct * 100)}%</span>
                        <span style={{ width: 40 }}><Track pct={m.pct} /></span>
                      </div>
                      {/* issues for this milestone (epics flattened) */}
                      <div style={{ borderLeft: "1px solid var(--border-soft)", marginLeft: 6, paddingLeft: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                        {m.epics.flatMap((e) => e.issues).map((is) => (
                          <IssueRow key={is.n} is={is} agents={agents}
                            open={openIss === is.n} onToggle={() => setOpenIss(openIss === is.n ? null : is.n)} />
                        ))}
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

// One issue row — shared by the repo-first and phase-first structure views.
// Collapsible: clicking toggles the acceptance-criteria drill-in.
function IssueRow({ is, agents, open, onToggle, showRepo }: {
  is: Issue; agents: Agent[]; open: boolean; onToggle: () => void; showRepo?: boolean;
}) {
  return (
    <div style={{ borderRadius: 6, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", overflow: "hidden" }}>
      <div onClick={onToggle} style={{ padding: "7px 9px", cursor: "pointer" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <MStateDot state={is.state} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>#{is.n}</span>
          <span style={{ flex: 1, fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{is.t}</span>
          {showRepo && is.repo && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{is.repo.split("/")[1] ?? is.repo}</span>}
          <span title={"@" + is.owner}><Avatar id={is.owner} sz={14} agents={agents} /></span>
        </div>
        <div style={{ display: "flex", gap: 5, marginTop: 5, paddingLeft: 20, alignItems: "center", flexWrap: "wrap" }}>
          <BranchChip n={is.branch} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--success)" }}>✓ {is.ac} AC</span>
          {is.sub.length > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>⌱ {is.sub.length} sub</span>}
          {is.deps.length > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--accent)" }}>⇠ #{is.deps.join(" #")}</span>}
        </div>
      </div>
      {open && is.sub.length > 0 && (
        <div style={{ padding: "0 9px 8px", borderTop: "1px solid var(--border-soft)" }}>
          <SubList sub={is.sub} pad={4} />
        </div>
      )}
    </div>
  );
}

// Phase-first, PROJECT-SCOPED structure (#497): each phase is one milestone
// spanning every repo, with a single progress bar; its issues are grouped by repo
// beneath it. Replaces the repo→milestone→epic→issue tree as the primary lens.
function PhaseStructure({ phases, agents }: { phases: PhaseGroup[]; agents: Agent[] }) {
  const [openPhase, setOpenPhase] = useState<string | null>(phases[0]?.id ?? null);
  const [openIss, setOpenIss] = useState<number | string | null>(null);
  const totalIssues = phases.reduce((a, p) => a + p.total, 0);
  return (
    <div>
      <div style={{ padding: "0 2px 10px", fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
        the plan · {phases.length} phase{phases.length !== 1 ? "s" : ""} · {totalIssues} issue{totalIssues !== 1 ? "s" : ""}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {phases.map((ph) => {
          const on = openPhase === ph.id;
          const byRepo = new Map<string, Issue[]>();
          for (const is of ph.issues) {
            const r = is.repo ?? "";
            const l = byRepo.get(r) ?? [];
            l.push(is);
            byRepo.set(r, l);
          }
          return (
            <div key={ph.id} style={{
              borderRadius: 7, overflow: "hidden",
              border: "1px solid var(--border-soft)", background: "var(--bg-canvas)",
            }}>
              {/* phase header — collapsible */}
              <div onClick={() => setOpenPhase(on ? null : ph.id)} style={{ padding: "9px 11px", cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <span style={{ width: 8, fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{on ? "▾" : "▸"}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)" }}>P{ph.order + 1}</span>
                  <span style={{ flex: 1, fontFamily: "var(--sans)", fontSize: 11, color: "var(--fg)" }}>{ph.name}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{ph.closed}/{ph.total}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{Math.round(ph.pct * 100)}%</span>
                  <span style={{ width: 40 }}><Track pct={ph.pct} /></span>
                </div>
                {ph.doneWhen && (
                  <div style={{ marginTop: 5, paddingLeft: 15, fontFamily: "var(--sans)", fontSize: 9.5, color: "var(--fg-dim)" }}>{ph.doneWhen}</div>
                )}
              </div>

              {on && (
                <div style={{ padding: "4px 10px 10px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
                  {ph.issues.length === 0 ? (
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", padding: "6px 4px" }}>
                      no issues yet
                    </div>
                  ) : [...byRepo.entries()].map(([repo, issues]) => (
                    <div key={repo} style={{ marginTop: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 4px" }}>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-muted)" }}>{repo || "—"}</span>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{issues.length} issue{issues.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div style={{ borderLeft: "1px solid var(--border-soft)", marginLeft: 6, paddingLeft: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                        {issues.map((is) => (
                          <IssueRow key={String(is.n)} is={is} agents={agents}
                            open={openIss === is.n} onToggle={() => setOpenIss(openIss === is.n ? null : is.n)} />
                        ))}
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

// Sample phase-first structure for the empty/illustrative state — derived from the
// repo-first STRUCTURE sample by grouping its milestones by phase name.
const PHASE_STRUCTURE: PhaseGroup[] = (() => {
  const byName = new Map<string, Issue[]>();
  for (const m of STRUCTURE) {
    const issues = m.epics.flatMap((e) => e.issues).map((is) => ({ ...is, repo: m.repo }));
    byName.set(m.title, [...(byName.get(m.title) ?? []), ...issues]);
  }
  let order = 0;
  return [...byName.entries()].map(([name, issues]) => {
    const closed = issues.filter((i) => i.state === "done").length;
    return {
      id: `sample-phase-${order}`, name, order: order++, issues,
      closed, total: issues.length, pct: issues.length ? closed / issues.length : 0,
    };
  });
})();

/* =================================================================
   pp-agents.jsx — Seg, AgentEditor, AgentsA
   ================================================================= */
// small segmented control
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

// ── the per-agent detail body (presets · capabilities · flow) ──
// Header-less by design: the AgentsA roster row is the single header and the
// repo/owns/issues meta now lives there too, so the row + this body read as one
// cohesive card instead of a row plus a second headered card.
function AgentEditor({ a, fleetStrategy, onPerm, onPreset, onFlow, onStrategy }: {
  a: Agent;
  fleetStrategy?: IntegrationStrategy;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onStrategy?: (streamId: string, strategy: IntegrationStrategy | undefined) => void;
}) {
  // Local state for snappy UI; the callbacks (when supplied) persist every change
  // to the store so it survives a remount. Re-seed when the agent id changes.
  const [perm, setPerm] = useState<Perm>(a.perm);
  const [preset, setPreset] = useState(a.preset);
  const [flow, setFlow] = useState<Flow>(a.flow);
  const [strategy, setStrategy] = useState<IntegrationStrategy | undefined>(a.strategy);
  useEffect(() => { setPerm(a.perm); setPreset(a.preset); setFlow(a.flow); setStrategy(a.strategy); }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
      {/* presets */}
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

      {/* capabilities */}
      <div style={{ padding: "6px 12px 10px", borderTop: "1px solid var(--border-soft)" }}>
        <div className="ulabel" style={{ padding: "5px 0 7px" }}>capabilities</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {CAPS.map((c) => (
            <div key={c.k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{
                width: 16, textAlign: "center", fontFamily: "var(--mono)",
                fontSize: 11, color: "var(--fg-dim)",
              }}>{c.g}</span>
              <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>{c.label}</span>
              <Tri value={perm[c.k]} onChange={(v) => set(c.k, v)} />
            </div>
          ))}
        </div>
      </div>

      {/* flow */}
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

      {/* integration strategy (#378) — resolved chip + per-stream override */}
      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)" }}>
        <div className="ulabel" style={{ marginBottom: 8 }}>integration</div>
        {(() => {
          const resolved = resolveStrategy(strategy, fleetStrategy);
          const st = strategySettings(resolved);
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="fbadge" title="resolved integration strategy">
                strategy: {STRATEGY_LABEL[resolved]} · integrate={st.integrate} · director={st.director}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: "0 0 64px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>override</span>
                <Seg
                  options={["inherit", ...INTEGRATION_STRATEGIES]}
                  value={strategy ?? "inherit"}
                  onChange={(v) => {
                    const next = v === "inherit" ? undefined : (v as IntegrationStrategy);
                    setStrategy(next); onStrategy?.(a.id, next);
                  }}
                  tiny
                />
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
                {strategy ? STRATEGY_LABEL[strategy] + " (override)" : "inherits fleet default"}
              </span>
            </div>
          );
        })()}
      </div>
    </>
  );
}

// VARIANT A — Roster rows; the row IS the single header and the detail body
// (meta + presets + capabilities + flow) expands inside the SAME card, so an
// open agent reads as one cohesive element rather than a row + a second card.
function AgentsA({ agents = AGENTS, fleetStrategy, onPerm, onPreset, onFlow, onStrategy }: {
  agents?: Agent[];
  fleetStrategy?: IntegrationStrategy;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onStrategy?: (streamId: string, strategy: IntegrationStrategy | undefined) => void;
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
              {/* header row — the single header for the whole card */}
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
                  <span className="fbadge" title={a.strategy ? "integration strategy (override)" : "integration strategy (inherited)"}>
                    {STRATEGY_LABEL[resolveStrategy(a.strategy, fleetStrategy)]}
                  </span>
                </div>
              </div>

              {on && (
                <>
                  {/* detail meta — moved out of the old editor header so the card has ONE header */}
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
                  <AgentEditor a={a} fleetStrategy={fleetStrategy} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} onStrategy={onStrategy} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// FlowBadges and repoRollup are ported for completeness but unused by the
// assembled composition (it picks RepoStructure + AgentsA); reference them so
// strict noUnusedLocals stays satisfied.
void FlowBadges;
void repoRollup;

const DRIVE_DESC: Record<DirectorDrive, string> = {
  event: "Re-prompts the director when workers post coordination events (landed / blocked / waiting), while it is idle.",
  heartbeat: "Re-prompts the director on a fixed interval to sweep the fleet — review PRs, merge, unblock.",
  manual: "Never auto-prompts; poke the director on demand from the Coordination inbox.",
  off: "The director runs once from its kickoff and is never re-prompted.",
};

// Director drive selector (#366) — how the async-integrator session is driven once the
// fleet is running. Writes through onDirectorDrive to the fleet plan.
function DirectorBar({ director, fleetStrategy, onDirectorDrive }: {
  director: { enabled: boolean; role?: string; drive: DirectorDrive };
  fleetStrategy?: IntegrationStrategy;
  onDirectorDrive?: (drive: DirectorDrive) => void;
}) {
  const directorRole = strategySettings(resolveStrategy(undefined, fleetStrategy)).director;
  return (
    <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: "0 0 48px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>role</span>
        <span className="fbadge" title="director role under the fleet integration strategy">role: {directorRole}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: "0 0 48px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>drive</span>
        <Seg options={DIRECTOR_DRIVES} value={director.drive}
          onChange={(v) => onDirectorDrive?.(v as DirectorDrive)} />
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
        {DRIVE_DESC[director.drive]}
      </div>
      {!director.enabled && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--warn, var(--fg-dim))" }}>
          No director in this fleet — enable one in the plan for the drive mode to take effect.
        </div>
      )}
    </div>
  );
}

/* =================================================================
   pp-assembled.jsx — AssembledPane → ProjectPane
   ================================================================= */
/**
 * The planning-page right visualizer. Prop-driven: when `data` carries any real
 * plan content (agents, structure, or context) it renders that; otherwise it
 * falls back to the illustrative sample consts so an unplanned project still
 * shows the full pane. The drill-in editors keep local state -- display only,
 * no write-back in this slice.
 */
export function ProjectPane({ data, projectName, projectId, onPerm, onPreset, onFlow, onStrategy, onTogglePin,
  onDirectorDrive, onSyncLabels, syncState }: {
  data?: ProjectPaneData;
  projectName?: string;
  projectId?: string;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onStrategy?: (streamId: string, strategy: IntegrationStrategy | undefined) => void;
  onTogglePin?: (name: string) => void;
  onDirectorDrive?: (drive: DirectorDrive) => void;
  // Publish is owned by the planning header's button and the app's Publish flow
  // (#506/#503): the per-section "Sync to GitHub →" / "Push docs →" buttons were
  // removed as redundant. Only label application remains pane-local.
  onSyncLabels?: () => void;
  syncState?: { labels?: SyncState };
}) {
  const hasData = !!data && (data.agents.length > 0 || data.structure.length > 0 || data.phaseStructure.length > 0 || data.context.length > 0);
  const agents:    Agent[]       = hasData ? data!.agents         : AGENTS;
  const repos:     Repo[]        = hasData ? data!.repos          : REPOS;
  const structure: Milestone[]   = hasData ? data!.structure      : STRUCTURE;
  const phaseStructure: PhaseGroup[] = hasData ? data!.phaseStructure : PHASE_STRUCTURE;
  const context:   ContextFile[] = hasData ? data!.context        : CONTEXT;
  // Phase-first is the primary lens (#497); the repo-first tree is the secondary one.
  const [structView, setStructView] = useState<"phase" | "repo">("phase");

  const running = agents.filter((a) => a.status === "run").length;
  const pinnedCount = context.filter((c) => c.pinned).length;
  const director = hasData ? data!.director : { enabled: true, drive: "event" as DirectorDrive };
  const fleetStrategy = hasData ? data!.fleetStrategy : undefined;

  const [viewing, setViewing] = useState<ContextFile | null>(null);
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setViewing(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  return (
    <div className="pp">
      {/* pane header */}
      <div style={{
        flex: "0 0 auto", padding: "10px 12px",
        borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)",
        display: "flex", alignItems: "center", gap: 8,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: 2,
          background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
        }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)" }}>{hasData ? (projectName || "Project") : "Settlement webhooks v2"}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>{hasData ? (projectId || "") : "prj_2fa"}</span>
      </div>

      <div className="pp-scroll">
        <Sec title="Context Files" count={`✦ ${pinnedCount} pinned`} open={false}>
          <ContextA context={context} onTogglePin={onTogglePin} onView={setViewing} />
        </Sec>
        <Sec
          title="Milestones · Structure"
          count={structView === "phase"
            ? `${phaseStructure.length} phase${phaseStructure.length !== 1 ? "s" : ""}`
            : `${repos.length} repos · ${structure.length} milestones`}
          open={true}
          // Phase/repo lens lives inline in the header (where the publish button
          // used to be, #506); stop the click so toggling the lens doesn't also
          // collapse the section.
          right={
            <span onClick={(e) => e.stopPropagation()}>
              <Seg options={["phase", "repo"]} value={structView} onChange={(v) => setStructView(v as "phase" | "repo")} tiny />
            </span>
          }
        >
          {structView === "phase"
            ? <PhaseStructure phases={phaseStructure} agents={agents} />
            : <RepoStructure structure={structure} repos={repos} agents={agents} />}
        </Sec>
        <Sec title="Agents · Permissions" count={`${agents.length} · ${running} running`} open={true} right={<SyncBtn label="Apply labels →" state={syncState?.labels} onClick={onSyncLabels} />}>
          <AgentsA agents={agents} fleetStrategy={fleetStrategy} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} onStrategy={onStrategy} />
        </Sec>
        <Sec title="Director · Coordination" count={director.enabled ? `drive: ${director.drive}` : "disabled"} open={false}>
          <DirectorBar director={director} fleetStrategy={fleetStrategy} onDirectorDrive={onDirectorDrive} />
        </Sec>
      </div>

      {viewing && (
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
      )}
    </div>
  );
}
