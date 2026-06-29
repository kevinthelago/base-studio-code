// Agents — Profiles tab (#1643 split from AgentsScreen).
//
// The roles list (application + custom) + the selected profile's policy editor: base
// policy, shell allowlist, per-tool tri-states, filesystem + network scope, and the
// pane-assignment / app-session ownership panel. Composition + view only; all data
// transforms live in ./lib.

import { type CSSProperties } from "react";
import { StatusDot } from "@/shared/ui/StatusDot";
import { CardListRow } from "@/shared/ui/CardListRow";
import {
  TOOL_DEFS, GUARANTEED, MODE_LABEL, paneCount, consoleCount,
  type AgentProfile, type ConsoleSession, type Tier, type ToolKey,
} from "./lib/agentProfiles";
import { appSessionOpenLabel, appReachNote } from "./lib/appSession";

const initialOf = (name: string) => name.replace(/[^a-z]/gi, "").slice(0, 2).toUpperCase();
const modeColor = (m: Tier) => m === "deny" ? "var(--danger)" : m === "ask" ? "var(--accent)" : "var(--success)";

export interface ProfilesTabProps {
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

export function ProfilesTab(props: ProfilesTabProps) {
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
    <CardListRow
      variant="grouped"
      accent={p.color}
      selected={on}
      onClick={onClick}
      lead={<span style={{ width: 9, height: 9, borderRadius: 3, background: p.color, display: "block" }} />}
      title={p.name}
      titleAside={<span className={`origin-badge ${obCls}`}>{origin}</span>}
      subtitle={
        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", display: "inline-flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {isApp
            ? <><span>◆ owns {p.session}</span><span>· always on</span></>
            : <><span>{paneCount(p.id, consoles)} panes</span><span>· {p.commands.length} cmds</span></>}
        </span>
      }
      trailing={<span className={`mode-badge ${p.mode}`} style={{ fontSize: 8.5 }}>{p.mode}</span>}
    />
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
              <span className="tag green" style={{ fontSize: 9.5 }}><StatusDot color="var(--success)" style={{ marginRight: 4 }} />running</span>
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
