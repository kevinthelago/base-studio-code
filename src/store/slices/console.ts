// ConsoleSlice — extracted from the store implementation (store split, stage 2).
// Typed Pick<AppStore, …> so AppStore stays whole in types.ts while the create() composes slices.
import type { StateCreator } from "zustand";
import type { AppStore } from "../types";
import { unlock } from "@/shared/lib/core/achievements";
import { type AgentProfile, PROFILES } from "@/features/agents/lib/agentProfiles";
import { DEFAULT_ACCENT } from "@/features/settings/lib/appearance";
import { enqueue as enqueueFocusQueue, removeFromQueue, nextInCycle, reconcileQueue, shouldFocus, DEFAULT_FOCUS_TARGET } from "@/app/console/lib/focusQueue";
import { DEFAULT_REAPER_CONFIG } from "@/app/console/lib/idleReaper";
import { clampFontSize, DEFAULT_TERMINAL_FONT_SIZE } from "@/app/console/lib/terminal";
import { aggregateTabState, clearTabStatuses as clearTabStatusesPure } from "@/app/console/lib/paneStatus";
import { isManualPaneId, findPaneOwnerTab } from "@/app/console/lib/paneIdentity";
import { moveInArray, tabIndexMap, rekeyByTab, rekeyByPaneId, remapFocusQueue } from "@/app/console/lib/tabReorder";
import { newTabId } from "../helpers";
import { setMapEntry, deleteMapEntry, deleteMapEntries, updateArrayItem } from "../updateHelpers";

type ConsoleSlice = Pick<AppStore,
  "activeWorkspace" | "setWorkspace" | "hasHydrated" | "setHasHydrated" | "tabs" | "activeTabIdx" | "paneMenuOpenIdx" | "focusedPaneIdx" | "fullscreenPaneIdx" | "consoleBroadcast" | "setConsoleBroadcast" | "focusQueue" | "focusTarget" | "setFocusTarget" | "enqueueFocus" | "removeFocus" | "clearFocusQueue" | "reconcileFocusQueue" | "advanceFocus" | "terminalFontSize" | "setTerminalFontSize" | "accent" | "setAccent" | "keybindings" | "setKeybinding" | "resetKeybinding" | "resetAllKeybindings" | "paneViews" | "paneNames" | "paneCwds" | "paneWasClaude" | "uncleanShutdown" | "setUncleanShutdown" | "restoreRequested" | "restoreSessionsFromCrash" | "achievements" | "unlockAchievement" | "setPaneWasClaude" | "setPaneCwd" | "paneStatus" | "setPaneStatus" | "quarantinedPanes" | "markQuarantine" | "clearQuarantine" | "wardenSince" | "clearProjectQuarantine" | "endedPanes" | "markPaneEnded" | "reopenPane" | "dormantPanes" | "paneLastActivity" | "idleReaper" | "reapPane" | "resumePane" | "setIdleReaperConfig" | "recomputeTabState" | "clearTabStatuses" | "paneInitCmds" | "setPaneInitCmd" | "paneStartupPromptDocs" | "paneCheckpointDocs" | "paneStartupPromptText" | "paneContinue" | "disabledPanes" | "setPaneDisabled" | "paneRoles" | "setPaneRole" | "agentProfiles" | "setAgentProfiles" | "updateAgentProfile" | "panePermsStale" | "clearPanePermsStale" | "paneRedrawNonce" | "requestPaneRedraw" | "paneProfiles" | "paneRoleGlobs" | "paneRepos" | "paneFlows" | "paneProviders" | "setPaneProvider" | "paneClaudeActive" | "setPaneClaudeActive" | "setPaneProfile" | "setActiveTab" | "addTab" | "closeTab" | "moveTab" | "renameTab" | "setTabState" | "setTabLayout" | "setPaneMenu" | "setFocusedPane" | "setFullscreenPane" | "focusedAgentName" | "setFocusedAgentName" | "setPaneView" | "setAllPanesView" | "setPaneName" | "liveAgents" | "bumpLiveAgents" | "paneDirectorDrive" | "paneDirectorMode" | "paneStream"
>;

export const createConsoleSlice: StateCreator<AppStore, [], [], ConsoleSlice> = (set, get) => ({
      activeWorkspace: "console",
      setWorkspace: (screen) => set({ activeWorkspace: screen }),
      hasHydrated: false,
      setHasHydrated: (v) => set({ hasHydrated: v }),

      tabs: [],
      activeTabIdx: 0,
      paneMenuOpenIdx: -1,
      focusedPaneIdx: -1,
      fullscreenPaneIdx: -1,
      consoleBroadcast: false,
      setConsoleBroadcast: (v) => set({ consoleBroadcast: v }),
      focusQueue: [],
      focusTarget: DEFAULT_FOCUS_TARGET,
      setFocusTarget: (target) =>
        // Re-gate the live queue against the new target so panes that no longer
        // match drop out (and the cursor isn't stranded on them).
        set((s) => ({
          focusTarget: target,
          focusQueue: s.focusQueue.filter((q) => shouldFocus(s.paneRoles[`t${q.tab}p${q.pane}`], target)),
        })),
      enqueueFocus: (tab, pane) =>
        // Role-aware gate (#392): only queue the pane if its role matches the
        // active focus target (a plain console always queues except under "none").
        set((s) =>
          shouldFocus(s.paneRoles[`t${tab}p${pane}`], s.focusTarget)
            ? { focusQueue: enqueueFocusQueue(s.focusQueue, { tab, pane }) }
            : {}),
      removeFocus: (tab, pane) =>
        set((s) => ({ focusQueue: removeFromQueue(s.focusQueue, { tab, pane }) })),
      clearFocusQueue: () => set({ focusQueue: [] }),
      reconcileFocusQueue: (waitingByTab) =>
        set((s) => ({ focusQueue: reconcileQueue(s.focusQueue, waitingByTab) })),
      // Cycle to the next waiting pane relative to the one you're on (maximized
      // pane if maximized, else focused). Focuses it — switching to its tab first
      // when it lives on another tab — and swaps the maximized pane to it so you
      // stay full-screen. Does NOT dequeue: a pane leaves the queue only when you
      // respond to it (see Console.handleStatusChange).
      advanceFocus: () =>
        set((s) => {
          const pane = s.fullscreenPaneIdx >= 0 ? s.fullscreenPaneIdx : s.focusedPaneIdx;
          const next = nextInCycle(s.focusQueue, { tab: s.activeTabIdx, pane });
          if (next === null) return {};
          const maximized = s.fullscreenPaneIdx >= 0;
          if (next.tab !== s.activeTabIdx) {
            // Hop to the tab holding the waiting console, focusing (and re-maximizing) it.
            return {
              activeTabIdx: next.tab,
              focusedPaneIdx: next.pane,
              fullscreenPaneIdx: maximized ? next.pane : -1,
              paneMenuOpenIdx: -1,
            };
          }
          return maximized
            ? { focusedPaneIdx: next.pane, fullscreenPaneIdx: next.pane }
            : { focusedPaneIdx: next.pane };
        }),
      terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
      setTerminalFontSize: (size) => set({ terminalFontSize: clampFontSize(size) }),
      accent: DEFAULT_ACCENT,
      setAccent: (id) => set({ accent: id }),
      keybindings: {},
      setKeybinding: (id, chord) =>
        set((s) => ({ keybindings: setMapEntry(s.keybindings, id, chord) })),
      resetKeybinding: (id) =>
        set((s) => ({ keybindings: deleteMapEntry(s.keybindings, id) })),
      resetAllKeybindings: () => set({ keybindings: {} }),
      paneViews: [],
      paneNames: {},
      paneCwds: {},
      paneWasClaude: {},
  liveAgents: 0,
  bumpLiveAgents: (delta) => set((s) => ({ liveAgents: Math.max(0, s.liveAgents + delta) })),
      achievements: {},
      unlockAchievement: (id) => {
        const next = unlock(get().achievements, id, Date.now());
        if (!next) return false;            // already unlocked — once ever
        set({ achievements: next });
        return true;
      },
      setPaneWasClaude: (paneId, on) =>
        set((s) => {
          const cur = s.paneWasClaude[paneId];
          // Avoid producing a new object reference when nothing changed —
          // OSC 100 "run" can fire many times in a session.
          if (cur === on) return s;
          const next = { ...s.paneWasClaude };
          if (on) next[paneId] = true; else delete next[paneId];
          return { paneWasClaude: next };
        }),
      // Crash recovery (#1041): the boot flag + the one-click restore.
      uncleanShutdown: false,
      setUncleanShutdown: (v: boolean) => set({ uncleanShutdown: v }),
      restoreRequested: {},
      restoreSessionsFromCrash: () => {
        const s = get();
        const panes = Object.keys(s.paneWasClaude).filter((p) => s.paneWasClaude[p]);
        // Stage 3 of stable pane identity (#1176): walk identity ids, not grid positions.
        // Manual consoles (`man:…`) are never auto-recovered — a scratch shell must not silently
        // resume. Fleet/triage panes now carry a project-scoped identity id recorded on the tab's
        // `paneIds[]`, so we locate the hosting tab by that id; a legacy positional id still encodes
        // its tab index directly (fallback).
        let scheduled = 0;
        panes.forEach((paneId) => {
          if (isManualPaneId(paneId)) return;
          let tabIdx = s.tabs.findIndex((t) => t.paneIds?.includes(paneId));
          if (tabIdx < 0) {
            const m = /^t(\d+)p\d+$/.exec(paneId);
            if (!m) return; // unrecognized id shape (no host tab) — not recoverable
            tabIdx = Number(m[1]);
          }
          const order = scheduled++;
          // Stagger the relaunches so N Claudes don't cold-start at once (#1041) — each remount
          // resolves to `claude --continue` because restoreRequested is set for the pane.
          setTimeout(() => {
            set((st) => {
              // Skip disabled panes and auto-ended workers (#920) — a finished worker must not
              // be re-opened on crash-restore; its ended state is persisted + recovery-gated here.
              if (tabIdx < 0 || tabIdx >= st.tabs.length || st.disabledPanes[paneId] || st.endedPanes[paneId]) return {};
              return {
                restoreRequested: setMapEntry(st.restoreRequested, paneId, true),
                tabs: st.tabs.map((t, idx) => (idx === tabIdx ? { ...t, runId: (t.runId ?? 0) + 1 } : t)),
              };
            });
          }, order * 250);
        });
        return scheduled;
      },
      setPaneCwd: (paneId, cwd) =>
        set((s) => ({ paneCwds: setMapEntry(s.paneCwds, paneId, cwd) })),
      paneStatus: {},
      setPaneStatus: (paneId, status) =>
        set((s) => {
          if (s.paneStatus[paneId] === status) return {}; // no-op — same status
          const paneStatus = setMapEntry(s.paneStatus, paneId, status);
          // Stamp last-activity on every status CHANGE (#849): a run↔idle transition is the
          // idle-reaper's clock — for an idle pane this records the moment it went idle, which
          // is exactly what the reaper ages from. (Same-status pings early-return above, so an
          // idle pane that stays idle keeps aging correctly.)
          const paneLastActivity = setMapEntry(s.paneLastActivity, paneId, Date.now());
          // Resolve the owning tab by IDENTITY (#1176) — a manual/minted pane id never
          // parses as a positional `t{idx}p{n}`, so the old positional parse dropped the
          // rollup for every fleet/triage/manual pane (its activity dot got stuck).
          const owner = findPaneOwnerTab(s.tabs, paneId);
          if (!owner) return { paneStatus, paneLastActivity };
          // Re-roll the owning tab from the full live set; only rebuild the tabs
          // array when the rollup actually changes (status events are frequent).
          const nextState = aggregateTabState(owner.tab, owner.tabIdx, paneStatus, s.disabledPanes);
          if (nextState === owner.tab.state) return { paneStatus, paneLastActivity };
          return {
            paneStatus,
            paneLastActivity,
            tabs: updateArrayItem(s.tabs, owner.tabIdx, { state: nextState }),
          };
        }),
      // ── Warden quarantine (#1102) ────────────────────────────────────────────
      quarantinedPanes: {},
      markQuarantine: (paneId, info) =>
        set((s) => (s.quarantinedPanes[paneId]
          ? {} // already quarantined — never re-mark (the warden's planWarden also dedupes)
          : { quarantinedPanes: setMapEntry(s.quarantinedPanes, paneId, info) })),
      clearQuarantine: (paneId) =>
        set((s) => {
          if (!s.quarantinedPanes[paneId]) return {};
          return { quarantinedPanes: deleteMapEntry(s.quarantinedPanes, paneId) };
        }),
      wardenSince: {},
      clearProjectQuarantine: (projectKey, panes, since) =>
        set((s) => {
          const prefix = `${projectKey}:`;
          const quarantinedPanes = { ...s.quarantinedPanes };
          for (const paneId of Object.keys(s.quarantinedPanes)) {
            if (paneId.startsWith(prefix)) delete quarantinedPanes[paneId];
          }
          // Stamp the warden floor for EVERY relaunching pane (not just the ones currently flagged),
          // so a stale denied command that hasn't tripped the warden yet also can't re-pause on relaunch.
          const wardenSince = { ...s.wardenSince };
          for (const paneId of panes) wardenSince[paneId] = since;
          return { quarantinedPanes, wardenSince };
        }),
      // ── Auto-end finished workers (#920) ─────────────────────────────────────
      endedPanes: {},
      markPaneEnded: (paneId, info) =>
        set((s) => {
          if (s.endedPanes[paneId]) return {}; // already ended — never re-mark
          // Drop the live status so the pane reads as not-running (its PTY has exited).
          return { endedPanes: setMapEntry(s.endedPanes, paneId, info), paneStatus: deleteMapEntry(s.paneStatus, paneId) };
        }),
      reopenPane: (paneId) =>
        set((s) => {
          if (!s.endedPanes[paneId]) return {};
          return { endedPanes: deleteMapEntry(s.endedPanes, paneId), paneLastActivity: setMapEntry(s.paneLastActivity, paneId, Date.now()) };
        }),
      // ── Idle session reaping (#849) ──────────────────────────────────────────
      dormantPanes: {},
      paneLastActivity: {},
      idleReaper: DEFAULT_REAPER_CONFIG,
      reapPane: (paneId) =>
        set((s) => {
          if (s.dormantPanes[paneId]) return {};
          // Mark dormant + drop the live status so the pane reads as not-running while its
          // PTY is gone (the hook fires pty_kill alongside this).
          return { dormantPanes: setMapEntry(s.dormantPanes, paneId, true), paneStatus: deleteMapEntry(s.paneStatus, paneId) };
        }),
      resumePane: (paneId) =>
        set((s) => {
          if (!s.dormantPanes[paneId]) return {};
          return { dormantPanes: deleteMapEntry(s.dormantPanes, paneId), paneLastActivity: setMapEntry(s.paneLastActivity, paneId, Date.now()) };
        }),
      setIdleReaperConfig: (cfg) =>
        set((s) => ({ idleReaper: { ...s.idleReaper, ...cfg } })),
      recomputeTabState: (tabIdx) =>
        set((s) => {
          const tab = s.tabs[tabIdx];
          if (!tab) return {};
          const state = aggregateTabState(tab, tabIdx, s.paneStatus, s.disabledPanes);
          return state === tab.state
            ? {}
            : { tabs: updateArrayItem(s.tabs, tabIdx, { state }) };
        }),
      clearTabStatuses: (tabIdx) =>
        set((s) => {
          const tab = s.tabs[tabIdx];
          if (!tab) return {};
          const paneStatus = clearTabStatusesPure(s.paneStatus, tab, tabIdx);
          const tabs = s.tabs.map((t, i) =>
            i === tabIdx
              ? { ...t, state: aggregateTabState(t, i, paneStatus, s.disabledPanes) }
              : t);
          return { paneStatus, tabs };
        }),
      paneInitCmds: {},
      setPaneInitCmd: (paneId, cmd) =>
        set((s) => ({ paneInitCmds: setMapEntry(s.paneInitCmds, paneId, cmd) })),
      paneStartupPromptDocs: {},
      paneCheckpointDocs: {},
      paneStartupPromptText: {},
      paneContinue: {},
      disabledPanes: {},
      setPaneDisabled: (paneId, disabled) =>
        set((s) => {
          const next = { ...s.disabledPanes };
          if (disabled) next[paneId] = true; else delete next[paneId];
          // Enabling/disabling a pane changes which cells count in its tab's rollup
          // (a disabled cell can't be "run"), so re-roll the owning tab (#435). Resolve
          // the tab by identity so a manual/minted pane id rolls up too (#1176).
          const owner = findPaneOwnerTab(s.tabs, paneId);
          const tabs = owner
            ? s.tabs.map((t, i) =>
                i === owner.tabIdx
                  ? { ...t, state: aggregateTabState(t, i, s.paneStatus, next) }
                  : t)
            : s.tabs;
          return { disabledPanes: next, tabs };
        }),
      paneRoles: {},
    paneDirectorDrive: {},
    paneDirectorMode: {},
    paneStream: {},
      setPaneRole: (paneId, role) =>
        set((s) => ({ paneRoles: setMapEntry(s.paneRoles, paneId, role) })),

      // Agents (#255): seed the editable profiles from the built-in defaults; persisted
      // edits replace this on rehydrate. Deep-cloned so edits never mutate the defaults.
      agentProfiles: JSON.parse(JSON.stringify(PROFILES)) as AgentProfile[],
      setAgentProfiles: (profiles) => set({ agentProfiles: profiles }),
      updateAgentProfile: (id, patch) =>
        set((s) => {
          // Mark every console using this profile as stale so it can prompt a relaunch to
          // apply the edit — the launch path rewrites settings.json with replacePermissions (#799).
          const panePermsStale = { ...s.panePermsStale };
          for (const [paneId, profileId] of Object.entries(s.paneProfiles)) {
            if (profileId === id) panePermsStale[paneId] = true;
          }
          return {
            agentProfiles: s.agentProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
            panePermsStale,
          };
        }),
      panePermsStale: {},
      clearPanePermsStale: (paneId) =>
        set((s) => {
          if (!s.panePermsStale[paneId]) return {};
          return { panePermsStale: deleteMapEntry(s.panePermsStale, paneId) };
        }),
      paneRedrawNonce: {},
      requestPaneRedraw: (paneId) =>
        set((s) => ({ paneRedrawNonce: setMapEntry(s.paneRedrawNonce, paneId, (s.paneRedrawNonce[paneId] ?? 0) + 1) })),
      paneProfiles: {},
      paneRoleGlobs: {},
      paneRepos: {},
      paneFlows: {},
      paneProviders: {},
      setPaneProvider: (paneId, providerId) =>
        set((s) => ({ paneProviders: setMapEntry(s.paneProviders, paneId, providerId) })),
      paneClaudeActive: {},
      setPaneClaudeActive: (paneId, active) =>
        set((s) => (!!s.paneClaudeActive[paneId] === active
          ? s
          : { paneClaudeActive: setMapEntry(s.paneClaudeActive, paneId, active) })),
      setPaneProfile: (paneId, profileId) =>
        set((s) => {
          const next = { ...s.paneProfiles };
          if (profileId === null) delete next[paneId];
          else next[paneId] = profileId;
          return { paneProfiles: next };
        }),
      // Switching tabs clears focus/fullscreen/menu — these are positional and
      // global, so a stale index from the previous tab would mis-target features
      // like broadcast (excluding a console that isn't actually focused). The focus
      // queue is NOT cleared: it spans tabs now, so waiting consoles left behind on
      // this tab stay reachable via Ctrl+Shift+N (which hops back to them).
      setActiveTab: (idx) => set({ activeTabIdx: idx, focusedPaneIdx: -1, fullscreenPaneIdx: -1, paneMenuOpenIdx: -1 }),
      addTab: (tab) =>
        set((s) => ({
          tabs: [...s.tabs, { ...tab, id: tab.id ?? newTabId() }],
          activeTabIdx: s.tabs.length,
          focusedPaneIdx: -1,
          fullscreenPaneIdx: -1,
          paneMenuOpenIdx: -1,
        })),
      closeTab: (idx) =>
        set((s) => {
          const closing = s.tabs[idx];
          const tabs = s.tabs.filter((_, i) => i !== idx);
          // Drop the closed tab's pane statuses so its sessions' "run"/"on" can't
          // linger as a stale activity dot (#435) — like the focusQueue reset.
          const paneStatus = closing ? clearTabStatusesPure(s.paneStatus, closing, idx) : s.paneStatus;
          // Release the closed tab's worker pane state (#1951). The always-on warden (#1102) watches
          // every pane in `fleetPaneStreams`; leaving the closed tab's now-dead (PTY-killed) workers
          // there means it keeps re-evaluating them, sees the worktree still off-plan, and
          // re-quarantines them every tick — so the "Worker quarantined" banner reappears despite the
          // tab AND the banner being closed. The tab's minted identity ids (`paneIds`) are exactly the
          // keys `fleetStartProject` set in these maps, so drop them here (mirrors that teardown).
          const ids = closing?.paneIds ?? [];
          const released = ids.length
            ? {
                fleetPaneStreams: deleteMapEntries(s.fleetPaneStreams, ids),
                paneCwds: deleteMapEntries(s.paneCwds, ids),
                quarantinedPanes: deleteMapEntries(s.quarantinedPanes, ids),
              }
            : {};
          if (tabs.length === 0) return { tabs, activeTabIdx: 0, focusQueue: [], paneStatus, ...released };
          let activeTabIdx = s.activeTabIdx;
          if (idx < s.activeTabIdx) activeTabIdx -= 1;
          else if (idx === s.activeTabIdx) activeTabIdx = Math.min(activeTabIdx, tabs.length - 1);
          return { tabs, activeTabIdx, focusQueue: [], paneStatus, ...released };
        }),
      moveTab: (from, to) =>
        set((s) => {
          if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return {};
          // OLD tab index → NEW tab index; remap every index-keyed structure so
          // a reordered tab keeps its panes' names/cwd/status/disabled/etc.
          const map = tabIndexMap(s.tabs.length, from, to);
          return {
            tabs: moveInArray(s.tabs, from, to),
            activeTabIdx: map[s.activeTabIdx] ?? s.activeTabIdx,
            paneNames: rekeyByTab(s.paneNames, map),
            paneCwds: rekeyByPaneId(s.paneCwds, map),
            paneStatus: rekeyByPaneId(s.paneStatus, map),
            disabledPanes: rekeyByPaneId(s.disabledPanes, map),
            paneMcpServers: rekeyByPaneId(s.paneMcpServers, map),
            paneHooks: rekeyByPaneId(s.paneHooks, map),
            focusQueue: remapFocusQueue(s.focusQueue, map),
          };
        }),
      renameTab: (idx, name) =>
        set((s) => ({ tabs: updateArrayItem(s.tabs, idx, { name }) })),
      setTabState: (tabIdx, state) =>
        set((s) => ({ tabs: updateArrayItem(s.tabs, tabIdx, { state }) })),
      setTabLayout: (tabIdx, layout) =>
        set((s) => {
          const [newCols, newRows] = layout.split("×").map(Number);
          const newCount = newCols * newRows;
          const tabs = [...s.tabs];
          tabs[tabIdx] = { ...tabs[tabIdx], layout };
          // Trim pane names for this tab to only surviving indices
          const tabPaneNames = { ...(s.paneNames[tabIdx] ?? {}) };
          (Object.keys(tabPaneNames) as unknown as number[]).forEach((k) => {
            if (Number(k) >= newCount) delete tabPaneNames[Number(k)];
          });
          // Trim cwds keyed by "t{tabIdx}p{n}"
          const paneCwds = { ...s.paneCwds };
          const isExcess = (key: string) => {
            const m = key.match(/^t(\d+)p(\d+)$/);
            return m && Number(m[1]) === tabIdx && Number(m[2]) >= newCount;
          };
          Object.keys(paneCwds).forEach((key) => { if (isExcess(key)) delete paneCwds[key]; });
          // Re-roll this tab's state against the new grid: cells trimmed away by a
          // smaller layout stop contributing their "run"/"on" (#435).
          tabs[tabIdx] = { ...tabs[tabIdx], state: aggregateTabState(tabs[tabIdx], tabIdx, s.paneStatus, s.disabledPanes) };
          return {
            tabs,
            paneNames: setMapEntry(s.paneNames, tabIdx, tabPaneNames),
            paneCwds,
          };
        }),
      setPaneMenu:       (idx) => set({ paneMenuOpenIdx: idx }),
      setFocusedPane:    (idx) => set({ focusedPaneIdx: idx }),
      setFullscreenPane: (idx) => set({ fullscreenPaneIdx: idx }),
      focusedAgentName: "",
      setFocusedAgentName: (name) => set({ focusedAgentName: name }),
      setPaneView: (idx, view) =>
        set((s) => { const v = [...s.paneViews]; v[idx] = view; return { paneViews: v }; }),
      setAllPanesView: (view) =>
        set((s) => {
          // paneViews is a shared index→view map that defaults to [] and is only grown lazily by
          // setPaneView — so mapping over it was a silent no-op until a pane had been switched
          // individually. Fill at least the ACTIVE tab's pane slots (the point of "switch all"),
          // keeping any higher indices a larger tab may have populated. (#1182)
          const tab = s.tabs[s.activeTabIdx];
          const [c, r] = tab ? tab.layout.split("×").map(Number) : [0, 0];
          const count = Math.max((c || 0) * (r || 0), s.paneViews.length);
          return { paneViews: Array.from({ length: count }, () => view) };
        }),
      setPaneName: (tabIdx, paneIdx, name) =>
        set((s) => ({
          paneNames: setMapEntry(s.paneNames, tabIdx, { ...s.paneNames[tabIdx], [paneIdx]: name }),
        })),
});
