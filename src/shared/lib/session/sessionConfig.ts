// Assemble a session's backend config from its resolved MCP servers + hooks.
// The two feature models stay independent; they meet only here, where the lists are
// converted to the payload shapes `ensure_session_settings` writes into a session's
// `.mcp.json` (servers) and `.claude/settings.json` (hooks).

import { type McpServer, type McpServerPayload, toMcpPayload } from "@/features/extensions/lib/mcpServers";
import { type Hook, type HookPayload, toHookPayload } from "@/features/extensions/lib/hooks";

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

/**
 * Auto-allow permission rules (`mcp__<server>`) for a set of resolved MCP payloads. Listing a
 * server in `enabledMcpjsonServers` only lets Claude Code LOAD it without the trust prompt — in the
 * default permission mode each tool CALL still prompts unless an allow rule covers it. `mcp__<name>`
 * with no `__tool` suffix is Claude Code's "all tools from this server" form, so a session that
 * trusts these servers also auto-approves their tool calls (e.g. the planner running the Research
 * MCP while authoring a skill). Pass the rules into `ensure_session_settings`' `allowToolRules`.
 */
export function mcpAllowRules(mcp: McpServerPayload[]): string[] {
  return mcp.map((m) => `mcp__${m.name}`);
}
