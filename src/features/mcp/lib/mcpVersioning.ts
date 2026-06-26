// Version/install status of a downloadable (first-party) MCP server (#885). Pure (no React/Tauri)
// so the status type + its derivation are unit-testable and shared by the screen's install hook.

import { catalogLink } from "./mcpInstall";
import type { McpServer } from "./mcpServers";

/** Install/version status of a downloadable MCP server (#885). */
export type McpStat =
  | "checking" | "current" | "outdated" | "needs-build"
  | "downloading" | "building" | "updating" | "error";

/** The shape `mcp_check_update` resolves to: whether the clone exists, is built, and is behind. */
export interface McpCheckResult {
  downloaded: boolean;
  built: boolean;
  updateAvailable: boolean;
}

/** Map a backend `mcp_check_update` result to the row status shown on an installed server (#885):
 *  not cloned (or not yet built) → needs-build, behind its remote → outdated, else current. */
export function deriveCheckStat(r: McpCheckResult): McpStat {
  return !r.downloaded ? "needs-build" : r.updateAvailable ? "outdated" : !r.built ? "needs-build" : "current";
}

/** The names of installed servers that are downloadable (first-party, install-from-source) — the
 *  ones the version check runs against. */
export function installedDownloadableNames(servers: McpServer[]): string[] {
  return servers.filter(e => catalogLink(e.name)).map(e => e.name);
}
