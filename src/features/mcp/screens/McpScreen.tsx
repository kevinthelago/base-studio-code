import { useState, useMemo } from "react";
import { resolveMcpInstallDir, catalogLink } from "../lib/mcpInstall";
import { useMcpInstallStatus } from "../useMcpInstallStatus";
import { builtInCatalog, browsableCatalog, catalogTabCount, filterCatalog } from "../lib/mcpCatalogView";
import { useAppStore } from "@/store";
import { type TabItem } from "@/app/chrome/TabBar";
import { TabbedScreen } from "@/app/chrome/TabbedScreen";
import { McpAnalyticsTab } from "../McpAnalytics";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { SCOPE_COPY, type CatalogItem } from "@/shared/data/mcpCatalog";
import { HOOK_CATALOG } from "@/shared/data/hookCatalog";
import { mcpFromCatalog, blankMcpServer, type McpServer, type McpTransport } from "../lib/mcpServers";
import { hookFromCatalog, blankHook, type Hook } from "../lib/hooks";
import {
  useGhProjects, scopeChips, DrawerBody, DrawerSlideOver, InstalledRow, CatalogCard, type Scope,
} from "../shared";
import "../mcp.css";

// ════════════════════════════════════════════════════════════════════════════════════════════
// MCP servers screen — the Rail "MCP" page. Owns the install/version machinery (download, build,
// update-check) that only servers have. Reads/mutates the store's `mcpServers` slice; every drawer
// edit is live. Hooks live separately in the Automations Hooks view (HooksView, below).
// ════════════════════════════════════════════════════════════════════════════════════════════

/** The free-text label shown on a server row / drawer header. */
function mcpLabel(e: McpServer): string {
  return e.transport === "http" ? "mcp · http" : "mcp · stdio";
}

export function McpScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  const mcpServers          = useAppStore(s => s.mcpServers);
  const addMcpServer        = useAppStore(s => s.addMcpServer);
  const updateMcpServer     = useAppStore(s => s.updateMcpServer);
  const removeMcpServer     = useAppStore(s => s.removeMcpServer);
  const toggleMcpServer     = useAppStore(s => s.toggleMcpServer);
  const setMcpServerProjects = useAppStore(s => s.setMcpServerProjects);
  const githubToken         = useAppStore(s => s.githubToken);
  const bscBaseDir          = useAppStore(s => s.bscBaseDir);

  const [scope, setScope] = useState<Scope>("global");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const projects = useGhProjects(githubToken);

  // Install/version machinery (#885): the per-server status map, the version check on page open,
  // and the download/update flows (see useMcpInstallStatus).
  const { mcpStatus, downloadFromCatalog, updateInstalled } = useMcpInstallStatus(mcpServers);

  const tabDefs: TabItem[] = useMemo(() => {
    const installed = mcpServers.filter(e => e.enabled).length;
    return [
      { id: "installed", label: "Installed", count: installed, hint: "· active capabilities" },
      { id: "catalog", label: "Catalog", count: catalogTabCount(mcpServers) },
      { id: "analytics", label: "Analytics" },
    ];
  }, [mcpServers]);
  const { tabs, activeId, select, reorder, tearOff } = usePageTabs("mcp", tabDefs);
  const tab = sectionOverride ?? activeId;
  const selected = selectedId ? mcpServers.find(e => e.id === selectedId) ?? null : null;

  /** Add a catalog item as an installed server, with `{dir}` resolved to its on-disk download
   *  path (#859). `select` opens it in the drawer; the download flow adds silently (#885). */
  function addFromCatalog(item: CatalogItem, openDrawer = true) {
    const def = resolveMcpInstallDir(mcpFromCatalog(item.name), item.name, bscBaseDir);
    addMcpServer(def);
    if (openDrawer) {
      const created = useAppStore.getState().mcpServers;
      const last = created[created.length - 1];
      if (last) setSelectedId(last.id);
    }
  }

  function addCustom() {
    addMcpServer(blankMcpServer());
    const created = useAppStore.getState().mcpServers;
    const last = created[created.length - 1];
    if (last) setSelectedId(last.id);
    setAddOpen(false);
  }

  // The version/update control on an installed downloadable server's row (#885).
  function updateControl(e: McpServer): React.ReactNode {
    if (!catalogLink(e.name)) return null;
    const s = mcpStatus[e.name];
    if (s === "current") return <span className="tag green" title="at the latest release">up to date</span>;
    if (s === "updating" || s === "building")
      return <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>{s === "building" ? "building…" : "updating…"}</span>;
    if (s === undefined || s === "checking" || s === "downloading")
      return <span className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10 }}>checking…</span>;
    const label = s === "needs-build" ? "build" : s === "error" ? "retry ↻" : "update";
    return (
      <button className="btn ghost" style={{ height: 20, fontSize: 10, padding: "0 9px" }}
        onClick={ev => { ev.stopPropagation(); updateInstalled(e); }}>{label}</button>
    );
  }

  // Built-in tools (#1196) — ship compiled in the app bundle (native sidecars), always available
  // with no download/build/Docker. Shown as info, not toggleable; rendered in both the empty and
  // populated installed states.
  const builtInSection = builtInCatalog.length > 0 && (
    <>
      <div className="sec-head">
        <h3 style={{ color: "var(--fg-dim)" }}>Built-in tools</h3>
        <span className="hint">always available — no install</span>
      </div>
      <div className="catalog">
        {builtInCatalog.map(c => (
          <CatalogCard key={c.name} item={c} action={<span className="hint">built-in</span>} />
        ))}
      </div>
    </>
  );

  function installedView() {
    if (mcpServers.length === 0) {
      return (
        <>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: "64px 24px", textAlign: "center" }}>
            <h3 style={{ margin: 0 }}>No MCP servers installed</h3>
            <p className="hint" style={{ maxWidth: 380, margin: 0 }}>Add MCP servers from the catalog to give your agents new tools.</p>
            <button className="btn primary" onClick={() => select("catalog")}>Browse the catalog →</button>
          </div>
          {builtInSection}
        </>
      );
    }
    const onCount = mcpServers.filter(e => e.enabled).length;
    return (
      <>
        <div>
          <div className="sec-head">
            <h3>MCP servers</h3>
            <span className="hint">external processes over stdio or HTTP</span>
            <div className="spacer" />
            <span className="meta">{onCount}/{mcpServers.length} enabled</span>
          </div>
          <div className="row-list">
            {mcpServers.map(e => (
              <InstalledRow
                key={e.id}
                name={e.name}
                tagCls="info"
                tagLabel={mcpLabel(e)}
                desc={e.transport === "http" ? (e.url || "no endpoint set") : (e.command ? `${e.command} ${e.args ?? ""}`.trim() : "no command set")}
                scopeChip={scopeChips(e, projects)}
                aside={updateControl(e)}
                on={e.enabled}
                selected={selectedId === e.id}
                onSelect={() => setSelectedId(e.id)}
                onToggle={() => toggleMcpServer(e.id)}
              />
            ))}
          </div>
        </div>
        {builtInSection}
      </>
    );
  }

  function catalogView() {
    // Built-in servers (#1196) live in the "Built-in tools" section, not the downloadable browse list.
    const items = filterCatalog(browsableCatalog(mcpServers), search);
    return (
      <>
        <div className="sec-head">
          <h3>Browse</h3>
          <span className="hint">First-party and third-party MCP servers you can add with one click.</span>
          <div className="spacer" />
          <input className="input" placeholder="search catalog…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200, height: 24, fontSize: 10.5 }} />
        </div>
        <div className="catalog">
          {items.map(c => (
            <CatalogCard key={c.name} item={c} action={
              c.link ? (
                <button className="btn primary" style={{ height: 22, fontSize: 10, padding: "0 10px" }}
                  disabled={mcpStatus[c.name] === "downloading" || mcpStatus[c.name] === "building"}
                  onClick={() => downloadFromCatalog(c, item => addFromCatalog(item, false))}>
                  {mcpStatus[c.name] === "downloading" ? "downloading…" : mcpStatus[c.name] === "building" ? "building…" : mcpStatus[c.name] === "error" ? "retry ↻" : "download"}
                </button>
              ) : (
                <button className="btn" style={{ height: 22, fontSize: 10, padding: "0 10px" }} onClick={() => addFromCatalog(c)}>add</button>
              )
            } />
          ))}
          {items.length === 0 && <div className="hint" style={{ padding: "8px 2px" }}>No catalog entries match “{search}”.</div>}
        </div>
      </>
    );
  }

  const body = tab === "analytics" ? <McpAnalyticsTab />
    : tab === "catalog" ? catalogView()
    : installedView();

  const summary = useMemo<React.ReactNode>(() => (
    <>showing MCP servers <b style={{ color: "var(--fg-muted)" }}>{SCOPE_COPY[scope]}</b></>
  ), [scope]);

  return (
    <TabbedScreen
      tabs={tabs}
      active={tab}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      sectionOverride={sectionOverride}
      className="ext-screen"
      bodyClassName="ext-body"
      right={
              tab === "analytics" ? (
                <span className="hint" style={{ fontFamily: "var(--mono)" }}>window · last 14 days</span>
              ) : (
                <>
                  <span className="hint" style={{ fontFamily: "var(--mono)" }}>{summary}</span>
                  <span className="scope-label">scope</span>
                  <div className="scope">
                    {(["global", "project"] as Scope[]).map(s => (
                      <button key={s} className={scope === s ? "on" : ""} onClick={() => setScope(s)}>{s.charAt(0).toUpperCase() + s.slice(1)}</button>
                    ))}
                  </div>
                  <div style={{ position: "relative" }}>
                    <button className="btn primary" onClick={() => setAddOpen(o => !o)}>+ Add MCP server</button>
                    {addOpen && (
                      <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 10, background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: 4, minWidth: 180, display: "flex", flexDirection: "column", gap: 2, boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
                        <button className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={addCustom}>Custom MCP server</button>
                        <div style={{ borderTop: "1px solid var(--border-soft)", margin: "2px 0" }} />
                        <button className="btn ghost" style={{ justifyContent: "flex-start" }} onClick={() => { setAddOpen(false); select("catalog"); }}>Browse catalog…</button>
                      </div>
                    )}
                  </div>
                </>
              )
            }
      overlay={
        <DrawerSlideOver
        open={!!selected}
        onClose={() => setSelectedId(null)}
        onRemove={() => { if (selected) { removeMcpServer(selected.id); setSelectedId(null); } }}
        header={selected && (
          <>
            <div className={"health " + (selected.enabled ? "" : "off")} />
            <div className="name">{selected.name || "Untitled server"}</div>
            <span className="tag info">{mcpLabel(selected)}</span>
          </>
        )}
        body={selected && (
          <DrawerBody
            item={selected}
            kindLabel={mcpLabel(selected)}
            projects={projects}
            onName={name => updateMcpServer(selected.id, { name })}
            onSetProjects={ids => setMcpServerProjects(selected.id, ids)}
            onSetEnv={env => updateMcpServer(selected.id, { env })}
          >
            <div className="field">
              <label>transport</label>
              <div className="scope">
                {(["stdio", "http"] as McpTransport[]).map(t => (
                  <button key={t} className={selected.transport === t ? "on" : ""} onClick={() => updateMcpServer(selected.id, { transport: t })}>{t}</button>
                ))}
              </div>
            </div>
            {selected.transport === "http"
              ? (
                <div className="field"><label>endpoint URL</label>
                  <input className="input" value={selected.url ?? ""} onChange={ev => updateMcpServer(selected.id, { url: ev.target.value })} />
                </div>
              ) : (
                <div className="field"><label>command</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input className="input" placeholder="command" value={selected.command ?? ""} onChange={ev => updateMcpServer(selected.id, { command: ev.target.value })} style={{ flex: "0 0 120px" }} />
                    <input className="input" placeholder="args" value={selected.args ?? ""} onChange={ev => updateMcpServer(selected.id, { args: ev.target.value })} style={{ flex: 1 }} />
                  </div>
                </div>
              )}
          </DrawerBody>
        )}
      />
      }
    >
      {body}
    </TabbedScreen>
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// Hooks view — embedded in Automations (lifecycle automations live beside Schedules). Reads/mutates
// the store's `hooks` slice. No install/version/analytics machinery (hooks aren't downloadable).
// ════════════════════════════════════════════════════════════════════════════════════════════

function hookLabel(e: Hook): string {
  return e.event ? `hook · ${e.event}` : "hook";
}

export function HooksView() {
  const hooks            = useAppStore(s => s.hooks);
  const addHook          = useAppStore(s => s.addHook);
  const updateHook       = useAppStore(s => s.updateHook);
  const removeHook       = useAppStore(s => s.removeHook);
  const toggleHook       = useAppStore(s => s.toggleHook);
  const setHookProjects  = useAppStore(s => s.setHookProjects);
  const githubToken      = useAppStore(s => s.githubToken);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const projects = useGhProjects(githubToken);
  const selected = selectedId ? hooks.find(e => e.id === selectedId) ?? null : null;

  function addFromCatalog(item: CatalogItem) {
    addHook(hookFromCatalog(item.name));
    const created = useAppStore.getState().hooks;
    const last = created[created.length - 1];
    if (last) setSelectedId(last.id);
  }

  function addCustom() {
    addHook(blankHook());
    const created = useAppStore.getState().hooks;
    const last = created[created.length - 1];
    if (last) setSelectedId(last.id);
  }

  function installedView() {
    const onCount = hooks.filter(e => e.enabled).length;
    return (
      <div>
        <div className="sec-head">
          <h3>Hooks</h3>
          <span className="hint">Claude Code lifecycle automations</span>
          <div className="spacer" />
          <span className="meta">{onCount}/{hooks.length} enabled</span>
        </div>
        <div className="row-list">
          {hooks.length === 0 && (
            <div className="hint" style={{ padding: "8px 2px" }}>No hooks yet — add one from the catalog.</div>
          )}
          {hooks.map(e => (
            <InstalledRow
              key={e.id}
              name={e.name}
              tagCls="green"
              tagLabel={hookLabel(e)}
              desc={<>{e.command || "no command set"}{e.matcher ? ` · ${e.matcher}` : ""}</>}
              scopeChip={scopeChips(e, projects)}
              on={e.enabled}
              selected={selectedId === e.id}
              onSelect={() => setSelectedId(e.id)}
              onToggle={() => toggleHook(e.id)}
            />
          ))}
        </div>
      </div>
    );
  }

  function catalogView() {
    const q = search.trim().toLowerCase();
    const installedNames = new Set(hooks.map(e => e.name.toLowerCase()));
    const available = HOOK_CATALOG.filter(c => !installedNames.has(c.name.toLowerCase()));
    const items = q ? available.filter(c => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)) : available;
    return (
      <>
        <div className="sec-head">
          <h3>Add from catalog</h3>
          <span className="hint">First-party hooks.</span>
          <div className="spacer" />
          <input className="input" placeholder="search catalog…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200, height: 24, fontSize: 10.5 }} />
        </div>
        <div className="catalog">
          {items.map(c => (
            <CatalogCard key={c.name} item={c} action={
              <button className="btn" style={{ height: 22, fontSize: 10, padding: "0 10px" }} onClick={() => addFromCatalog(c)}>add</button>
            } />
          ))}
          {items.length === 0 && <div className="hint" style={{ padding: "8px 2px" }}>No catalog entries match “{search}”.</div>}
        </div>
      </>
    );
  }

  return (
    <div className="ext-screen">
      <div className="ext-page">
        <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 22px 0" }}>
          <button className="btn ghost" onClick={addCustom}>+ Custom hook</button>
        </div>
        <div className="ext-body">
          {installedView()}
          <div style={{ height: 20 }} />
          {catalogView()}
        </div>
      </div>

      <DrawerSlideOver
        open={!!selected}
        onClose={() => setSelectedId(null)}
        onRemove={() => { if (selected) { removeHook(selected.id); setSelectedId(null); } }}
        header={selected && (
          <>
            <div className={"health " + (selected.enabled ? "" : "off")} />
            <div className="name">{selected.name || "Untitled hook"}</div>
            <span className="tag green">{hookLabel(selected)}</span>
          </>
        )}
        body={selected && (
          <DrawerBody
            item={selected}
            kindLabel={hookLabel(selected)}
            projects={projects}
            onName={name => updateHook(selected.id, { name })}
            onSetProjects={ids => setHookProjects(selected.id, ids)}
            onSetEnv={env => updateHook(selected.id, { env })}
          >
            <div className="field"><label>event</label>
              <input className="input" placeholder="PreToolUse | PostToolUse | Stop …" value={selected.event ?? ""} onChange={ev => updateHook(selected.id, { event: ev.target.value })} style={{ width: 240 }} />
            </div>
            <div className="field"><label>matcher</label>
              <input className="input" placeholder="optional tool matcher (regex)" value={selected.matcher ?? ""} onChange={ev => updateHook(selected.id, { matcher: ev.target.value })} />
            </div>
            <div className="field"><label>command</label>
              <input className="input" placeholder="command to run" value={selected.command ?? ""} onChange={ev => updateHook(selected.id, { command: ev.target.value })} />
            </div>
          </DrawerBody>
        )}
      />
    </div>
  );
}
