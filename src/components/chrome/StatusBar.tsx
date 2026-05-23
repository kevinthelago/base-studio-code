import { useAppStore } from "../../store";

interface StatusBarProps {
  extra?: React.ReactNode;
}

export function StatusBar({ extra }: StatusBarProps) {
  const { claudeApiKey, githubConnected, tabs } = useAppStore();

  const claudeOk  = Boolean(claudeApiKey);
  const totalPanes = tabs.reduce((sum, tab) => {
    const [c, r] = tab.layout.split("×").map(Number);
    return sum + c * r;
  }, 0);

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
        {tabs.length} {tabs.length === 1 ? "tab" : "tabs"} · {totalPanes} {totalPanes === 1 ? "pane" : "panes"}
      </div>
      <div>v0.2.0 · rust 1.82</div>
    </div>
  );
}
