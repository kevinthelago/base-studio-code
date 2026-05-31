// ProjectPane — the planning page right visualizer pane.
// Ported faithfully from design/project-pane-v4/recommended/* (the AssembledPane
// composition: pane header + fleet-pulse strip + three collapsible sections —
// Context Files, Repository · Structure, Agents · Permissions). Styling lives in
// projectPane.css and uses the app's design tokens.
import { useState, useEffect } from "react";
import "./projectPane.css";
import type {
  Posture, Perm, Flow, Agent, Repo, Issue, Milestone, SubItem, ContextFile,
  ProjectPaneData,
} from "./projectPaneData";

/* =================================================================
   types -- the render shapes live in projectPaneData.ts (single source of
   truth). ProjectPane imports them so real plan data and the sample fallback
   share one contract. Local Role/Cap describe this file's palette tables only.
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
  { name: "settlement-webhooks.spec.md", kind: "spec",   tok: "4.1k", pinned: true,  scope: "project" },
  { name: "CLAUDE.md",                   kind: "claude", tok: "1.2k", pinned: true,  scope: "global" },
  { name: "blk_71fe · framing v2",       kind: "kb",     tok: "0.8k", pinned: true,  scope: "project" },
  { name: "blk_2199 · sqlite>lmdb",      kind: "kb",     tok: "0.6k", pinned: true,  scope: "project" },
  { name: "acme/payments · CLAUDE.md",   kind: "claude", tok: "0.9k", pinned: false, scope: "repo" },
  { name: "docs/architecture.md",        kind: "doc",    tok: "3.4k", pinned: false, scope: "repo" },
  { name: "blk_44a1 · retry policy",     kind: "kb",     tok: "0.5k", pinned: false, scope: "project" },
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

function CtxRow({ f, onToggle }: { f: ContextFile; onToggle?: () => void }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 7, padding: "5px 7px",
      borderRadius: 5, background: f.pinned ? "var(--bg-canvas)" : "transparent",
      border: "1px solid " + (f.pinned ? "var(--border-soft)" : "transparent"),
    }}>
      <KindDot kind={f.kind} />
      <span style={{
        flex: 1, fontFamily: "var(--mono)", fontSize: 10, color: f.pinned ? "var(--fg)" : "var(--fg-muted)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>{f.name}</span>
      <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)" }}>{f.tok}</span>
      <span onClick={onToggle} style={{
        cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11,
        color: f.pinned ? "var(--accent)" : "var(--fg-dim)", width: 14, textAlign: "center",
      }}>
        {f.pinned ? "✦" : "+"}
      </span>
    </div>
  );
}

// VARIANT A — Pinned vs Library, two sections
function ContextA({ context = CONTEXT, onTogglePin }: {
  context?: ContextFile[]; onTogglePin?: (name: string) => void;
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
        {pinned.map((f) => <CtxRow key={f.name} f={f} onToggle={() => toggle(f.name)} />)}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 2px 7px" }}>
        <span className="ulabel">library</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>{lib.length} available</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {lib.map((f) => <CtxRow key={f.name} f={f} onToggle={() => toggle(f.name)} />)}
      </div>
    </div>
  );
}

/* =================================================================
   pp-merged.jsx — MStateDot, repoRollup, MergedC
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

// MERGED C — Milestone-first (the project plan); repo is a tag
function MergedC({ structure = STRUCTURE, repos = REPOS, agents = AGENTS }: {
  structure?: Milestone[]; repos?: Repo[]; agents?: Agent[];
}) {
  const [openIss, setOpenIss] = useState<number | string | null>(417);
  return (
    <div>
      <div style={{ padding: "0 2px 10px", fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
        the plan · {structure.length} milestones across {repos.length} repos
      </div>
      <div style={{ paddingLeft: 6 }}>
        {structure.map((m, mi) => (
          <div key={m.id} style={{
            position: "relative", paddingLeft: 18,
            borderLeft: "2px solid var(--border-soft)", paddingBottom: mi < structure.length - 1 ? 16 : 0,
          }}>
            <span style={{
              position: "absolute", left: -7, top: 1, width: 12, height: 12, borderRadius: "50%",
              background: "var(--bg-panel)", border: "2px solid var(--accent)",
            }} />
            {/* milestone header with repo tag */}
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)" }}>{m.id}</span>
              <span style={{ flex: 1, fontFamily: "var(--sans)", fontSize: 11.5, color: "var(--fg)" }}>{m.title}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--fg-dim)" }}>{Math.round(m.pct * 100)}%</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
              <span style={{
                fontFamily: "var(--mono)", fontSize: 8.5, padding: "0 6px", borderRadius: 3,
                background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)",
              }}>⎇ {m.repo.split("/")[1]}</span>
              <span style={{ flex: 1 }}><Track pct={m.pct} /></span>
            </div>
            {m.epics.map((e) => (
              <div key={e.id} style={{ marginBottom: 9 }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--info)", marginBottom: 5 }}>{e.id} · {e.title}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {e.issues.map((is) => {
                    const io = openIss === is.n;
                    return (
                      <div key={is.n} style={{
                        borderRadius: 6, background: "var(--bg-canvas)",
                        border: "1px solid var(--border-soft)", overflow: "hidden",
                      }}>
                        <div onClick={() => setOpenIss(io ? null : is.n)} style={{ padding: "7px 9px", cursor: "pointer" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <MStateDot state={is.state} />
                            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>#{is.n}</span>
                            <span style={{
                              flex: 1, fontFamily: "var(--sans)", fontSize: 10.5, color: "var(--fg)",
                              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                            }}>{is.t}</span>
                            <span title={"@" + is.owner}><Avatar id={is.owner} sz={14} agents={agents} /></span>
                          </div>
                          <div style={{ display: "flex", gap: 5, marginTop: 5, paddingLeft: 20, alignItems: "center" }}>
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
        ))}
      </div>
      <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)", cursor: "pointer" }}>+ milestone</div>
    </div>
  );
}

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

// ── the shared per-agent editor (drill-in) ─────────────────────
function AgentEditor({ a, agents = AGENTS, onPerm, onPreset, onFlow }: {
  a: Agent; agents?: Agent[]; dense?: boolean;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
}) {
  // Local state for snappy UI; the callbacks (when supplied) persist every change
  // to the store so it survives a remount. Initialized from the agent prop so a
  // reopened editor reflects the persisted values. Re-seed when the agent id
  // changes (a different stream's editor reuses this component instance).
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
    <div className="editor">
      {/* header */}
      <div style={{ padding: "10px 12px", background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Avatar id={a.id} sz={20} agents={agents} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{a.name}</span>
          <RoleChip role={a.role} />
          <span style={{ flex: 1 }} />
          <Dot s={a.status} />
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 6, marginTop: 7,
          fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)", flexWrap: "wrap",
        }}>
          <span style={{ color: "var(--info)" }}>⎇ {a.repo}</span>
          <span style={{ color: "var(--fg-dim)" }}>·</span>
          <span>owns</span>
          {a.owns.map((o) => <span key={o} className="glob">{o}</span>)}
          {a.issues.map((i) => <span key={i} style={{ color: "var(--accent)" }}>{i}</span>)}
        </div>
      </div>

      {/* presets */}
      <div style={{ padding: "9px 12px", borderBottom: "1px solid var(--border-soft)" }}>
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
      <div style={{ padding: "6px 12px 10px" }}>
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
    </div>
  );
}

// VARIANT A — Roster rows w/ inline expand
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
            <div key={a.id}>
              <div onClick={() => setOpen(on ? null : a.id)} style={{
                display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8,
                alignItems: "center", padding: "7px 8px", borderRadius: 6, cursor: "pointer",
                background: on ? "color-mix(in oklch, var(--accent), transparent 92%)" : "var(--bg-canvas)",
                border: "1px solid " + (on ? "var(--accent-dim)" : "var(--border-soft)"),
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
              {on && <div style={{ marginTop: 5, marginBottom: 2 }}>
                <AgentEditor a={a} agents={agents} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} />
              </div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// FlowBadges and repoRollup are ported for completeness but unused by the
// assembled composition (it picks MergedC + AgentsA); reference them so
// strict noUnusedLocals stays satisfied.
void FlowBadges;
void repoRollup;

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
export function ProjectPane({ data, onPerm, onPreset, onFlow, onTogglePin }: {
  data?: ProjectPaneData;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onTogglePin?: (name: string) => void;
}) {
  const hasData = !!data && (data.agents.length > 0 || data.structure.length > 0 || data.context.length > 0);
  const agents:    Agent[]       = hasData ? data!.agents    : AGENTS;
  const repos:     Repo[]        = hasData ? data!.repos      : REPOS;
  const structure: Milestone[]   = hasData ? data!.structure  : STRUCTURE;
  const context:   ContextFile[] = hasData ? data!.context    : CONTEXT;

  const running = agents.filter((a) => a.status === "run").length;
  const onCount = agents.filter((a) => a.status === "on").length;
  const idleCount = agents.filter((a) => a.status === "idle").length;
  const pinnedCount = context.filter((c) => c.pinned).length;

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
        <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)" }}>Settlement webhooks v2</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>prj_2fa</span>
      </div>

      {/* fleet pulse strip — always-visible glance line */}
      <div style={{
        flex: "0 0 auto", padding: "7px 12px", borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 9,
        color: "var(--fg-muted)", background: "var(--bg-panel)",
      }}>
        <span style={{ display: "flex", gap: -4 }}>
          {agents.map((a, i) => (
            <span key={a.id} style={{ marginLeft: i ? -4 : 0, position: "relative" }}>
              <span className="av" style={{ width: 16, height: 16, background: a.color, fontSize: 9 }}>{a.initial}</span>
            </span>
          ))}
        </span>
        <span style={{ color: "var(--accent)" }}>{running} running</span>
        <span style={{ color: "var(--fg-dim)" }}>· {onCount} on · {idleCount} idle</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--success)" }}>● github 4m</span>
      </div>

      <div className="pp-scroll">
        <Sec title="Context Files" count={`✦ ${pinnedCount} pinned`} open={false}>
          <ContextA context={context} onTogglePin={onTogglePin} />
        </Sec>
        <Sec title="Repository · Structure" count={`${repos.length} repos · ${structure.length} milestones`} open={true}>
          <MergedC structure={structure} repos={repos} agents={agents} />
        </Sec>
        <Sec title="Agents · Permissions" count={`${agents.length} · ${running} running`} open={true}>
          <AgentsA agents={agents} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} />
        </Sec>
      </div>
    </div>
  );
}
