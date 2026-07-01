import { Terminal, FolderOpen, GitBranch, GitCompareArrows, History, ShieldCheck, Activity } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// The canonical console-pane VIEW registry: the set of views a pane can show, their icon/label/
// hotkey, and their order. The view switcher itself lives in the PaneMenu dropdown (#1149/#1319) and
// the PaneShell trigger glyph; both read VIEW_DEFS, and useHotkeys maps Alt+digits through VIEW_ORDER.
// (Extracted out of the former ViewTabs tab-strip component — removed once switching moved into the
// menu; the icon-registry migration of these glyphs is tracked separately as the console+icons theme.)
export type ViewKey = "console" | "files" | "branches" | "changes" | "log" | "tools" | "telemetry";

// `group` (#1149) splits the view-switcher dropdown into the working SCREENs (terminal, files,
// git views) and the INSPECT panels (tools & permissions, …) — mirroring the Console-Shell design.
export const VIEW_DEFS: Record<ViewKey, { Icon: LucideIcon; label: string; hint: string; hotkey: string; group: "screen" | "inspect" }> = {
  console:  { Icon: Terminal,   label: "Console",  hint: "claude session",      hotkey: "Alt+1", group: "screen" },
  files:    { Icon: FolderOpen, label: "Files",    hint: "working tree",        hotkey: "Alt+2", group: "screen" },
  branches: { Icon: GitBranch,  label: "Branches", hint: "local + remote refs", hotkey: "Alt+3", group: "screen" },
  changes:  { Icon: GitCompareArrows, label: "Changes", hint: "diff vs HEAD",   hotkey: "Alt+4", group: "screen" },
  log:      { Icon: History,    label: "Log",      hint: "recent commits",      hotkey: "Alt+5", group: "screen" },
  tools:    { Icon: ShieldCheck, label: "Tools & permissions", hint: "mcp + role posture", hotkey: "Alt+6", group: "inspect" },
  telemetry:{ Icon: Activity,   label: "Telemetry · cost", hint: "tokens + spend", hotkey: "Alt+7", group: "inspect" },
};

/** Views in their canonical (hotkey) order — index i ⇒ Alt+(i+1) / Alt+Shift+(i+1). The single
 *  source the view hotkeys (useHotkeys) map digits through, so the keys never drift from VIEW_DEFS. */
export const VIEW_ORDER: ViewKey[] = ["console", "files", "branches", "changes", "log", "tools", "telemetry"];
