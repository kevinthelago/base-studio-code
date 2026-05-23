import { useState } from "react";
import { Titlebar } from "./components/chrome/Titlebar";
import { Rail, type Screen } from "./components/chrome/Rail";
import { Tabstrip } from "./components/chrome/Tabstrip";
import { StatusBar } from "./components/chrome/StatusBar";

const PLACEHOLDER_TABS = [
  { name: "orchestrator", layout: "3×3", state: "run" as const },
  { name: "feat/tunnel",  layout: "2×2", state: "on"  as const },
  { name: "scratch",      layout: "1×1", state: "idle" as const },
];

export default function App() {
  const [screen, setScreen] = useState<Screen>("console");
  const [tabIdx, setTabIdx] = useState(0);

  return (
    <div className="app">
      <Titlebar workspace="orchestrator · acme/payments" />
      <div className="shell">
        <Rail active={screen} onNavigate={setScreen} />
        <div className="main">
          {screen === "console" && (
            <Tabstrip
              tabs={PLACEHOLDER_TABS}
              activeIdx={tabIdx}
              onSelect={setTabIdx}
            />
          )}
          <div className="page" style={{
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "var(--mono)",
            fontSize: 12,
            color: "var(--fg-dim)",
          }}>
            {screen}
          </div>
          <StatusBar />
        </div>
      </div>
    </div>
  );
}
