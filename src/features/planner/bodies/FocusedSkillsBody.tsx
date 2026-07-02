// Skills stage body (#1056, split from FocusedBodies.tsx #1757).
import type { PaneSkill } from "@/features/planner/pane/projectPaneData";
import { ListItemCard } from "./bodyPrimitives";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";

export function SkillsBody({ skills }: { skills?: PaneSkill[] }) {
  const list = skills ?? [];
  if (list.length === 0) {
    return <EmptyState iconVariant="dashed" icon="◈" title="No skills attached" />;
  }
  // Skills authored by this planning session (#1056) render FIRST and highlighted, so freshly
  // generated skills are obvious. Stable sort keeps each group's original order.
  const ordered = [...list].sort((a, b) => Number(b.isNew ?? false) - Number(a.isNew ?? false));
  return (
    <Stack gap={5}>
      {ordered.map((s) => (
        <ListItemCard
          key={s.name}
          title={s.name}
          meta={s.desc || undefined}
          highlight={s.isNew}
          badge={s.isNew && (
            <Box as="span" className="mono" radius={4} bg="var(--accent)" pad={[1, 5]} style={{
              fontSize: 8.5, fontWeight: 600, letterSpacing: ".04em",
              color: "var(--accent-text)",
            }}>NEW</Box>
          )}
        />
      ))}
    </Stack>
  );
}
