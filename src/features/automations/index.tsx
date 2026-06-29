import { useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { SchedulesTab, ScheduleDrawer } from "./Schedules";
import { HistoryTab } from "./History";
import { HooksView } from "@/features/mcp";
import { HookAnalyticsTab } from "./HookAnalytics";
import { fmtClock } from "./format";
import { TabbedScreen } from "@/app/chrome/TabbedScreen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { useDraft } from "@/shared/hooks/useDraft";
import type { TabItem } from "@/app/chrome/TabBar";
import type { RunStatus, Every, Automation } from "./lib/scheduler";
import "./automations.css";

/**
 * Automations screen (#142) — on the shared `<TabbedScreen>` shell (#1821) + the unified tab system
 * (#463): tab order persists per page, the page opens whatever tab is first, tabs reorder, and each
 * can be torn off into its own window. `sectionOverride` renders a single section with no tab bar.
 */
export function AutomationsScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  const { automations, addAutomation, updateAutomation, tabs } = useAppStore();
  // Hooks live here (the MCP page is servers-only, #865 / #mcp-hooks-split) — event-triggered
  // automations alongside the time-triggered Schedules.
  const hookCount = useAppStore(s => s.hooks.length);

  // One drawer lifecycle for the schedule editor — the shared useDraft/<Pane> system (#1824).
  const drawer = useDraft<Automation>({ items: automations, onUpdate: updateAutomation });
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
    const id = addAutomation({
      name: "New automation", armed: false,
      when: { kind: "simple", every: "day" as Every, at: "09:00" },
      targetTab: tabs[0]?.name ?? "", targetPaneIdx: 0,
      action: "command", command: "",
    });
    drawer.select(id);
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
    : <SchedulesTab selectedId={drawer.selectedId} onSelect={drawer.select} onNew={createAndSelect} />;

  return (
    <TabbedScreen
      tabs={tabItems}
      active={active}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      sectionOverride={sectionOverride}
      className="auto-screen"
      bodyClassName="auto-body"
      right={active === "schedules" ? (
        <>
          <span className="quick-stat">
            <i style={{ background: armed > 0 ? "var(--success)" : "var(--fg-dim)" }} /> next run <b>{fmtClock(nextAt)}</b>
          </span>
          <button className="btn primary" onClick={createAndSelect}>+ New schedule</button>
        </>
      ) : undefined}
      overlay={active === "schedules"
        ? <ScheduleDrawer selected={drawer.selected} onClose={drawer.close} onViewAllHistory={viewAllHistory} />
        : undefined}
    >
      {body}
    </TabbedScreen>
  );
}

// Re-exported feature surface — this index is the automations feature's public API barrel (#1309).
export { AutomationsStatus } from "./AutomationsStatus";
export { useScheduler } from "./useScheduler";
