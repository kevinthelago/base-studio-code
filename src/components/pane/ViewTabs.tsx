export type ViewKey = "console" | "files" | "branches" | "changes" | "log";

export const VIEW_DEFS: Record<ViewKey, { icon: string; label: string; hint: string; hotkey: string }> = {
  console:  { icon: "▸", label: "Console",  hint: "claude session",      hotkey: "⌥1" },
  files:    { icon: "⌗", label: "Files",    hint: "working tree",        hotkey: "⌥2" },
  branches: { icon: "⎇", label: "Branches", hint: "local + remote refs", hotkey: "⌥3" },
  changes:  { icon: "±", label: "Changes",  hint: "diff vs HEAD",        hotkey: "⌥4" },
  log:      { icon: "⏱", label: "Log",      hint: "recent commits",      hotkey: "⌥5" },
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
        const v = VIEW_DEFS[k];
        const on = k === active;
        return (
          <div
            key={k}
            title={`${v.label} · ${v.hotkey}`}
            onClick={() => onSwitch?.(k)}
            style={{
              width: 24, height: 20,
              display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 4,
              background: on ? "var(--bg-canvas)" : "transparent",
              border: on ? "1px solid var(--accent-dim)" : "1px solid transparent",
              color: on ? "var(--accent)" : "var(--fg-muted)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {v.icon}
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
    </div>
  );
}
