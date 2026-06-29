// MCP feature store slice (#1309) — MCP servers + hooks, extracted from the former `session`
// grab-bag slice. Composed into the single app store by store/index.ts.
import type { StateCreator } from "zustand";
import type { AppStore } from "@/store/types";
import type { McpServer } from "./lib/mcpServers";
import type { Hook } from "./lib/hooks";

export interface McpSlice {
  // MCP servers the user configures, each scoped via `projects` ([] = global). Written into a
  // launched session's .mcp.json. Persisted.
  mcpServers: McpServer[];
  addMcpServer: (def: Omit<McpServer, "id">) => string;
  updateMcpServer: (id: string, patch: Partial<McpServer>) => void;
  removeMcpServer: (id: string) => void;
  toggleMcpServer: (id: string) => void;
  setMcpServerProjects: (id: string, projects: string[]) => void;
  // Lifecycle hooks, each scoped via `projects`. Written into .claude/settings.json. Persisted.
  hooks: Hook[];
  addHook: (def: Omit<Hook, "id">) => string;
  updateHook: (id: string, patch: Partial<Hook>) => void;
  removeHook: (id: string) => void;
  toggleHook: (id: string) => void;
  setHookProjects: (id: string, projects: string[]) => void;
  // Resolved per-pane servers + hooks (transient): set at session creation, read by TerminalView.
  paneMcpServers: Record<string, McpServer[]>;
  paneHooks: Record<string, Hook[]>;
}

export const createMcpSlice: StateCreator<AppStore, [], [], McpSlice> = (set) => ({
  mcpServers: [],
  addMcpServer: (def) => {
    const id = `mcp_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ mcpServers: [...s.mcpServers, { ...def, id }] }));
    return id;
  },
  updateMcpServer: (id, patch) =>
    set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
  removeMcpServer: (id) =>
    set((s) => ({ mcpServers: s.mcpServers.filter((e) => e.id !== id) })),
  toggleMcpServer: (id) =>
    set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
  setMcpServerProjects: (id, projects) =>
    set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, projects } : e)) })),
  hooks: [],
  addHook: (def) => {
    const id = `hook_${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ hooks: [...s.hooks, { ...def, id }] }));
    return id;
  },
  updateHook: (id, patch) =>
    set((s) => ({ hooks: s.hooks.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
  removeHook: (id) =>
    set((s) => ({ hooks: s.hooks.filter((e) => e.id !== id) })),
  toggleHook: (id) =>
    set((s) => ({ hooks: s.hooks.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
  setHookProjects: (id, projects) =>
    set((s) => ({ hooks: s.hooks.map((e) => (e.id === id ? { ...e, projects } : e)) })),
  paneMcpServers: {},
  paneHooks: {},
});
