// SessionSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import { repoPromptKey } from "../../lib/session/startupPrompt";
import { DEFAULT_AUTO_FOCUS_MODE } from "../../lib/console/focusQueue";

// NOTE: the skill library / per-session overrides / task groups moved to the Skills feature slice
// (@/features/skills/store, #1309). This slice keeps MCP servers, hooks, command tiers, and the
// session-wide flags/models.
type SessionSlice = Pick<AppStore,
  "mcpServers" | "addMcpServer" | "updateMcpServer" | "removeMcpServer" | "toggleMcpServer" | "setMcpServerProjects" | "hooks" | "addHook" | "updateHook" | "removeHook" | "toggleHook" | "setHookProjects" | "paneMcpServers" | "paneHooks" | "allowedCommands" | "addAllowedCommand" | "removeAllowedCommand" | "setAllowedCommands" | "deniedCommands" | "addDeniedCommand" | "removeDeniedCommand" | "setDeniedCommands" | "projectAllowedCommands" | "addProjectAllowedCommand" | "removeProjectAllowedCommand" | "repoAllowedCommands" | "addRepoAllowedCommand" | "removeRepoAllowedCommand" | "paneAllowedCommands" | "autoFocusMode" | "setAutoFocusMode" | "autoAdvanceOnReply" | "setAutoAdvanceOnReply" | "autoResumeClaude" | "setAutoResumeClaude" | "injectionHardGate" | "setInjectionHardGate" | "autoPlanWithClaude" | "setAutoPlanWithClaude" | "autoCompleteGates" | "setAutoCompleteGates" | "allowGateOverride" | "setAllowGateOverride" | "restrictToBscIssues" | "setRestrictToBscIssues" | "coordAutoWake" | "setCoordAutoWake" | "defaultModel" | "setDefaultModel" | "fleetHarness" | "setFleetHarness" | "paneModels" | "setPaneModel"
>;

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = (set) => ({
      mcpServers: [],
      addMcpServer: (def) =>
        set((s) => ({
          mcpServers: [...s.mcpServers, { ...def, id: `mcp_${Math.random().toString(36).slice(2, 8)}` }],
        })),
      updateMcpServer: (id, patch) =>
        set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
      removeMcpServer: (id) =>
        set((s) => ({ mcpServers: s.mcpServers.filter((e) => e.id !== id) })),
      toggleMcpServer: (id) =>
        set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, enabled: !e.enabled } : e)) })),
      setMcpServerProjects: (id, projects) =>
        set((s) => ({ mcpServers: s.mcpServers.map((e) => (e.id === id ? { ...e, projects } : e)) })),
      hooks: [],
      addHook: (def) =>
        set((s) => ({
          hooks: [...s.hooks, { ...def, id: `hook_${Math.random().toString(36).slice(2, 8)}` }],
        })),
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

      allowedCommands: [],
      addAllowedCommand: (cmd) =>
        set((s) => ({
          allowedCommands: s.allowedCommands.includes(cmd)
            ? s.allowedCommands
            : [...s.allowedCommands, cmd],
        })),
      removeAllowedCommand: (cmd) =>
        set((s) => ({ allowedCommands: s.allowedCommands.filter((c) => c !== cmd) })),
      setAllowedCommands: (commands) => set({ allowedCommands: commands }),

      deniedCommands: [],
      addDeniedCommand: (cmd) =>
        set((s) => {
          const c = cmd.trim().toLowerCase();
          if (!c || s.deniedCommands.includes(c)) return {};
          return { deniedCommands: [...s.deniedCommands, c] };
        }),
      removeDeniedCommand: (cmd) =>
        set((s) => ({ deniedCommands: s.deniedCommands.filter((c) => c !== cmd) })),
      setDeniedCommands: (commands) => set({ deniedCommands: commands }),

      projectAllowedCommands: {},
      addProjectAllowedCommand: (projectId, cmd) =>
        set((s) => {
          const c = cmd.trim().toLowerCase();
          const cur = s.projectAllowedCommands[projectId] ?? [];
          if (!c || cur.includes(c)) return {};
          return { projectAllowedCommands: { ...s.projectAllowedCommands, [projectId]: [...cur, c] } };
        }),
      removeProjectAllowedCommand: (projectId, cmd) =>
        set((s) => ({
          projectAllowedCommands: {
            ...s.projectAllowedCommands,
            [projectId]: (s.projectAllowedCommands[projectId] ?? []).filter((x) => x !== cmd),
          },
        })),
      repoAllowedCommands: {},
      addRepoAllowedCommand: (projectId, repo, cmd) =>
        set((s) => {
          const key = repoPromptKey(projectId, repo);
          const c = cmd.trim().toLowerCase();
          const cur = s.repoAllowedCommands[key] ?? [];
          if (!c || cur.includes(c)) return {};
          return { repoAllowedCommands: { ...s.repoAllowedCommands, [key]: [...cur, c] } };
        }),
      removeRepoAllowedCommand: (projectId, repo, cmd) =>
        set((s) => {
          const key = repoPromptKey(projectId, repo);
          return {
            repoAllowedCommands: {
              ...s.repoAllowedCommands,
              [key]: (s.repoAllowedCommands[key] ?? []).filter((x) => x !== cmd),
            },
          };
        }),
      paneAllowedCommands: {},

      autoFocusMode: DEFAULT_AUTO_FOCUS_MODE,
      setAutoFocusMode: (mode) => set({ autoFocusMode: mode, autoAdvanceOnReply: mode !== "off" }),
      autoAdvanceOnReply: true,
      // Back-compat: syncs to autoFocusMode.
      setAutoAdvanceOnReply: (v) => set({ autoAdvanceOnReply: v, autoFocusMode: v ? "cycle-on-reply" : "off" }),

      autoResumeClaude: true,
      setAutoResumeClaude: (v) => set({ autoResumeClaude: v }),
      // #1107: when ON, a detected prompt-injection marker in the plan HARD-blocks publish (must be
      // resolved). Default OFF = acknowledge-to-clear (findings surfaced; the user reviews + proceeds).
      injectionHardGate: false,
      setInjectionHardGate: (v) => set({ injectionHardGate: v }),

      autoPlanWithClaude: false,
      setAutoPlanWithClaude: (v) => set({ autoPlanWithClaude: v }),

      autoCompleteGates: false,
      setAutoCompleteGates: (v) => set({ autoCompleteGates: v }),

      allowGateOverride: false,
      setAllowGateOverride: (v) => set({ allowGateOverride: v }),

      restrictToBscIssues: true, // secure by default (#738)
      setRestrictToBscIssues: (v) => set({ restrictToBscIssues: v }),
      coordAutoWake: false,
      setCoordAutoWake: (v) => set({ coordAutoWake: v }),

      defaultModel: "sonnet-4.5",
      setDefaultModel: (m) => set({ defaultModel: m }),
      fleetHarness: "claude",
      setFleetHarness: (h) => set({ fleetHarness: h }),
      paneModels: {},
      setPaneModel: (paneId, m) =>
        set((s) => ({ paneModels: { ...s.paneModels, [paneId]: m } })),
});
