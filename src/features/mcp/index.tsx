import { useState, useMemo } from "react";
import { resolveMcpInstallDir, catalogLink } from "./lib/mcpInstall";
import { useMcpInstallStatus } from "./useMcpInstallStatus";
import { builtInCatalog, browsableCatalog, catalogTabCount, filterCatalog } from "./lib/mcpCatalogView";
import { useAppStore } from "@/store";
import { type TabItem } from "@/app/chrome/TabBar";
import { Screen } from "@/app/chrome/Screen";
import { McpAnalyticsTab } from "./McpAnalytics";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { type CatalogItem } from "@/shared/data/mcpCatalog";
import { HOOK_CATALOG } from "@/shared/data/hookCatalog";
import { mcpFromCatalog, type McpServer, type McpTransport } from "./lib/mcpServers";
import { hookFromCatalog, blankHook, type Hook } from "./lib/hooks";
import {
  useGhProjects, scopeChips, DrawerBody, InstalledRow, CatalogCard,
} from "./shared";
import { Pane } from "@/shared/ui/overlay/Pane";
import { Chip } from "@/shared/ui/data/Chip";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Button } from "@/shared/ui/controls/Button";
import { SectionHeader } from "@/shared/ui/layout/SectionHeader";
import { Row } from "@/shared/ui/layout/Row";
import { useDraft } from "@/shared/hooks/useDraft";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import "./mcp.css";

// ════════════════════════════════════════════════════════════════════════════════════════════
// MCP servers screen — the Rail "MCP" page. Owns the install/version machinery (download, build,
// update-check) that only servers have. Reads/mutates the store's `mcpServers` slice; every drawer
// edit is live. Hooks live separately in the Automations Hooks view (HooksView, below).
// ════════════════════════════════════════════════════════════════════════════════════════════

/** The free-text label shown on a server row / drawer header. */
function mcpLabel(e: McpServer): string {
  return e.transport === "http" ? "mcp · http" : "mcp · stdio";
}

export function McpWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  const mcpServers          = useAppStore(s => s.mcpServers);
  const addMcpServer        = useAppStore(s => s.addMcpServer);
  const updateMcpServer     = useAppStore(s => s.updateMcpServer);
  const removeMcpServer     = useAppStore(s => s.removeMcpServer);
  const toggleMcpServer     = useAppStore(s => s.toggleMcpServer);
  const setMcpServerProjects = useAppStore(s => s.setMcpServerProjects);
  const githubToken         = useAppStore(s => s.githubToken);
  const bscBaseDir          = useAppStore(s => s.bscBaseDir);

  const drawer = useDraft<McpServer>({ items: mcpServers, onUpdate: updateMcpServer });
  const [search, setSearch] = useState("");

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
  const tab = pageOverride ?? activeId;
  const selected = drawer.selected;

  /** Add a catalog item as an installed server, with `{dir}` resolved to its on-disk download
   *  path (#859). `select` opens it in the drawer; the download flow adds silently (#885). */
  function addFromCatalog(item: CatalogItem, openDrawer = true) {
    const def = resolveMcpInstallDir(mcpFromCatalog(item.name), item.name, bscBaseDir);
    const id = addMcpServer(def);
    if (openDrawer) drawer.select(id);
  }

  // The version/update control on an installed downloadable server's row (#885).
  function updateControl(e: McpServer): React.ReactNode {
    if (!catalogLink(e.name)) return null;
    const s = mcpStatus[e.name];
    if (s === "current") return <Chip tone="success" title="at the latest release">up to date</Chip>;
    if (s === "updating" || s === "building")
      return <span className="hint mono" style={{ fontSize: 10 }}>{s === "building" ? "building…" : "updating…"}</span>;
    if (s === undefined || s === "checking" || s === "downloading")
      return <span className="hint mono" style={{ fontSize: 10 }}>checking…</span>;
    const label = s === "needs-build" ? "build" : s === "error" ? "retry ↻" : "update";
    return (
      <Button variant="ghost" style={{ height: 20, fontSize: 10, padding: "0 9px" }}
        onClick={ev => { ev.stopPropagation(); updateInstalled(e); }}>{label}</Button>
    );
  }

  // Built-in tools (#1196) — ship compiled in the app bundle (native sidecars), always available
  // with no download/build/Docker. Shown as info, not toggleable; rendered in both the empty and
  // populated installed states.
  const builtInSection = builtInCatalog.length > 0 && (
    <>
      <SectionHeader title="Built-in tools" titleStyle={{ color: "var(--fg-dim)" }} hint="always available — no install" />
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
          <EmptyState
            title="No MCP servers installed"
            description="Add MCP servers from the catalog to give your agents new tools."
            actions={<Button variant="primary" onClick={() => select("catalog")}>Browse the catalog →</Button>}
          />
          {builtInSection}
        </>
      );
    }
    const onCount = mcpServers.filter(e => e.enabled).length;
    return (
      <>
        <div>
          <SectionHeader title="MCP servers" hint="external processes over stdio or HTTP" meta={<>{onCount}/{mcpServers.length} enabled</>} />
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
                selected={drawer.selectedId === e.id}
                onSelect={() => drawer.select(e.id)}
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
        <SectionHeader title="Browse" hint="First-party and third-party MCP servers you can add with one click." right={<input className="input" placeholder="search catalog…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200, height: 24, fontSize: 10.5 }} />} />
        <div className="catalog">
          {items.map(c => (
            <CatalogCard key={c.name} item={c} action={
              c.link ? (
                <Button variant="primary" style={{ height: 22, fontSize: 10, padding: "0 10px" }}
                  disabled={mcpStatus[c.name] === "downloading" || mcpStatus[c.name] === "building"}
                  onClick={() => downloadFromCatalog(c, item => addFromCatalog(item, false))}>
                  {mcpStatus[c.name] === "downloading" ? "downloading…" : mcpStatus[c.name] === "building" ? "building…" : mcpStatus[c.name] === "error" ? "retry ↻" : "download"}
                </Button>
              ) : (
                <Button style={{ height: 22, fontSize: 10, padding: "0 10px" }} onClick={() => addFromCatalog(c)}>add</Button>
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

  return (
    <Screen
      tabs={tabs}
      active={tab}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      pageOverride={pageOverride}
      className="ext-workspace"
      bodyClassName="ext-body"
      overlay={
        <Pane
        open={!!selected}
        onClose={drawer.close}
        onRemove={() => { if (selected) { removeMcpServer(selected.id); drawer.close(); } }}
        header={selected && (
          <>
            <div className={"health " + (selected.enabled ? "" : "off")} />
            <div className="name">{selected.name || "Untitled server"}</div>
            <Chip tone="info">{mcpLabel(selected)}</Chip>
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
              <SegmentedControl
                options={(["stdio", "http"] as McpTransport[]).map(t => ({
                  label: t,
                  on: selected.transport === t,
                  onClick: () => updateMcpServer(selected.id, { transport: t }),
                }))}
              />
            </div>
            {selected.transport === "http"
              ? (
                <div className="field"><label>endpoint URL</label>
                  <input className="input" value={selected.url ?? ""} onChange={ev => updateMcpServer(selected.id, { url: ev.target.value })} />
                </div>
              ) : (
                <div className="field"><label>command</label>
                  <Row gap={6} align="stretch">
                    <input className="input" placeholder="command" value={selected.command ?? ""} onChange={ev => updateMcpServer(selected.id, { command: ev.target.value })} style={{ flex: "0 0 120px" }} />
                    <input className="input" placeholder="args" value={selected.args ?? ""} onChange={ev => updateMcpServer(selected.id, { args: ev.target.value })} style={{ flex: 1 }} />
                  </Row>
                </div>
              )}
          </DrawerBody>
        )}
      />
      }
    >
      {body}
    </Screen>
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

  const drawer = useDraft<Hook>({ items: hooks, onUpdate: updateHook });
  const [search, setSearch] = useState("");
  const projects = useGhProjects(githubToken);
  const selected = drawer.selected;

  function addFromCatalog(item: CatalogItem) {
    drawer.select(addHook(hookFromCatalog(item.name)));
  }

  function addCustom() {
    drawer.select(addHook(blankHook()));
  }

  function installedView() {
    const onCount = hooks.filter(e => e.enabled).length;
    return (
      <div>
        <SectionHeader title="Hooks" hint="Claude Code lifecycle automations" meta={<>{onCount}/{hooks.length} enabled</>} />
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
              selected={drawer.selectedId === e.id}
              onSelect={() => drawer.select(e.id)}
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
        <SectionHeader title="Add from catalog" hint="First-party hooks." right={<input className="input" placeholder="search catalog…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200, height: 24, fontSize: 10.5 }} />} />
        <div className="catalog">
          {items.map(c => (
            <CatalogCard key={c.name} item={c} action={
              <Button style={{ height: 22, fontSize: 10, padding: "0 10px" }} onClick={() => addFromCatalog(c)}>add</Button>
            } />
          ))}
          {items.length === 0 && <div className="hint" style={{ padding: "8px 2px" }}>No catalog entries match “{search}”.</div>}
        </div>
      </>
    );
  }

  return (
    <div className="ext-workspace">
      <div className="ext-page">
        <Row justify="end" align="stretch" style={{ padding: "10px 22px 0" }}>
          <Button variant="ghost" onClick={addCustom}>+ Custom hook</Button>
        </Row>
        <div className="ext-body">
          {installedView()}
          <div style={{ height: 20 }} />
          {catalogView()}
        </div>
      </div>

      <Pane
        open={!!selected}
        onClose={drawer.close}
        onRemove={() => { if (selected) { removeHook(selected.id); drawer.close(); } }}
        header={selected && (
          <>
            <div className={"health " + (selected.enabled ? "" : "off")} />
            <div className="name">{selected.name || "Untitled hook"}</div>
            <Chip tone="success">{hookLabel(selected)}</Chip>
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
