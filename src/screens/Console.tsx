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
import { shouldAutoFocusOnIdle, STARTUP_GRACE_MS } from "../lib/consoleFocus";
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

interface GitInfo { repo: string; branch: string; dirty: boolean }

interface PaneAtProps {
  i: number;
  tabIdx: number;
  name: string;
  view: ViewKey;
  status: "run" | "on" | "idle";
  cwd?: string;
  initCmd?: string;
  gitInfo?: GitInfo | null;
  // Index-taking dispatchers, stable across ConsoleScreen renders so the memo
  // below holds; PaneAt binds its own `i` into the no-arg callbacks the chrome
  // expects.
  onRename: (i: number, name: string) => void;
  onMenuToggle: (i: number) => void;
  onFocus: (i: number) => void;
  onViewChange: (i: number, v: ViewKey) => void;
  onPickDirectory: (i: number) => void;
  onCwdChange: (i: number, path: string) => void;
  onStatusChange: (i: number, status: "run" | "idle") => void;
  onToggleFullscreen: (i: number) => void;
  onToggleDisable: (i: number) => void;
  // Per-pane booleans (not the raw indices) so a focus/menu change only re-renders
  // the two panes whose flag actually flipped — not all N.
  menuOpen: boolean;
  focused: boolean;
  fullscreen: boolean;
  disabled: boolean;
  hidden: boolean;
}

const PaneAt = memo(function PaneAt({
  i, tabIdx, name, view, status, cwd, initCmd, gitInfo,
  onRename, onMenuToggle, onFocus, onViewChange, onPickDirectory, onCwdChange, onStatusChange,
  onToggleFullscreen, onToggleDisable, menuOpen, focused, fullscreen, disabled, hidden,
}: PaneAtProps) {
  const pid = paneId(tabIdx, i);
  return (
    <PaneShell
      agent={name}
      onRename={(n) => onRename(i, n)}
      onMenuToggle={() => onMenuToggle(i)}
      onToggleFullscreen={() => onToggleFullscreen(i)}
      onToggleDisable={() => onToggleDisable(i)}
      onFocus={() => onFocus(i)}
      onPickDirectory={() => onPickDirectory(i)}
      status={disabled ? "idle" : status}
      model="sonnet-4.5"
      cwd={gitInfo ? undefined : cwd}
      repo={gitInfo?.repo}
      branch={gitInfo?.branch}
      dirty={gitInfo?.dirty}
      available={["console", "files", "branches", "changes", "log"]}
      active={view}
      menuOpen={menuOpen}
      focused={focused}
      fullscreen={fullscreen}
      disabled={disabled}
      hidden={hidden}
      onViewChange={(v) => onViewChange(i, v)}
    >
      {disabled ? (
        <DisabledConsole onEnable={() => onToggleDisable(i)} />
      ) : (
      <>
      {/* Terminal stays mounted so the PTY session survives view switches */}
      <TerminalView
        paneId={pid}
        visible={view === "console"}
        focused={focused}
        initialCwd={cwd}
        initCmd={initCmd}
        onCwdChange={(path) => onCwdChange(i, path)}
        onStatusChange={(s) => onStatusChange(i, s)}
        onFocus={() => onFocus(i)}
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
  const {
    tabs, activeTabIdx, paneMenuOpenIdx, setPaneMenu,
    focusedPaneIdx, setFocusedPane, fullscreenPaneIdx, setFullscreenPane,
    paneViews, setPaneView,
    paneNames, setPaneName,
    paneCwds, setPaneCwd,
    paneInitCmds,
    paneGitInfo, setPaneGitInfo,
    disabledPanes, setPaneDisabled,
    setFocusedAgentName,
    setTabState, autoFocusOnInterrupt,
    consoleBroadcast,
  } = useAppStore();

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

  const activeTab = tabs[activeTabIdx];
  const [cols, rows] = activeTab.layout.split("×").map(Number);
  const paneCount = cols * rows;

  // Per-pane status ("run" | "idle"), keyed by paneId string.
  // Kept local — not persisted, resets on reload.
  const [paneStatuses, setPaneStatuses] = useState<Record<string, "run" | "on" | "idle">>({});
  // Ref so the callback passed to TerminalView always has the latest value without re-registering
  const paneStatusesRef = useRef(paneStatuses);
  useEffect(() => { paneStatusesRef.current = paneStatuses; }, [paneStatuses]);
  // Timestamp of the last auto-focus steal — feeds the cooldown that stops two
  // panes settling in quick succession from ping-ponging the cursor.
  const lastAutoFocusRef = useRef(0);

  const handleStatusChange = useCallback((paneIdx: number, status: "run" | "idle") => {
    const pid = paneId(activeTabIdx, paneIdx);
    const prev = paneStatusesRef.current[pid] ?? "idle";

    // Auto-focus the pane that just finished so you can reply fast — this is meant
    // to steal focus. Suppressed during a freshly-launched grid's cold-start
    // window and for a short cooldown after a previous steal (so competing idles
    // don't ping-pong the cursor between panes).
    const now = Date.now();
    const startedAt = useAppStore.getState().tabStartedAt[activeTabIdx] ?? 0;
    const withinStartupGrace = startedAt > 0 && now - startedAt < STARTUP_GRACE_MS;
    if (shouldAutoFocusOnIdle(autoFocusOnInterrupt, status, prev, withinStartupGrace, now - lastAutoFocusRef.current)) {
      setFocusedPane(paneIdx);
      lastAutoFocusRef.current = now;
    }

    setPaneStatuses((current) => {
      const next = { ...current, [pid]: status };
      // Aggregate to tab-level state: any "run" → run, else any "on" → on, else idle
      let tabState: "run" | "on" | "idle" = "idle";
      for (let i = 0; i < paneCount; i++) {
        const s = next[paneId(activeTabIdx, i)] ?? "idle";
        if (s === "run") { tabState = "run"; break; }
        if (s === "on") tabState = "on";
      }
      setTabState(activeTabIdx, tabState);
      return next;
    });
  }, [activeTabIdx, paneCount, autoFocusOnInterrupt, setFocusedPane, setTabState]);

  // All per-pane handlers are stable (useCallback) so the memoized PaneAt
  // children don't re-render on every ConsoleScreen commit. Store-action refs
  // are already stable; transient indices (focus/menu/fullscreen) are read via
  // getState() at call time rather than captured, keeping deps minimal.
  const handleToggleDisable = useCallback((paneIdx: number) => {
    const pid = paneId(activeTabIdx, paneIdx);
    const st = useAppStore.getState();
    const next = !st.disabledPanes[pid];
    setPaneDisabled(pid, next);
    if (next) {
      // Kill the PTY (stops claude/shell) and clear any focus/fullscreen on it.
      invoke("pty_kill", { paneId: pid }).catch(console.error);
      // Re-arm the launch gate so a later batch re-enable is serialized again.
      resetLaunchGate(pid);
      setPaneStatuses((s) => ({ ...s, [pid]: "idle" }));
      if (st.focusedPaneIdx === paneIdx) setFocusedPane(-1);
      if (st.fullscreenPaneIdx === paneIdx) setFullscreenPane(-1);
    }
  }, [activeTabIdx, setPaneDisabled, setFocusedPane, setFullscreenPane]);

  const handleCwdChange = useCallback(async (paneIdx: number, path: string) => {
    const pid = paneId(activeTabIdx, paneIdx);
    setPaneCwd(pid, path);
    const info = await invoke<GitInfo | null>("git_info", { path }).catch(() => null);
    setPaneGitInfo(pid, info);
  }, [activeTabIdx, setPaneCwd, setPaneGitInfo]);

  const handlePickDirectory = useCallback(async (paneIdx: number) => {
    const pid = paneId(activeTabIdx, paneIdx);
    const dir = await invoke<string | null>("pick_directory");
    if (!dir) return;
    // cd in the running shell (bash on Windows uses forward slashes)
    const posix = dir.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/${d.toLowerCase()}`);
    await invoke("pty_write", { paneId: pid, data: `cd "${posix}"\r` });
    await handleCwdChange(paneIdx, dir);
  }, [activeTabIdx, handleCwdChange]);

  const handleRename = useCallback((paneIdx: number, n: string) => setPaneName(activeTabIdx, paneIdx, n), [activeTabIdx, setPaneName]);
  const handleMenuToggle = useCallback((paneIdx: number) => setPaneMenu(useAppStore.getState().paneMenuOpenIdx === paneIdx ? -1 : paneIdx), [setPaneMenu]);
  const handleViewChange = useCallback((paneIdx: number, v: ViewKey) => setPaneView(paneIdx, v), [setPaneView]);
  const handleFocusPane = useCallback((paneIdx: number) => setFocusedPane(paneIdx), [setFocusedPane]);
  const handleToggleFullscreen = useCallback((paneIdx: number) => setFullscreenPane(useAppStore.getState().fullscreenPaneIdx === paneIdx ? -1 : paneIdx), [setFullscreenPane]);

  function renderPane(i: number) {
    const pid = paneId(activeTabIdx, i);
    return (
      <PaneAt
        key={i}
        i={i}
        tabIdx={activeTabIdx}
        name={resolvePaneName(activeTabIdx, i, paneNames)}
        view={paneViews[i] ?? "console"}
        status={paneStatuses[pid] ?? "idle"}
        cwd={paneCwds[pid]}
        initCmd={paneInitCmds[pid]}
        gitInfo={paneGitInfo[pid]}
        onRename={handleRename}
        onMenuToggle={handleMenuToggle}
        onFocus={handleFocusPane}
        onViewChange={handleViewChange}
        onPickDirectory={handlePickDirectory}
        onCwdChange={handleCwdChange}
        onStatusChange={handleStatusChange}
        onToggleFullscreen={handleToggleFullscreen}
        onToggleDisable={handleToggleDisable}
        menuOpen={paneMenuOpenIdx === i}
        focused={focusedPaneIdx === i}
        fullscreen={fullscreenPaneIdx === i}
        disabled={!!disabledPanes[paneId(activeTabIdx, i)]}
        hidden={isFullscreen && i !== fullscreenPaneIdx}
      />
    );
  }

  // Maximize keeps EVERY pane mounted (xterm + PTY + scrollback intact); the
  // non-maximized panes are CSS-hidden, not unmounted. Disposing/recreating 15
  // terminals on every toggle was the lag — and made the others look stopped.
  const isFullscreen = fullscreenPaneIdx >= 0 && fullscreenPaneIdx < paneCount;

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
      <div
        className="console-grid"
        style={{
          gridTemplateColumns: isFullscreen ? "1fr" : `repeat(${cols}, 1fr)`,
          gridTemplateRows:    isFullscreen ? "1fr" : `repeat(${rows}, 1fr)`,
        }}
      >
        {Array.from({ length: paneCount }, (_, i) => renderPane(i))}
      </div>
    </div>
  );
}
