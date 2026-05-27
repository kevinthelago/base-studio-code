import { useState } from "react";
import { useAppStore } from "../../store";
import { SchedulesTab } from "./Schedules";
import { HistoryTab } from "./History";
import { fmtClock } from "./format";
import type { RunStatus, Every } from "../../lib/scheduler";
import "./automations.css";

type Tab = "schedules" | "history";

/**
 * Automations screen (#142) — wired to the real `automations` store slice and
 * the scheduler engine. Schedules tab edits real automations (fired by
 * useScheduler); History aggregates their recorded runs. Active tab is mirrored
 * into the store so the titlebar reflects it.
 */
export function AutomationsScreen() {
  const { automations, automationsTab, setAutomationsTab, addAutomation, tabs } = useAppStore();
  const tab: Tab = automationsTab === "history" ? "history" : "schedules";

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [histStatus, setHistStatus] = useState<"all" | RunStatus>("all");
  const [histSched, setHistSched] = useState<string>("all");

  const armed = automations.filter(a => a.armed).length;
  const totalRuns = automations.reduce((n, a) => n + a.runs.length, 0);
  const nextAt = automations
    .filter(a => a.armed && a.nextRunAt != null)
    .reduce<number | null>((min, a) => (min == null || a.nextRunAt! < min ? a.nextRunAt! : min), null);

  function createAndSelect() {
    addAutomation({
      name: "New automation", armed: false,
      when: { kind: "simple", every: "day" as Every, at: "09:00" },
      targetTab: tabs[0]?.name ?? "", targetPaneIdx: 0,
      action: "command", command: "",
    });
    const list = useAppStore.getState().automations;
    const created = list[list.length - 1];
    if (created) setSelectedId(created.id);
    setAutomationsTab("schedules");
  }

  function viewAllHistory(id: string) {
    setHistSched(id);
    setHistStatus("all");
    setAutomationsTab("history");
  }

  return (
    <div className="auto-screen">
      <div className="auto-page">
        <div className="subtabs">
          <div className={"t" + (tab === "schedules" ? " on" : "")} onClick={() => setAutomationsTab("schedules")}>
            Schedules <span className="count">{automations.length}</span>
            <span className="hint-inline">· {armed} armed</span>
          </div>
          <div className={"t" + (tab === "history" ? " on" : "")} onClick={() => setAutomationsTab("history")}>
            History <span className="count">{totalRuns}</span>
          </div>
          <div className="right">
            <span className="quick-stat">
              <i style={{ background: armed > 0 ? "var(--success)" : "var(--fg-dim)" }} /> next run <b>{fmtClock(nextAt)}</b>
            </span>
            <button className="btn primary" onClick={createAndSelect}>+ New schedule</button>
          </div>
        </div>

        <div className="auto-body">
          {tab === "schedules"
            ? <SchedulesTab selectedId={selectedId} setSelectedId={setSelectedId} onNew={createAndSelect} onViewAllHistory={viewAllHistory} />
            : <HistoryTab status={histStatus} setStatus={setHistStatus} sched={histSched} setSched={setHistSched} />}
        </div>
      </div>
    </div>
  );
}
