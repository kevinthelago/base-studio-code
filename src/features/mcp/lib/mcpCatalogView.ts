// Catalog/installed derivation for the MCP screen. Pure (no React/Tauri): splits the catalog into
// the always-available "Built-in tools" set vs the downloadable browse list, dedupes already-
// installed servers, and free-text filters. Shared by the screen's installed + catalog views.

import { MCP_CATALOG, type CatalogItem } from "@/shared/data/mcpCatalog";
import { BUILTIN_MCP_SERVERS, type McpServer } from "./mcpServers";

/** Catalog entries for the built-in servers (#1196) — shown as always-available, never downloadable. */
export const builtInCatalog: CatalogItem[] = MCP_CATALOG.filter(
  c => c.builtIn || BUILTIN_MCP_SERVERS.some(b => b.name.toLowerCase() === c.name.toLowerCase()),
);

/** Lowercased names of the installed servers, for catalog dedupe. */
export function installedNameSet(servers: McpServer[]): Set<string> {
  return new Set(servers.map(e => e.name.toLowerCase()));
}

/** The downloadable/browsable catalog: every entry that isn't built-in (those live in the
 *  Built-in tools section) and isn't already installed. */
export function browsableCatalog(servers: McpServer[]): CatalogItem[] {
  const installed = installedNameSet(servers);
  return MCP_CATALOG.filter(c => !c.builtIn && !installed.has(c.name.toLowerCase()));
}

/** Count for the Catalog tab badge: catalog entries not yet installed (built-ins included, matching
 *  the original badge). */
export function catalogTabCount(servers: McpServer[]): number {
  const installed = installedNameSet(servers);
  return MCP_CATALOG.filter(c => !installed.has(c.name.toLowerCase())).length;
}

/** Free-text filter over a catalog list by name + description (empty query → unchanged). */
export function filterCatalog(items: CatalogItem[], query: string): CatalogItem[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter(c => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q)) : items;
}
