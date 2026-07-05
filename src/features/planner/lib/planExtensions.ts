// MCP-server assignment from the planner (#174). The planner assigns an MCP server to a project via
// `bsc plan mcp add <name>` (plan.db); the section poll resolves each assigned catalog name into the
// MCP-servers subsystem (`applyMcpAssign` → `resolveMcpServers` → `paneMcpServers` → `.mcp.json` at
// build/triage launch), so the SAME launch wiring that powers the MCP screen loads it with no extra
// glue. Pure (no React/Tauri) so the catalog mapping is unit-testable and shared with its tests.
// (The old `<mcp_assign>` stream tag + its parser were removed in the tag→bsc migration, #2012.)

import { mcpFromCatalog, type McpServer } from "@/features/mcp";
import { resolveMcpInstallDir, catalogLink } from "@/features/mcp";

/**
 * The {@link McpServer} (minus id) a `<mcp_assign name>` resolves to: the catalog
 * template for `name`, **enabled** and **scoped to `projectId`** so it applies to that
 * project's build/triage sessions. An unknown name yields a blank stdio server the user
 * completes; required env values stay blank (never invent secrets).
 *
 * For a downloadable (first-party) server, `baseDir` resolves the `{dir}` placeholder in
 * the run config to its on-disk install path (`~/.base-studio-code/mcp/<repo>`). Without
 * this the launched config keeps a literal `--directory {dir}` and the server never starts.
 */
export function mcpAssignToServer(name: string, projectId: string, baseDir = ""): Omit<McpServer, "id"> {
  const def = resolveMcpInstallDir(mcpFromCatalog(name), name, baseDir);
  return { ...def, enabled: true, projects: projectId ? [projectId] : [] };
}

/** Whether a `<mcp_assign>` name is a downloadable first-party server (has a catalog
 *  download link) — i.e. assigning it should also clone its repo. */
export function isDownloadableMcp(name: string): boolean {
  return !!catalogLink(name);
}

export interface McpStoreLike {
  mcpServers: McpServer[];
  addMcpServer: (def: Omit<McpServer, "id">) => void;
  updateMcpServer: (id: string, patch: Partial<McpServer>) => void;
}

/**
 * Idempotently apply one `<mcp_assign>` to the MCP-servers store: if a server with this
 * name already exists, just ensure it's enabled and scoped to the project (a global
 * server — `projects: []` — is left global); otherwise add a fresh catalog-derived def.
 * Returns whether a NEW server was added (vs. an existing one updated), for callers that
 * want to report it. Keeping this here (not in the React component) makes the dedup/scope
 * rule unit-testable.
 */
export function applyMcpAssign(store: McpStoreLike, name: string, projectId: string, baseDir = ""): boolean {
  const existing = store.mcpServers.find(
    (e) => e.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    const projects =
      existing.projects.length === 0 || existing.projects.includes(projectId)
        ? existing.projects
        : [...existing.projects, projectId];
    store.updateMcpServer(existing.id, { enabled: true, projects });
    return false;
  }
  store.addMcpServer(mcpAssignToServer(name, projectId, baseDir));
  return true;
}
