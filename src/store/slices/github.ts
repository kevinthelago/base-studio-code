// GithubSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import { type AppStore, DEFAULT_PERF_CONFIG, DEFAULT_LOG_CONFIG } from "../types";
import { invoke } from "@tauri-apps/api/core";
// NOTE: action-body imports are added below (tsc-guided).

type GithubSlice = Pick<AppStore,
  "githubConnected" | "githubToken" | "repoGithubTokens" | "setRepoGithubToken" | "githubUser" | "githubRepos" | "activeRepoName" | "githubPageMode" | "setGithubPageMode" | "setGithubToken" | "setGithubUser" | "setGithubRepos" | "setActiveRepo" | "setGithubConnected" | "disconnectGithub" | "markGithubTokenInvalid" | "automationsTab" | "setAutomationsTab" | "pageTabOrder" | "setPageTabOrder" | "detachedTabIds" | "setTabDetached" | "detachedSections" | "setSectionDetached" | "settingsSection" | "setSettingsSection" | "perfConfig" | "setPerfConfig" | "logConfig" | "setLogConfig" | "tunnelRelayUrl" | "setTunnelRelayUrl" | "tunnelRunning" | "setTunnelRunning" | "tunnelExtraPanes" | "setTunnelExtraPanes"
>;

export const createGithubSlice: StateCreator<AppStore, [], [], GithubSlice> = (set) => ({

      githubConnected: false,
      githubToken: "",
      repoGithubTokens: {},
      setRepoGithubToken: (repo, token) =>
        set((s) => {
          const next = { ...s.repoGithubTokens };
          if (token && token.trim()) next[repo] = token.trim();
          else delete next[repo];
          return { repoGithubTokens: next };
        }),
      githubUser: null,
      githubRepos: [],
      activeRepoName: "",
      githubPageMode: "summary",
      setGithubPageMode: (v) => set({ githubPageMode: v }),
      setGithubToken: (token) => set({ githubToken: token }),
      setGithubUser: (user) => set({ githubUser: user }),
      setGithubRepos: (repos) => set({ githubRepos: repos }),
      setActiveRepo: (name) => set({ activeRepoName: name }),
      setGithubConnected: (connected) => set({ githubConnected: connected }),
      disconnectGithub: () => set({
        githubConnected: false,
        githubToken: "",
        repoGithubTokens: {},
        githubUser: null,
        githubRepos: [],
        activeRepoName: "",
      }),
      // A request returned 401 (the stored token expired/was revoked). Flip to
      // disconnected so the UI prompts a reconnect instead of silently 401-looping;
      // the cached user/repos stay for context until the user reconnects.
      markGithubTokenInvalid: () => set((s) => (s.githubConnected ? { githubConnected: false } : {})),

      automationsTab: "schedules",
      setAutomationsTab: (tab) => set({ automationsTab: tab }),
      pageTabOrder: {},
      setPageTabOrder: (page, order) =>
        set((s) => ({ pageTabOrder: { ...s.pageTabOrder, [page]: order } })),
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
          return { detachedSections: { ...s.detachedSections, [page]: next } };
        }),

      settingsSection: "github",
      setSettingsSection: (section) => set({ settingsSection: section }),

      perfConfig: DEFAULT_PERF_CONFIG,
      setPerfConfig: (config) => {
        set({ perfConfig: config });
        // Push the new config to the Rust backend so the sampler respects it.
        invoke("perf_set_config", {
          enabled: config.enabled,
          intervalSecs: config.intervalSecs,
          retentionHours: config.retentionHours,
          maxDbMb: config.maxDbMb,
          trackProcess: config.trackProcess,
          trackFrontend: config.trackFrontend,
        }).catch(() => { /* backend may not be ready */ });
      },

      logConfig: DEFAULT_LOG_CONFIG,
      setLogConfig: (config) => {
        set({ logConfig: config });
        // Push the cap to the Rust backend so "Enforce now" and the next startup respect it.
        invoke("log_set_config", {
          maxLines: config.maxLines,
          maxSizeMb: config.maxSizeMb,
        }).catch(() => { /* backend may not be ready */ });
      },

      tunnelRelayUrl: "",
      setTunnelRelayUrl: (url) => set({ tunnelRelayUrl: url }),
      tunnelRunning: false,
      setTunnelRunning: (v) => set({ tunnelRunning: v }),
      tunnelExtraPanes: [],
      setTunnelExtraPanes: (panes) => set({ tunnelExtraPanes: panes }),
});
