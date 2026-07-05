import { Card } from "@/shared/ui/data/Card";
import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";

/**
 * Toggle: show the legacy Console page in the rail (#2372). OFF by default — the graph (Glance) is
 * becoming the execution surface, where an agent's live stream opens from its node. This is the
 * migration escape hatch: turn it on to keep the classic tabbed console during the transition.
 */
export function ConsolePageCard() {
  const { showConsolePage, setShowConsolePage } = useAppStore();
  return (
    <Card title="Console page">
      <ToggleRow
        on={showConsolePage}
        onToggle={() => setShowConsolePage(!showConsolePage)}
        title="Show the legacy Console page"
      >
        The tabbed <b>Console</b> is being retired — <b>Glance</b> is becoming the execution surface,
        where you open an agent's live stream right from its node in the graph. Off by default; turn it
        on to keep the classic tabbed console as a rail destination during the transition. Your agents
        keep running either way — this only controls whether the page is reachable.
      </ToggleRow>
    </Card>
  );
}
