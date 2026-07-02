import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { usePaneTokenUsage } from "@/app/console/lib/usePaneTokenUsage";
import { recordRender } from "@/shared/lib/core/perf";
import { resetLaunchGate } from "@/shared/lib/fleet/launchGate";
import { shouldAdvanceOnReply } from "@/app/console/lib/consoleFocus";
import type { ViewKey } from "@/app/console/panes/viewDefs";
import { paneIdFor } from "@/app/console/lib/paneIdentity";
import { useCoordinator } from "./useCoordinator";
import { useDirectorPump } from "./useDirectorPump";
import { useIdleReaper } from "@/app/console/lib/useIdleReaper";
import { useCiWatcher } from "@/features/github/lib/useCiWatcher";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { PaneAt } from "./PaneAt";

function resolvePaneName(
  tabIdx: number,
  paneIdx: number,
  names: Record<number, Record<number, string>>,
): string {
  return names[tabIdx]?.[paneIdx] ?? `console-${tabIdx + 1}-${paneIdx + 1}`;
}

export function ConsoleWorkspace({ tabIdxOverride }: { tabIdxOverride?: number } = {}) {
  // #199: the always-on coordinator — auto-wakes ready parked panes when enabled.
  // Mounted here because ConsoleWorkspace stays mounted across every screen (#187).
  useCoordinator();
  useIdleReaper(); // #849 — reap idle background PTYs to bound memory
  // #1181: per-pane token/cost rollup (actual running model + Telemetry view), polled from
  // the transcripts the `bsc-tokens` hook records. Empty until an agent takes a turn.
  const tokenUsage = usePaneTokenUsage();
  // Subscribe per-slice instead of `useAppStore()`-the-whole-state, so a mutation
  // anywhere else in the store (GitHub cache, settings, planning data)
  // no longer re-renders the entire console grid — only changes to slices this
  // screen actually reads. Was a meaningful source of render churn on multi-pane
  // grids per #52.
  const tabs              = useAppStore((s) => s.tabs);
  const storeActiveTabIdx = useAppStore((s) => s.activeTabIdx);
  // A detached tab window pins this screen to one tab (#430) — render that tab,
  // decoupled from the shared `activeTabIdx`, without ever writing it.
  const activeTabIdx      = tabIdxOverride ?? storeActiveTabIdx;
  const paneMenuOpenIdx   = useAppStore((s) => s.paneMenuOpenIdx);
  const focusedPaneIdx    = useAppStore((s) => s.focusedPaneIdx);
  const fullscreenPaneIdx = useAppStore((s) => s.fullscreenPaneIdx);
  const paneViews         = useAppStore((s) => s.paneViews);
  const paneNames         = useAppStore((s) => s.paneNames);
  const paneCwds          = useAppStore((s) => s.paneCwds);
  const paneInitCmds      = useAppStore((s) => s.paneInitCmds);
  const disabledPanes     = useAppStore((s) => s.disabledPanes);
  const autoAdvanceOnReply = useAppStore((s) => s.autoAdvanceOnReply);
  const consoleBroadcast  = useAppStore((s) => s.consoleBroadcast);
  // Action references are stable across store updates, so subscribing through a
  // selector is fine — they never trigger a re-render on their own.
  const setPaneMenu          = useAppStore((s) => s.setPaneMenu);
  const setFocusedPane       = useAppStore((s) => s.setFocusedPane);
  const setFullscreenPane    = useAppStore((s) => s.setFullscreenPane);
  const setPaneView          = useAppStore((s) => s.setPaneView);
  const setPaneName          = useAppStore((s) => s.setPaneName);
  const setPaneCwd           = useAppStore((s) => s.setPaneCwd);
  const setPaneStatus        = useAppStore((s) => s.setPaneStatus);
  const setPaneDisabled      = useAppStore((s) => s.setPaneDisabled);
  const setFocusedAgentName  = useAppStore((s) => s.setFocusedAgentName);
  const enqueueFocus         = useAppStore((s) => s.enqueueFocus);
  const advanceFocus         = useAppStore((s) => s.advanceFocus);
  const reconcileFocusQueue  = useAppStore((s) => s.reconcileFocusQueue);

  // Count every commit so the perf summary can tell a React re-render loop apart
  // from paint/render cost (no deps → runs after each render).
  useEffect(() => { recordRender(); });

  // Keep titlebar breadcrumb in sync
  useEffect(() => {
    const name = focusedPaneIdx >= 0
      ? resolvePaneName(activeTabIdx, focusedPaneIdx, paneNames)
      : "";
    setFocusedAgentName(name);
  }, [focusedPaneIdx, activeTabIdx, paneNames, setFocusedAgentName]);

  // Per-pane status ("run" | "on" | "idle"), keyed by paneId string. The STORE is
  // the single source of truth (#435) — it owns the tab-level rollup and clears
  // stale statuses on close/remount; this screen subscribes for rendering and
  // forwards status events through setPaneStatus. Transient (not persisted).
  const paneStatuses = useAppStore((s) => s.paneStatus);
  // Ref so the callback passed to TerminalView always has the latest value without re-registering
  const paneStatusesRef = useRef(paneStatuses);
  useEffect(() => { paneStatusesRef.current = paneStatuses; }, [paneStatuses]);

  // #366: the director pump — re-prompts each launched director pane per its drive mode
  // (idle-gated), so the async-integrator session acts on worker activity instead of idling.
  useDirectorPump(paneStatusesRef);

  // #373: the CI watcher — polls each worker PR's checks and, on completion, tells the
  // worker to continue/fix and nudges the director to merge on green.
  useCiWatcher();

  const handleStatusChange = useCallback((tabIdx: number, paneIdx: number, status: "run" | "idle") => {
    const pid = paneIdFor(useAppStore.getState().tabs[tabIdx], tabIdx, paneIdx);
    const prev = paneStatusesRef.current[pid] ?? "idle";

    // Focus queue is screen-level (one cursor across the app), and after #77
    // it now spans every tab — a background-tab agent finishing also joins
    // the queue, and advanceFocus knows to hop tabs to bring you there. Going
    // back to "run" clears it from the queue (handled by the reconcile sweep).
    if (status === "idle" && prev === "run") {
      enqueueFocus(tabIdx, paneIdx);
    } else if (status === "run" && prev === "idle") {
      // Auto-advance-on-reply stays scoped to the ACTIVE tab — only the user's
      // foreground reply should move the cursor. A background-tab pane going
      // run -> idle (e.g. an agent picking up after backend latency) shouldn't
      // yank focus away from whatever the user is doing.
      if (tabIdx === useAppStore.getState().activeTabIdx) {
        const st = useAppStore.getState();
        const activeIdx = st.fullscreenPaneIdx >= 0 ? st.fullscreenPaneIdx : st.focusedPaneIdx;
        if (autoAdvanceOnReply && shouldAdvanceOnReply(prev, status, paneIdx, activeIdx)) advanceFocus();
      }
    }

    // Record the status and re-roll the owning tab's state in the store — the single
    // source of truth aggregates over the source tab's live (non-disabled) panes, so a
    // background tab's rollup is never clamped by the active tab's grid size (#435).
    setPaneStatus(pid, status);
  }, [autoAdvanceOnReply, setPaneStatus, enqueueFocus, advanceFocus]);

  // Reconcile the focus queue with reality: a session stays queued only while
  // it's idle, so whenever statuses change, drop any queued pane that's no
  // longer idle. After #77 this sweeps EVERY tab (not just the active one),
  // since every tab's TerminalView is mounted (#187) and emits status events.
  // Self-heals desync (manual focus changes, a missed transition).
  useEffect(() => {
    const waitingByTab = new Map<number, Set<number>>();
    for (let ti = 0; ti < tabs.length; ti++) {
      const [tc, tr] = tabs[ti].layout.split("×").map(Number);
      const count = (tc || 1) * (tr || 1);
      const waiting = new Set<number>();
      for (let i = 0; i < count; i++) {
        if ((paneStatuses[paneIdFor(tabs[ti], ti, i)] ?? "idle") === "idle") waiting.add(i);
      }
      waitingByTab.set(ti, waiting);
    }
    reconcileFocusQueue(waitingByTab);
  }, [paneStatuses, tabs, reconcileFocusQueue]);

  // Mobile tunnel pane-sync moved to the always-on useTunnelSync hook (App) so the relay
  // mirror stays current — and includes the planner pane — regardless of the active screen (#801).

  // All per-pane handlers are stable (useCallback) so the memoized PaneAt
  // children don't re-render on every ConsoleWorkspace commit. Each handler takes
  // (tabIdx, paneIdx, …) so background-tab events (#186 mounts every tab's
  // panes) route to the right tab's state — never to whichever tab happens to
  // be active. Transient screen-level indices (focus/menu/fullscreen) are read
  // via getState() at call time rather than captured, keeping deps minimal.
  const handleToggleDisable = useCallback((tabIdx: number, paneIdx: number) => {
    const st = useAppStore.getState();
    const pid = paneIdFor(st.tabs[tabIdx], tabIdx, paneIdx);
    const next = !st.disabledPanes[pid];
    setPaneDisabled(pid, next);
    if (next) {
      // Kill the PTY (stops claude/shell) and clear any focus/fullscreen on it.
      fireInvoke("pty_kill", { paneId: pid }, console.error);
      // Re-arm the launch gate so a later batch re-enable is serialized again.
      resetLaunchGate(pid);
      // Disabling kills the PTY; force the pane idle (store re-rolls the tab, excluding
      // the now-disabled cell) so a stale "run" can't keep the tab dot lit (#435).
      setPaneStatus(pid, "idle");
      // Screen-level focus / fullscreen only matter for the active tab — only
      // clear them when this disable came from the active tab.
      if (tabIdx === st.activeTabIdx) {
        if (st.focusedPaneIdx === paneIdx) setFocusedPane(-1);
        if (st.fullscreenPaneIdx === paneIdx) setFullscreenPane(-1);
      }
    }
  }, [setPaneDisabled, setFocusedPane, setFullscreenPane, setPaneStatus]);

  const handleCwdChange = useCallback((tabIdx: number, paneIdx: number, path: string) => {
    setPaneCwd(paneIdFor(useAppStore.getState().tabs[tabIdx], tabIdx, paneIdx), path);
  }, [setPaneCwd]);

  const handlePickDirectory = useCallback(async (tabIdx: number, paneIdx: number) => {
    const pid = paneIdFor(useAppStore.getState().tabs[tabIdx], tabIdx, paneIdx);
    const dir = await invoke<string | null>("pick_directory");
    if (!dir) return;
    // cd in the running shell (bash on Windows uses forward slashes)
    const posix = dir.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/${d.toLowerCase()}`);
    await invoke("pty_write", { paneId: pid, data: `cd "${posix}"\r` });
    handleCwdChange(tabIdx, paneIdx, dir);
  }, [handleCwdChange]);

  const handleRename = useCallback((tabIdx: number, paneIdx: number, n: string) =>
    setPaneName(tabIdx, paneIdx, n), [setPaneName]);
  const handleMenuToggle = useCallback((_tabIdx: number, paneIdx: number) =>
    setPaneMenu(useAppStore.getState().paneMenuOpenIdx === paneIdx ? -1 : paneIdx), [setPaneMenu]);
  // paneViews is a shared index→view map (not per-tab), so tabIdx is
  // intentionally unused here; switching tabs preserves view selections per
  // pane slot. Promoting paneViews to per-tab is its own concern.
  const handleViewChange = useCallback((_tabIdx: number, paneIdx: number, v: ViewKey) =>
    setPaneView(paneIdx, v), [setPaneView]);
  // Focusing/viewing a pane does NOT dequeue it — it stays queued until you send
  // it a response (handled in handleStatusChange on idle -> run).
  const handleFocusPane = useCallback((_tabIdx: number, paneIdx: number) =>
    setFocusedPane(paneIdx), [setFocusedPane]);
  const handleToggleFullscreen = useCallback((_tabIdx: number, paneIdx: number) =>
    setFullscreenPane(useAppStore.getState().fullscreenPaneIdx === paneIdx ? -1 : paneIdx),
    [setFullscreenPane]);
  // Resize-nudge redraw (#1221): bump the pane's redraw counter; its terminal nudges the PTY size
  // (SIGWINCH) and settles back, un-jumbling the Claude CLI's TUI the way a window resize does.
  const handleRedraw = useCallback((tabIdx: number, paneIdx: number) => {
    const st = useAppStore.getState();
    st.requestPaneRedraw(paneIdFor(st.tabs[tabIdx], tabIdx, paneIdx));
  }, []);

  // Per-tab pane renderer. tabIdx + isFullscreenInTab let one helper render
  // BOTH the active tab and the (display:none) background tabs from the same
  // code path. hidden=true covers both "background tab" (whole grid invisible)
  // and "active tab, but a sibling pane is fullscreened over us" — the
  // downstream visible/render-pause logic then doesn't have to distinguish.
  function renderPane(tabIdx: number, i: number, isFullscreenInTab: boolean) {
    const pid = paneIdFor(tabs[tabIdx], tabIdx, i);
    const isActiveTab = tabIdx === activeTabIdx;
    return (
      <PaneAt
        key={`${tabs[tabIdx].runId ?? 0}-${i}`}
        i={i}
        tabIdx={tabIdx}
        paneId={pid}
        name={resolvePaneName(tabIdx, i, paneNames)}
        view={paneViews[i] ?? "console"}
        status={paneStatuses[pid] ?? "idle"}
        cwd={paneCwds[pid]}
        initCmd={paneInitCmds[pid]}
        onRename={handleRename}
        onMenuToggle={handleMenuToggle}
        onFocus={handleFocusPane}
        onViewChange={handleViewChange}
        onPickDirectory={handlePickDirectory}
        onCwdChange={handleCwdChange}
        onStatusChange={handleStatusChange}
        onToggleFullscreen={handleToggleFullscreen}
        onToggleDisable={handleToggleDisable}
        onRedraw={handleRedraw}
        // Screen-level chrome state only applies to the active tab.
        menuOpen={isActiveTab && paneMenuOpenIdx === i}
        focused={isActiveTab && focusedPaneIdx === i}
        fullscreen={isActiveTab && fullscreenPaneIdx === i}
        disabled={!!disabledPanes[pid]}
        hidden={!isActiveTab || (isFullscreenInTab && i !== fullscreenPaneIdx)}
        usage={tokenUsage.get(pid)}
      />
    );
  }

  return (
    <Stack style={{ flex: 1, minHeight: 0, background: "var(--bg-canvas)" }}>
      {consoleBroadcast && (
        <Row className="mono" gap={8} style={{
          padding: "3px 14px",
          background: "color-mix(in oklch, var(--accent), transparent 82%)",
          borderBottom: "1px solid var(--accent-dim)",
          fontSize: 10, color: "var(--accent)",
          flexShrink: 0,
        }}>
          <Text as="span">⟳ broadcast · input mirrors to all panes</Text>
          <Text tone="dim">· Ctrl+Shift+C to exit</Text>
        </Row>
      )}
      {/* Render every tab's grid; inactive tabs are display:none so their
          xterm instances stay mounted (PTY listener live, scrollback intact)
          across switches. Was unmounting the previous tab's panes on switch,
          which disposed xterm and lost everything claude streamed while you
          were elsewhere (#186). Pairs with #185's hide-and-buffer to keep
          background-tab paint cost at zero. */}
      {tabs.map((tab, ti) => {
        const [tcols, trows] = tab.layout.split("×").map(Number);
        const tPaneCount = (tcols || 1) * (trows || 1);
        const isActiveTab = ti === activeTabIdx;
        // Fullscreen-of-a-pane is screen-level — only meaningful on the active
        // tab; background tabs keep their full grid so the layout is sane the
        // moment the user switches back.
        const isFullscreenInTab = isActiveTab && fullscreenPaneIdx >= 0 && fullscreenPaneIdx < tPaneCount;
        return (
          // eslint-disable-next-line no-restricted-syntax -- conditional-display grid (toggles grid/none per active tab)
          <div
            key={ti}
            className="console-grid"
            style={{
              display: isActiveTab ? "grid" : "none",
              gridTemplateColumns: isFullscreenInTab ? "1fr" : `repeat(${tcols || 1}, 1fr)`,
              gridTemplateRows:    isFullscreenInTab ? "1fr" : `repeat(${trows || 1}, 1fr)`,
            }}
          >
            {Array.from({ length: tPaneCount }, (_, i) => renderPane(ti, i, isFullscreenInTab))}
          </div>
        );
      })}
    </Stack>
  );
}
