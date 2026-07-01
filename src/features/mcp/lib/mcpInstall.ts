// Shared helpers for downloadable (first-party) MCP servers — the bridge between a
// catalog entry's GitHub download link and the on-disk install path its run config
// points at. Pure (no React/Tauri) so the MCP screen, the planner-assign path,
// and the planning-page panel all resolve `{dir}` the same way.

import { MCP_CATALOG } from "@/shared/data/mcpCatalog";
import { mcpInstallDir } from "@/shared/lib/core/projectPaths";

/** Repo slug from a GitHub link: the last non-empty path segment. */
export function repoNameFromLink(link: string): string {
  return link.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** The catalog download link for a server name, if it's a downloadable (first-party)
 *  server that installs from source; `undefined` for built-in/remote servers. */
export function catalogLink(name: string): string | undefined {
  return MCP_CATALOG.find((c) => c.name === name)?.link;
}

/** The repo slug (== install dir name) for a downloadable server, or "" if it isn't one.
 *  This is the `name` arg `mcp_clone` / `mcp_build` / `mcp_status` take. */
export function mcpRepoName(name: string): string {
  const link = catalogLink(name);
  return link ? repoNameFromLink(link) : "";
}

/** The on-disk install dir for a downloadable server, or "" if it isn't downloadable
 *  or `baseDir` is empty. `~/.base-studio-code/mcp/<repo>`. */
export function mcpDirForServer(name: string, baseDir: string): string {
  const link = catalogLink(name);
  return link && baseDir ? mcpInstallDir(baseDir, repoNameFromLink(link)) : "";
}

/**
 * Substitute the `{dir}` placeholder in a server def's `args` with its real on-disk
 * install path. No-op when the def has no `{dir}`, the server isn't downloadable, or
 * `baseDir` is empty — so a literal `{dir}` never reaches a launched config (the bug
 * the planner-assign path had: it skipped this and launched `--directory {dir}`).
 */
export function resolveMcpInstallDir<T extends { args?: string }>(def: T, name: string, baseDir: string): T {
  const dir = mcpDirForServer(name, baseDir);
  if (dir && def.args?.includes("{dir}")) {
    return { ...def, args: def.args.replace("{dir}", dir) };
  }
  return def;
}
