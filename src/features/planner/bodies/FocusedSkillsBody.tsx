// Skills stage body (#1056, split from FocusedBodies.tsx #1757).
import type { PaneSkill } from "@/features/planner/pane/projectPaneData";
import { ListItemCard } from "./bodyPrimitives";
import { Stack } from "@/shared/ui/layout/Stack";

export function SkillsBody({ skills }: { skills?: PaneSkill[] }) {
  const list = skills ?? [];
  if (list.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◈</span>
        <span>No skills attached</span>
      </div>
    );
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
            <span className="mono" style={{
              fontSize: 8.5, fontWeight: 600, letterSpacing: ".04em",
              color: "var(--accent-text)", background: "var(--accent)", borderRadius: 4, padding: "1px 5px",
            }}>NEW</span>
          )}
        />
      ))}
    </Stack>
  );
}
