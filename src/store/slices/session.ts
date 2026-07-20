// SessionSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import { DEFAULT_AUTO_FOCUS_MODE } from "@/app/console/lib/focusQueue";
import { DEFAULT_MODEL_ID } from "@/app/console/lib/models";
import { setMapEntry } from "../updateHelpers";

// NOTE: skills moved to the Skills feature slice (@/features/skills/store) and MCP servers + hooks
// to the MCP feature slice (@/features/mcp/store) (#1309). The standalone
// allowed-command tiers were retired (#1457) — profiles own command auto-approval. This slice
// keeps the global denied-command block-list and the session-wide flags/models.
type SessionSlice = Pick<AppStore,
  "deniedCommands" | "addDeniedCommand" | "removeDeniedCommand" | "setDeniedCommands" | "autoFocusMode" | "setAutoFocusMode" | "autoAdvanceOnReply" | "setAutoAdvanceOnReply" | "autoResumeClaude" | "setAutoResumeClaude" | "injectionHardGate" | "setInjectionHardGate" | "bypassPermissions" | "setBypassPermissions" | "sandboxConsoles" | "setSandboxConsoles" | "debugSession" | "setDebugSession" | "autoSpawnDebugSessions" | "setAutoSpawnDebugSessions" | "activeRequestSessions" | "setActiveRequestSessions" | "showConsolePage" | "setShowConsolePage" | "autoPlanWithClaude" | "setAutoPlanWithClaude" | "autoCompleteGates" | "setAutoCompleteGates" | "allowGateOverride" | "setAllowGateOverride" | "restrictToBscIssues" | "setRestrictToBscIssues" | "coordAutoWake" | "setCoordAutoWake" | "defaultModel" | "setDefaultModel" | "fleetHarness" | "setFleetHarness" | "paneModels" | "setPaneModel" | "activeStudioTargets" | "setActiveStudioTargets"
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
      // Safe-by-default posture (#2050): sessions run the ALLOW-LIST (Claude's `default` mode enforces
      // the enumerated allow/deny lists — anything unlisted prompts), NOT bypass. The broad base
      // allow-list (base.json) covers the typical dev toolchains so it isn't prompt-spammy, and the
      // deny-hook floor still blocks the dangerous set. Bypass (auto-run-everything) is the opt-in
      // power-user posture via Settings → Security.
      bypassPermissions: false,
      setBypassPermissions: (v) => set({ bypassPermissions: v }),
      sandboxConsoles: false,
      setSandboxConsoles: (v) => set({ sandboxConsoles: v }),
      debugSession: false,
      setDebugSession: (v) => set({ debugSession: v }),
      // #3498: auto-spawn is OFF by default. See `shared/lib/session/autoSpawn.ts` — this is only the
      // outer gate; the inner one refuses every role but `debugger` even when this is on.
      autoSpawnDebugSessions: false,
      setAutoSpawnDebugSessions: (v) => set({ autoSpawnDebugSessions: v }),
      // #3498: which requests have a live session — read by the Glance graph so each one is a visible,
      // openable node rather than a hidden background actor.
      activeRequestSessions: [],
      setActiveRequestSessions: (ids) => set({ activeRequestSessions: ids }),
      showConsolePage: false,
      setShowConsolePage: (v) => set({ showConsolePage: v }),

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

      defaultModel: DEFAULT_MODEL_ID,
      setDefaultModel: (m) => set({ defaultModel: m }),
      fleetHarness: "claude",
      setFleetHarness: (h) => set({ fleetHarness: h }),
      paneModels: {},
      setPaneModel: (paneId, m) =>
        set((s) => ({ paneModels: setMapEntry(s.paneModels, paneId, m) })),

      // Studio network (#2940): which app-owned studio sessions the pump wants reachable right now
      // (targets with open commissions). Transient (NOT persisted) — it drives the lazy-mount hosts
      // in ConsoleWorkspace, which launch the designer/librarian session on demand and tear it down
      // when the list empties.
      activeStudioTargets: [],
      setActiveStudioTargets: (t) => set({ activeStudioTargets: t }),
});
