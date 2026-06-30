// Automations stage body (split from FocusedBodies.tsx #1757).
import type { PaneAutomation } from "@/features/planner/pane/projectPaneData";
import { ListItemCard } from "./bodyPrimitives";

export function AutomationsBody({ automations }: { automations?: PaneAutomation[] }) {
  const list = automations ?? [];
  if (list.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">⏱</span>
        <span>No automations yet</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      {list.map((a) => (
        <ListItemCard
          key={a.name}
          title={a.name}
          meta={`${a.command}${a.schedule ? ` · ${a.schedule}` : ""}`}
        />
      ))}
    </div>
  );
}
