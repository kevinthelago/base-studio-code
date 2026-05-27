import { useState } from "react";
import {
  EXTENSIONS, EXT_PROJECTS, EXT_CATALOG, SCOPE_COPY,
  type Extension, type ExtGroup,
} from "../../data/extensions";
import "./extensions.css";

type Scope = "global" | "project" | "console";
type Tab = "installed" | "catalog";

const GROUPS: Array<{ key: ExtGroup; label: string; hint: string }> = [
  { key: "firstparty", label: "First-party", hint: "served in-process by the host" },
  { key: "mcp",        label: "MCP servers", hint: "external processes over stdio or HTTP" },
  { key: "hook",       label: "Hooks",       hint: "Claude Code lifecycle automations" },
];

/** Tag color class for a free-text extension kind. */
function tagClass(kind: string): string {
  const l = kind.toLowerCase();
  if (l.includes("first-party")) return "amber";
  if (l.includes("mcp")) return "info";
  if (l.includes("hook")) return "green";
  return "";
}

function ToolsLine({ tools }: { tools: string[] }) {
  if (tools.length === 0) return null;
  const shown = tools.slice(0, 3);
  return (
    <div className="row-tools">
      <b>{tools.length} tools</b><span>·</span>
      {shown.map((t, i) => (
        <span key={t}><span className="tname">{t}</span>{i < shown.length - 1 ? ", " : ""}</span>
      ))}
      {tools.length > 3 && <span>· +{tools.length - 3}</span>}
    </div>
  );
}

/**
 * The Extensions screen — a static mock (#33) rendered entirely from
 * src/data/extensions.ts. Manages MCP servers (first-party + third-party) and
 * hooks; backend wiring (config writer, in-process server) lands later.
 */
export function ExtensionsScreen() {
  const [tab, setTab] = useState<Tab>("installed");
  const [scope, setScope] = useState<Scope>("global");
  const [selected, setSelected] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [toggles, setToggles] = useState<Record<string, boolean>>(
    () => Object.fromEntries(EXTENSIONS.map(e => [e.id, e.on])),
  );
  const [projects, setProjects] = useState<Record<string, string[]>>(
    () => Object.fromEntries(EXTENSIONS.map(e => [e.id, [...e.projects]])),
  );
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});

  const projectsOf = (id: string) => projects[id] ?? [];
  const isGlobal = (id: string) => !!toggles[id] && projectsOf(id).length === 0;
  const appliesTo = (id: string, pid: string) => {
    if (!toggles[id]) return false;
    const ps = projectsOf(id);
    return ps.length === 0 || ps.includes(pid);
  };

  const toggle = (id: string) => setToggles(t => ({ ...t, [id]: !t[id] }));
  const setProjectsFor = (id: string, list: string[]) =>
    setProjects(p => ({ ...p, [id]: list }));
  const togglePid = (id: string, pid: string) => {
    const list = projectsOf(id);
    setProjectsFor(id, list.includes(pid) ? list.filter(x => x !== pid) : [...list, pid]);
  };

  const enabledCount = Object.values(toggles).filter(Boolean).length;
  const selectedExt = selected ? EXTENSIONS.find(e => e.id === selected) ?? null : null;

  // ── shared row pieces ──────────────────────────────────────────────────────
  function scopeChips(e: Extension) {
    if (!toggles[e.id]) return <span className="tag" style={{ color: "var(--fg-dim)" }}>off</span>;
    if (isGlobal(e.id)) return <span className="tag green">● global</span>;
    const ps = projectsOf(e.id).map(pid => EXT_PROJECTS.find(p => p.id === pid)).filter(Boolean) as typeof EXT_PROJECTS;
    if (ps.length === 0) return <span className="tag amber">unassigned</span>;
    return (
      <>
        {ps.slice(0, 2).map(p => (
          <span key={p.id} className="ptag"><span className="pdot" style={{ background: p.color }} />{p.name}</span>
        ))}
        {ps.length > 2 && <span className="ptag muted">+{ps.length - 2}</span>}
      </>
    );
  }

  function toggleEl(id: string) {
    return (
      <div
        className={"toggle" + (toggles[id] ? " on" : "")}
        title={toggles[id] ? "enabled" : "disabled"}
        onClick={e => { e.stopPropagation(); toggle(id); }}
      />
    );
  }

  // ── installed · global view ────────────────────────────────────────────────
  function globalRows() {
    return (
      <>
        {GROUPS.map(g => {
          const rows = EXTENSIONS.filter(e => e.group === g.key);
          const onCount = rows.filter(e => toggles[e.id]).length;
          return (
            <div key={g.key}>
              <div className="sec-head">
                <h3>{g.label}</h3>
                <span className="hint">{g.hint}</span>
                <div className="spacer" />
                <span className="meta">{onCount}/{rows.length} enabled</span>
              </div>
              <div className="row-list">
                {rows.map(e => {
                  const on = toggles[e.id];
                  const fail = e.health === "fail" && on;
                  const healthCls = !on ? "off" : e.health === "fail" ? "fail" : "";
                  return (
                    <div
                      key={e.id}
                      className={"row" + (!on ? " off" : "") + (fail ? " failed" : "") + (selected === e.id ? " selected" : "")}
                      onClick={() => setSelected(e.id)}
                    >
                      <div className={"health " + healthCls} />
                      <div className="row-main">
                        <div className="row-line1">
                          <span className="row-name">{e.name}</span>
                          <span className={"tag " + tagClass(e.kind)}>{e.kind}</span>
                        </div>
                        <div className="row-desc">{e.desc}</div>
                        <ToolsLine tools={e.tools} />
                        {fail && (
                          <div className="row-err">✗ <span>{e.error}</span><span className="kbd" style={{ marginLeft: 4 }}>view log</span></div>
                        )}
                      </div>
                      <div className="row-aside">
                        <div className="row-stats">
                          <div className="row-chips">{scopeChips(e)}</div>
                          <div><b>{e.lastUsed}</b> · {e.calls} calls</div>
                        </div>
                        {toggleEl(e.id)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </>
    );
  }

  // ── installed · project scope, no project picked → matrix ───────────────────
  function matrixRows() {
    return (
      <>
        <div style={{
          display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 10,
          padding: "8px 14px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          borderRadius: "var(--r-md)", marginBottom: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
        }}>
          <span style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>extension × project — green = global, color = per-project</span>
          <div style={{ display: "flex", gap: 14 }}>
            {EXT_PROJECTS.map(p => (
              <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                <span style={{ color: "var(--fg-muted)" }}>{p.name}</span>
              </span>
            ))}
          </div>
        </div>
        {GROUPS.map(g => {
          const rows = EXTENSIONS.filter(e => e.group === g.key);
          return (
            <div key={g.key}>
              <div className="sec-head">
                <h3>{g.label}</h3>
                <div className="spacer" />
                <span className="meta">{rows.filter(e => toggles[e.id]).length}/{rows.length} enabled</span>
              </div>
              <div className="row-list">
                {rows.map(e => {
                  const on = toggles[e.id];
                  return (
                    <div
                      key={e.id}
                      className={"row" + (!on ? " off" : "") + (selected === e.id ? " selected" : "")}
                      onClick={() => setSelected(e.id)}
                    >
                      <div className={"health " + (on ? (e.health === "fail" ? "fail" : "") : "off")} />
                      <div className="row-main">
                        <div className="row-line1">
                          <span className="row-name">{e.name}</span>
                          <span className={"tag " + tagClass(e.kind)}>{e.kind}</span>
                        </div>
                        <div className="row-desc">{e.desc}</div>
                      </div>
                      <div className="row-aside" style={{ gap: 18 }}>
                        <div className="pmatrix" title="per-project enable">
                          {EXT_PROJECTS.map(p => {
                            const cls = isGlobal(e.id) ? "global" : (appliesTo(e.id, p.id) ? "on" : "");
                            return (
                              <span
                                key={p.id}
                                className={"cell " + cls}
                                title={p.full + (isGlobal(e.id) ? " (global)" : "")}
                                style={cls === "on" ? { background: p.color } : undefined}
                                onClick={ev => {
                                  ev.stopPropagation();
                                  if (!toggles[e.id]) return;
                                  if (isGlobal(e.id)) setProjectsFor(e.id, EXT_PROJECTS.filter(x => x.id !== p.id).map(x => x.id));
                                  else togglePid(e.id, p.id);
                                }}
                              />
                            );
                          })}
                        </div>
                        {toggleEl(e.id)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </>
    );
  }

  // ── installed · project scope, single project picked ────────────────────────
  function singleProject(pid: string) {
    const proj = EXT_PROJECTS.find(p => p.id === pid)!;
    const allOn = EXTENSIONS.filter(e => toggles[e.id]);
    const enabledHere = allOn.filter(e => appliesTo(e.id, pid));
    const disabledHere = allOn.filter(e => !appliesTo(e.id, pid));
    return (
      <>
        <div style={{
          display: "flex", alignItems: "center", gap: 14, padding: "10px 14px",
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          borderRadius: "var(--r-md)", marginBottom: 14,
        }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: proj.color }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)", fontWeight: 600 }}>{proj.full}</div>
            <div className="hint">{enabledHere.length} extensions active here · {disabledHere.length} installed but not assigned · branch <span className="kbd">{proj.branch}</span></div>
          </div>
          <button className="btn">+ assign extension</button>
        </div>

        {GROUPS.map(g => {
          const group = enabledHere.filter(e => e.group === g.key);
          if (group.length === 0) return null;
          return (
            <div key={g.key}>
              <div className="sec-head">
                <h3>{g.label}</h3>
                <div className="spacer" />
                <span className="meta">{group.length} active</span>
              </div>
              <div className="row-list">
                {group.map(e => {
                  const global = isGlobal(e.id);
                  const fail = e.health === "fail";
                  return (
                    <div
                      key={e.id}
                      className={"row" + (selected === e.id ? " selected" : "")}
                      onClick={() => setSelected(e.id)}
                    >
                      <div className={"health " + (fail ? "fail" : "")} />
                      <div className="row-main">
                        <div className="row-line1">
                          <span className="row-name">{e.name}</span>
                          <span className={"tag " + tagClass(e.kind)}>{e.kind}</span>
                          {global
                            ? <span className="tag green">● global</span>
                            : <span className="ptag"><span className="pdot" style={{ background: proj.color }} />{proj.name}</span>}
                        </div>
                        <div className="row-desc">{e.desc}</div>
                        <ToolsLine tools={e.tools} />
                        {fail && <div className="row-err">✗ <span>{e.error}</span></div>}
                      </div>
                      <div className="row-aside">
                        <div className="row-stats"><div><b>{e.lastUsed}</b> · {e.calls} calls</div></div>
                        {global
                          ? <button className="btn ghost" style={{ height: 24, fontSize: 10 }} title="globally enabled — disable here only" onClick={ev => ev.stopPropagation()}>override</button>
                          : <button className="btn ghost" style={{ height: 24, fontSize: 10, color: "var(--danger)" }} title={`unassign from ${proj.name}`} onClick={ev => { ev.stopPropagation(); togglePid(e.id, pid); }}>unassign</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {disabledHere.length > 0 && (
          <>
            <div className="sec-head" style={{ marginTop: 24 }}>
              <h3 style={{ color: "var(--fg-dim)" }}>Installed but not in {proj.name}</h3>
              <span className="hint">extensions you have configured globally — click to add to this project</span>
            </div>
            <div className="row-list">
              {disabledHere.map(e => (
                <div key={e.id} className="row off" style={{ opacity: 0.6 }} onClick={() => setSelected(e.id)}>
                  <div className="health off" />
                  <div className="row-main">
                    <div className="row-line1">
                      <span className="row-name">{e.name}</span>
                      <span className={"tag " + tagClass(e.kind)}>{e.kind}</span>
                    </div>
                    <div className="row-desc">{e.desc}</div>
                  </div>
                  <div className="row-aside">
                    <button className="btn" style={{ height: 24, fontSize: 10 }} onClick={ev => { ev.stopPropagation(); if (!isGlobal(e.id)) togglePid(e.id, pid); }}>+ add to {proj.name}</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </>
    );
  }

  function catalogView() {
    return (
      <>
        <div className="sec-head">
          <h3>Browse</h3>
          <span className="hint">First-party extensions, hooks, and MCP servers you can add with one click.</span>
          <div className="spacer" />
          <input className="input" placeholder="search catalog…" style={{ width: 200, height: 24, fontSize: 10.5 }} />
        </div>
        <div className="catalog">
          {EXT_CATALOG.map(c => (
            <div className="cat-card" key={c.name}>
              <div className="cat-head">
                <div className="cat-icon">{c.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cat-name">{c.name}</div>
                  <div className="cat-by">{c.by}</div>
                </div>
              </div>
              <div className="cat-desc">{c.desc}</div>
              <div className="cat-foot">
                <span className="hint">{c.by.startsWith("@modelcontextprotocol") ? "official MCP" : c.by === "first-party" ? "first-party" : "third-party"}</span>
                <div className="spacer" />
                <button className="btn ghost" style={{ height: 22, fontSize: 10, padding: "0 8px" }}>details</button>
                <button className="btn" style={{ height: 22, fontSize: 10, padding: "0 10px" }}>add</button>
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  // ── drawer ───────────────────────────────────────────────────────────────
  function drawerBody(e: Extension) {
    const on = toggles[e.id];
    const c = e.config;
    const statusText = on ? (e.health === "fail" ? "failed" : e.health === "ok" ? "connected" : "idle") : "disabled";
    const statusColor = on ? (e.health === "fail" ? "var(--danger)" : e.health === "ok" ? "var(--success)" : "var(--fg-dim)") : "var(--fg-dim)";
    return (
      <>
        {on && e.health === "fail" && (
          <div className="row-err" style={{ marginTop: 0 }}>✗ <span><b style={{ color: "var(--danger)" }}>connect() failed:</b> {e.error}</span></div>
        )}
        <div className="dr-stat">
          <div className="k">status</div><div className="v" style={{ color: statusColor }}>{statusText}</div>
          <div className="k">transport</div><div className="v">{c.transport}</div>
          <div className="k">last used</div><div className="v">{e.lastUsed}</div>
          <div className="k">calls (24h)</div><div className="v">{e.calls}</div>
        </div>

        <div className="field">
          <label>project assignment</label>
          {isGlobal(e.id)
            ? (
              <>
                <div className="global-banner"><span className="gd" /><b style={{ color: "var(--success)", fontWeight: 600 }}>Enabled globally</b><span style={{ color: "var(--fg-muted)" }}>— applies to every project</span></div>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>keep global</button>
                  <button className="btn" style={{ height: 24, fontSize: 10.5 }} onClick={() => setProjectsFor(e.id, EXT_PROJECTS.map(p => p.id))}>restrict to specific projects…</button>
                </div>
              </>
            ) : (
              <>
                <div className="proj-multi">
                  {EXT_PROJECTS.map(p => {
                    const sel = projectsOf(e.id).includes(p.id);
                    return (
                      <div key={p.id} className={"pm-row" + (sel ? " on" : "")} onClick={() => togglePid(e.id, p.id)}>
                        <div className="check">{sel ? "✓" : ""}</div>
                        <div>
                          <div className="pname">{p.full}</div>
                          <div className="pbranch">{p.branch}</div>
                        </div>
                        <div className="pside"><span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /></div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
                  <span className="hint">{projectsOf(e.id).length} of {EXT_PROJECTS.length} projects · </span>
                  <span className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => setProjectsFor(e.id, [])}>make global</span>
                  <div style={{ flex: 1 }} />
                  <span className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => setProjectsFor(e.id, EXT_PROJECTS.map(p => p.id))}>select all</span>
                  <span className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => setProjectsFor(e.id, [])}>none</span>
                </div>
              </>
            )}
          <div className="hint" style={{ marginTop: 6 }}>Adds to console-level scope — never subtracts. Console overrides are set from the console's hamburger menu.</div>
        </div>

        {c.transport === "stdio" && (
          <div className="field"><label>command</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input className="input" defaultValue={c.command ?? ""} style={{ flex: "0 0 120px" }} />
              <input className="input" defaultValue={c.args ?? ""} style={{ flex: 1 }} />
            </div>
          </div>
        )}
        {c.transport === "http+sse" && (
          <div className="field"><label>endpoint URL</label><input className="input" defaultValue={c.endpoint ?? ""} /></div>
        )}
        {c.transport === "hook" && (
          <>
            <div className="field"><label>event</label><input className="input" defaultValue={c.event ?? ""} style={{ width: 240 }} /></div>
            <div className="field"><label>command</label><input className="input" defaultValue={c.command ?? ""} /></div>
          </>
        )}
        {c.transport === "in-process" && (
          <div className="field"><label>endpoint</label><input className="input" defaultValue={c.endpoint ?? ""} disabled style={{ opacity: 0.6 }} />
            <div className="hint">in-process · provided by base-studio-code</div></div>
        )}

        {c.env.length > 0 && (
          <div className="field"><label>environment</label>
            <div className="kv-list">
              {c.env.map(([k, v], i) => (
                <div className="kv-row" key={i}>
                  <input className="input k" defaultValue={k} />
                  <input className="input" defaultValue={v} />
                  <button className="x">×</button>
                </div>
              ))}
              <button className="btn ghost" style={{ height: 24, fontSize: 10.5, width: "fit-content" }}>+ env var</button>
            </div>
          </div>
        )}

        {c.secrets.length > 0 && (
          <div className="field"><label>secrets</label>
            <div className="kv-list">
              {c.secrets.map(([k, v], i) => {
                const key = `${e.id}:${i}`;
                return (
                  <div className="kv-row" key={i}>
                    <input className="input k" defaultValue={k} />
                    <div className="secret" style={{ flex: 1 }}>
                      <input className="input" type={showSecret[key] ? "text" : "password"} defaultValue={v} />
                      <span className="eye" onClick={() => setShowSecret(s => ({ ...s, [key]: !s[key] }))}>{showSecret[key] ? "hide" : "show"}</span>
                    </div>
                  </div>
                );
              })}
              <div className="hint">Stored in the OS keyring · never written to disk in plaintext.</div>
            </div>
          </div>
        )}

        <div className="field">
          <label>exposed {e.group === "hook" ? "event" : "tools"}</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {e.tools.map(t => <span key={t} className="tag" style={{ color: "var(--accent-dim)" }}>{t}</span>)}
          </div>
          {e.group !== "hook" && e.tools.length > 0 && (
            <div className="hint">{e.tools.length} tool{e.tools.length === 1 ? "" : "s"} available · all enabled (per-tool toggles coming soon)</div>
          )}
        </div>

        {c.log.length > 0 && (
          <div className="field"><label>recent tool calls</label>
            <div className="log">
              {c.log.map(([t, l, m], i) => (
                <div className="ln" key={i}>
                  <span className="t">{t}</span>
                  <span className={"lvl " + l}>{l === "ok" ? "✓" : l === "warn" ? "◑" : "✗"}</span>
                  <span className="m">{m}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  // ── body dispatch ──────────────────────────────────────────────────────────
  const body = tab === "catalog"
    ? catalogView()
    : scope === "project"
      ? (projectFilter ? singleProject(projectFilter) : matrixRows())
      : globalRows();

  let summary: React.ReactNode = <>showing extensions enabled <b style={{ color: "var(--fg-muted)" }}>{SCOPE_COPY[scope]}</b></>;
  if (scope === "project" && projectFilter) {
    const p = EXT_PROJECTS.find(x => x.id === projectFilter);
    summary = <>filtered to <b style={{ color: "var(--fg-muted)" }}>{p?.full}</b></>;
  } else if (scope === "project") {
    summary = <><b style={{ color: "var(--fg-muted)" }}>{EXT_PROJECTS.length} projects</b> · pick one above to filter</>;
  }

  return (
    <div className="ext-screen">
      <div className="ext-page">
        {/* sub-tabs / page header */}
        <div className="subtabs">
          <div className={"t" + (tab === "installed" ? " on" : "")} onClick={() => setTab("installed")}>
            Installed <span className="count">{enabledCount}</span>
            <span className="hint-inline">· active capabilities</span>
          </div>
          <div className={"t" + (tab === "catalog" ? " on" : "")} onClick={() => setTab("catalog")}>
            Catalog <span className="count">{EXT_CATALOG.length}</span>
          </div>
          <div className="right">
            <span className="hint" style={{ fontFamily: "var(--mono)" }}>{summary}</span>
            <span className="scope-label">scope</span>
            <div className="scope">
              {(["global", "project", "console"] as Scope[]).map(s => (
                <button key={s} className={scope === s ? "on" : ""} onClick={() => { setScope(s); setProjectFilter(null); }}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <button className="btn primary" onClick={() => setTab("catalog")}>+ Add Extension</button>
          </div>
        </div>

        {/* project picker (project scope only) */}
        {scope === "project" && (
          <div className="proj-bar">
            <span className="label">filter ›</span>
            <div className="proj-chips">
              <span
                className={"proj-chip" + (projectFilter === null ? " on all-on" : "")}
                onClick={() => setProjectFilter(null)}
              >
                <span className="dot" />All projects<span className="num">{EXT_PROJECTS.length}</span>
              </span>
              {EXT_PROJECTS.map(p => {
                const count = EXTENSIONS.filter(e => appliesTo(e.id, p.id)).length;
                const on = projectFilter === p.id;
                return (
                  <span key={p.id} className={"proj-chip" + (on ? " on" : "")} onClick={() => setProjectFilter(p.id)}>
                    <span className="dot" style={on ? { background: p.color } : undefined} />{p.full}<span className="num">{count}</span>
                  </span>
                );
              })}
            </div>
            <button className="btn ghost" style={{ height: 24, fontSize: 10, padding: "0 8px" }} onClick={() => setProjectFilter(null)}>clear</button>
          </div>
        )}

        <div className="ext-body">{body}</div>
      </div>

      {/* drawer */}
      <div className={"scrim" + (selected ? " on" : "")} onClick={() => setSelected(null)} />
      <div className={"drawer" + (selected ? " on" : "")}>
        {selectedExt && (
          <>
            <div className="dr-head">
              <div className={"health " + (toggles[selectedExt.id] ? (selectedExt.health === "fail" ? "fail" : "") : "off")} />
              <div className="name">{selectedExt.name}</div>
              <span className={"tag " + tagClass(selectedExt.kind)}>{selectedExt.kind}</span>
              <button className="x" title="close" onClick={() => setSelected(null)}>×</button>
            </div>
            <div className="dr-body">{drawerBody(selectedExt)}</div>
            <div className="dr-foot">
              <button className="btn ghost danger">remove</button>
              <div className="spacer" />
              <button className="btn">reset</button>
              <button className="btn primary">save</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
