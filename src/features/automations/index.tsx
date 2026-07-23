import { useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { SchedulesTab, ScheduleDrawer } from "./Schedules";
import { HistoryTab } from "./History";
import { HooksView } from "@/features/mcp";
import { HookAnalyticsTab } from "./HookAnalytics";
import { Screen } from "@/shared/ui/layouts/Screen";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { useDraft } from "@/shared/hooks/useDraft";
import type { TabItem } from "@/shared/ui/layouts/TabBar";
import type { RunStatus, Every, Automation } from "./lib/scheduler";
import "./automations.css";

/**
 * Automations screen (#142) — on the shared `<Screen>` shell (#1821) + the unified tab system
 * (#463): tab order persists per page, the page opens whatever tab is first, tabs reorder, and each
 * can be torn off into its own window. `pageOverride` renders a single section with no tab bar.
 */
export function AutomationsWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
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

  const defs: TabItem[] = useMemo(() => [
    { id: "schedules", label: "Schedules", count: automations.length, hint: `· ${armed} armed` },
    { id: "history", label: "History", count: totalRuns },
    { id: "hooks", label: "Hooks", count: hookCount },
    { id: "analytics", label: "Hook Analytics" },
  ], [automations.length, armed, totalRuns, hookCount]);

  const { tabs: tabItems, activeId, select, reorder, tearOff } = usePageTabs("automations", defs);
  const active = pageOverride ?? activeId;

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
    <Screen
      tabs={tabItems}
      active={active}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      pageOverride={pageOverride}
      className="auto-workspace"
      bodyClassName="auto-body"
      overlay={active === "schedules"
        ? <ScheduleDrawer selected={drawer.selected} onClose={drawer.close} onViewAllHistory={viewAllHistory} />
        : undefined}
    >
      {body}
    </Screen>
  );
}

// Re-exported feature surface — this index is the automations feature's public API barrel (#1309).
export { AutomationsGraphHost } from "./AutomationsGraphHost"; // the graph-hosted workspace (#3642)
export { AutomationsStatus } from "./AutomationsStatus";
export { useScheduler } from "./useScheduler";

// #1545: public API for cross-feature consumers (tunnel).
export { type Automation, type AutomationWhen } from "./lib/scheduler";
export { isValidCron } from "./lib/cron";
export { dispatchAutomation } from "./lib/dispatch";
