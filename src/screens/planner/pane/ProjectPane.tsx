// ProjectPane — planning-page right visualizer pane.
// v5: stage-focused one-at-a-time view (#652) with real data (#674).
// Ported from design/project-pane-v4/recommended; now wraps in a 7-stage stepper
// so the planning workflow is one focused phase at a time.
import { useState, useEffect, useMemo } from "react";
import "./projectPane.css";
import type {
  Posture, Perm, Flow, Agent, Repo, Issue, Milestone, ContextFile,
  ProjectPaneData, PaneAutomation, PaneSkill, McpServer,
} from "./projectPaneData";
import { featureDefined, type PlanFeature } from "../issues/featureList";
import type { Phase, GatePill, FooterKind } from "../stages/focusedPlan";
import {
  Stepper as FocusedStepper,
  PhaseHeader as FocusedPhaseHeader,
  LockBanner as FocusedLockBanner,
  PhaseFooter as FocusedPhaseFooter,
} from "./FocusedShell";
import type { StagePrompt } from "../session/plannerConductor";
import { FileIntakePane } from "../bodies/FileIntakePane";
import { FocusedDeployBody } from "../bodies/DeployView";
import type { DeployConfig } from "../shared/deployConfig";
import { PurposeView, StagesView, CapabilitiesView, PublishView } from "../blueprints/BlueprintAuthorViews";
import type { BlueprintSkillItem } from "../blueprints/blueprintSkills";
import type { McpLibraryItem } from "../blueprints/blueprintMcp";
import { FocusedSourceBody } from "../bodies/FocusedSourceBody";
import { FocusedTargetsBody } from "../bodies/FocusedTargetsBody";
import { FocusedLegitimacyBody } from "../bodies/FocusedLegitimacyBody";
import { FocusedAcquireBody } from "../bodies/FocusedAcquireBody";
import { FocusedExtractBody } from "../bodies/FocusedExtractBody";
import { FocusedModelBody } from "../bodies/FocusedModelBody";
import { FocusedMappingBody } from "../bodies/FocusedMappingBody";
import { FocusedCleaningBody } from "../bodies/FocusedCleaningBody";
import { FocusedLoadBody } from "../bodies/FocusedLoadBody";
import { RelationshipGraphView } from "../relationship/RelationshipGraphView";
import { RelationshipInspector } from "../relationship/RelationshipInspector";
import {
  buildRelationshipGraph, EDGE_KIND_META,
  type Topology, type RelFocus,
} from "../relationship/relationshipGraph";
import { DIRECTOR_DRIVES, type DirectorDrive } from "../fleet/directorDrive";

/** The three coordination topologies + their one-line explainers (Permissions control). */
const TOPOLOGY_OPTS: { id: Topology; label: string; hint: string }[] = [
  { id: "director", label: "Director", hint: "hub-and-spoke — every relationship routes through the director" },
  { id: "peer",     label: "Peer",     hint: "mesh — agents hand off directly to each other" },
  { id: "hybrid",   label: "Hybrid",   hint: "per-edge — director for some, direct for others" },
];

/** Director drive modes (when a director is in play) + their tooltips. */
const DRIVE_HINTS: Record<DirectorDrive, string> = {
  event:     "re-prompt the director when workers post coordination events (idle-gated)",
  heartbeat: "re-prompt on a fixed interval — a periodic fleet sweep",
  manual:    "never auto-prompt — poke it from the Coordination inbox",
  off:       "the director is never driven (a static session)",
};

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

function structFor(repoId: string, structure: Milestone[] = []): Milestone[] {
  return structure.filter((m) => m.repo === repoId);
}

const CTX_KIND: Record<string, string> = {
  spec:   "oklch(0.72 0.10 230)",
  claude: "oklch(0.80 0.14 70)",
  kb:     "oklch(0.70 0.12 300)",
  doc:    "oklch(0.66 0.06 200)",
};

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

function Avatar({ id, sz = 17, agents = [] }: { id: string; sz?: number; agents?: Agent[] }) {
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

export type SyncState = "idle" | "running" | "done" | "error";
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

function KindDot({ kind }: { kind: string }) {
  return <span style={{
    width: 6, height: 6, borderRadius: 2, flex: "0 0 6px",
    background: CTX_KIND[kind] || "var(--fg-dim)",
  }} />;
}

function repoRollup(repoId: string, structure: Milestone[] = []): { ms: Milestone[]; iss: Issue[]; pct: number } {
  const ms = structFor(repoId, structure);
  const iss = ms.flatMap((m) => m.epics.flatMap((e) => e.issues));
  const pct = ms.length ? ms.reduce((a, m) => a + m.pct, 0) / ms.length : 0;
  return { ms, iss, pct };
}

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

function AgentsA({ agents = [], onPerm, onPreset, onFlow }: {
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

/** One row of the required-context checklist (#1061): names a required topic's `<topic>.md`
 *  and whether it's been written yet, so the user sees exactly which files the gate still needs. */
function RequiredCtxRow({ topic, written }: { topic: string; written: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 7, padding: "4px 7px", borderRadius: 5,
      fontFamily: "var(--mono)", fontSize: 10,
    }}>
      <span style={{ width: 12, textAlign: "center", color: written ? "var(--success)" : "var(--fg-dim)" }}>
        {written ? "✓" : "○"}
      </span>
      <span style={{ flex: 1, color: written ? "var(--fg-muted)" : "var(--fg)" }}>{topic}.md</span>
      {!written && (
        <span style={{ fontSize: 8.5, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--danger)" }}>
          missing
        </span>
      )}
    </div>
  );
}

function FocusedContextBody({ context, onView, requiredContext }: {
  context?: ContextFile[]; onView?: (f: ContextFile) => void; requiredContext?: string[];
}) {
  const files = context ?? [];
  const required = requiredContext ?? [];
  // A topic is satisfied once its `<topic>.md` exists (the gate keys on generation, #1028).
  const written = new Set(files.map((f) => f.name.replace(/\.md$/i, "")));
  const missingCount = required.filter((t) => !written.has(t)).length;
  if (files.length === 0 && required.length === 0) {
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
      {required.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", padding: "0 2px 6px", gap: 8 }}>
            <span className="ulabel">required files</span>
            <span style={{ flex: 1 }} />
            <span style={{
              fontFamily: "var(--mono)", fontSize: 9,
              color: missingCount === 0 ? "var(--success)" : "var(--fg-dim)",
            }}>
              {required.length - missingCount}/{required.length} written
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {required.map((t) => <RequiredCtxRow key={t} topic={t} written={written.has(t)} />)}
          </div>
        </div>
      )}
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
  const view = (() => {
    switch (phaseKey) {
      case "purpose":         return <PurposeView {...common} />;
      case "bp_stages":       return <StagesView {...common} selectedUid={sel} onSelectStage={setSelStage} />;
      case "bp_capabilities": return <CapabilitiesView {...common} />;
      case "bp_review":       return <PublishView {...common} onPublish={wiring.onPublish} published={wiring.published} />;
      default:                return null;
    }
  })();
  if (!view) return null;
  // blueprints.css scopes every component rule under `.bp-page`; the focused pane has no such
  // ancestor, so the views render unstyled without this wrapper. `bpwrap` neutralizes .bp-page's
  // own page-level layout and adds the focused-pane label/spacing tweaks (#923, ported from ba.css).
  // No own padding — `.fp .pp-scroll` already pads the body (14px 16px 18px), matching every pane.
  return <div className="bp-page bpwrap">{view}</div>;
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
          <div
            key={f.slug}
            className={"feature-card" + (done ? " done" : "") + (isOpen ? " open" : "")}
            onClick={hasDetail ? () => toggle(f.slug) : undefined}
            style={{ cursor: hasDetail ? "pointer" : "default" }}
          >
            <div className="feature-head">
              <span className="feature-caret">{hasDetail ? (isOpen ? "▼" : "▶") : ""}</span>
              <span className="sdot" style={{ background: done ? "var(--success)" : "var(--fg-dim)" }} />
              <span className="feature-name">{f.name}</span>
              <span style={{ flex: 1 }} />
              <span className={"feature-badge" + (done ? " done" : "")}>{done ? "✓ defined" : "○ drafting"}</span>
            </div>
            {f.behavior && <div className="feature-behavior">{f.behavior}</div>}

            {isOpen ? (
              <div
                className="feature-detail"
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: "default" }}
              >
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
function FocusedPlanBody({ data }: {
  data?: ProjectPaneData;
}) {
  const [focus, setFocus] = useState<RelFocus>(null);
  const [hover, setHover] = useState<string | null>(null);
  const phases = data?.phaseStructure ?? [];

  // Agent-relationship graph (#…): the typed coordination graph over the fleet streams.
  const artifacts = data?.relationshipArtifacts ?? [];
  const edges = data?.relationships ?? [];
  const topology = (data?.topology ?? "hybrid") as Topology;
  // Renders for ANY planned fleet (≥1 stream) — and, before the fleet is authored, straight from
  // the FEATURES (a feature IS a stream; #plan-db), so the stream graph shows during the Structure
  // stage. `relationships` (edges) falls back to dependsOn-derived edges in projectPaneData.
  const relGraph = useMemo(() => {
    const nodes = (data?.agents?.length ?? 0) > 0
      ? (data?.agents ?? []).map((a) => ({ id: a.id, role: a.role, repo: a.repo, owns: a.owns }))
      : (data?.features ?? []).map((f) => ({ id: f.slug, role: "worker" as const, repo: "", owns: [] }));
    return nodes.length ? buildRelationshipGraph(nodes, artifacts, edges, topology) : null;
  }, [data?.agents, data?.features, artifacts, edges, topology]);
  const hasRel = !!relGraph;

  if (phases.length === 0 && !hasRel) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◫</span>
        <span>No plan yet — define the features, then Claude drafts the phases + seams</span>
      </div>
    );
  }

  const kindsUsed = relGraph ? [...new Set(edges.map((e) => e.kind))] : [];
  const cycleN = relGraph?.cycleEdgeIds.size ?? 0;
  const gatePass = !relGraph?.hasCycle;
  const focusName = focus ? (focus.type === "agent" ? focus.id : `contract:${focus.id}`) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {relGraph && (
        <div>
          {/* header: gate pill + topology + edge-kind legend */}
          <div className="ulabel" style={{ paddingBottom: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            agent relationships
            <span data-testid="relationship-gate" style={{
              display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 9, padding: "2px 9px", borderRadius: 99, textTransform: "none",
              color: gatePass ? "var(--success)" : "var(--danger)",
              background: `color-mix(in oklch, ${gatePass ? "var(--success)" : "var(--danger)"}, transparent 86%)`,
              border: `1px solid color-mix(in oklch, ${gatePass ? "var(--success)" : "var(--danger)"}, transparent 58%)`,
            }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: gatePass ? "var(--success)" : "var(--danger)", animation: gatePass ? undefined : "pulse 1.1s ease-in-out infinite" }} />
              {gatePass ? "no dependency cycles" : `gate blocked · ${cycleN} edge${cycleN === 1 ? "" : "s"} in a cycle`}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", textTransform: "none" }}>topology · {topology}</span>
            <span style={{ flex: 1 }} />
            {kindsUsed.map((k) => (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)", textTransform: "none" }}>
                <span style={{ width: 12, height: 2.5, borderRadius: 2, background: EDGE_KIND_META[k].color, display: "inline-block" }} />{EDGE_KIND_META[k].label}
              </span>
            ))}
          </div>
          {/* focus bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "5px 2px 8px" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: focus ? "var(--accent)" : "var(--fg-dim)" }}>
              {focus ? `◆ focused: ${focusName} — its relationships are spotlit; others dimmed` : "hover a stream to spotlight its relationships · click to pin"}
            </span>
            <span style={{ flex: 1 }} />
            {focus && <button className="mini" onClick={() => { setFocus(null); setHover(null); }} style={{ fontSize: 9 }}>clear focus ✕</button>}
          </div>
          <RelationshipGraphView
            graph={relGraph}
            focus={focus}
            hover={hover}
            onHover={setHover}
            onFocusAgent={(id) => setFocus((f) => (f && f.type === "agent" && f.id === id ? null : { type: "agent", id }))}
            onInspectEdge={(id) => setFocus({ type: "edge", id })}
            onInspectArtifact={(id) => setFocus({ type: "art", id })}
          />
          {/* relationship inspector */}
          <div style={{ marginTop: 10, padding: "12px 13px", borderRadius: 8, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)" }}>
            <RelationshipInspector
              graph={relGraph}
              focus={focus}
              onFocusAgent={(id) => setFocus({ type: "agent", id })}
              onInspectArtifact={(id) => setFocus({ type: "art", id })}
              onInspectEdge={(id) => setFocus({ type: "edge", id })}
            />
          </div>
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
    </div>
  );
}

// The focused Permissions stage (#817): the fleet's streams as least-privilege agent rows
// (posture bar + per-stream editor), plus the "generate profiles" action that materializes the
// profiles the stage's `profilesComplete` gate requires. Previously a hardcoded "No agents yet"
// stub that never rendered the fleet — so the stage looked empty even with streams planned.
function FocusedPermissionsBody({ data, onPerm, onPreset, onFlow, onGenerateProfiles, onTopology, onDirectorDrive }: {
  data?: ProjectPaneData;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onGenerateProfiles?: () => void;
  /** Set the project's coordination topology (#…). */
  onTopology?: (t: Topology) => void;
  /** Set the director's drive mode (#…) — only meaningful when the topology routes through it. */
  onDirectorDrive?: (d: DirectorDrive) => void;
}) {
  const agents = data?.agents ?? [];
  const topology = (data?.topology ?? "hybrid") as Topology;
  // The director is in play unless the topology is pure peer mesh.
  const hub = topology !== "peer";
  const drive = data?.director?.drive ?? "event";
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
      {/* Coordination topology (#…): how agents relate — director-orchestrated, peer mesh,
          or hybrid. Reflected live in the Structure relationship graph. */}
      <div data-testid="topology-control" style={{
        padding: "9px 11px", marginBottom: 8, borderRadius: 8,
        background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".07em", color: "var(--fg-dim)" }}>coordination</span>
          <div style={{ display: "flex", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
            {TOPOLOGY_OPTS.map((t) => (
              <button
                key={t.id}
                onClick={() => onTopology?.(t.id)}
                disabled={!onTopology}
                title={t.hint}
                style={{
                  height: 26, padding: "0 11px", border: 0, cursor: onTopology ? "pointer" : "default",
                  fontFamily: "var(--mono)", fontSize: 10.5,
                  background: topology === t.id ? "var(--bg-elev2)" : "transparent",
                  color: topology === t.id ? "var(--fg)" : "var(--fg-dim)",
                }}
              >{t.label}</button>
            ))}
          </div>
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
          {TOPOLOGY_OPTS.find((t) => t.id === topology)?.hint} · configure individual relationships on the Structure graph.
        </div>
        {/* Director drive — only when the topology routes through a director (#…). */}
        {hub && (
          <div data-testid="director-drive-control" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border-soft)" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)" }}>director drive</span>
            <div style={{ display: "flex", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
              {DIRECTOR_DRIVES.map((d) => (
                <button
                  key={d}
                  onClick={() => onDirectorDrive?.(d)}
                  disabled={!onDirectorDrive}
                  title={DRIVE_HINTS[d]}
                  style={{
                    height: 24, padding: "0 9px", border: 0, cursor: onDirectorDrive ? "pointer" : "default",
                    fontFamily: "var(--mono)", fontSize: 9.5,
                    background: drive === d ? "var(--bg-elev2)" : "transparent",
                    color: drive === d ? "var(--fg)" : "var(--fg-dim)",
                  }}
                >{d}</button>
              ))}
            </div>
          </div>
        )}
      </div>
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

function FocusedPhaseBody({ phase, data, projectId, authoring, onLinkRepo, onView, onPerm, onPreset, onFlow, onGenerateProfiles, onTopology, onDirectorDrive, onToggleMcp, onBuildMcp, onAddMcp, onRemoveMcp, onDeployChange, requiredContext }: {
  phase: Phase;
  data?: ProjectPaneData;
  projectId?: string;
  /** Required-context topics for the Context body's written/missing checklist (#1061). */
  requiredContext?: string[];
  /** Authoring-lifecycle wiring (#923) — present only for a blueprint-authoring project. */
  authoring?: AuthoringWiring;
  onLinkRepo?: (r: string) => void;
  /** Deploy stage (#919): persist the edited deployment config. */
  onDeployChange?: (next: DeployConfig) => void;
  onView?: (f: ContextFile) => void;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onGenerateProfiles?: () => void;
  onTopology?: (t: Topology) => void;
  onDirectorDrive?: (d: DirectorDrive) => void;
  onToggleMcp?: (id: string) => void;
  onBuildMcp?: (s: McpServer) => void;
  onAddMcp?: (input: string) => void;
  onRemoveMcp?: (id: string) => void;
}) {
  switch (phase.key) {
    case "source":
      return <FocusedSourceBody projectId={projectId} />;
    case "collectTargets":
      return <FocusedTargetsBody projectId={projectId} />;
    case "sourceLicensing":
      return <FocusedLegitimacyBody projectId={projectId} />;
    case "dataAcquire":
      return <FocusedAcquireBody projectId={projectId} />;
    case "dataExtract":
      return <FocusedExtractBody projectId={projectId} />;
    case "dataModel":
      return <FocusedModelBody projectId={projectId} />;
    case "dataMap":
      return <FocusedMappingBody projectId={projectId} />;
    case "dataClean":
      return <FocusedCleaningBody projectId={projectId} />;
    case "dataLoad":
      return <FocusedLoadBody projectId={projectId} />;
    case "repos":
      return <FocusedReposBody repos={data?.repos} onLinkRepo={onLinkRepo} />;
    case "deploy":
      return <FocusedDeployBody deploy={data?.deploy} onChange={onDeployChange} dependencies={data?.dependencies} registries={data?.registries} />;
    case "context":
      return <FocusedContextBody context={data?.context} onView={onView} requiredContext={requiredContext} />;
    case "ui":
      // The UI stage's drop-in-files surface (#604/#829): stage design assets into the
      // project's `design/` dir for the planner to route. The pipeline-screen registry that
      // hosted this was orphaned by the focused-pane refactor — render it directly here.
      return <FileIntakePane projectKey={projectId ?? ""} />;
    case "features":
      return <FocusedFeaturesBody features={data?.features} />;
    case "structure":
      return <FocusedPlanBody data={data} />;
    case "permissions":
      return <FocusedPermissionsBody data={data} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} onGenerateProfiles={onGenerateProfiles} onTopology={onTopology} onDirectorDrive={onDirectorDrive} />;
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
   ProjectPane — main export
   ================================================================= */
export function ProjectPane({
  data,
  projectId,
  onPerm,
  onPreset,
  onFlow,
  // focused mode: one-phase sequenced rail (#652) — the only render mode (#1061)
  focus,
  onLinkRepo,
  onGenerateProfiles,
  onTopology,
  onDirectorDrive,
  onToggleMcp,
  onBuildMcp,
  onAddMcp,
  onRemoveMcp,
  onDeployChange,
}: {
  data?: ProjectPaneData;
  projectId?: string;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  /** The sequenced-rail focused mode (#652) — the sole render path (#1061 removed the legacy
   *  staged/flat view + its hardcoded PLAN_STAGES gate). */
  focus?: {
    phases: Phase[];
    selectedIdx: number;
    activeIdx: number;
    onSelect: (i: number) => void;
    pill: GatePill;
    footer: { kind: FooterKind; enabled: boolean; canSkip?: boolean };
    onBack: () => void;
    onPrimary: () => void;
    /** Skip the active OPTIONAL stage (#921) — rendered when `footer.canSkip`. */
    onSkip?: () => void;
    /** The project already has a GitHub board — the publish action reads as "Update GitHub" (#823). */
    published?: boolean;
    /** Override the footer publish label (#923) — "Publish blueprint" for an authoring project. */
    publishLabel?: string;
    /** Blueprint-authoring wiring (#923) — present only for an authoring project; drives the
     *  interactive Purpose/Stages/Capabilities/Review editor views. */
    authoring?: AuthoringWiring;
    /** The selected stage's injectable prompts + inject handler — drives the header "?" helper (#…),
     *  replacing the removed auto-injecting conductor. */
    promptHelp?: { prompts: StagePrompt[]; onInject: (text: string) => void };
    /** The project's live required-context topics (#1061) — the Context body lists each by name
     *  with written/missing state so the user sees exactly which files the gate still needs. */
    requiredContext?: string[];
  };
  /** Callback to link a repository from the focused repos body (#677). */
  onLinkRepo?: (repo: string) => void;
  /** Materialize least-privilege profiles for every fleet stream (#817) — what the focused
   *  Permissions stage needs to satisfy its `profilesComplete` gate. */
  onGenerateProfiles?: () => void;
  /** Set the project's coordination topology (#…) — director / peer / hybrid. */
  onTopology?: (t: Topology) => void;
  /** Set the director's drive mode (#…) — event / heartbeat / manual / off. */
  onDirectorDrive?: (d: DirectorDrive) => void;
  /** MCP stage (#878): toggle a server's fleet grant, download+build it, add a new one
   *  (catalog name / command / URL), or remove it. */
  onToggleMcp?: (id: string) => void;
  onBuildMcp?: (s: McpServer) => void;
  onAddMcp?: (input: string) => void;
  onRemoveMcp?: (id: string) => void;
  /** Deploy stage (#919): persist the edited deployment config. */
  onDeployChange?: (next: DeployConfig) => void;
}) {
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

  // Focused mode: sequenced-rail one-phase view (#652)
  if (focus) {
    const selected = focus.phases[focus.selectedIdx];
    const active   = focus.phases[focus.activeIdx];
    const isLocked = focus.selectedIdx > focus.activeIdx;
    return (
      <div className="pp fp">
        <FocusedStepper phases={focus.phases} selectedIdx={focus.selectedIdx} onSelect={focus.onSelect} />
        <FocusedPhaseHeader phase={selected} pill={focus.pill} promptHelp={focus.promptHelp} />
        {isLocked && <FocusedLockBanner activeName={active?.name ?? ""} />}
        <div className="pp-scroll">
          <FocusedPhaseBody phase={selected} data={data} projectId={projectId} authoring={focus.authoring} onLinkRepo={onLinkRepo} onView={setViewing}
            onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} onGenerateProfiles={onGenerateProfiles} onTopology={onTopology} onDirectorDrive={onDirectorDrive}
            onToggleMcp={onToggleMcp} onBuildMcp={onBuildMcp} onAddMcp={onAddMcp} onRemoveMcp={onRemoveMcp} onDeployChange={onDeployChange} requiredContext={focus.requiredContext} />
        </div>
        <FocusedPhaseFooter phase={selected} action={focus.footer} published={focus.published} publishLabel={focus.publishLabel} onBack={focus.onBack} onPrimary={focus.onPrimary} onSkip={focus.onSkip} />
        {viewerModal}
      </div>
    );
  }

  return null;
}
