// Agents screen (#236, made real in #255) — permission profiles, console/pane
// assignments & an audit feed. Profiles + assignments are now persisted in the store
// and ENFORCED at session launch via profileEnforcement → ensure_session_settings
// (the same gate as the role model). Shell allowlists resolve additively (guaranteed ∪
// profile ∪ project ∪ repo); gh/git are guaranteed; a profile layers a base policy +
// per-tool tri-states + path scope. Data model + helpers live in ./agentProfiles.
// (The Activity feed is still sample data — a real audit log is a follow-up.)
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { TabBar, type TabItem } from "@/app/chrome/TabBar";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import {
  APP_ROLES, TOOL_DEFS, GUARANTEED,
  MODE_LABEL, resolveAllowlistFrom, paneCount, consoleCount,
} from "./lib/agentProfiles";
import type { AgentProfile, ConsoleSession, ConsolePane, Tier, ToolKey } from "./lib/agentProfiles";
import { resolveProfileSettings } from "./lib/profileEnforcement";
import { parseAuditLog, toRow, decideAudit, type AuditDecision, type AuditKind, type ResolvedGate } from "./lib/auditLog";
import { roleCapability, roleWriteRules } from "@/shared/lib/session/sessionRoles";
import {
  ingestCoordLog, coordinationSummary, wakePromptFor, emptyCoordState,
  type BlockedView, type Waiter, type CoordState,
} from "@/shared/lib/fleet/coordination";
import { actuateWake } from "@/shared/lib/fleet/coordinatorActuate";
import type { WorkflowRun } from "@/shared/lib/fleet/conductor";
import { useAppStore } from "@/store";
import "./agents.css";

type DecFilter = "all" | "allow" | "ask" | "block";

/** A computed audit row for the Activity table. */
interface AuditDisplayRow {
  ts: string;
  console: string;
  pane: string;
  profileId: string;
  kind: AuditKind;
  target: string;
  decision: AuditDecision;
}

const initialOf = (name: string) => name.replace(/[^a-z]/gi, "").slice(0, 2).toUpperCase();
const modeColor = (m: Tier) => m === "deny" ? "var(--danger)" : m === "ask" ? "var(--accent)" : "var(--success)";

export function AgentsScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  const [selectedId, setSelectedId] = useState("sys_planner");
  const [actDecision, setActDecision] = useState<DecFilter>("all");
  const [actConsole, setActConsole] = useState("all");

  // Persisted profiles + assignment (#255); console panes come from the real workspace.
  const profiles = useAppStore((s) => s.agentProfiles);
  const updateAgentProfile = useAppStore((s) => s.updateAgentProfile);
  const setAgentProfiles = useAppStore((s) => s.setAgentProfiles);
  const setPaneProfile = useAppStore((s) => s.setPaneProfile);
  const tabs = useAppStore((s) => s.tabs);
  const paneNames = useAppStore((s) => s.paneNames);
  const disabledPanes = useAppStore((s) => s.disabledPanes);
  const paneProfiles = useAppStore((s) => s.paneProfiles);
  const activeRepoName = useAppStore((s) => s.activeRepoName);

  // Coordination & workflows (the Flow tab): the fleet's live work-flow, cross-referenced
  // with the profile each session runs under — the Agents screen's angle on #199/#220.
  const wakePane = useAppStore((s) => s.wakePane);
  const workflowRuns = useAppStore((s) => s.workflowRuns);

  // Application roles are app-managed singletons (display-only here).
  const roles = APP_ROLES;

  // Live console/pane model derived from the real workspace tabs — each tab is a
  // console, each live pane a row. An unassigned pane shows the safe default
  // (Sandboxed) but is only ENFORCED once you assign it a profile.
  const consoles = useMemo<ConsoleSession[]>(() => tabs.map((t, ti) => {
    const [cols, rows] = t.layout.split("×").map(Number);
    const count = (cols || 1) * (rows || 1);
    const panes: ConsolePane[] = [];
    for (let i = 0; i < count; i++) {
      const pid = `t${ti}p${i}`;
      if (disabledPanes[pid]) continue;
      panes.push({
        id: pid,
        agent: paneNames[ti]?.[i] ?? `pane ${i + 1}`,
        status: "idle",
        profileId: paneProfiles[pid] ?? "pf_sandbox",
      });
    }
    return { id: `t${ti}`, name: t.name, repo: activeRepoName ?? "—", status: "running", projectAllow: [], panes };
  }), [tabs, paneNames, disabledPanes, paneProfiles, activeRepoName]);

  // Activity audit (#257): load the real per-pane tool log and derive each decision
  // from the pane's resolved gate (profile ∪ role) — the same rules the launch gate
  // applies. Refreshed while the Activity tab is open.
  const paneRoles = useAppStore((s) => s.paneRoles);
  const [auditRows, setAuditRows] = useState<AuditDisplayRow[]>([]);

  const agentDefs: TabItem[] = useMemo(() => [
    { id: "profiles", label: "Profiles", count: roles.length + profiles.length, hint: "· application + custom roles" },
    { id: "assignments", label: "Assignments", count: consoles.length, hint: "· consoles & panes" },
    { id: "activity", label: "Activity", count: auditRows.length },
    { id: "flow", label: "Flow", count: Object.keys(workflowRuns).length, hint: "· coordination & workflows" },
  ], [roles.length, profiles.length, consoles.length, auditRows.length, workflowRuns]);
  const { tabs: agentTabs, activeId, select, reorder, tearOff } = usePageTabs("agents", agentDefs);
  const tab = sectionOverride ?? activeId; // active section

  usePoll(async (isCancelled) => {
      if (tab !== "activity") return;
      const lines = await safeInvoke<string[]>("read_audit_log", { limit: 300 }, []);
      const records = parseAuditLog(lines.join("\n"));
      const rows = records.map((rec): AuditDisplayRow => {
        const profileId = paneProfiles[rec.pane] ?? "";
        const profile = profiles.find((p) => p.id === profileId);
        const role = paneRoles[rec.pane];
        const roleCap = role ? roleCapability(role) : undefined;
        const prof = profile ? resolveProfileSettings(profile) : null;
        const roleW = roleCap ? roleWriteRules(roleCap) : { allow: [], deny: [] };
        const gate: ResolvedGate = {
          allowedCommands: prof?.allowedCommands ?? [],
          allowToolRules: [...(prof?.allowToolRules ?? []), ...roleW.allow],
          denyToolRules: [...(prof?.denyToolRules ?? []), ...roleW.deny],
        };
        const r = toRow(rec);
        const ti = Number(/^t(\d+)p/.exec(rec.pane)?.[1] ?? "-1");
        return {
          ts: rec.ts,
          console: consoles.find((c) => c.id === `t${ti}`)?.name ?? "—",
          pane: rec.pane,
          profileId: profileId || "—",
          kind: r.kind,
          target: r.target,
          decision: decideAudit(rec, gate, roleCap),
        };
      });
      if (!isCancelled()) setAuditRows(rows);
  }, 3000, [tab, paneProfiles, profiles, paneRoles, consoles]);

  const find = (id: string) => [...roles, ...profiles].find((p) => p.id === id);
  const selected = find(selectedId) ?? profiles[0];

  // Resolve the profile a coord/workflow session (a pane id like `t0p1`) runs under, so the
  // Flow tab can show who is parked/flowing and under which permission profile. Falls back
  // to the safe default when a pane has no explicit assignment.
  const profileFor = useCallback(
    (session: string): AgentProfile | undefined => find(paneProfiles[session] ?? "pf_sandbox"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paneProfiles, profiles],
  );

  // Edits persist to the store. Application-role ids won't match a stored profile, so
  // their controls are effectively read-only (they're system-managed).
  function setMode(m: Tier) { updateAgentProfile(selectedId, { mode: m }); }
  function setTool(t: ToolKey, v: Tier) {
    const p = find(selectedId);
    if (p) updateAgentProfile(selectedId, { tools: { ...p.tools, [t]: v } });
  }
  function removeCmd(c: string) {
    const p = find(selectedId);
    if (p) updateAgentProfile(selectedId, { commands: p.commands.filter((x) => x !== c) });
  }
  function addCmd() {
    const v = window.prompt("Allow which command? (e.g. cargo)");
    const k = v?.trim().toLowerCase();
    const p = find(selectedId);
    if (k && p && !p.commands.includes(k)) updateAgentProfile(selectedId, { commands: [...p.commands, k] });
  }
  function toggleAssign(_consoleId: string, paneId: string) {
    setPaneProfile(paneId, paneProfiles[paneId] === selectedId ? null : selectedId);
  }
  function openProfile(id: string) { select("profiles"); setSelectedId(id); }

  // Create a new user profile (#259): sensible defaults, persisted, then selected.
  function createProfile() {
    const name = window.prompt("New role name?")?.trim();
    if (!name) return;
    const taken = new Set(profiles.map((p) => p.id));
    const base = "pf_" + (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "role");
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const colors = ["oklch(0.7 0.12 290)", "oklch(0.72 0.12 175)", "oklch(0.78 0.14 70)", "oklch(0.68 0.18 25)", "oklch(0.72 0.10 230)"];
    const next: AgentProfile = {
      id, name, color: colors[profiles.length % colors.length],
      category: "user", origin: "user-defined",
      desc: "Custom role.", mode: "ask", commands: [],
      tools: { read: "allow", grep: "allow", glob: "allow", edit: "ask", write: "ask", bash: "ask", web: "ask", task: "ask" },
      paths: { allow: [], deny: [] }, net: { allow: [] }, builtin: false,
    };
    setAgentProfiles([...profiles, next]);
    select("profiles");
    setSelectedId(id);
  }

  // Delete a custom profile (#259): drop it + any pane assignments pointing at it.
  function deleteProfile(id: string) {
    const p = find(id);
    if (!p || p.category === "application" || p.builtin) return;
    if (!window.confirm(`Delete the "${p.name}" role?`)) return;
    setAgentProfiles(profiles.filter((x) => x.id !== id));
    for (const [paneId, pid] of Object.entries(paneProfiles)) {
      if (pid === id) setPaneProfile(paneId, null);
    }
    setSelectedId("sys_planner");
  }

  const editable = selected?.category !== "application";

  const paneTotal = consoles.reduce((a, c) => a + c.panes.length, 0);
  const allow = auditRows.filter((r) => r.decision === "allow").length;
  const ask = auditRows.filter((r) => r.decision === "ask").length;
  const block = auditRows.filter((r) => r.decision === "block").length;

  return (
    <div className="agents-page">
      {!sectionOverride && (
        <TabBar
          tabs={agentTabs}
          activeId={activeId}
          onSelect={select}
          onReorder={reorder}
          onTearOff={tearOff}
          right={
            <>
              {tab === "profiles" && <>
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>{roles.length} application · {profiles.length} custom roles</span>
                <button className="btn primary" onClick={createProfile}>+ New role</button>
              </>}
              {tab === "assignments" && <>
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>resolved · guaranteed ∪ profile ∪ project ∪ repo</span>
                <button className="btn">apply to all panes…</button>
              </>}
              {tab === "activity" && <>
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>live · last 1h</span>
                <button className="btn">pause feed</button>
              </>}
              {tab === "flow" && (
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>live · #199 latches + #220 stages</span>
              )}
            </>
          }
        />
      )}

      <div className="body">
        {tab === "profiles" && (
          <ProfilesTab
            roles={roles} profiles={profiles} consoles={consoles} selected={selected}
            onSelect={setSelectedId} setMode={setMode} setTool={setTool}
            removeCmd={removeCmd} addCmd={addCmd} toggleAssign={toggleAssign} find={find}
            editable={editable} onCreate={createProfile} onDelete={deleteProfile}
          />
        )}
        {tab === "assignments" && (
          <AssignmentsTab
            roles={roles} consoles={consoles} paneTotal={paneTotal}
            profiles={profiles} onAssign={(_c, paneId, profileId) => setPaneProfile(paneId, profileId)}
            onOpen={openProfile} find={find}
          />
        )}
        {tab === "activity" && (
          <ActivityTab
            rows={auditRows} consoles={consoles}
            actDecision={actDecision} setActDecision={setActDecision}
            actConsole={actConsole} setActConsole={setActConsole}
            allow={allow} ask={ask} block={block} find={find}
          />
        )}
        {tab === "flow" && (
          <FlowTab runs={workflowRuns} wakePane={wakePane} profileFor={profileFor} />
        )}
      </div>
    </div>
  );
}

// ── Profiles tab ────────────────────────────────────────────────────────────────

interface ProfilesTabProps {
  roles: AgentProfile[]; profiles: AgentProfile[]; consoles: ConsoleSession[];
  selected: AgentProfile;
  onSelect: (id: string) => void;
  setMode: (m: Tier) => void;
  setTool: (t: ToolKey, v: Tier) => void;
  removeCmd: (c: string) => void;
  addCmd: () => void;
  toggleAssign: (consoleId: string, paneId: string) => void;
  find: (id: string) => AgentProfile | undefined;
  editable: boolean;
  onCreate: () => void;
  onDelete: (id: string) => void;
}

function ProfilesTab(props: ProfilesTabProps) {
  const { roles, profiles, consoles, selected, onSelect, onCreate } = props;
  return (
    <div className="prof-layout">
      <div className="card prof-list">
        <div className="head">
          <div className="head-row">
            <h3>Roles</h3>
            <span className="hint">{roles.length} application · {profiles.length} custom</span>
          </div>
          <input className="input" placeholder="filter…" style={{ marginTop: 8, height: 24, fontSize: 10.5 }} />
        </div>
        <div className="scroll">
          <div className="list-label">Application · always present</div>
          {roles.map((p) => <ProfRow key={p.id} p={p} on={p.id === selected.id} consoles={consoles} onClick={() => onSelect(p.id)} />)}
          <div className="list-label">Custom &amp; generated</div>
          {profiles.map((p) => <ProfRow key={p.id} p={p} on={p.id === selected.id} consoles={consoles} onClick={() => onSelect(p.id)} />)}
          <div style={{ padding: "12px 14px" }}>
            <button className="btn ghost" style={{ width: "100%", justifyContent: "center" }} onClick={onCreate}>+ new role</button>
          </div>
        </div>
      </div>
      <div className="prof-detail"><ProfDetail {...props} p={selected} /></div>
    </div>
  );
}

function ProfRow({ p, on, consoles, onClick }: { p: AgentProfile; on: boolean; consoles: ConsoleSession[]; onClick: () => void }) {
  const isApp = p.category === "application";
  const origin = isApp ? "application" : p.category === "generated" ? "generated" : (p.origin === "built-in" ? "built-in" : "user-defined");
  const obCls = isApp ? "approle" : p.category === "generated" ? "gen" : "";
  return (
    <div className={`prof-row ${isApp ? "approle" : ""} ${on ? "on" : ""}`} onClick={onClick} style={{ ["--pc" as string]: p.color }}>
      <div className="l1">
        <span className="swatch" style={{ background: p.color }} />
        <span className="pname">{p.name}</span>
        <span className="spacer" />
        <span className={`origin-badge ${obCls}`}>{origin}</span>
      </div>
      <div className="l2">
        {isApp
          ? <><span className="sys-pin">◆ owns {p.session}</span><span>· always on</span></>
          : <><span>{paneCount(p.id, consoles)} panes</span><span>· {p.commands.length} cmds</span></>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className={`mode-badge ${p.mode}`} style={{ fontSize: 8.5 }}>{p.mode}</span>
      </div>
    </div>
  );
}

function ProfDetail({ p, consoles, setMode, setTool, removeCmd, addCmd, toggleAssign, find, editable, onDelete }: ProfilesTabProps & { p: AgentProfile }) {
  const isApp = p.category === "application";
  // Application roles are app-managed: lock their policy editors (visually + clicks).
  const lock: CSSProperties | undefined = editable ? undefined : { opacity: 0.55, pointerEvents: "none" };
  const originLabel = isApp ? "application · always on" : p.category === "generated" ? "generated" : (p.origin === "built-in" ? "built-in" : "user-defined");
  const allowPaths = p.paths.allow.length ? p.paths.allow : ["(none — read-only)"];
  return (
    <>
      <div className="pd-head">
        <div className="top">
          <span className="pswatch" style={{ background: p.color }}>{isApp ? "◆" : initialOf(p.name)}</span>
          <div className="pt">
            <div className="nm">
              {p.name}{" "}
              {isApp && <span className="origin-badge approle" style={{ verticalAlign: "middle" }}>application role</span>}
              {p.category === "generated" && <span className="origin-badge gen" style={{ verticalAlign: "middle" }}>generated</span>}
            </div>
            <div className="ds">{p.desc}</div>
          </div>
          {isApp
            ? <><button className="btn ghost" style={{ height: 26, fontSize: 10.5 }}>open {appSessionOpenLabel(p)} →</button><button className="btn" style={{ height: 26, fontSize: 10.5 }}>save</button></>
            : <><button className="btn ghost" style={{ height: 26, fontSize: 10.5 }}>duplicate</button><button className="btn" style={{ height: 26, fontSize: 10.5 }}>save</button></>}
        </div>
        {isApp && (
          <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-soft)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="sys-banner">
              <span className="ico" style={{ background: p.color }}>◆</span>
              <span><b style={{ color: "var(--fg)" }}>System role.</b> Always present in every workspace — can't be deleted or assigned to a console pane. It runs as its own session.</span>
            </div>
            <div className="owns-card">
              <span className="surf">{p.surfaceGlyph}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>Owns {p.owns}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", marginTop: 2 }}>surface · {p.surface} &nbsp;·&nbsp; session · {p.session}</div>
              </div>
              <span className="tag green" style={{ fontSize: 9.5 }}><span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--success)", display: "inline-block", marginRight: 4 }} />running</span>
            </div>
          </div>
        )}
        <div className="pd-stat">
          <div><div className="k">base policy</div><div className="v" style={{ color: modeColor(p.mode) }}>{MODE_LABEL[p.mode]}</div></div>
          <div><div className="k">{isApp ? "scope" : "assigned"}</div><div className="v">{isApp ? "singleton session" : `${paneCount(p.id, consoles)} panes · ${consoleCount(p.id, consoles)} consoles`}</div></div>
          <div><div className="k">commands</div><div className="v">{p.commands.length} + {GUARANTEED.length} guaranteed</div></div>
          <div><div className="k">origin</div><div className="v">{originLabel}</div></div>
        </div>
      </div>

      {/* base policy */}
      <div className="pd-sec" style={lock}>
        <div className="h"><h4>Base policy</h4><span className="hint">applies to anything not listed below</span></div>
        <div className="seg">
          {(["deny", "ask", "allow"] as Tier[]).map((v) => (
            <button key={v} data-v={v} className={p.mode === v ? "on" : ""} onClick={() => setMode(v)}>
              <span className="d" />{v[0].toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* shell commands */}
      <div className="pd-sec" style={lock}>
        <div className="h">
          <h4>Shell commands</h4>
          <span className="hint">allowlist — runs without a prompt</span>
          <span className="spacer" />
          <span className="hint">unions with project + repo lists</span>
        </div>
        <div className="cmd-chips">
          {GUARANTEED.map((c) => (
            <span key={c} className="cmd-chip locked" title="guaranteed by backend — always available"><span style={{ color: "var(--info)" }}>{c}</span></span>
          ))}
          {p.commands.map((c) => (
            <span key={c} className="cmd-chip">{c}<span className="x" onClick={() => removeCmd(c)}>×</span></span>
          ))}
          <button className="cmd-add" onClick={addCmd}>+ add command</button>
        </div>
        <div className="inherit-note">
          <span style={{ color: "var(--info)" }}>ℹ</span>
          <span><b style={{ color: "var(--fg-muted)" }}>{GUARANTEED.join(", ")}</b> are always available.</span>
          <span>Effective list also unions the console's project &amp; repo allowlists at run time.</span>
        </div>
      </div>

      {/* tools */}
      <div className="pd-sec" style={lock}>
        <div className="h"><h4>Tools</h4><span className="hint">per-capability — allow runs silently, ask prompts you, deny blocks</span></div>
        <div className="tool-table">
          {TOOL_DEFS.map(([t, d]) => (
            <div className="tool-row" key={t}>
              <span className="tn">{t}</span>
              <span className="td">{d}</span>
              <span style={{ justifySelf: "end" }}>
                <span className="tri">
                  {(["deny", "ask", "allow"] as Tier[]).map((v) => (
                    <button key={v} data-v={v} className={p.tools[t] === v ? "on" : ""} onClick={() => setTool(t, v)}>{v}</button>
                  ))}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* filesystem */}
      <div className="pd-sec" style={lock}>
        <div className="h"><h4>Filesystem scope</h4><span className="hint">globs the agent may write to / is blocked from</span></div>
        <div className="scope-list">
          {allowPaths.map((g, i) => {
            const placeholder = g.startsWith("(");
            return (
              <div className="scope-line" key={`a${i}`}>
                <span className="gly allow">＋</span>
                <input className="input" defaultValue={g} disabled={placeholder} style={placeholder ? { opacity: 0.5 } : undefined} />
                {!placeholder && <button className="x">×</button>}
              </div>
            );
          })}
          {p.paths.deny.map((g, i) => (
            <div className="scope-line" key={`d${i}`}>
              <span className="gly deny">－</span>
              <input className="input" defaultValue={g} />
              <button className="x">×</button>
            </div>
          ))}
          <button className="cmd-add" style={{ marginTop: 2 }}>+ add path rule</button>
        </div>
      </div>

      {/* network */}
      <div className="pd-sec" style={lock}>
        <div className="h"><h4>Network</h4><span className="hint">hosts the agent may reach (web / fetch tools)</span></div>
        {p.net.allow.length ? (
          <div className="cmd-chips">
            {p.net.allow.map((h) => (
              <span key={h} className="cmd-chip">{h === "*" ? <span style={{ color: "var(--accent)" }}>* all hosts</span> : h}<span className="x">×</span></span>
            ))}
            <button className="cmd-add">+ add host</button>
          </div>
        ) : (
          <div className="inherit-note"><span style={{ color: "var(--fg-dim)" }}>⊘</span> No outbound network. The web / fetch tools are blocked regardless of their tri-state above.</div>
        )}
      </div>

      {/* assignments / ownership */}
      {isApp ? (
        <div className="pd-sec">
          <div className="h"><h4>Session</h4><span className="hint">this role is not assignable — it is its own always-on session</span></div>
          <div className="assign-mini">
            <div className="row on" style={{ cursor: "default" }}>
              <div className="check">◆</div>
              <div>
                <span className="cn">{p.session}</span>
                <div className="pn">{p.surface} · launched at startup · 1 of 1</div>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--success)" }}>always present</div>
            </div>
          </div>
          <div className="inherit-note" style={{ marginTop: 8 }}>
            <span style={{ color: "var(--info)" }}>ℹ</span>
            <span>{appReachNote(p)}</span>
          </div>
        </div>
      ) : (
        <div className="pd-sec">
          <div className="h"><h4>Assigned to</h4><span className="hint">tick the console panes this profile governs</span><span className="spacer" /><span className="hint">a profile can govern many panes</span></div>
          <div className="assign-mini">
            {consoles.flatMap((c) => c.panes.map((pane) => {
              const on = pane.profileId === p.id;
              return (
                <div key={`${c.id}|${pane.id}`} className={`row ${on ? "on" : ""}`} onClick={() => toggleAssign(c.id, pane.id)}>
                  <div className="check">{on ? "✓" : ""}</div>
                  <div>
                    <span className="cn">{c.name} <span style={{ color: "var(--fg-dim)" }}>›</span> {pane.agent}</span>
                    <div className="pn">{c.repo} · {pane.id}</div>
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{on ? "this profile" : `→ ${find(pane.profileId)?.name ?? pane.profileId}`}</div>
                </div>
              );
            }))}
          </div>
        </div>
      )}

      {!(isApp || p.builtin) && (
        <div style={{ padding: "0 2px 6px" }}>
          <button className="btn ghost danger" style={{ height: 26, fontSize: 10.5 }} onClick={() => onDelete(p.id)}>delete profile</button>
        </div>
      )}
    </>
  );
}

// ── Assignments tab ───────────────────────────────────────────────────────────

interface AssignmentsTabProps {
  roles: AgentProfile[]; consoles: ConsoleSession[]; paneTotal: number;
  /** Assignable profiles (the user/custom profiles a pane can run under). */
  profiles: AgentProfile[];
  /** Assign a specific profile to a pane (#681 — replaces the old cycle-to-next). */
  onAssign: (consoleId: string, paneId: string, profileId: string) => void;
  onOpen: (id: string) => void;
  find: (id: string) => AgentProfile | undefined;
}

/** A click-to-open dropdown for picking a pane's profile (#681). */
export function ProfileSelect({ current, profiles, onPick }: {
  current?: AgentProfile; profiles: AgentProfile[]; onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="prof-select" style={{ position: "relative" }} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
      <span className="sw" style={{ background: current?.color }} />
      <span className="nm">{current?.name ?? "—"}</span>
      {current && <span className={`mode-badge ${current.mode}`} style={{ marginLeft: 2 }}>{current.mode}</span>}
      <span className="cv">▾</span>
      {open && (
        <div className="prof-menu" role="listbox" onClick={(e) => e.stopPropagation()}>
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === current?.id}
              className={"prof-opt" + (p.id === current?.id ? " on" : "")}
              onClick={() => { onPick(p.id); setOpen(false); }}
            >
              <span className="sw" style={{ background: p.color }} />
              <span className="nm">{p.name}</span>
              <span className={`mode-badge ${p.mode}`}>{p.mode}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AssignmentsTab({ roles, consoles, paneTotal, profiles, onAssign, onOpen, find }: AssignmentsTabProps) {
  return (
    <>
      <div className="sec-head">
        <h3>Application sessions</h3>
        <span className="hint">always present · one per workspace · role is fixed</span>
        <div className="spacer" />
        <span className="meta">{roles.length} system roles</span>
      </div>
      <div className="asn-grid" style={{ marginBottom: 14 }}>
        <div className="console-card" style={{ borderColor: "color-mix(in oklch, var(--info), transparent 78%)" }}>
          <div className="ch" style={{ background: "color-mix(in oklch, var(--info), transparent 92%)" }}>
            <span className="cdot" style={{ background: "var(--info)" }} />
            <span className="cn">system</span>
            <span className="repo">workspace-wide</span>
            <span className="spacer" />
            <span className="hint" style={{ fontFamily: "var(--mono)" }}>launched at startup · not reassignable</span>
          </div>
          {roles.map((p) => <AppSessionRow key={p.id} p={p} onOpen={onOpen} />)}
        </div>
      </div>

      <div className="sec-head">
        <h3>Console sessions</h3>
        <span className="hint">each pane runs under one profile · the resolved command allowlist shows what actually runs there</span>
        <div className="spacer" />
        <span className="meta">{consoles.length} consoles · {paneTotal} panes</span>
      </div>
      <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        <div className="asn-grid">
          {consoles.map((c) => (
            <div className="console-card" key={c.id}>
              <div className="ch">
                <span className="cdot" />
                <span className="cn">{c.name}</span>
                <span className="repo">{c.repo}</span>
                <span className="spacer" />
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>
                  project allow: {(c.projectAllow || []).join(", ") || "—"}{c.repoAllow ? ` · repo: ${c.repoAllow.join(", ")}` : ""}
                </span>
              </div>
              {c.panes.map((pane) => {
                const p = find(pane.profileId);
                const resolved = resolveAllowlistFrom(c, p);
                return (
                  <div className="pane-row" key={pane.id}>
                    <div className="pident">
                      <span className={`pdot ${pane.status}`} />
                      <span className="pa">{pane.agent}</span>
                      <span className="pstat">{pane.id}</span>
                    </div>
                    <ProfileSelect current={p} profiles={profiles} onPick={(id) => onAssign(c.id, pane.id, id)} />
                    <div className="resolved">
                      <span className="lbl">runs:</span>
                      {resolved.map((r) => (
                        <span key={r.cmd} className={`rchip ${r.origin === "guaranteed" ? "guar" : ""}`} title={`from ${r.origin}`}>{r.cmd}</span>
                      ))}
                      {resolved.length === 0 && <span className="rchip">— prompt for everything —</span>}
                    </div>
                    <div style={{ justifySelf: "end" }}>
                      <button className="btn ghost" style={{ height: 24, fontSize: 10 }} onClick={() => onOpen(pane.profileId)}>edit profile →</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// Short type chip for an app-session row, distinct per role. Was a planner-or-else-librarian
// binary (#236, two roles only) that collapsed every non-planner app role to "librarian" once
// Blueprint Assistant (#680) + Planning Autopilot (#693) were added (#740). Data-driven now:
// known roles get a tailored icon+label; any future role derives one from its own fields.
export function appSessionTag(p: AgentProfile): string {
  switch (p.id) {
    case "sys_planner":             return "⌨ planner";
    case "sys_blueprint_assistant": return "✦ blueprint";
    case "sys_planning_autopilot":  return "◇ autopilot";
    default:                        return `${p.surfaceGlyph ?? "◆"} ${(p.name.split(" ")[0] ?? "role").toLowerCase()}`;
  }
}

/** The surface the app-role's "open … →" button points at — distinct per role (#740). */
export function appSessionOpenLabel(p: AgentProfile): string {
  switch (p.id) {
    case "sys_planner":             return "planner";
    case "sys_blueprint_assistant": return "blueprints";
    case "sys_planning_autopilot":  return "settings";
    default:                        return (p.surface ?? "surface").toLowerCase();
  }
}

/** How other sessions interact with an app role — role-correct (the one-shot helpers aren't
 *  reached by other agents at all, so they don't get the planner/librarian reach note) (#740). */
export function appReachNote(p: AgentProfile): string {
  const first = p.name.split(" ")[0];
  switch (p.id) {
    case "sys_planner":   return `Other agents reach ${first} through the Plan surface — not by being assigned this role.`;
    default:              return `${first} runs on demand as a one-shot helper — it isn't reached by other agents, and can't be assigned to a pane.`;
  }
}

function AppSessionRow({ p, onOpen }: { p: AgentProfile; onOpen: (id: string) => void }) {
  const all = [
    ...GUARANTEED.map((c) => ({ cmd: c, origin: "guaranteed" as const })),
    ...p.commands.map((c) => ({ cmd: c, origin: "profile" as const })),
  ];
  return (
    <div className="pane-row">
      <div className="pident">
        <span className="pdot running" />
        {/* Title (type) over subtitle (session) so longer names don't clip (#740). */}
        <div className="psess">
          <span className="pa">{appSessionTag(p)}</span>
          <span className="pstat">{p.session}</span>
        </div>
      </div>
      <div className="prof-select" onClick={() => onOpen(p.id)}>
        <span className="sw" style={{ background: p.color }} />
        <span className="nm">{p.name}</span>
        <span className="origin-badge approle" style={{ marginLeft: 2 }}>locked</span>
      </div>
      <div className="resolved">
        <span className="lbl">runs:</span>
        {all.map((r) => (
          <span key={r.cmd} className={`rchip ${r.origin === "guaranteed" ? "guar" : ""}`} title={`from ${r.origin}`}>{r.cmd}</span>
        ))}
        <span className="rchip" style={{ borderStyle: "dashed" }}>owns {p.surface}</span>
      </div>
      <div style={{ justifySelf: "end" }}>
        <button className="btn ghost" style={{ height: 24, fontSize: 10 }} onClick={() => onOpen(p.id)}>edit role →</button>
      </div>
    </div>
  );
}

// ── Activity tab ──────────────────────────────────────────────────────────────

interface ActivityTabProps {
  rows: AuditDisplayRow[];
  consoles: ConsoleSession[];
  actDecision: DecFilter; setActDecision: (d: DecFilter) => void;
  actConsole: string; setActConsole: (c: string) => void;
  allow: number; ask: number; block: number;
  find: (id: string) => AgentProfile | undefined;
}

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString("en-US", { hour12: false });
};

function ActivityTab({ rows, consoles, actDecision, setActDecision, actConsole, setActConsole, allow, ask, block, find }: ActivityTabProps) {
  const shown = rows.filter((r) => {
    if (actDecision !== "all" && r.decision !== actDecision) return false;
    if (actConsole !== "all" && r.console !== actConsole) return false;
    return true;
  });
  const decChip = (d: DecFilter, label: string, n?: number) => (
    <span className={`dchip ${actDecision === d ? "on" : ""}`} data-d={d === "all" ? undefined : d} onClick={() => setActDecision(d)}>
      <span className="dot" />{label}{n !== undefined && <span style={{ color: "var(--fg-dim)", marginLeft: 2 }}>{n}</span>}
    </span>
  );
  return (
    <>
      <div className="summary">
        <div className="card"><div className="k">decisions</div><div className="v">{rows.length}</div><div className="sub">across {consoles.length} consoles</div></div>
        <div className="card"><div className="k">auto-allowed</div><div className="v success">{allow}</div><div className="sub">ran without a prompt</div></div>
        <div className="card"><div className="k">prompted</div><div className="v accent">{ask}</div><div className="sub">you confirmed</div></div>
        <div className="card"><div className="k">blocked</div><div className="v danger">{block}</div><div className="sub">policy denied</div></div>
      </div>

      <div className="act-toolbar">
        <span className="lbl">decision</span>
        <div style={{ display: "flex", gap: 4 }}>
          {decChip("all", "all")}
          {decChip("allow", "allowed", allow)}
          {decChip("ask", "asked", ask)}
          {decChip("block", "blocked", block)}
        </div>
        <span className="lbl" style={{ marginLeft: 14 }}>console</span>
        <select className="input" style={{ width: 200 }} value={actConsole} onChange={(e) => setActConsole(e.target.value)}>
          <option value="all">all consoles</option>
          {consoles.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <div className="spacer" />
        <span className="hint" style={{ fontFamily: "var(--mono)" }}>per the configured policy</span>
      </div>

      <div className="act-table">
        <div className="act-row head">
          <span>time</span><span>console › pane</span><span>profile</span><span>command / action</span><span>decision</span>
        </div>
        {shown.length === 0 && (
          <div style={{ padding: "18px 14px", fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-dim)" }}>
            No activity yet. Tool attempts are logged once a pane has a profile or role assigned.
          </div>
        )}
        {shown.map((r, i) => {
          const p = find(r.profileId);
          const sym = r.decision === "allow" ? "✓" : r.decision === "ask" ? "◑" : "✗";
          const decLabel = r.decision === "allow" ? "allowed" : r.decision === "ask" ? "asked" : "blocked";
          const kindGlyph = r.kind === "cmd" ? "$" : r.kind === "net" ? "⇡" : "⚒";
          return (
            <div className="act-row" key={i}>
              <span className="when">{fmtTime(r.ts)}</span>
              <span style={{ color: "var(--fg-muted)" }}>{r.console} <span style={{ color: "var(--fg-dim)" }}>›</span> {r.pane}</span>
              <span className="prof">{p && <span className="sw" style={{ background: p.color }} />}{p?.name ?? r.profileId}</span>
              <span className="cmd"><span style={{ color: "var(--fg-dim)" }}>{kindGlyph}</span> {r.target}</span>
              <span className={`dec ${r.decision}`}>{sym} {decLabel}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Flow tab ──────────────────────────────────────────────────────────────────
// The fleet's live work-flow: which sessions are parked on a dependency (#199) and which
// work items are flowing through their workflow stages (#220) — each cross-referenced with
// the permission profile the session runs under. This is the Agents-screen view of
// coordination (the project-wide inbox lives on the Projects board); the angle here is
// "who is blocked/flowing, and under which profile". Coord state is rebuilt from the
// app-wide $BSC_COORD_LOG via read_coord_log + ingestCoordLog, so it needs no store wiring.

const COORD_POLL_MS = 3000;

interface FlowTabProps {
  runs: Record<string, WorkflowRun>;
  wakePane: (paneId: string, prompt: string) => boolean;
  profileFor: (session: string) => AgentProfile | undefined;
}

function depColor(status: BlockedView["deps"][number]["status"]): string {
  return status === "satisfied" ? "var(--success)" : status === "failed" ? "var(--danger)" : "var(--fg-dim)";
}

function stageColor(status: string): string {
  return status === "done" ? "var(--success)" : status === "escalated" ? "var(--danger)" : "var(--accent)";
}

/** A compact "session @ profile" chip — the Agents-screen cross-reference. */
function SessionTag({ session, profile }: { session: string; profile?: AgentProfile }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{session}</h3>
      {profile && (
        <span className="hint" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--mono)", fontSize: 10 }}>
          <span className="sw" style={{ background: profile.color, width: 8, height: 8, borderRadius: 2, display: "inline-block" }} />
          {profile.name}
        </span>
      )}
    </span>
  );
}

function FlowTab({ runs, wakePane, profileFor }: FlowTabProps) {
  const [views, setViews] = useState<BlockedView[]>([]);
  const [ready, setReady] = useState<Waiter[]>([]);
  const [state, setState] = useState<CoordState>(emptyCoordState());
  const [err, setErr] = useState<string | null>(null);
  const [waking, setWaking] = useState<Set<string>>(new Set());

  // Polls only while this tab is mounted (the tab is conditionally rendered).
  usePoll((isCancelled) => {
    invoke<string[]>("read_coord_log", { limit: 1000 })
      .then((lines) => {
        if (isCancelled()) return;
        const r = ingestCoordLog(lines, emptyCoordState());
        setViews(coordinationSummary(r.state));
        setReady(r.ready);
        setState(r.state);
        setErr(null);
      })
      .catch((e) => { if (!isCancelled()) setErr(String(e)); });
  }, COORD_POLL_MS);

  const handleWake = useCallback(async (wtr: Waiter) => {
    setWaking((cur) => new Set(cur).add(wtr.session));
    try {
      await actuateWake(wtr.session, wakePromptFor(wtr, state), wakePane);
    } finally {
      setWaking((cur) => { const n = new Set(cur); n.delete(wtr.session); return n; });
    }
  }, [wakePane, state]);

  const stalled = views.filter((v) => v.stalled).length;
  const deadlocked = views.filter((v) => v.deadlocked).length;
  const runEntries = Object.entries(runs);
  const idle = ready.length === 0 && views.length === 0 && runEntries.length === 0;

  return (
    <div style={{ overflow: "auto", flex: 1, minWidth: 0 }}>
      <div className="summary">
        <div className="card"><div className="k">ready</div><div className="v success">{ready.length}</div><div className="sub">deps landed — wake</div></div>
        <div className="card"><div className="k">blocked</div><div className="v accent">{views.length}</div><div className="sub">parked on a dep</div></div>
        <div className="card"><div className="k">stalled / deadlocked</div><div className="v danger">{stalled + deadlocked}</div><div className="sub">{deadlocked} cyclic · escalate</div></div>
        <div className="card"><div className="k">workflows</div><div className="v">{runEntries.length}</div><div className="sub">work items flowing</div></div>
      </div>

      {deadlocked > 0 && (
        <div className="card" style={{ margin: "0 0 14px", borderColor: "var(--danger)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 12 }}>
            <span>⚠ deadlock</span>
            <span className="hint" style={{ color: "var(--fg-muted)" }}>
              {deadlocked} session{deadlocked === 1 ? "" : "s"} sit in a wait-for cycle — no producer can move. Escalate to the director / break the cycle (#199).
            </span>
          </div>
        </div>
      )}

      {err && <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)", marginBottom: 10 }}>{err}</div>}

      {idle && !err && (
        <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 11.5, padding: "8px 2px" }}>
          The fleet is flowing. Parked sessions appear here when a worker runs <code>bsc-blocked --on &lt;ref&gt;</code>;
          workflow runs appear once a work item is started (Projects → Workflows).
        </div>
      )}

      {ready.length > 0 && (
        <>
          <div className="sec-head"><h3>Ready</h3><span className="hint">dependencies landed — wake the parked pane</span></div>
          <div style={{ marginBottom: 14 }}>
            {ready.map((wtr) => (
              <div key={wtr.session} className="card" style={{ marginBottom: 10, borderColor: "var(--success)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <SessionTag session={wtr.session} profile={profileFor(wtr.session)} />
                  <span className="tag green" style={{ fontSize: 9.5 }}>● ready</span>
                  <div style={{ flex: 1 }} />
                  {wtr.checkpoint && <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>↺ {wtr.checkpoint}</span>}
                  <button
                    className="btn primary"
                    style={{ height: 24, padding: "0 12px", fontSize: 11 }}
                    disabled={waking.has(wtr.session)}
                    onClick={() => handleWake(wtr)}
                  >
                    {waking.has(wtr.session) ? "waking…" : "Wake"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {views.length > 0 && (
        <>
          <div className="sec-head"><h3>Blocked</h3><span className="hint">parked on a dependency · live from the coordination log</span></div>
          {views.map((v) => (
            <div key={v.session} className="card" style={{ marginBottom: 10, borderColor: v.deadlocked || v.stalled ? "var(--danger)" : undefined }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <SessionTag session={v.session} profile={profileFor(v.session)} />
                {v.deadlocked
                  ? <span className="tag" style={{ color: "var(--danger)", fontSize: 9.5 }}>● deadlocked</span>
                  : v.stalled
                    ? <span className="tag" style={{ color: "var(--danger)", fontSize: 9.5 }}>● stalled</span>
                    : <span className="tag" style={{ fontSize: 9.5 }}>waiting</span>}
                <div style={{ flex: 1 }} />
                {v.checkpoint && <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>↺ {v.checkpoint}</span>}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {v.deps.map((d) => (
                  <span key={d.ref} style={{
                    fontFamily: "var(--mono)", fontSize: 11, padding: "3px 8px", borderRadius: 5,
                    border: "1px solid var(--border-soft)", color: depColor(d.status),
                  }}>
                    {d.ref} · {d.status}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {runEntries.length > 0 && (
        <>
          <div className="sec-head"><h3>Workflows</h3><span className="hint">role-staged work items (#220) · the role each stage runs as</span></div>
          {runEntries.map(([id, run]) => {
            const stages = Object.values(run.workflow.stages);
            return (
              <div key={id} className="card" style={{ marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{id}</h3>
                  <span className="hint" style={{ fontSize: 10.5 }}>{run.workflow.name}</span>
                  <span className="tag" style={{ color: stageColor(run.state.status), fontSize: 9.5 }}>● {run.state.status}</span>
                  <div style={{ flex: 1 }} />
                  {run.state.escalation && (
                    <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)" }}>{run.state.escalation}</span>
                  )}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {stages.map((st, i) => {
                    const current = run.state.stage === st.name;
                    const attempts = run.state.attempts[st.name] ?? 0;
                    return (
                      <span key={st.name} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        {i > 0 && <span style={{ color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 10 }}>→</span>}
                        <span style={{
                          fontFamily: "var(--mono)", fontSize: 11, padding: "3px 8px", borderRadius: 5,
                          border: "1px solid " + (current ? "var(--accent)" : "var(--border-soft)"),
                          color: current ? "var(--accent)" : "var(--fg-muted)",
                          background: current ? "var(--bg-elev)" : "transparent",
                        }}>
                          {st.name} <span style={{ color: "var(--fg-dim)", fontSize: 9.5 }}>{st.role}</span>{attempts > 1 ? ` ×${attempts}` : ""}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
