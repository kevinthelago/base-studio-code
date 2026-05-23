import { useAppStore } from "../../store";

interface StatusBarProps {
  extra?: React.ReactNode;
}

export function StatusBar({ extra }: StatusBarProps) {
  const { claudeApiKey, githubConnected, tabs, activeTabIdx } = useAppStore();

  const claudeOk  = Boolean(claudeApiKey);
  const activeTab = tabs[activeTabIdx];
  const [cols, rows] = activeTab
    ? activeTab.layout.split("×").map(Number)
    : [1, 1];
  const paneCount = cols * rows;

  return (
    <div className="statusbar">
      <div className="s">
        <i className={claudeOk ? "" : "off"} />
        claude · {claudeOk ? "connected" : "no key"}
      </div>
      <div className="s">
        <i className={githubConnected ? "" : "off"} />
        github · {githubConnected ? "synced" : "not connected"}
      </div>
      <div className="spacer" />
      {extra}
      <div className="s" style={{ color: "var(--fg-dim)" }}>
        {tabs.length} {tabs.length === 1 ? "tab" : "tabs"} · {paneCount} {paneCount === 1 ? "pane" : "panes"}
      </div>
      <div>v0.2.0 · rust 1.82</div>
    </div>
  );
}
