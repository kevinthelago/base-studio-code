// KitChangeApprovalCard (#2944, default ON #2968) — the Planner setting governing how the designer
// session's kit changes land: ON (default) auto-applies (propagates to consumer projects without the
// gate); OFF gates each change in the top-right KitChangesBanner for the user to review + Approve.
import { useAppStore } from "@/store";
import { Card } from "@/shared/ui/data/Card";
import { ToggleRow } from "../pages/SettingsControls";

export function KitChangeApprovalCard() {
  const on = useAppStore((s) => s.autoApplyKitChanges);
  const setOn = useAppStore((s) => s.setAutoApplyKitChanges);
  return (
    <Card title="Designer kit changes">
      <ToggleRow on={on} onToggle={() => setOn(!on)} title="Auto-apply kit changes">
        When ON (default), the kit changes the designer session makes propagate to consumer projects
        automatically — no confirmation. Turn OFF to hold each change in a top-right banner for you to
        review its propagated changes and <b>Approve</b> before it goes out.
      </ToggleRow>
    </Card>
  );
}
