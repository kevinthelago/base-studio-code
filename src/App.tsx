import { Titlebar } from "./components/chrome/Titlebar";
import { Rail } from "./components/chrome/Rail";
import { Tabstrip } from "./components/chrome/Tabstrip";
import { StatusBar } from "./components/chrome/StatusBar";
import { useAppStore } from "./store";

function ScreenPlaceholder({ name }: { name: string }) {
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
  const {
    activeScreen, setScreen,
    tabs, activeTabIdx, setActiveTab,
  } = useAppStore();

  return (
    <div className="app">
      <Titlebar workspace="orchestrator · acme/payments" />
      <div className="shell">
        <Rail active={activeScreen} onNavigate={setScreen} />
        <div className="main">
          {activeScreen === "console" && (
            <Tabstrip
              tabs={tabs}
              activeIdx={activeTabIdx}
              onSelect={setActiveTab}
            />
          )}
          <div className="page">
            <ScreenPlaceholder name={activeScreen} />
          </div>
          <StatusBar />
        </div>
      </div>
    </div>
  );
}
