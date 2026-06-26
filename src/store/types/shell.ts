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

  // Performance monitoring (#569)
  perfConfig: PerfConfig;
  setPerfConfig: (config: PerfConfig) => void;

  // Log management (#1060)
  logConfig: LogConfig;
  setLogConfig: (config: LogConfig) => void;
}
