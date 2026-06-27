import { useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { SchedulesTab } from "../Schedules";
import { HistoryTab } from "../History";
import { HooksView } from "@/features/mcp";
import { HookAnalyticsTab } from "../HookAnalytics";
import { TabbedScreen } from "@/app/chrome/TabbedScreen";
import type { TabItem } from "@/app/chrome/TabBar";
import type { RunStatus, Every, Automation } from "../lib/scheduler";
import "../automations.css";

/**
 * Automations screen (#142) — on the shared `<TabbedScreen>` shell (#1821) + the unified tab system
 * (#463): tab order persists per page, the page opens whatever tab is first, tabs reorder, and each
 * can be torn off. `sectionOverride` renders a single section with no tab bar (detached window).
 */
export function AutomationsScreen({ sectionOverride }: { sectionOverride?: string } = {}) {
  const { automations, addAutomation, tabs } = useAppStore();
  // Hooks live here (the MCP page is servers-only, #865 / #mcp-hooks-split) — event-triggered
  // automations alongside the time-triggered Schedules.
  const hookCount = useAppStore(s => s.hooks.length);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Automation | null>(null);
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

  function commitDraft() {
    if (!draft) return;
    const { id: _, ...def } = draft;
    addAutomation(def);
    const list = useAppStore.getState().automations;
    const created = list[list.length - 1];
    setDraft(null);
    if (created) setSelectedId(created.id);
  }

  return (
    <TabbedScreen
      pageKey="automations"
      defs={defs}
      sectionOverride={sectionOverride}
      className="auto-screen"
      bodyClassName="auto-body"
      renderBody={(active, select) => {
        const createAndSelect = () => {
          setSelectedId(null);
          setDraft({
            id: "__draft__",
            name: "New automation", armed: false,
            when: { kind: "simple", every: "day" as Every, at: "09:00" },
            targetTab: tabs[0]?.name ?? "", targetPaneIdx: 0,
            action: "command", command: "",
            lastRunAt: null,
            nextRunAt: null,
            runs: [],
          });
          select("schedules");
        };
        const viewAllHistory = (id: string) => {
          setHistSched(id);
          setHistStatus("all");
          select("history");
        };
        return active === "analytics"
          ? <HookAnalyticsTab />
          : active === "hooks"
          ? <HooksView />
          : active === "history"
          ? <HistoryTab status={histStatus} setStatus={setHistStatus} sched={histSched} setSched={setHistSched} />
          : <SchedulesTab selectedId={selectedId} setSelectedId={setSelectedId} draft={draft} setDraft={setDraft} onCommit={commitDraft} onNew={createAndSelect} onViewAllHistory={viewAllHistory} />;
      }}
    />
  );
}
