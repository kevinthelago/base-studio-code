import { Titlebar } from "./components/chrome/Titlebar";
import { Rail } from "./components/chrome/Rail";
import { Tabstrip } from "./components/chrome/Tabstrip";
import { StatusBar } from "./components/chrome/StatusBar";
import { useAppStore } from "./store";
import { useHotkeys } from "./hooks/useHotkeys";
import { ConsoleScreen } from "./screens/Console";
import { KnowledgeStoreScreen } from "./screens/KnowledgeStore";
import { GitHubScreen } from "./screens/github";
import { AutomationsScreen } from "./screens/automations";
import { SettingsScreen } from "./screens/settings";

function Placeholder({ name }: { name: string }) {
  return (
    <div style={{
      flex: 1,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)",
    }}>
      {name}
    </div>
  );
}

export default function App() {
  useHotkeys();
  const { activeScreen, setScreen, tabs, activeTabIdx, setActiveTab } = useAppStore();

  const screen = (() => {
    switch (activeScreen) {
      case "console":    return <ConsoleScreen />;
      case "knowledge":  return <KnowledgeStoreScreen />;
      case "github":     return <GitHubScreen />;
      case "automation": return <AutomationsScreen />;
      case "settings":   return <SettingsScreen />;
      default:           return <Placeholder name={activeScreen} />;
    }
  })();

  return (
    <div className="app">
      <Titlebar workspace="orchestrator · acme/payments" />
      <div className="shell">
        <Rail active={activeScreen} onNavigate={setScreen} />
        <div className="main">
          {activeScreen === "console" && (
            <Tabstrip tabs={tabs} activeIdx={activeTabIdx} onSelect={setActiveTab} />
          )}
          <div className="page">{screen}</div>
          <StatusBar extra={
            activeScreen === "console"
              ? <span className="s">9 panes · 5 views · acme/payments</span>
              : undefined
          } />
        </div>
      </div>
    </div>
  );
}
