import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveMcpInstallDir, repoNameFromLink, catalogLink, mcpRepoName } from "../../lib/mcpInstall";
import { useAppStore } from "../../store";
import { TabBar, type TabItem } from "../../components/chrome/TabBar";
import { McpAnalyticsTab } from "./McpAnalytics";
import { usePageTabs } from "../../hooks/usePageTabs";
import { EXT_CATALOG, SCOPE_COPY, type CatalogItem } from "../../data/extensions";
import {
  defFromCatalog, blankExtension,
  type ExtensionDef, type ExtKind, type McpTransport,
} from "../../lib/extensions";
import "./extensions.css";

type Scope = "global" | "project";
/** Install/version status of a downloadable MCP server on the MCP page (#885). */
type McpStat = "checking" | "current" | "outdated" | "needs-build" | "downloading" | "building" | "updating" | "error";

/** A GitHub Project (subset of the GraphQL `projectsV2` node). */
interface GhProject {
  id: string;
  number: number;
  title: string;
}

const PROJECTS_QUERY = `{
  viewer {
    projectsV2(first: 50) {
      nodes { id title number }
    }
  }
}`;

const GROUPS: Array<{ kind: ExtKind; label: string; hint: string }> = [
  { kind: "mcp",  label: "MCP servers", hint: "external processes over stdio or HTTP" },
  { kind: "hook", label: "Hooks",       hint: "Claude Code lifecycle automations" },
];

/** Tag color class for an extension kind. */
function tagClass(kind: ExtKind): string {
  return kind === "mcp" ? "info" : "green";
}

/** The free-text kind label shown on a row / in the drawer header. */
function kindLabel(e: ExtensionDef): string {
  if (e.kind === "hook") return e.event ? `hook · ${e.event}` : "hook";
  return e.transport === "http" ? "mcp · http" : "mcp · stdio";
}

/**
 * The Extensions screen — manages MCP servers + lifecycle hooks. Reads and
 * mutates {@link useAppStore} `extensions`; every drawer edit is live (no
 * separate save step). Project assignment offers the user's GitHub Projects;
 * `[]` projects = global (every project). Health, call counts, and logs are not
 * monitored yet and render as neutral placeholders.
 */
/**
 * One screen, parameterized by `kind` (#865): `kind="mcp"` is the MCP page (Rail route);
 * `kind="hook"` (with `embedded`) is the Hooks view inside Automations. Filters the
 * installed list, catalog, add menu, and counts to that kind. `embedded` drops the
 * page-level Installed/Catalog tabstrip and stacks both sections in one scroll (so it sits
 * cleanly under the Automations tabstrip).
 */
export function ExtensionsScreen({ sectionOverride, kind = "mcp", embedded = false }: { sectionOverride?: string; kind?: ExtKind; embedded?: boolean } = {}) {
  const extensions       = useAppStore(s => s.extensions);
  const addExtension     = useAppStore(s => s.addExtension);
  const updateExtension  = useAppStore(s => s.updateExtension);
  const removeExtension  = useAppStore(s => s.removeExtension);
  const toggleExtension  = useAppStore(s => s.toggleExtension);
  const setExtensionProjects = useAppStore(s => s.setExtensionProjects);
  const githubToken      = useAppStore(s => s.githubToken);

  const bscBaseDir       = useAppStore(s => s.bscBaseDir);

  const [scope, setScope] = useState<Scope>("global");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  // Per-server install/version status for the MCP page (#885), keyed by server NAME. Refreshed
  // on page open via mcp_check_update (the version check); advanced by the download (catalog) and
  // update (installed) actions. "current" = built + at the latest commit → an "up to date" pill;
  // "outdated"/"needs-build" → an update/build button; the rest are transient action states.
  const [mcpStatus, setMcpStatus] = useState<Record<string, McpStat>>({});
  const setStat = (name: string, s: McpStat) => setMcpStatus(m => ({ ...m, [name]: s }));

  // The user's GitHub Projects, fetched once on mount when a token exists. No
  // token / empty / failure all collapse to "global only" — never a crash.
  const [projects, setProjects] = useState<GhProject[]>([]);
  useEffect(() => {
    if (!githubToken) return;
    let cancelled = false;
    invoke<{ viewer: { projectsV2: { nodes: GhProject[] } } }>("github_graphql", {
      token: githubToken,
      query: PROJECTS_QUERY,
      variables: null,
    })
      .then(data => { if (!cancelled) setProjects(data?.viewer?.projectsV2?.nodes ?? []); })
      .catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [githubToken]);

  // Version check on every MCP-page open (#885): for each installed downloadable server, ask the
  // backend whether its clone is behind its remote (and whether it's built), so the installed
  // card shows an "up to date" pill or an "update"/"build" button. Best-effort + async; an
  // in-flight download/update is left alone. MCP page only (hooks aren't downloadable).
  useEffect(() => {
    if (kind !== "mcp") return;
    const servers = extensions.filter(e => e.kind === "mcp" && catalogLink(e.name)).map(e => e.name);
    if (servers.length === 0) return;
    let cancelled = false;
    for (const name of servers) {
      setMcpStatus(m => (m[name] ? m : { ...m, [name]: "checking" }));
      invoke<{ downloaded: boolean; built: boolean; updateAvailable: boolean }>("mcp_check_update", { name: mcpRepoName(name) })
        .then(r => {
          if (cancelled) return;
          const next: McpStat = !r.downloaded ? "needs-build" : r.updateAvailable ? "outdated" : !r.built ? "needs-build" : "current";
          setMcpStatus(m => (m[name] === "downloading" || m[name] === "building" || m[name] === "updating" ? m : { ...m, [name]: next }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
    // Re-check when the set of installed downloadable servers changes (and on mount).
  }, [kind, extensions.filter(e => e.kind === "mcp" && catalogLink(e.name)).map(e => e.name).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everything is scoped to this screen's `kind` (#865): the MCP page shows only MCP servers;
  // the Hooks view only hooks. The shared `extensions` store + config-writer are unchanged.
  const kindExtensions = useMemo(() => extensions.filter(e => e.kind === kind), [extensions, kind]);
  const kindCatalog = useMemo(() => EXT_CATALOG.filter(c => defFromCatalog(c.name).kind === kind), [kind]);
  const enabledCount = kindExtensions.filter(e => e.enabled).length;
  const extDefs: TabItem[] = useMemo(() => [
    { id: "installed", label: "Installed", count: enabledCount, hint: "· active capabilities" },
    { id: "catalog", label: "Catalog", count: kindCatalog.length },
    // MCP call telemetry (#879) — only on the MCP page, not the embedded Hooks view.
    ...(kind === "mcp" ? [{ id: "analytics", label: "Analytics" } as TabItem] : []),
  ], [enabledCount, kindCatalog.length, kind]);
  const { tabs: extTabs, activeId, select, reorder, tearOff } = usePageTabs(`extensions-${kind}`, extDefs);
  const tab = embedded ? "all" : (sectionOverride ?? activeId); // active section ("all" = stacked embedded)
  const selected = selectedId ? extensions.find(e => e.id === selectedId) ?? null : null;

  // ── helpers ────────────────────────────────────────────────────────────────
  function patch(id: string, p: Partial<ExtensionDef>) { updateExtension(id, p); }

  function setEnv(id: string, env: Array<[string, string]>) {
    updateExtension(id, { env });
  }

  function toggleProject(e: ExtensionDef, pid: string) {
    const next = e.projects.includes(pid)
      ? e.projects.filter(x => x !== pid)
      : [...e.projects, pid];
    setExtensionProjects(e.id, next);
  }

  /** Add a catalog item as an installed extension, with its `{dir}` placeholder resolved to the
   *  on-disk download path (#859). `select` opens it in the drawer (the manual "add" flow); the
   *  download flow adds silently so the server just lands in the Installed list (#885). */
  function addFromCatalog(item: CatalogItem, select = true) {
    const def = resolveMcpInstallDir(defFromCatalog(item.name), item.name, bscBaseDir);
    addExtension(def);
    if (select) {
      const created = useAppStore.getState().extensions;
      const last = created[created.length - 1];
      if (last) setSelectedId(last.id);
    }
  }

  /** One-click install (#885): the catalog's only action. Clone → add to Installed (silently) →
   *  build. The card then disappears from the catalog (it's installed), and the Installed card
   *  shows its version status. Best-effort build — a toolchain failure leaves it installed with
   *  a "build" action on the Installed card. */
  async function downloadFromCatalog(item: CatalogItem) {
    if (!item.link) return;
    const repo = repoNameFromLink(item.link);
    setStat(item.name, "downloading");
    try {
      await invoke<string>("mcp_clone", { name: repo, url: item.link });
    } catch {
      setStat(item.name, "error");
      return;
    }
    addFromCatalog(item, false); // moves the card into the Installed list
    setStat(item.name, "building");
    try {
      const r = await invoke<{ ok: boolean }>("mcp_build", { name: repo });
      setStat(item.name, r.ok ? "current" : "needs-build");
    } catch {
      setStat(item.name, "needs-build");
    }
  }

  /** Update (or finish building) an installed downloadable server (#885): pull the latest commit
   *  then rebuild. Drives the Installed card's update/build button. */
  async function updateInstalled(e: ExtensionDef) {
    const link = catalogLink(e.name);
    if (!link) return;
    const repo = repoNameFromLink(link);
    setStat(e.name, "updating");
    try {
      await invoke("mcp_clone", { name: repo, url: link }); // fast-forwards an existing clone
      setStat(e.name, "building");
      const r = await invoke<{ ok: boolean }>("mcp_build", { name: repo });
      setStat(e.name, r.ok ? "current" : "needs-build");
    } catch {
      setStat(e.name, "error");
    }
  }

  function addCustom(kind: ExtKind) {
    addExtension(blankExtension(kind));
    const created = useAppStore.getState().extensions;
    const last = created[created.length - 1];
    if (last) setSelectedId(last.id);
    setAddOpen(false);
  }

  // ── shared row pieces ────────────────────────────────────────────────────────
  function toggleEl(e: ExtensionDef) {
    return (
      <div
        className={"toggle" + (e.enabled ? " on" : "")}
        title={e.enabled ? "enabled" : "disabled"}
        onClick={ev => { ev.stopPropagation(); toggleExtension(e.id); }}
      />
    );
  }

  function scopeChips(e: ExtensionDef) {
    if (!e.enabled) return <span className="tag" style={{ color: "var(--fg-dim)" }}>off</span>;
    if (e.projects.length === 0) return <span className="tag green">● global</span>;
    const named = e.projects
      .map(pid => projects.find(p => p.id === pid))
      .filter(Boolean) as GhProject[];
    if (named.length === 0) {
      // Scoped to project ids we couldn't resolve (no token / not in the list).
      return <span className="ptag muted">{e.projects.length} project{e.projects.length === 1 ? "" : "s"}</span>;
    }
    return (
      <>
        {named.slice(0, 2).map(p => (
          <span key={p.id} className="ptag"><span className="pdot" style={{ background: "var(--accent-dim)" }} />{p.title}</span>
        ))}
        {named.length > 2 && <span className="ptag muted">+{named.length - 2}</span>}
      </>
    );
  }

  // The version/update control on an installed downloadable server's row (#885): an "up to date"
  // pill when built + at the latest commit, else an update/build button (drives pull + rebuild).
  // Non-downloadable servers (remote/custom) and hooks have nothing to update → null.
  function mcpUpdateControl(e: ExtensionDef) {
    if (kind !== "mcp" || !catalogLink(e.name)) return null;
    const s = mcpStatus[e.name];
    if (s === "current") return <span className="tag green" title="at the latest release">up to date</span>;
    if (s === "updating" || s === "building")
      return <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{s === "building" ? "building…" : "updating…"}</span>;
    if (s === undefined || s === "checking" || s === "downloading")
      return <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>checking…</span>;
    // outdated / needs-build / error → an action button (pull + rebuild).
    const label = s === "needs-build" ? "build" : s === "error" ? "retry ↻" : "update";
    return (
      <button
        className="btn ghost"
        style={{ height: 20, fontSize: 10, padding: "0 9px" }}
        onClick={ev => { ev.stopPropagation(); updateInstalled(e); }}
      >{label}</button>
    );
  }

  // ── installed view ───────────────────────────────────────────────────────────
  const NOUN = kind === "mcp" ? "MCP servers" : "hooks";
  function installedView() {
    // Nothing installed yet → a clear CTA into the catalog instead of empty groups.
    if (kindExtensions.length === 0 && !embedded) {
      return (
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 12, padding: "64px 24px", textAlign: "center",
        }}>
          <h3 style={{ margin: 0 }}>No {NOUN} installed</h3>
          <p className="hint" style={{ maxWidth: 380, margin: 0 }}>
            {kind === "mcp"
              ? "Add MCP servers from the catalog to give your agents new tools."
              : "Add hooks from the catalog to run commands on Claude Code lifecycle events."}
          </p>
          <button className="btn primary" onClick={() => select("catalog")}>Browse the catalog →</button>
        </div>
      );
    }
    return (
      <>
        {GROUPS.filter(g => g.kind === kind).map(g => {
          const rows = kindExtensions;
          const onCount = rows.filter(e => e.enabled).length;
          return (
            <div key={g.kind}>
              <div className="sec-head">
                <h3>{g.label}</h3>
                <span className="hint">{g.hint}</span>
                <div className="spacer" />
                <span className="meta">{onCount}/{rows.length} enabled</span>
              </div>
              <div className="row-list">
                {rows.length === 0 && (
                  <div className="hint" style={{ padding: "8px 2px" }}>
                    No {g.label.toLowerCase()} yet — add one from the catalog.
                  </div>
                )}
                {rows.map(e => (
                  <div
                    key={e.id}
                    className={"row" + (!e.enabled ? " off" : "") + (selectedId === e.id ? " selected" : "")}
                    onClick={() => setSelectedId(e.id)}
                  >
                    <div className={"health " + (e.enabled ? "" : "off")} />
                    <div className="row-main">
                      <div className="row-line1">
                        <span className="row-name">{e.name || "Untitled extension"}</span>
                        <span className={"tag " + tagClass(e.kind)}>{kindLabel(e)}</span>
                      </div>
                      {e.kind === "mcp"
                        ? <div className="row-desc">{e.transport === "http" ? (e.url || "no endpoint set") : (e.command ? `${e.command} ${e.args ?? ""}`.trim() : "no command set")}</div>
                        : <div className="row-desc">{e.hookCommand || "no command set"}{e.matcher ? ` · ${e.matcher}` : ""}</div>}
                    </div>
                    <div className="row-aside">
                      <div className="row-stats">
                        <div className="row-chips">{scopeChips(e)}</div>
                        <div>—</div>
                      </div>
                      {mcpUpdateControl(e)}
                      {toggleEl(e)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {/* First-party tools are not built yet — a static, non-fabricated note (MCP page only). */}
        {kind === "mcp" && (
          <div className="sec-head">
            <h3 style={{ color: "var(--fg-dim)" }}>First-party tools</h3>
            <span className="hint">coming soon</span>
          </div>
        )}
      </>
    );
  }

  // ── catalog view ───────────────────────────────────────────────────────────
  function catalogView() {
    const q = search.trim().toLowerCase();
    // Hide already-installed entries (#885): download auto-adds to Installed, so the catalog only
    // ever lists what you can still add — and the stale "download" label problem goes away.
    const installedNames = new Set(kindExtensions.map(e => e.name.toLowerCase()));
    const available = kindCatalog.filter(c => !installedNames.has(c.name.toLowerCase()));
    const items = q
      ? available.filter(c => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q))
      : available;
    return (
      <>
        <div className="sec-head">
          <h3>{embedded ? "Add from catalog" : "Browse"}</h3>
          <span className="hint">{kind === "mcp" ? "First-party and third-party MCP servers you can add with one click." : "First-party hooks."}</span>
          <div className="spacer" />
          <input
            className="input"
            placeholder="search catalog…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 200, height: 24, fontSize: 10.5 }}
          />
        </div>
        <div className="catalog">
          {items.map(c => (
            <div className="cat-card" key={c.name}>
              <div className="cat-head">
                <div className="cat-icon">{c.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cat-name">{c.name}</div>
                  <div className="cat-by">{c.by}</div>
                </div>
              </div>
              <div className="cat-desc">{c.desc}</div>
              {c.install && <div className="hint" style={{ marginTop: 6, fontSize: 10 }}>{c.install}</div>}
              <div className="cat-foot">
                <span className="hint">{c.by.startsWith("@modelcontextprotocol") ? "official MCP" : (c.by === "first-party" || c.link) ? "first-party" : "third-party"}</span>
                <div className="spacer" />
                {c.link ? (
                  // Downloadable (first-party): a single "download" action — clone + add + build,
                  // then the card moves to Installed. No separate "add" button (#885).
                  <button
                    className="btn primary"
                    style={{ height: 22, fontSize: 10, padding: "0 10px" }}
                    disabled={mcpStatus[c.name] === "downloading" || mcpStatus[c.name] === "building"}
                    onClick={() => downloadFromCatalog(c)}
                  >
                    {mcpStatus[c.name] === "downloading" ? "downloading…"
                      : mcpStatus[c.name] === "building" ? "building…"
                      : mcpStatus[c.name] === "error" ? "retry ↻"
                      : "download"}
                  </button>
                ) : (
                  // Non-downloadable (hooks, remote servers): nothing to fetch — add directly.
                  <button className="btn" style={{ height: 22, fontSize: 10, padding: "0 10px" }} onClick={() => addFromCatalog(c)}>add</button>
                )}
              </div>
            </div>
          ))}
          {items.length === 0 && (
            <div className="hint" style={{ padding: "8px 2px" }}>No catalog entries match “{search}”.</div>
          )}
        </div>
      </>
    );
  }

  // ── drawer ───────────────────────────────────────────────────────────────────
  function drawerBody(e: ExtensionDef) {
    const env = e.env ?? [];
    const isGlobal = e.projects.length === 0;
    return (
      <>
        <div className="field">
          <label>name</label>
          <input className="input" value={e.name} onChange={ev => patch(e.id, { name: ev.target.value })} />
        </div>

        <div className="dr-stat">
          <div className="k">status</div><div className="v" style={{ color: e.enabled ? "var(--success)" : "var(--fg-dim)" }}>{e.enabled ? "enabled" : "disabled"}</div>
          <div className="k">kind</div><div className="v">{kindLabel(e)}</div>
          <div className="k">last used</div><div className="v">—</div>
          <div className="k">calls (24h)</div><div className="v">—</div>
        </div>

        {/* project assignment */}
        <div className="field">
          <label>project assignment</label>
          <div className="global-banner" style={isGlobal ? undefined : { opacity: 0.6 }}>
            <span className="gd" />
            <b style={{ color: isGlobal ? "var(--success)" : "var(--fg-muted)", fontWeight: 600 }}>Global (all projects)</b>
            <div style={{ flex: 1 }} />
            <div
              className={"toggle" + (isGlobal ? " on" : "")}
              title={isGlobal ? "global" : "scoped to projects"}
              onClick={() => setExtensionProjects(e.id, isGlobal ? (projects[0] ? [projects[0].id] : []) : [])}
            />
          </div>

          {!isGlobal && (
            <>
              {projects.length === 0
                ? <div className="hint" style={{ marginTop: 6 }}>No projects — global only. Connect GitHub in Settings to scope per project.</div>
                : (
                  <div className="proj-multi" style={{ marginTop: 6 }}>
                    {projects.map(p => {
                      const sel = e.projects.includes(p.id);
                      return (
                        <div key={p.id} className={"pm-row" + (sel ? " on" : "")} onClick={() => toggleProject(e, p.id)}>
                          <div className="check">{sel ? "✓" : ""}</div>
                          <div>
                            <div className="pname">{p.title}</div>
                            <div className="pbranch">#{p.number}</div>
                          </div>
                          <div className="pside"><span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--accent-dim)" }} /></div>
                        </div>
                      );
                    })}
                  </div>
                )}
              {projects.length > 0 && (
                <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
                  <span className="hint">{e.projects.length} of {projects.length} projects</span>
                  <div style={{ flex: 1 }} />
                  <span className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => setExtensionProjects(e.id, projects.map(p => p.id))}>select all</span>
                  <span className="hint" style={{ cursor: "pointer", color: "var(--accent-dim)" }} onClick={() => setExtensionProjects(e.id, [])}>make global</span>
                </div>
              )}
            </>
          )}
          <div className="hint" style={{ marginTop: 6 }}>Global applies to every project; otherwise only the projects you pick.</div>
        </div>

        {/* mcp config */}
        {e.kind === "mcp" && (
          <>
            <div className="field">
              <label>transport</label>
              <div className="scope">
                {(["stdio", "http"] as McpTransport[]).map(t => (
                  <button key={t} className={e.transport === t ? "on" : ""} onClick={() => patch(e.id, { transport: t })}>{t}</button>
                ))}
              </div>
            </div>
            {e.transport === "http"
              ? (
                <div className="field"><label>endpoint URL</label>
                  <input className="input" value={e.url ?? ""} onChange={ev => patch(e.id, { url: ev.target.value })} />
                </div>
              ) : (
                <div className="field"><label>command</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input className="input" placeholder="command" value={e.command ?? ""} onChange={ev => patch(e.id, { command: ev.target.value })} style={{ flex: "0 0 120px" }} />
                    <input className="input" placeholder="args" value={e.args ?? ""} onChange={ev => patch(e.id, { args: ev.target.value })} style={{ flex: 1 }} />
                  </div>
                </div>
              )}
          </>
        )}

        {/* hook config */}
        {e.kind === "hook" && (
          <>
            <div className="field"><label>event</label>
              <input className="input" placeholder="PreToolUse | PostToolUse | Stop …" value={e.event ?? ""} onChange={ev => patch(e.id, { event: ev.target.value })} style={{ width: 240 }} />
            </div>
            <div className="field"><label>matcher</label>
              <input className="input" placeholder="optional tool matcher (regex)" value={e.matcher ?? ""} onChange={ev => patch(e.id, { matcher: ev.target.value })} />
            </div>
            <div className="field"><label>command</label>
              <input className="input" placeholder="command to run" value={e.hookCommand ?? ""} onChange={ev => patch(e.id, { hookCommand: ev.target.value })} />
            </div>
          </>
        )}

        {/* env editor (both kinds) */}
        <div className="field"><label>environment</label>
          <div className="kv-list">
            {env.map(([k, v], i) => (
              <div className="kv-row" key={i}>
                <input
                  className="input k"
                  value={k}
                  onChange={ev => setEnv(e.id, env.map((row, j) => j === i ? [ev.target.value, row[1]] : row))}
                />
                <input
                  className="input"
                  value={v}
                  onChange={ev => setEnv(e.id, env.map((row, j) => j === i ? [row[0], ev.target.value] : row))}
                />
                <button className="x" title="remove" onClick={() => setEnv(e.id, env.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            <button
              className="btn ghost"
              style={{ height: 24, fontSize: 10.5, width: "fit-content" }}
              onClick={() => setEnv(e.id, [...env, ["", ""]])}
            >+ env var</button>
          </div>
        </div>
      </>
    );
  }

  // ── body dispatch ──────────────────────────────────────────────────────────
  const body = tab === "analytics" ? <McpAnalyticsTab />
    : tab === "catalog" ? catalogView()
    : installedView();

  const summary = useMemo<React.ReactNode>(() => (
    <>showing {NOUN} <b style={{ color: "var(--fg-muted)" }}>{SCOPE_COPY[scope]}</b></>
  ), [scope, NOUN]);

  const drawer = selected && (
    <>
      <div className="dr-head">
        <div className={"health " + (selected.enabled ? "" : "off")} />
        <div className="name">{selected.name || "Untitled extension"}</div>
        <span className={"tag " + tagClass(selected.kind)}>{kindLabel(selected)}</span>
        <button className="x" title="close" onClick={() => setSelectedId(null)}>×</button>
      </div>
      <div className="dr-body">{drawerBody(selected)}</div>
      <div className="dr-foot">
        <button className="btn ghost danger" onClick={() => { removeExtension(selected.id); setSelectedId(null); }}>remove</button>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setSelectedId(null)}>done</button>
      </div>
    </>
  );

  // Embedded (Hooks-in-Automations): a compact toolbar + both sections stacked, no tabstrip.
  if (embedded) {
    return (
      <div className="ext-screen">
        <div className="ext-page">
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 22px 0" }}>
            <button className="btn ghost" onClick={() => addCustom(kind)}>+ Custom {kind === "hook" ? "hook" : "MCP server"}</button>
          </div>
          <div className="ext-body">
            {installedView()}
            <div style={{ height: 20 }} />
            {catalogView()}
          </div>
        </div>
        <div className={"scrim" + (selected ? " on" : "")} onClick={() => setSelectedId(null)} />
        <div className={"drawer" + (selected ? " on" : "")}>{drawer}</div>
      </div>
    );
  }

  return (
    <div className="ext-screen">
      <div className="ext-page">
        {!sectionOverride && (
          <TabBar
            tabs={extTabs}
            activeId={activeId}
            onSelect={select}
            onReorder={reorder}
            onTearOff={tearOff}
            right={
              tab === "analytics" ? (
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>window · last 14 days</span>
              ) : (
              <>
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>{summary}</span>
                <span className="scope-label">scope</span>
                <div className="scope">
                  {(["global", "project"] as Scope[]).map(s => (
                    <button key={s} className={scope === s ? "on" : ""} onClick={() => setScope(s)}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
                <div style={{ position: "relative" }}>
                  <button className="btn primary" onClick={() => setAddOpen(o => !o)}>+ Add {kind === "mcp" ? "MCP server" : "hook"}</button>
                  {addOpen && (
                    <div style={{
                      position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 10,
                      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
                      borderRadius: "var(--r-md)", padding: 4, minWidth: 180,
                      display: "flex", flexDirection: "column", gap: 2,
                      boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
                    }}>
                      <button className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => addCustom(kind)}>Custom {kind === "mcp" ? "MCP server" : "hook"}</button>
                      <div style={{ borderTop: "1px solid var(--border-soft)", margin: "2px 0" }} />
                      <button className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => { setAddOpen(false); select("catalog"); }}>Browse catalog…</button>
                    </div>
                  )}
                </div>
              </>
              )
            }
          />
        )}

        <div className="ext-body">{body}</div>
      </div>

      {/* drawer */}
      <div className={"scrim" + (selected ? " on" : "")} onClick={() => setSelectedId(null)} />
      <div className={"drawer" + (selected ? " on" : "")}>{drawer}</div>
    </div>
  );
}
