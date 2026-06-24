// One-time persisted-state migration: the legacy unified `extensions` list (an mcp+hook
// discriminated union) → the split `mcpServers` / `hooks` slices, plus the renamed MCP route
// key. Runs in the store's onRehydrateStorage; pure + idempotent (no-op once migrated).
// (#mcp-hooks-split)

import { type McpServer } from "./mcpServers";
import { type Hook } from "./hooks";

interface LegacyState {
  extensions?: Array<Record<string, unknown>>;
  mcpServers?: McpServer[];
  hooks?: Hook[];
  activeScreen?: string;
}

/** Split a persisted `extensions` array into `mcpServers` + `hooks` (by `kind`), mapping the old
 *  hook `hookCommand` field to `command`, and migrate the `extensions` → `mcp` route key.
 *  Mutates `state` in place. Safe to call on already-migrated or empty state. */
export function migrateLegacyExtensions(stateArg: unknown): void {
  const state = stateArg as LegacyState | undefined;
  if (!state) return;

  if (Array.isArray(state.extensions)) {
    const exts = state.extensions;
    state.mcpServers = exts
      .filter((e) => e.kind === "mcp")
      .map((e) => ({
        id: e.id, name: e.name, enabled: e.enabled, projects: (e.projects as string[]) ?? [],
        transport: e.transport ?? "stdio", command: e.command, args: e.args, url: e.url, env: e.env,
      } as McpServer));
    state.hooks = exts
      .filter((e) => e.kind === "hook")
      .map((e) => ({
        id: e.id, name: e.name, enabled: e.enabled, projects: (e.projects as string[]) ?? [],
        event: e.event ?? "PostToolUse", matcher: e.matcher, command: (e.hookCommand ?? e.command ?? ""), env: e.env,
      } as Hook));
    delete state.extensions;
  }

  if (state.activeScreen === "extensions") state.activeScreen = "mcp";
}
