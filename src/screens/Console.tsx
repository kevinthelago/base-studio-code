import { useEffect, useRef, useState, useCallback, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PaneShell } from "../components/pane/PaneShell";
import { TerminalView } from "../components/pane/views/TerminalView";
import { FilesView } from "../components/pane/views/FilesView";
import { BranchesView } from "../components/pane/views/BranchesView";
import { ChangesView } from "../components/pane/views/ChangesView";
import { LogView } from "../components/pane/views/LogView";
import { useAppStore } from "../store";
import { recordRender } from "../lib/perf";
import { resetLaunchGate } from "../lib/launchGate";
import { shouldAdvanceOnReply } from "../lib/consoleFocus";
import { log } from "../lib/log";
import { buildPanePayload } from "../lib/tunnel";
import { tunnelSetPanes, tunnelSetSessions } from "../lib/tunnelClient";
import type { ViewKey } from "../components/pane/ViewTabs";

function resolvePaneName(
  tabIdx: number,
  paneIdx: number,
  names: Record<number, Record<number, string>>,
): string {
  return names[tabIdx]?.[paneIdx] ?? `console-${tabIdx + 1}-${paneIdx + 1}`;
}

function paneId(tabIdx: number, paneIdx: number): string {
  return `t${tabIdx}p${paneIdx}`;
}

interface PaneAtProps {
  i: number;
  tabIdx: number;
  name: string;
  view: ViewKey;
  status: "run" | "on" | "idle";
  cwd?: string;
  initCmd?: string;
  // Dispatchers take (tabIdx, paneIdx, …) so a single handler in ConsoleScreen
  // can route events to the right tab. Stable across renders so the memo below
  // holds; PaneAt binds its own (tabIdx, i) into the no-arg callbacks the chrome
  // expects. Background-tab panes are mounted (display:none) so their PTY
  // listeners stay live, and their callbacks must record against THEIR tab —
  // not the currently-active one (#186).
  onRename: (tabIdx: number, i: number, name: string) => void;
  onMenuToggle: (tabIdx: number, i: number) => void;
  onFocus: (tabIdx: number, i: number) => void;
  onViewChange: (tabIdx: number, i: number, v: ViewKey) => void;
  onPickDirectory: (tabIdx: number, i: number) => void;
  onCwdChange: (tabIdx: number, i: number, path: string) => void;
  onStatusChange: (tabIdx: number, i: number, status: "run" | "idle") => void;
  onToggleFullscreen: (tabIdx: number, i: number) => void;
  onToggleDisable: (tabIdx: number, i: number) => void;
  // Per-pane booleans (not the raw indices) so a focus/menu change only re-renders
  // the two panes whose flag actually flipped — not all N.
  menuOpen: boolean;
  focused: boolean;
  fullscreen: boolean;
  disabled: boolean;
  hidden: boolean;
}

const PaneAt = memo(function PaneAt({
  i, tabIdx, name, view, status, cwd, initCmd,
  onRename, onMenuToggle, onFocus, onViewChange, onPickDirectory, onCwdChange, onStatusChange,
  onToggleFullscreen, onToggleDisable, menuOpen, focused, fullscreen, disabled, hidden,
}: PaneAtProps) {
  const pid = paneId(tabIdx, i);
  return (
    <PaneShell
      agent={name}
      onRename={(n) => onRename(tabIdx, i, n)}
      onMenuToggle={() => onMenuToggle(tabIdx, i)}
      onToggleFullscreen={() => onToggleFullscreen(tabIdx, i)}
      onToggleDisable={() => onToggleDisable(tabIdx, i)}
      onFocus={() => onFocus(tabIdx, i)}
      onPickDirectory={() => onPickDirectory(tabIdx, i)}
      status={disabled ? "idle" : status}
      model="sonnet-4.5"
      available={["console", "files", "branches", "changes", "log"]}
      active={view}
      menuOpen={menuOpen}
      focused={focused}
      fullscreen={fullscreen}
      disabled={disabled}
      hidden={hidden}
      onViewChange={(v) => onViewChange(tabIdx, i, v)}
    >
      {disabled ? (
        <DisabledConsole onEnable={() => onToggleDisable(tabIdx, i)} />
      ) : (
      <>
      {/* Terminal stays mounted so the PTY session survives view switches */}
      <TerminalView
        paneId={pid}
        visible={view === "console" && !hidden}
        focused={focused}
        initialCwd={cwd}
        initCmd={initCmd}
        onCwdChange={(path) => onCwdChange(tabIdx, i, path)}
        onStatusChange={(s) => onStatusChange(tabIdx, i, s)}
        onFocus={() => onFocus(tabIdx, i)}
      />
      {view === "files"    && <FilesView    small tree={[]} cwd={cwd} />}
      {view === "branches" && <BranchesView small branches={[]} />}
      {view === "changes"  && <ChangesView  small hunks={[]} />}
      {view === "log"      && <LogView      small commits={[]} />}
      </>
      )}
    </PaneShell>
  );
});

function DisabledConsole({ onEnable }: { onEnable: () => void }) {
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 12,
      background: "var(--bg-canvas)", color: "var(--fg-dim)",
      fontFamily: "var(--mono)", fontSize: 11,
    }}>
      <span>console disabled · session stopped</span>
      <button className="btn" onClick={onEnable}>enable</button>
    </div>
  );
}

export function ConsoleScreen() {
  // Subscribe per-slice instead of `useAppStore()`-the-whole-state, so a mutation
  // anywhere else in the store (kbBlocks, GitHub cache, settings, planning data)
  // no longer re-renders the entire console grid — only changes to slices this
  // screen actually reads. Was a meaningful source of render churn on multi-pane
  // grids per #52.
  const tabs              = useAppStore((s) => s.tabs);
  const activeTabIdx      = useAppStore((s) => s.activeTabIdx);
  const paneMenuOpenIdx   = useAppStore((s) => s.paneMenuOpenIdx);
  const focusedPaneIdx    = useAppStore((s) => s.focusedPaneIdx);
  const fullscreenPaneIdx = useAppStore((s) => s.fullscreenPaneIdx);
  const paneViews         = useAppStore((s) => s.paneViews);
  const paneNames         = useAppStore((s) => s.paneNames);
  const paneCwds          = useAppStore((s) => s.paneCwds);
  const paneInitCmds      = useAppStore((s) => s.paneInitCmds);
  const disabledPanes     = useAppStore((s) => s.disabledPanes);
  const focusQueue        = useAppStore((s) => s.focusQueue);
  const tunnelRunning     = useAppStore((s) => s.tunnelRunning);
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
  const setPaneDisabled      = useAppStore((s) => s.setPaneDisabled);
  const setFocusedAgentName  = useAppStore((s) => s.setFocusedAgentName);
  const setTabState          = useAppStore((s) => s.setTabState);
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

  // Per-pane status ("run" | "idle"), keyed by paneId string.
  // Kept local — not persisted, resets on reload.
  const [paneStatuses, setPaneStatuses] = useState<Record<string, "run" | "on" | "idle">>({});
  // Ref so the callback passed to TerminalView always has the latest value without re-registering
  const paneStatusesRef = useRef(paneStatuses);
  useEffect(() => { paneStatusesRef.current = paneStatuses; }, [paneStatuses]);

  const handleStatusChange = useCallback((tabIdx: number, paneIdx: number, status: "run" | "idle") => {
    const pid = paneId(tabIdx, paneIdx);
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

    setPaneStatuses((current) => {
      const next = { ...current, [pid]: status };
      // Aggregate to tab-level state: any "run" → run, else any "on" → on, else idle.
      // Source-tab's own paneCount — background-tab rollups must not be limited by
      // the active tab's grid size.
      const tab = useAppStore.getState().tabs[tabIdx];
      if (!tab) return next;
      const [tcols, trows] = tab.layout.split("×").map(Number);
      const tPaneCount = (tcols || 1) * (trows || 1);
      let tabState: "run" | "on" | "idle" = "idle";
      for (let i = 0; i < tPaneCount; i++) {
        const s = next[paneId(tabIdx, i)] ?? "idle";
        if (s === "run") { tabState = "run"; break; }
        if (s === "on") tabState = "on";
      }
      setTabState(tabIdx, tabState);
      return next;
    });
  }, [autoAdvanceOnReply, setTabState, enqueueFocus, advanceFocus]);

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
        if ((paneStatuses[paneId(ti, i)] ?? "idle") === "idle") waiting.add(i);
      }
      waitingByTab.set(ti, waiting);
    }
    reconcileFocusQueue(waitingByTab);
  }, [paneStatuses, tabs, reconcileFocusQueue]);

  // Mobile tunnel (#253): while a phone is paired, push pane *metadata* so it mirrors
  // the consoles. PTY output is teed in Rust (no-op while idle); this is the low-volume
  // names/cwds/statuses + awaiting-input channel. The pure mapping lives in
  // buildPanePayload; this effect only fires when those inputs (or the paired state)
  // change, so it costs nothing when the tunnel is off.
  useEffect(() => {
    if (!tunnelRunning) return;
    const awaiting = new Set(focusQueue.map((q) => paneId(q.tab, q.pane)));
    const { panes, sessions } = buildPanePayload({
      tabs, paneNames, paneCwds, paneStatuses, disabledPanes, awaiting,
      nowIso: new Date().toISOString(),
    });
    tunnelSetPanes(panes).catch((e) => log.error(`tunnel: set_panes failed: ${e}`));
    tunnelSetSessions(sessions).catch((e) => log.error(`tunnel: set_sessions failed: ${e}`));
  }, [tunnelRunning, tabs, paneNames, paneCwds, paneStatuses, disabledPanes, focusQueue]);

  // All per-pane handlers are stable (useCallback) so the memoized PaneAt
  // children don't re-render on every ConsoleScreen commit. Each handler takes
  // (tabIdx, paneIdx, …) so background-tab events (#186 mounts every tab's
  // panes) route to the right tab's state — never to whichever tab happens to
  // be active. Transient screen-level indices (focus/menu/fullscreen) are read
  // via getState() at call time rather than captured, keeping deps minimal.
  const handleToggleDisable = useCallback((tabIdx: number, paneIdx: number) => {
    const pid = paneId(tabIdx, paneIdx);
    const st = useAppStore.getState();
    const next = !st.disabledPanes[pid];
    setPaneDisabled(pid, next);
    if (next) {
      // Kill the PTY (stops claude/shell) and clear any focus/fullscreen on it.
      invoke("pty_kill", { paneId: pid }).catch(console.error);
      // Re-arm the launch gate so a later batch re-enable is serialized again.
      resetLaunchGate(pid);
      setPaneStatuses((s) => ({ ...s, [pid]: "idle" }));
      // Screen-level focus / fullscreen only matter for the active tab — only
      // clear them when this disable came from the active tab.
      if (tabIdx === st.activeTabIdx) {
        if (st.focusedPaneIdx === paneIdx) setFocusedPane(-1);
        if (st.fullscreenPaneIdx === paneIdx) setFullscreenPane(-1);
      }
    }
  }, [setPaneDisabled, setFocusedPane, setFullscreenPane]);

  const handleCwdChange = useCallback((tabIdx: number, paneIdx: number, path: string) => {
    setPaneCwd(paneId(tabIdx, paneIdx), path);
  }, [setPaneCwd]);

  const handlePickDirectory = useCallback(async (tabIdx: number, paneIdx: number) => {
    const pid = paneId(tabIdx, paneIdx);
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

  // Per-tab pane renderer. tabIdx + isFullscreenInTab let one helper render
  // BOTH the active tab and the (display:none) background tabs from the same
  // code path. hidden=true covers both "background tab" (whole grid invisible)
  // and "active tab, but a sibling pane is fullscreened over us" — the
  // downstream visible/render-pause logic then doesn't have to distinguish.
  function renderPane(tabIdx: number, i: number, isFullscreenInTab: boolean) {
    const pid = paneId(tabIdx, i);
    const isActiveTab = tabIdx === activeTabIdx;
    return (
      <PaneAt
        key={`${tabs[tabIdx].runId ?? 0}-${i}`}
        i={i}
        tabIdx={tabIdx}
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
        // Screen-level chrome state only applies to the active tab.
        menuOpen={isActiveTab && paneMenuOpenIdx === i}
        focused={isActiveTab && focusedPaneIdx === i}
        fullscreen={isActiveTab && fullscreenPaneIdx === i}
        disabled={!!disabledPanes[pid]}
        hidden={!isActiveTab || (isFullscreenInTab && i !== fullscreenPaneIdx)}
      />
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      {consoleBroadcast && (
        <div style={{
          padding: "3px 14px",
          background: "color-mix(in oklch, var(--accent), transparent 82%)",
          borderBottom: "1px solid var(--accent-dim)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)",
          display: "flex", alignItems: "center", gap: 8, flexShrink: 0,
        }}>
          <span>⟳ broadcast · input mirrors to all panes</span>
          <span style={{ color: "var(--fg-dim)" }}>· Ctrl+Shift+C to exit</span>
        </div>
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
    </div>
  );
}
