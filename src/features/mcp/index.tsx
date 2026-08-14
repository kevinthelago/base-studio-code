import { useState } from "react";
import { useAppStore } from "@/store";
import { type CatalogItem } from "@/shared/data/mcpCatalog";
import { HOOK_CATALOG } from "@/shared/data/hookCatalog";
import { hookFromCatalog, blankHook, SYSTEM_HOOKS, type Hook } from "./lib/hooks";
import {
  useGhProjects, scopeChips, DrawerBody, InstalledRow, CatalogCard,
} from "@/features/mcp/shared";
import { CardListRow } from "@/shared/ui/data/CardListRow";
import { Pane } from "@/shared/ui/overlay/Pane";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { SectionHeader } from "@/shared/ui/layout/SectionHeader";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { useDraft } from "@/shared/hooks/useDraft";
import { TextField } from "@/shared/ui/controls/Field";
import "./mcp.css";

// The graph-hosted workspace (#3656) — App.tsx/DetachedWindow render this via the lazy McpWorkspace.
export { McpGraphHost } from "./McpGraphHost";

// #1545: public API for cross-feature consumers (planner, automations, app/console, store).
// Re-export the exact lib symbols other features reach for so Phase 2 can target the barrel.
export {
  type McpServer, type McpTransport, BUILTIN_MCP_SERVERS, resolveMcpServers,
  mcpFromCatalog, resolveAllInstalledMcp, toBscAgentMcp,
} from "./lib/mcpServers";
export { catalogLink, resolveMcpInstallDir, repoNameFromLink, mcpRepoName } from "./lib/mcpInstall";
export { toSessionPayloads, mcpAllowRules } from "./lib/sessionConfig";
export { resolveHooks, type Hook } from "./lib/hooks";
export { parseHookLog, aggregateHookTelemetry, type HookAnalytics } from "./lib/hookTelemetry";
export { migrateLegacyExtensions } from "./lib/migrateExtensions";

// The MCP servers SCREEN is not here — it is the `mcppage` RECORD, mounted by `McpGraphHost`, which is
// what `lazyWorkspaces` resolves `McpWorkspace` to. Both shells already render the graph copy, so the
// duplicate that used to sit here was dead code: nothing imported it.
//
// HooksView below is DIFFERENT — no record holds it (`mcppage` says it is "out of scope here", and
// `automationspage` carries only a compact stand-in), so it is UNMIGRATED code with a live consumer,
// not a duplicate. Migrating it needs its own record + host, and deleting it on the assumption it
// lives in the graph would lose it.

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
      <Box>
        <SectionHeader title="Hooks" hint="Claude Code lifecycle automations" meta={<>{onCount}/{hooks.length} enabled</>} />
        <Box className="row-list">
          {hooks.length === 0 && (
            <Box className="hint" pad={[8, 2]}>No hooks yet — add one from the catalog.</Box>
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
        </Box>
      </Box>
    );
  }

  // The always-on security floor (#1916/#2050): PreToolUse hooks the app injects into every session
  // backend-side. Surfaced read-only ("system · always on") so the view reflects the REAL running
  // set — they can't be toggled or removed here (they describe what runs, not user config).
  function systemView() {
    return (
      <Box>
        <SectionHeader title="System hooks" hint="the always-on security floor — injected into every session, not editable" meta={<>{SYSTEM_HOOKS.length} always on</>} />
        <Box className="row-list">
          {SYSTEM_HOOKS.map(h => (
            <CardListRow
              key={h.name}
              lead={<Box className="health" />}
              title={h.name}
              badge={<Chip tone="info">{`hook · ${h.event}`}</Chip>}
              subtitle={h.purpose}
              trailing={<Chip title="always on — injected by the app, not user-configurable">system · always on</Chip>}
            />
          ))}
        </Box>
      </Box>
    );
  }

  function catalogView() {
    const q = search.trim().toLowerCase();
    const installedNames = new Set(hooks.map(e => e.name.toLowerCase()));
    const available = HOOK_CATALOG.filter(c => !installedNames.has(c.name.toLowerCase()));
    const items = q ? available.filter(c => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)) : available;
    return (
      <>
        {/* eslint-disable-next-line no-restricted-syntax -- inline toolbar search box in the SectionHeader right slot; TextField's .field wrapper would change the header layout */}
        <SectionHeader title="Add from catalog" hint="First-party hooks." right={<input className="input" placeholder="search catalog…" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200, height: 24, fontSize: 10.5 }} />} />
        <Box className="catalog">
          {items.map(c => (
            <CatalogCard key={c.name} item={c} action={
              <Button style={{ height: 22, fontSize: 10, padding: "0 10px" }} onClick={() => addFromCatalog(c)}>add</Button>
            } />
          ))}
          {items.length === 0 && <Box className="hint" pad={[8, 2]}>No catalog entries match “{search}”.</Box>}
        </Box>
      </>
    );
  }

  return (
    <Box className="ext-workspace">
      <Box className="ext-page">
        <Row justify="end" align="stretch" style={{ padding: "10px 22px 0" }}>
          <Button variant="ghost" onClick={addCustom}>+ Custom hook</Button>
        </Row>
        <Box className="ext-body">
          {installedView()}
          <Box style={{ height: 20 }} />
          {systemView()}
          <Box style={{ height: 20 }} />
          {catalogView()}
        </Box>
      </Box>

      <Pane
        open={!!selected}
        onClose={drawer.close}
        onRemove={() => { if (selected) { removeHook(selected.id); drawer.close(); } }}
        header={selected && (
          <>
            <Box className={"health " + (selected.enabled ? "" : "off")} />
            <Text as="div" className="name">{selected.name || "Untitled hook"}</Text>
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
            <TextField label="event" placeholder="PreToolUse | PostToolUse | Stop …" value={selected.event ?? ""} onChange={v => updateHook(selected.id, { event: v })} style={{ width: 240 }} />
            <TextField label="matcher" placeholder="optional tool matcher (regex)" value={selected.matcher ?? ""} onChange={v => updateHook(selected.id, { matcher: v })} />
            <TextField label="command" placeholder="command to run" value={selected.command ?? ""} onChange={v => updateHook(selected.id, { command: v })} />
          </DrawerBody>
        )}
      />
    </Box>
  );
}
