// Automations stage body (split from FocusedBodies.tsx #1757).
import type { PaneAutomation } from "@/features/planner/pane/projectPaneData";
import { ListItemCard } from "./bodyPrimitives";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";

export function AutomationsBody({ automations }: { automations?: PaneAutomation[] }) {
  const list = automations ?? [];
  if (list.length === 0) {
    return (
      <Box className="empty-state">
        <Box as="span" className="empty-icon">⏱</Box>
        <Box as="span">No automations yet</Box>
      </Box>
    );
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
