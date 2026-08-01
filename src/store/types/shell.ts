// App-chrome domain — automations/settings sub-tabs, per-page tab order, detached tabs/sections,
// and perf + log config. Split from store/types (#1634).
import type { PerfConfig } from "./perf";
import type { LogConfig } from "./log";
import type { AppStateSnapshot } from "../appState";

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
  /** Persisted last-selected page (tab id) per page (keyed by page id). Lets a
   *  workspace reopen on the Page the user last viewed — across an in-session
   *  workspace switch (most workspaces unmount when inactive) and across restart —
   *  instead of always snapping back to the front tab. Falls back to the front tab
   *  (see {@link pageTabOrder}, #463) when there's no memory; a stale id self-heals
   *  to the front tab via `usePageTabs`'s validity effect. */
  activePageTab: Record<string, string>;
  setActivePageTab: (page: string, id: string) => void;
  /** The navigated ENTITY label per graph, keyed by page id (`glance`/`teams`/`designs`/`algorithms`),
   *  reported by each graph via `useCrumbEntity` so the titlebar location crumb can name where you are
   *  INSIDE a graph — the drilled project, entered team, active kit, active language (#3041). Session-only
   *  transient (NOT persisted): each graph re-reports on mount, so it's always live. Empty = no entity. */
  crumbEntity: Record<string, string>;
  setCrumbEntity: (key: string, label: string) => void;
  /** The Workspace's live PageTabs, published by the mounted `Screen` so the app shell's keyboard owner
   *  (`useHotkeys`) can step them with Ctrl+←/→ (#4167).
   *
   *  This exists to INVERT a dependency, not to hold state: `Screen` lives in `shared/`, which may not
   *  import value symbols from `features/` or `app/` (#1626/#1703) — so it cannot match a keybinding
   *  itself. It publishes plain data + its own selector here instead, and the shell (which legitimately
   *  knows every feature) does the matching. That also keeps ALL keyboard handling in one place.
   *
   *  Session-only transient (NOT persisted — it carries a live callback): exactly one Screen is mounted
   *  at a time, it re-publishes on every change, and clears on unmount. `null` = no tabbed Workspace on
   *  screen (the Console page, or a torn-off single Page). */
  pageNav: { ids: string[]; active: string; select: (id: string) => void } | null;
  setPageNav: (nav: { ids: string[]; active: string; select: (id: string) => void } | null) => void;
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

  // Demo app-state (#2272) — a loaded demo overlays the demoable store slices; the pre-demo values
  // are stashed in `demoBackup` so clearing restores exactly what was there (empty → empty). Both
  // persist so a demo survives restart and stays clearable.
  /** Whether a demo app-state is currently loaded over the user's real state. */
  demoActive: boolean;
  /** The demoable slice values captured just before the demo was loaded (null when no demo active). */
  demoBackup: AppStateSnapshot | null;
  /** Overlay a demo snapshot onto the store, backing up the current demoable state first (once). */
  loadDemoState: (snapshot: AppStateSnapshot) => void;
  /** Restore the pre-demo state (no-op when no demo is active). */
  clearDemoState: () => void;
}
