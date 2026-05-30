// Agents screen (#236, made real in #255) — permission profiles, console/pane
// assignments & an audit feed. Profiles + assignments are now persisted in the store
// and ENFORCED at session launch via profileEnforcement → ensure_session_settings
// (the same gate as the role model). Shell allowlists resolve additively (guaranteed ∪
// profile ∪ project ∪ repo); gh/git are guaranteed; a profile layers a base policy +
// per-tool tri-states + path scope. Data model + helpers live in ./agentProfiles.
// (The Activity feed is still sample data — a real audit log is a follow-up.)
import { useMemo, useState } from "react";
import {
  APP_ROLES, TOOL_DEFS, GUARANTEED, ACTIVITY,
  MODE_LABEL, resolveAllowlistFrom, paneCount, consoleCount,
} from "./agentProfiles";
import type { AgentProfile, ConsoleSession, ConsolePane, Tier, ToolKey } from "./agentProfiles";
import { useAppStore } from "../../store";
import "./agents.css";

type Tab = "profiles" | "assignments" | "activity";
type DecFilter = "all" | "allow" | "ask" | "block";

const initialOf = (name: string) => name.replace(/[^a-z]/gi, "").slice(0, 2).toUpperCase();
const modeColor = (m: Tier) => m === "deny" ? "var(--danger)" : m === "ask" ? "var(--accent)" : "var(--success)";

export function AgentsScreen() {
  const [tab, setTab] = useState<Tab>("profiles");
  const [selectedId, setSelectedId] = useState("sys_planner");
  const [actDecision, setActDecision] = useState<DecFilter>("all");
  const [actConsole, setActConsole] = useState("all");

  // Persisted profiles + assignment (#255); console panes come from the real workspace.
  const profiles = useAppStore((s) => s.agentProfiles);
  const updateAgentProfile = useAppStore((s) => s.updateAgentProfile);
  const setPaneProfile = useAppStore((s) => s.setPaneProfile);
  const tabs = useAppStore((s) => s.tabs);
  const paneNames = useAppStore((s) => s.paneNames);
  const disabledPanes = useAppStore((s) => s.disabledPanes);
  const paneProfiles = useAppStore((s) => s.paneProfiles);
  const activeRepoName = useAppStore((s) => s.activeRepoName);

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

  const find = (id: string) => [...roles, ...profiles].find((p) => p.id === id);
  const selected = find(selectedId) ?? profiles[0];

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
  function cycleProfile(_consoleId: string, paneId: string) {
    const cur = paneProfiles[paneId] ?? "pf_sandbox";
    const idx = profiles.findIndex((p) => p.id === cur);
    setPaneProfile(paneId, profiles[(idx + 1) % profiles.length].id);
  }
  function openProfile(id: string) { setTab("profiles"); setSelectedId(id); }

  const paneTotal = consoles.reduce((a, c) => a + c.panes.length, 0);
  const allow = ACTIVITY.filter((r) => r[6] === "allow").length;
  const ask = ACTIVITY.filter((r) => r[6] === "ask").length;
  const block = ACTIVITY.filter((r) => r[6] === "block").length;

  return (
    <div className="agents-page">
      <div className="subtabs">
        {([
          ["profiles", "Profiles", roles.length + profiles.length, "· application + custom roles"],
          ["assignments", "Assignments", consoles.length, "· consoles & panes"],
          ["activity", "Activity", ACTIVITY.length, ""],
        ] as [Tab, string, number, string][]).map(([k, label, count, hint]) => (
          <div key={k} className={`t ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>
            {label} <span className="count">{count}</span>
            {hint && <span className="hint-inline">{hint}</span>}
          </div>
        ))}
        <div className="right">
          {tab === "profiles" && <>
            <span className="hint" style={{ fontFamily: "var(--mono)" }}>{roles.length} application · {profiles.length} custom roles</span>
            <button className="btn primary">+ New role</button>
          </>}
          {tab === "assignments" && <>
            <span className="hint" style={{ fontFamily: "var(--mono)" }}>resolved · guaranteed ∪ profile ∪ project ∪ repo</span>
            <button className="btn">apply to all panes…</button>
          </>}
          {tab === "activity" && <>
            <span className="hint" style={{ fontFamily: "var(--mono)" }}>live · last 1h</span>
            <button className="btn">pause feed</button>
          </>}
        </div>
      </div>

      <div className="body">
        {tab === "profiles" && (
          <ProfilesTab
            roles={roles} profiles={profiles} consoles={consoles} selected={selected}
            onSelect={setSelectedId} setMode={setMode} setTool={setTool}
            removeCmd={removeCmd} addCmd={addCmd} toggleAssign={toggleAssign} find={find}
          />
        )}
        {tab === "assignments" && (
          <AssignmentsTab
            roles={roles} consoles={consoles} paneTotal={paneTotal}
            onCycle={cycleProfile} onOpen={openProfile} find={find}
          />
        )}
        {tab === "activity" && (
          <ActivityTab
            consoles={consoles} actDecision={actDecision} setActDecision={setActDecision}
            actConsole={actConsole} setActConsole={setActConsole}
            allow={allow} ask={ask} block={block} find={find}
          />
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
}

function ProfilesTab(props: ProfilesTabProps) {
  const { roles, profiles, consoles, selected, onSelect } = props;
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
            <button className="btn ghost" style={{ width: "100%", justifyContent: "center" }}>+ new role</button>
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

function ProfDetail({ p, consoles, setMode, setTool, removeCmd, addCmd, toggleAssign, find }: ProfilesTabProps & { p: AgentProfile }) {
  const isApp = p.category === "application";
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
            ? <><button className="btn ghost" style={{ height: 26, fontSize: 10.5 }}>open {p.surfaceGlyph === "P" ? "planner" : "library"} →</button><button className="btn" style={{ height: 26, fontSize: 10.5 }}>save</button></>
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
      <div className="pd-sec">
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
      <div className="pd-sec">
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
      <div className="pd-sec">
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
      <div className="pd-sec">
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
      <div className="pd-sec">
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
            <span>Other agents reach {p.name.split(" ")[0]} through {p.surfaceGlyph === "P" ? "the Plan surface and commands.json" : "pinned Knowledge blocks"} — not by being assigned this role.</span>
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
          <button className="btn ghost danger" style={{ height: 26, fontSize: 10.5 }}>delete profile</button>
        </div>
      )}
    </>
  );
}

// ── Assignments tab ───────────────────────────────────────────────────────────

interface AssignmentsTabProps {
  roles: AgentProfile[]; consoles: ConsoleSession[]; paneTotal: number;
  onCycle: (consoleId: string, paneId: string) => void;
  onOpen: (id: string) => void;
  find: (id: string) => AgentProfile | undefined;
}

function AssignmentsTab({ roles, consoles, paneTotal, onCycle, onOpen, find }: AssignmentsTabProps) {
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
            <span className="repo">workspace · acme/payments</span>
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
                    <div className="prof-select" onClick={() => onCycle(c.id, pane.id)}>
                      <span className="sw" style={{ background: p?.color }} />
                      <span className="nm">{p?.name}</span>
                      {p && <span className={`mode-badge ${p.mode}`} style={{ marginLeft: 2 }}>{p.mode}</span>}
                      <span className="cv">▾</span>
                    </div>
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

function AppSessionRow({ p, onOpen }: { p: AgentProfile; onOpen: (id: string) => void }) {
  const all = [
    ...GUARANTEED.map((c) => ({ cmd: c, origin: "guaranteed" as const })),
    ...p.commands.map((c) => ({ cmd: c, origin: "profile" as const })),
  ];
  return (
    <div className="pane-row">
      <div className="pident">
        <span className="pdot running" />
        <span className="pa">{p.surfaceGlyph === "P" ? "⌨ planner" : "⌬ librarian"}</span>
        <span className="pstat">{p.session}</span>
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
  consoles: ConsoleSession[];
  actDecision: DecFilter; setActDecision: (d: DecFilter) => void;
  actConsole: string; setActConsole: (c: string) => void;
  allow: number; ask: number; block: number;
  find: (id: string) => AgentProfile | undefined;
}

function ActivityTab({ consoles, actDecision, setActDecision, actConsole, setActConsole, allow, ask, block, find }: ActivityTabProps) {
  const rows = ACTIVITY.filter((r) => {
    if (actDecision !== "all" && r[6] !== actDecision) return false;
    if (actConsole !== "all" && r[1] !== actConsole) return false;
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
        <div className="card"><div className="k">decisions · 1h</div><div className="v">{ACTIVITY.length}</div><div className="sub">across {consoles.length} consoles</div></div>
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
        <input className="input" placeholder="search command…" style={{ width: 200 }} />
        <button className="btn ghost">export</button>
      </div>

      <div className="act-table">
        <div className="act-row head">
          <span>time</span><span>console › pane</span><span>profile</span><span>command / action</span><span>decision</span>
        </div>
        {rows.map(([t, con, pane, prof, kind, target, dec], i) => {
          const p = find(prof);
          const sym = dec === "allow" ? "✓" : dec === "ask" ? "◑" : "✗";
          const decLabel = dec === "allow" ? "allowed" : dec === "ask" ? "asked" : "blocked";
          const kindGlyph = kind === "cmd" ? "$" : kind === "tool" ? "⚒" : kind === "net" ? "⇡" : "·";
          return (
            <div className="act-row" key={i}>
              <span className="when">{t}</span>
              <span style={{ color: "var(--fg-muted)" }}>{con} <span style={{ color: "var(--fg-dim)" }}>›</span> {pane}</span>
              <span className="prof"><span className="sw" style={{ background: p?.color }} />{p?.name}</span>
              <span className="cmd"><span style={{ color: "var(--fg-dim)" }}>{kindGlyph}</span> {target}</span>
              <span className={`dec ${dec}`}>{sym} {decLabel}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
