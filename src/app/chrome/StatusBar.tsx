import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "@/store";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

interface StatusBarProps {
  extra?: React.ReactNode;
}

export function StatusBar({ extra }: StatusBarProps) {
  // Per-field selectors, not a bare whole-store read (#3612) — the StatusBar is always mounted, so a
  // whole-store subscription would re-render it on every unrelated store write.
  const claudeApiKey = useAppStore((s) => s.claudeApiKey);
  const githubConnected = useAppStore((s) => s.githubConnected);
  const tabs = useAppStore((s) => s.tabs);

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
    <Box className="statusbar">
      <Box className="s">
        <i className={claudeOk ? "" : "off"} />
        claude · {claudeOk ? "connected" : "no key"}
      </Box>
      <Box className="s">
        <i className={githubConnected ? "" : "off"} />
        github · {githubConnected ? "synced" : "not connected"}
      </Box>
      <Box className="spacer" />
      {extra}
      <Box className="s" style={{ color: "var(--fg-dim)" }}>
        {tabs.length} {tabs.length === 1 ? "tab" : "tabs"} · {totalPanes} {totalPanes === 1 ? "pane" : "panes"}
      </Box>
      {appVersion && <Text as="div">v{appVersion}</Text>}
    </Box>
  );
}
