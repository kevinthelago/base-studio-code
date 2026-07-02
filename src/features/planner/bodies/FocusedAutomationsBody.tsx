// Automations stage body (split from FocusedBodies.tsx #1757).
import type { PaneAutomation } from "@/features/planner/pane/projectPaneData";
import { ListItemCard } from "./bodyPrimitives";
import { Stack } from "@/shared/ui/layout/Stack";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";

export function AutomationsBody({ automations }: { automations?: PaneAutomation[] }) {
  const list = automations ?? [];
  if (list.length === 0) {
    return <EmptyState iconVariant="dashed" icon="⏱" title="No automations yet" />;
  }
  return (
    <Stack gap={5}>
      {list.map((a) => (
        <ListItemCard
          key={a.name}
          title={a.name}
          meta={`${a.command}${a.schedule ? ` · ${a.schedule}` : ""}`}
        />
      ))}
    </Stack>
  );
}
