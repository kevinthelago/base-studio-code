// PaneAt (#2128, extracted from console/index.tsx) — the memoized single-pane cell: reads the pane's
// store-backed chrome (model/role/provider/repo/branch, claude-active) and renders the PaneShell with
// its active view (TerminalView stays mounted across view switches so the PTY survives), or one of the
// placeholder states (disabled / ended / dormant) from consoleStates. Memoized on its own props so a
// focus/menu change only re-renders the two panes whose flag flipped, not all N. Behavior-preserving.
import { memo } from "react";
import { PaneShell } from "@/app/console/panes/PaneShell";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";
import { FilesView } from "@/app/console/panes/views/FilesView";
import { BranchesView } from "@/app/console/panes/views/BranchesView";
import { ChangesView } from "@/app/console/panes/views/ChangesView";
import { LogView } from "@/app/console/panes/views/LogView";
import { ToolsView } from "@/app/console/panes/views/ToolsView";
import { TelemetryView } from "@/app/console/panes/views/TelemetryView";
import { useAppStore } from "@/store";
import type { PaneTokenUsage } from "@/app/console/lib/usePaneTokenUsage";
import type { ViewKey } from "@/app/console/panes/viewDefs";
import { DisabledConsole, EndedConsole, DormantConsole, CompletedConsole } from "./consoleStates";

export interface PaneAtProps {
  i: number;
  tabIdx: number;
  /** Stable identity id for this pane (#1176) — resolved from the tab, not the grid position. */
  paneId: string;
  name: string;
  view: ViewKey;
  status: "run" | "on" | "idle";
  cwd?: string;
  initCmd?: string;
  // Dispatchers take (tabIdx, paneIdx, …) so a single handler in ConsoleWorkspace
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
  onRedraw: (tabIdx: number, i: number) => void;
  // Per-pane booleans (not the raw indices) so a focus/menu change only re-renders
  // the two panes whose flag actually flipped — not all N.
  menuOpen: boolean;
  focused: boolean;
  fullscreen: boolean;
  disabled: boolean;
  hidden: boolean;
  usage?: PaneTokenUsage;
}

export const PaneAt = memo(function PaneAt({
  i, tabIdx, paneId: pid, name, view, status, cwd, initCmd,
  onRename, onMenuToggle, onFocus, onViewChange, onPickDirectory, onCwdChange, onStatusChange,
  onToggleFullscreen, onToggleDisable, onRedraw, menuOpen, focused, fullscreen, disabled, hidden, usage,
}: PaneAtProps) {
  const defaultModel = useAppStore((s) => s.defaultModel);
  const paneModel = useAppStore((s) => s.paneModels[pid]);
  const setPaneModel = useAppStore((s) => s.setPaneModel);
  const applyPersonaToPane = useAppStore((s) => s.applyPersonaToPane);
  // Header/footer chrome data (#1149) — read from the store where known; the header degrades
  // gracefully when a field is absent (e.g. no role/branch assigned to an ad-hoc console).
  const paneRole = useAppStore((s) => s.paneRoles[pid]);
  const paneProvider = useAppStore((s) => s.paneProviders[pid]);
  const paneRepoFull = useAppStore((s) => s.paneRepos[pid]);
  const paneBranch = useAppStore((s) => s.paneStream[pid]?.branch);
  // While a Claude session is active, the native console input replaces the status footer (#1158).
  const claudeActive = useAppStore((s) => !!s.paneClaudeActive[pid]);
  // Prefer the assigned repo's short name; fall back to the cwd's basename.
  const repoShort = (paneRepoFull ?? cwd)?.split(/[\\/]/).filter(Boolean).pop();
  // Idle-reaped (#849): the PTY was killed for idleness. Unmount the terminal (this frees
  // its renderer buffer + the dead session) and show a resume placeholder; resuming clears
  // the flag, remounting TerminalView, which spawns a fresh PTY (--continue resumes it).
  const dormant = useAppStore((s) => !!s.dormantPanes[pid]);
  // #4027 — declared maintenance: this worker finished everything it owns. Distinct from `dormant`
  // (reaped for idleness) even though a completed worker is now both, because the CARD differs: one
  // reports what the worker did, the other reports a memory optimisation.
  const maintaining = useAppStore((s) => !!s.paneMaintaining[pid]);
  const resumePane = useAppStore((s) => s.resumePane);
  // Auto-ended (#920): the worker finished and its PTY exited; show a resting card (state from
  // plan.db) instead of a dead terminal. Persisted, so it survives a restart; reopen relaunches.
  const ended = useAppStore((s) => s.endedPanes[pid]);
  const reopenPane = useAppStore((s) => s.reopenPane);
  return (
    <PaneShell
      agent={name}
      onRename={(n) => onRename(tabIdx, i, n)}
      onMenuToggle={() => onMenuToggle(tabIdx, i)}
      onToggleFullscreen={() => onToggleFullscreen(tabIdx, i)}
      onToggleDisable={() => onToggleDisable(tabIdx, i)}
      onRedraw={() => onRedraw(tabIdx, i)}
      onFocus={() => onFocus(tabIdx, i)}
      onPickDirectory={() => onPickDirectory(tabIdx, i)}
      status={disabled ? "idle" : status}
      model={paneModel ?? defaultModel}
      onModel={(m) => setPaneModel(pid, m)}
      onPersona={(personaId) => applyPersonaToPane(pid, personaId)}
      runningModel={usage?.model}
      repo={repoShort}
      branch={paneBranch}
      role={paneRole}
      provider={paneProvider}
      claudeActive={claudeActive}
      available={["console", "files", "branches", "changes", "log", "tools", "telemetry"]}
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
      ) : ended ? (
        <EndedConsole info={ended} onReopen={() => reopenPane(pid)} />
      ) : maintaining ? (
        /* #4027 — a worker that FINISHED. Checked before `dormant` because a completed worker is
           reaped immediately (#4025), so it is dormant too — and `DormantConsole` would report a
           memory optimisation ("reaped after idle") where the answer is what the worker did. */
        <CompletedConsole cwd={cwd ?? ""} repo={paneRepoFull ?? ""} />
      ) : dormant ? (
        <DormantConsole onResume={() => resumePane(pid)} />
      ) : (
      <>
      {/* The console cell is the PRIMARY slot: the app-level TerminalHost re-parents the pane's single
          terminal into here, and sources its launch/cwd/status props from this claim (#2378). The terminal
          survives view switches (hidden, not unmounted) and moves intact when the Glance dock borrows it. */}
      <TerminalSlot
        paneId={pid}
        primary
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
      {view === "tools"    && <ToolsView    small role={paneRole} />}
      {view === "telemetry"&& <TelemetryView small usage={usage} />}
      </>
      )}
    </PaneShell>
  );
});
