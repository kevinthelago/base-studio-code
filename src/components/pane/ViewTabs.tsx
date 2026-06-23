import { Terminal, FolderOpen, GitBranch, GitCompareArrows, History, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type ViewKey = "console" | "files" | "branches" | "changes" | "log" | "tools";

// `group` (#1149) splits the view-switcher dropdown into the working SCREENs (terminal, files,
// git views) and the INSPECT panels (tools & permissions, …) — mirroring the Console-Shell design.
export const VIEW_DEFS: Record<ViewKey, { Icon: LucideIcon; label: string; hint: string; hotkey: string; group: "screen" | "inspect" }> = {
  console:  { Icon: Terminal,   label: "Console",  hint: "claude session",      hotkey: "Alt+1", group: "screen" },
  files:    { Icon: FolderOpen, label: "Files",    hint: "working tree",        hotkey: "Alt+2", group: "screen" },
  branches: { Icon: GitBranch,  label: "Branches", hint: "local + remote refs", hotkey: "Alt+3", group: "screen" },
  changes:  { Icon: GitCompareArrows, label: "Changes", hint: "diff vs HEAD",   hotkey: "Alt+4", group: "screen" },
  log:      { Icon: History,    label: "Log",      hint: "recent commits",      hotkey: "Alt+5", group: "screen" },
  tools:    { Icon: ShieldCheck, label: "Tools & permissions", hint: "mcp + role posture", hotkey: "Alt+6", group: "inspect" },
};

interface ViewTabsProps {
  active: ViewKey;
  available: ViewKey[];
  onSwitch?: (view: ViewKey) => void;
}

export function ViewTabs({ active, available, onSwitch }: ViewTabsProps) {
  return (
    <div style={{
      height: 26, flex: "0 0 26px",
      display: "flex", alignItems: "center", gap: 2,
      padding: "0 6px",
      borderBottom: "1px solid var(--border-soft)",
      background: "var(--bg-panel)",
      fontFamily: "var(--mono)",
    }}>
      {available.map((k) => {
        const { Icon, label, hotkey } = VIEW_DEFS[k];
        const on = k === active;
        return (
          <div
            key={k}
            title={`${label} · ${hotkey}`}
            onClick={() => onSwitch?.(k)}
            style={{
              width: 24, height: 20,
              display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 4,
              background: on ? "var(--bg-canvas)" : "transparent",
              border: on ? "1px solid var(--accent-dim)" : "1px solid transparent",
              color: on ? "var(--accent)" : "var(--fg-muted)",
              cursor: "pointer",
            }}
          >
            <Icon size={12} />
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
    </div>
  );
}
