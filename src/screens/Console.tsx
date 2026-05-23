import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { PaneShell } from "../components/pane/PaneShell";
import { TerminalView } from "../components/pane/views/TerminalView";
import { FilesView } from "../components/pane/views/FilesView";
import { BranchesView } from "../components/pane/views/BranchesView";
import { ChangesView } from "../components/pane/views/ChangesView";
import { LogView } from "../components/pane/views/LogView";
import { useAppStore } from "../store";
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
  gitInfo?: GitInfo | null;
  onRename: (name: string) => void;
  onMenuToggle: () => void;
  onFocus: () => void;
  onViewChange: (v: ViewKey) => void;
  onPickDirectory: () => void;
  onCwdChange: (path: string) => void;
  onStatusChange: (status: "run" | "idle") => void;
  paneMenuOpenIdx: number;
  focusedPaneIdx: number;
}

function PaneAt({
  i, tabIdx, name, view, status, cwd, gitInfo,
  onRename, onMenuToggle, onFocus, onViewChange, onPickDirectory, onCwdChange, onStatusChange,
  paneMenuOpenIdx, focusedPaneIdx,
}: PaneAtProps) {
  const pid = paneId(tabIdx, i);
  return (
    <PaneShell
      agent={name}
      onRename={onRename}
      onMenuToggle={onMenuToggle}
      onFocus={onFocus}
      onPickDirectory={onPickDirectory}
      status={status}
      model="sonnet-4.5"
      cwd={gitInfo ? undefined : cwd}
      repo={gitInfo?.repo}
      branch={gitInfo?.branch}
      dirty={gitInfo?.dirty}
      available={["console", "files", "branches", "changes", "log"]}
      active={view}
      menuOpen={i === paneMenuOpenIdx}
      focused={i === focusedPaneIdx}
      onViewChange={onViewChange}
    >
      {/* Terminal stays mounted so the PTY session survives view switches */}
      <TerminalView
        paneId={pid}
        visible={view === "console"}
        focused={i === focusedPaneIdx}
        initialCwd={cwd}
        onCwdChange={onCwdChange}
        onStatusChange={onStatusChange}
        onFocus={onFocus}
      />
      {view === "files"    && <FilesView    small tree={[]} cwd={cwd} />}
      {view === "branches" && <BranchesView small branches={[]} />}
      {view === "changes"  && <ChangesView  small hunks={[]} />}
      {view === "log"      && <LogView      small commits={[]} />}
    </PaneShell>
  );
}

export function ConsoleScreen() {
  const {
    tabs, activeTabIdx, paneMenuOpenIdx, setPaneMenu,
    focusedPaneIdx, setFocusedPane, fullscreenPaneIdx,
    paneViews, setPaneView,
    paneNames, setPaneName,
    paneCwds, setPaneCwd,
    paneGitInfo, setPaneGitInfo,
    setFocusedAgentName,
    setTabState, autoFocusOnInterrupt,
  } = useAppStore();

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

  const handleStatusChange = useCallback((paneIdx: number, status: "run" | "idle") => {
    const pid = paneId(activeTabIdx, paneIdx);
    const prev = paneStatusesRef.current[pid] ?? "idle";

    // Auto-focus the pane that just finished responding
    if (status === "idle" && prev === "run" && autoFocusOnInterrupt) {
      setFocusedPane(paneIdx);
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

  async function handleCwdChange(paneIdx: number, path: string) {
    const pid = paneId(activeTabIdx, paneIdx);
    setPaneCwd(pid, path);
    const info = await invoke<GitInfo | null>("git_info", { path }).catch(() => null);
    setPaneGitInfo(pid, info);
  }

  async function handlePickDirectory(paneIdx: number) {
    const pid = paneId(activeTabIdx, paneIdx);
    const dir = await invoke<string | null>("pick_directory");
    if (!dir) return;
    // cd in the running shell (bash on Windows uses forward slashes)
    const posix = dir.replace(/\\/g, "/").replace(/^([A-Z]):/, (_, d) => `/${d.toLowerCase()}`);
    await invoke("pty_write", { paneId: pid, data: `cd "${posix}"\r` });
    await handleCwdChange(paneIdx, dir);
  }

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
        gitInfo={paneGitInfo[pid]}
        onRename={(n) => setPaneName(activeTabIdx, i, n)}
        onMenuToggle={() => setPaneMenu(paneMenuOpenIdx === i ? -1 : i)}
        onFocus={() => setFocusedPane(i)}
        onViewChange={(v) => setPaneView(i, v)}
        onPickDirectory={() => handlePickDirectory(i)}
        onCwdChange={(path) => handleCwdChange(i, path)}
        onStatusChange={(s) => handleStatusChange(i, s)}
        paneMenuOpenIdx={paneMenuOpenIdx}
        focusedPaneIdx={focusedPaneIdx}
      />
    );
  }

  if (fullscreenPaneIdx >= 0 && fullscreenPaneIdx < paneCount) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, padding: 10 }}>
        {renderPane(fullscreenPaneIdx)}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div
        className="console-grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows:    `repeat(${rows}, 1fr)`,
        }}
      >
        {Array.from({ length: paneCount }, (_, i) => renderPane(i))}
      </div>
    </div>
  );
}
