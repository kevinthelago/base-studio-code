// SessionSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import { DEFAULT_AUTO_FOCUS_MODE } from "@/app/console/lib/focusQueue";
import { setMapEntry } from "../updateHelpers";

// NOTE: skills moved to the Skills feature slice (@/features/skills/store) and MCP servers + hooks
// to the MCP feature slice (@/features/mcp/store) (#1309). The standalone
// allowed-command tiers were retired (#1457) — profiles own command auto-approval. This slice
// keeps the global denied-command block-list and the session-wide flags/models.
type SessionSlice = Pick<AppStore,
  "deniedCommands" | "addDeniedCommand" | "removeDeniedCommand" | "setDeniedCommands" | "autoFocusMode" | "setAutoFocusMode" | "autoAdvanceOnReply" | "setAutoAdvanceOnReply" | "autoResumeClaude" | "setAutoResumeClaude" | "injectionHardGate" | "setInjectionHardGate" | "bypassPermissions" | "setBypassPermissions" | "autoPlanWithClaude" | "setAutoPlanWithClaude" | "autoCompleteGates" | "setAutoCompleteGates" | "allowGateOverride" | "setAllowGateOverride" | "restrictToBscIssues" | "setRestrictToBscIssues" | "coordAutoWake" | "setCoordAutoWake" | "defaultModel" | "setDefaultModel" | "fleetHarness" | "setFleetHarness" | "paneModels" | "setPaneModel"
>;

export const createSessionSlice: StateCreator<AppStore, [], [], SessionSlice> = (set) => ({
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
      bypassPermissions: true,
      setBypassPermissions: (v) => set({ bypassPermissions: v }),

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
        set((s) => ({ paneModels: setMapEntry(s.paneModels, paneId, m) })),
});
