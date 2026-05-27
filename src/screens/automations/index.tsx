import { useState } from "react";
import { useAppStore } from "../../store";
import { SchedulesTab } from "./Schedules";
import { HistoryTab } from "./History";
import { AUTO_SCHEDULES, AUTO_HISTORY, type RunStatus } from "../../data/automations";
import "./automations.css";

type Tab = "schedules" | "history";

/**
 * Automations screen (mock, #142) — a faithful static port of
 * design/Automations.html: a Schedules tab (list + deep editor) and a History
 * tab (summary + filterable run table). Renders from src/data/automations.ts;
 * the real scheduler/runtime is future work. The active tab is mirrored into the
 * store (automationsTab) so the titlebar reflects it.
 */
export function AutomationsScreen() {
  const { automationsTab, setAutomationsTab } = useAppStore();
  const tab: Tab = automationsTab === "history" ? "history" : "schedules";

  // History filters live here so the editor's "view all →" can pre-filter.
  const [histStatus, setHistStatus] = useState<"all" | RunStatus>("all");
  const [histSched, setHistSched] = useState<string>("all");

  const armed = AUTO_SCHEDULES.filter(s => s.on).length;

  function viewAllHistory(sid: string) {
    setHistSched(sid);
    setHistStatus("all");
    setAutomationsTab("history");
  }

  return (
    <div className="auto-screen">
      <div className="auto-page">
        <div className="subtabs">
          <div className={"t" + (tab === "schedules" ? " on" : "")} onClick={() => setAutomationsTab("schedules")}>
            Schedules <span className="count">{AUTO_SCHEDULES.length}</span>
            <span className="hint-inline">· {armed} armed · next at 15:15</span>
          </div>
          <div className={"t" + (tab === "history" ? " on" : "")} onClick={() => setAutomationsTab("history")}>
            History <span className="count">{AUTO_HISTORY.length}</span>
          </div>
          <div className="right">
            <span className="quick-stat"><i /> <b>14:24</b> · next run in <b>22m</b></span>
            <button className="btn">import</button>
            <button className="btn primary">+ New schedule</button>
          </div>
        </div>

        <div className="auto-body">
          {tab === "schedules"
            ? <SchedulesTab onViewAllHistory={viewAllHistory} />
            : <HistoryTab status={histStatus} setStatus={setHistStatus} sched={histSched} setSched={setHistSched} />}
        </div>
      </div>
    </div>
  );
}
