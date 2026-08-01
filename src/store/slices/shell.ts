// ShellSlice — app-CHROME state: the active automations/settings sub-tab, per-page tab order,
// detached tabs/sections, and perf + log config. The residual of the former `github` grab-bag after
// GitHub state moved to the GitHub feature slice and tunnel state to the Tunnel feature slice
// (#1309); the chrome fields belong to app/ eventually. Typed Pick<AppStore, …>.
import type { StateCreator } from "zustand";
import { type AppStore, DEFAULT_PERF_CONFIG, DEFAULT_LOG_CONFIG } from "../types";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { setMapEntry } from "../updateHelpers";
import { pickDemoable, mergeSnapshotInto } from "../appState";

type ShellSlice = Pick<AppStore,
  "automationsTab" | "setAutomationsTab" | "pageTabOrder" | "setPageTabOrder" | "activePageTab" | "setActivePageTab" | "crumbEntity" | "setCrumbEntity" | "detachedTabIds" | "setTabDetached" | "detachedSections" | "setSectionDetached" | "settingsSection" | "setSettingsSection" | "sandboxNudgeDismissCount" | "dismissSandboxNudge" | "perfConfig" | "setPerfConfig" | "logConfig" | "setLogConfig" | "demoActive" | "demoBackup" | "loadDemoState" | "clearDemoState"
>;

export const createShellSlice: StateCreator<AppStore, [], [], ShellSlice> = (set) => ({
      automationsTab: "schedules",
      setAutomationsTab: (tab) => set({ automationsTab: tab }),
      pageTabOrder: {},
      setPageTabOrder: (page, order) =>
        set((s) => ({ pageTabOrder: setMapEntry(s.pageTabOrder, page, order) })),
      activePageTab: {},
      // Idempotent: return state unchanged when the id is already current so the
      // no-op writes from usePageTabs's validity effect don't churn subscribers.
      setActivePageTab: (page, id) =>
        set((s) => (s.activePageTab[page] === id ? s : { activePageTab: setMapEntry(s.activePageTab, page, id) })),
      crumbEntity: {},
      // Idempotent (same guard as setActivePageTab) — the reporting effects fire on every render, so
      // skip the write when the label is unchanged to avoid churning subscribers.
      setCrumbEntity: (key, label) =>
        set((s) => (s.crumbEntity[key] === label ? s : { crumbEntity: setMapEntry(s.crumbEntity, key, label) })),
      detachedTabIds: [],
      setTabDetached: (id, detached) =>
        set((s) => ({
          detachedTabIds: detached
            ? (s.detachedTabIds.includes(id) ? s.detachedTabIds : [...s.detachedTabIds, id])
            : s.detachedTabIds.filter((x) => x !== id),
        })),
      detachedSections: {},
      setSectionDetached: (page, id, detached) =>
        set((s) => {
          const cur = s.detachedSections[page] ?? [];
          const next = detached
            ? (cur.includes(id) ? cur : [...cur, id])
            : cur.filter((x) => x !== id);
          return { detachedSections: setMapEntry(s.detachedSections, page, next) };
        }),

      settingsSection: "github",
      setSettingsSection: (section) => set({ settingsSection: section }),

      sandboxNudgeDismissCount: 0,
      dismissSandboxNudge: () => set((s) => ({ sandboxNudgeDismissCount: s.sandboxNudgeDismissCount + 1 })),

      perfConfig: DEFAULT_PERF_CONFIG,
      setPerfConfig: (config) => {
        set({ perfConfig: config });
        // Push the new config to the Rust backend so the sampler respects it.
        fireInvoke("perf_set_config", {
          enabled: config.enabled,
          intervalSecs: config.intervalSecs,
          retentionHours: config.retentionHours,
          maxDbMb: config.maxDbMb,
          trackProcess: config.trackProcess,
          trackFrontend: config.trackFrontend,
        });
      },

      logConfig: DEFAULT_LOG_CONFIG,
      setLogConfig: (config) => {
        set({ logConfig: config });
        // Push the cap to the Rust backend so "Enforce now" and the next startup respect it.
        fireInvoke("log_set_config", {
          maxLines: config.maxLines,
          maxSizeMb: config.maxSizeMb,
        });
      },

      // Demo app-state (#2272). Loading MERGES the demo onto the demoable slices (additive — arrays
      // union by id, objects by key; #2288) so it augments the built-in libraries instead of wiping
      // them, and stashes the pre-demo values (once — a re-load keeps the ORIGINAL backup); clearing
      // restores them exactly (removing the demo's additions).
      demoActive: false,
      demoBackup: null,
      loadDemoState: (snapshot) =>
        set((s) => ({
          ...mergeSnapshotInto(s as unknown as Record<string, unknown>, snapshot),
          demoActive: true,
          demoBackup: s.demoActive ? s.demoBackup : pickDemoable(s),
        })),
      clearDemoState: () =>
        set((s) => (s.demoActive && s.demoBackup
          ? { ...s.demoBackup, demoActive: false, demoBackup: null }
          : { demoActive: false, demoBackup: null })),
});
