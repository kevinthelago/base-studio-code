// Blueprint MCP-server attachment (#897). A blueprint section (and the blueprint as a whole)
// can attach reusable MCP servers — tools the planner / fleet can call (research, analysis,
// grading, validation, export). This is the tool counterpart to blueprintSkills.ts (knowledge);
// the two are kept SEPARATE on purpose. Servers are referenced by NAME — the portable ref that
// matches the catalog + `<mcp_assign name="…">` — so a blueprint shared as a gist carries its
// tool list, and the existing applyMcpAssign/{dir} machinery scopes them to the project at
// launch. Pure (no React/Tauri) so it's unit-testable and shared by the editor + launch path.

import { type McpServer } from "@/features/mcp/lib/mcpServers";
import { MCP_CATALOG } from "@/shared/data/mcpCatalog";
import { catalogLink } from "@/features/mcp/lib/mcpInstall";
import { applyMcpAssign, type McpStoreLike } from "../lib/planExtensions";
import { type Blueprint } from "../stages/blueprints";

/** One pickable MCP server. `id` is the server NAME (the portable ref stored in a blueprint). */
export interface McpLibraryItem {
  id: string;
  name: string;
  desc?: string;
  /** A downloadable first-party server (installs from source via its catalog git link). */
  downloadable: boolean;
}

/**
 * The pickable MCP-server library for the editor: every MCP server in the catalog (first-party +
 * known) plus any installed MCP server not already in the catalog. Deduped by name
 * (case-insensitive), catalog first.
 */
export function buildMcpLibrary(servers: McpServer[], catalog = MCP_CATALOG): McpLibraryItem[] {
  const out: McpLibraryItem[] = [];
  const seen = new Set<string>();
  const add = (name: string, desc: string | undefined, downloadable: boolean) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: name, name, desc, downloadable });
  };
  for (const c of catalog) add(c.name, c.desc, !!c.link);
  for (const e of servers) add(e.name, undefined, !!catalogLink(e.name));
  return out;
}

/**
 * Every MCP server name a blueprint attaches — blueprint-wide plus every section — deduped
 * (case-insensitive) and order-preserving. The launch path feeds these to `applyMcpAssign` so the
 * project's planner/fleet sessions get them. The blueprint-wide names come first.
 */
export function collectBlueprintMcp(bp: Blueprint): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (name: string) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const n of bp.mcp ?? []) add(n);
  for (const s of bp.sections) for (const n of s.mcp ?? []) add(n);
  return out;
}

/**
 * Scope a blueprint's attached MCP servers to a project (#897 Phase 2). Idempotently applies
 * each `collectBlueprintMcp` name via `applyMcpAssign` (enables + scopes an existing extension, or
 * adds a catalog-derived one), so the project's planner + fleet sessions get the tools the
 * blueprint declares. Returns the **downloadable** server names (those with a catalog git link) so
 * the caller can clone them (a Tauri side-effect kept out of this pure function). `baseDir`
 * resolves the `{dir}` placeholder for first-party servers.
 */
export function applyBlueprintMcp(
  store: McpStoreLike,
  bp: Blueprint,
  projectId: string,
  baseDir = "",
): string[] {
  const downloadable: string[] = [];
  for (const name of collectBlueprintMcp(bp)) {
    applyMcpAssign(store, name, projectId, baseDir);
    if (catalogLink(name)) downloadable.push(name);
  }
  return downloadable;
}
