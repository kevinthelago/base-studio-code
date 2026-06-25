import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "@/store";

interface StatusBarProps {
  extra?: React.ReactNode;
}

export function StatusBar({ extra }: StatusBarProps) {
  const { claudeApiKey, githubConnected, tabs } = useAppStore();

  // The real app version (from tauri.conf.json); drops the old hardcoded
  // "vX · rust Y" string (#215). Empty in a non-Tauri/web context.
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

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
      {appVersion && <div>v{appVersion}</div>}
    </div>
  );
}
