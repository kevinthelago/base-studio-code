// ShellSlice — app-CHROME state: the active automations/settings sub-tab, per-page tab order,
// detached tabs/sections, and perf + log config. The residual of the former `github` grab-bag after
// GitHub state moved to the GitHub feature slice and tunnel state to the Tunnel feature slice
// (#1309); the chrome fields belong to app/ eventually. Typed Pick<AppStore, …>.
import type { StateCreator } from "zustand";
import { type AppStore, DEFAULT_PERF_CONFIG, DEFAULT_LOG_CONFIG } from "../types";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { setMapEntry } from "../updateHelpers";

type ShellSlice = Pick<AppStore,
  "automationsTab" | "setAutomationsTab" | "pageTabOrder" | "setPageTabOrder" | "detachedTabIds" | "setTabDetached" | "detachedSections" | "setSectionDetached" | "settingsSection" | "setSettingsSection" | "sandboxNudgeDismissed" | "dismissSandboxNudge" | "perfConfig" | "setPerfConfig" | "logConfig" | "setLogConfig"
>;

export const createShellSlice: StateCreator<AppStore, [], [], ShellSlice> = (set) => ({
      automationsTab: "schedules",
      setAutomationsTab: (tab) => set({ automationsTab: tab }),
      pageTabOrder: {},
      setPageTabOrder: (page, order) =>
        set((s) => ({ pageTabOrder: setMapEntry(s.pageTabOrder, page, order) })),
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

      sandboxNudgeDismissed: false,
      dismissSandboxNudge: () => set({ sandboxNudgeDismissed: true }),

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
});
