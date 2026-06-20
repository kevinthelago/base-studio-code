// Assemble a session's backend config from its resolved MCP servers + hooks.
// The two feature models stay independent; they meet only here, where the lists are
// converted to the payload shapes `ensure_session_settings` writes into a session's
// `.mcp.json` (servers) and `.claude/settings.json` (hooks).

import { type McpServer, type McpServerPayload, toMcpPayload } from "./mcpServers";
import { type Hook, type HookPayload, toHookPayload } from "./hooks";

/** Resolved servers + hooks → the two backend payload lists, dropping incomplete entries. */
export function toSessionPayloads(
  mcpServers: McpServer[],
  hooks: Hook[],
): { mcp: McpServerPayload[]; hooks: HookPayload[] } {
  return {
    mcp: mcpServers.map(toMcpPayload).filter((p): p is McpServerPayload => p !== null),
    hooks: hooks.map(toHookPayload).filter((p): p is HookPayload => p !== null),
  };
}
