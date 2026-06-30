// App-chrome domain — automations/settings sub-tabs, per-page tab order, detached tabs/sections,
// and perf + log config. Split from store/types (#1634).
import type { PerfConfig } from "./perf";
import type { LogConfig } from "./log";

/** App-chrome slice of {@link AppStore}. */
export interface ShellState {
  // Automations
  automationsTab: "schedules" | "history";
  setAutomationsTab: (tab: ShellState["automationsTab"]) => void;
  /** Persisted, user-arranged tab order per page (keyed by page id). A page opens
   *  whatever tab the user dragged to the front, so the order IS the preference
   *  (#463). Unknown/new tabs append; stale ids are ignored. */
  pageTabOrder: Record<string, string[]>;
  setPageTabOrder: (page: string, order: string[]) => void;
  /** Console tab ids currently shown in their own window (#430). Session-only
   *  (NOT persisted): hidden from this window's tab bar while detached, cleared
   *  on re-dock or app restart — so the tab returns to its persisted place. */
  detachedTabIds: string[];
  setTabDetached: (id: string, detached: boolean) => void;
  /** Per-page section ids currently shown in their own window (#430). Session-only
   *  (NOT persisted), like detachedTabIds — hidden from the page's tab bar while
   *  detached, returned on re-dock/restart to their persisted place. */
  detachedSections: Record<string, string[]>;
  setSectionDetached: (page: string, id: string, detached: boolean) => void;

  // Settings
  settingsSection: string;
  setSettingsSection: (section: string) => void;
  /**
   * First-run OS-sandbox setup nudge (#1916). How many times the user has DISMISSED the banner
   * (pressed the ✕). The banner shows on launch while the deny-list posture is on and the sandbox
   * isn't ready, and stays hidden once this reaches `SANDBOX_NUDGE_MAX_DISMISSALS`. Counting
   * dismissals (not shows) means the nudge persists across launches until the user actually
   * acknowledges it, rather than silently vanishing after a render they may have missed.
   */
  sandboxNudgeDismissCount: number;
  /** Record a ✕ dismissal of the sandbox nudge. */
  dismissSandboxNudge: () => void;

  // Performance monitoring (#569)
  perfConfig: PerfConfig;
  setPerfConfig: (config: PerfConfig) => void;

  // Log management (#1060)
  logConfig: LogConfig;
  setLogConfig: (config: LogConfig) => void;
}
