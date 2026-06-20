import { useMemo, useState } from "react";
import { useAppStore } from "../../store";
import { SchedulesTab } from "./Schedules";
import { HistoryTab } from "./History";
import { HooksView } from "../mcp";
import { HookAnalyticsTab } from "./HookAnalytics";
import { fmtClock } from "./format";
import { TabBar, type TabItem } from "../../components/chrome/TabBar";
import { usePageTabs } from "../../hooks/usePageTabs";
import type { RunStatus, Every } from "../../lib/automations/scheduler";
import "./automations.css";

/**
 * Automations screen (#142) — on the unified tab system (#463): tab order is
 * persisted per page, the page opens whatever tab is first, tabs reorder, and
 * each can be torn off into its own window. `sectionOverride` renders a single
 * section with no tab bar (detached window).
 */
export function AutomationsScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  const { automations, addAutomation, tabs } = useAppStore();
  // Hooks live here (the MCP page is servers-only, #865 / #mcp-hooks-split) — event-triggered
  // automations alongside the time-triggered Schedules.
  const hookCount = useAppStore(s => s.hooks.length);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [histStatus, setHistStatus] = useState<"all" | RunStatus>("all");
  const [histSched, setHistSched] = useState<string>("all");

  const armed = automations.filter(a => a.armed).length;
  const totalRuns = automations.reduce((n, a) => n + a.runs.length, 0);
  const nextAt = automations
    .filter(a => a.armed && a.nextRunAt != null)
    .reduce<number | null>((min, a) => (min == null || a.nextRunAt! < min ? a.nextRunAt! : min), null);

  const defs: TabItem[] = useMemo(() => [
    { id: "schedules", label: "Schedules", count: automations.length, hint: `· ${armed} armed` },
    { id: "history", label: "History", count: totalRuns },
    { id: "hooks", label: "Hooks", count: hookCount },
    { id: "analytics", label: "Hook Analytics" },
  ], [automations.length, armed, totalRuns, hookCount]);

  const { tabs: tabItems, activeId, select, reorder, tearOff } = usePageTabs("automations", defs);
  const active = sectionOverride ?? activeId;

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
    select("schedules");
  }

  function viewAllHistory(id: string) {
    setHistSched(id);
    setHistStatus("all");
    select("history");
  }

  const body = active === "analytics"
    ? <HookAnalyticsTab />
    : active === "hooks"
    ? <HooksView />
    : active === "history"
    ? <HistoryTab status={histStatus} setStatus={setHistStatus} sched={histSched} setSched={setHistSched} />
    : <SchedulesTab selectedId={selectedId} setSelectedId={setSelectedId} onNew={createAndSelect} onViewAllHistory={viewAllHistory} />;

  return (
    <div className="auto-screen">
      <div className="auto-page">
        {!sectionOverride && (
          <TabBar
            tabs={tabItems}
            activeId={activeId}
            onSelect={select}
            onReorder={reorder}
            onTearOff={tearOff}
            right={
              active === "schedules" ? (
                <>
                  <span className="quick-stat">
                    <i style={{ background: armed > 0 ? "var(--success)" : "var(--fg-dim)" }} /> next run <b>{fmtClock(nextAt)}</b>
                  </span>
                  <button className="btn primary" onClick={createAndSelect}>+ New schedule</button>
                </>
              ) : undefined
            }
          />
        )}
        <div className="auto-body">{body}</div>
      </div>
    </div>
  );
}
