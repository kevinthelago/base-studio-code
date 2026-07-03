// Fleet lessons card (#2242) — the self-correction lessons the fleet captured mid-session (#1362),
// surfaced next to what the fleet DID. Reads the active project's plan.db review queue via the existing
// `loadPendingLessons` bridge (`bsc plan lesson list`). Uses the slice-1 empty + loading states.
import { useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import { loadPendingLessons, lessonTitle, type Lesson } from "@/features/skills/lib/lessons";
import { CardHead } from "@/shared/ui/charts";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";

export function FleetLessons() {
  const activeProjectName = useAppStore((s) => s.activeProjectName);
  const projectKey = activeProjectName ? sanitizeProjectKey(activeProjectName) : "";

  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loaded, setLoaded] = useState(false);
  usePoll(async (isCancelled) => {
    if (!projectKey) { if (!isCancelled()) { setLessons([]); setLoaded(true); } return; }
    const ls = await loadPendingLessons(projectKey);
    if (!isCancelled()) { setLessons(ls); setLoaded(true); }
  }, 8000, [projectKey]);

  return (
    <Card>
      <CardHead title="Lessons learned" hint="captured mid-session · review in Skills"
        right={lessons.length > 0 ? <Text as="span" mono size={10.5} tone="accent">{lessons.length}</Text> : undefined} />
      {!loaded && lessons.length === 0
        ? <Stack gap={6}>{[0, 1].map((i) => <Skeleton key={i} h={44} radius={6} />)}</Stack>
        : lessons.length === 0
        ? <EmptyState size="sm" iconVariant="dashed" icon="✎" title="No lessons yet"
            description="Agents capture self-corrections here as they work — review and confirm them in Skills → Lessons." style={{ padding: "20px 12px" }} />
        : (
          <Stack gap={7}>
            {lessons.slice(0, 6).map((l) => (
              <Box key={l.id} style={{ borderLeft: "2px solid var(--accent)", paddingLeft: 9 }}>
                <Row gap={7} align="baseline">
                  <Text as="div" size={11.5} weight={600} style={{ flex: 1, minWidth: 0 }}>{lessonTitle(l)}</Text>
                  {l.seen > 1 && <Chip title="times this recurred">×{l.seen}</Chip>}
                </Row>
                {l.mistake && <Text as="div" mono size={9.5} tone="dim" style={{ marginTop: 1, lineHeight: 1.4 }}>{l.mistake}</Text>}
                {l.provenance && <Text as="div" mono size={9} tone="dim" style={{ marginTop: 1, opacity: 0.75 }}>{l.provenance}</Text>}
              </Box>
            ))}
            {lessons.length > 6 && <Text as="div" mono size={9.5} tone="dim">+{lessons.length - 6} more in Skills → Lessons</Text>}
          </Stack>
        )}
    </Card>
  );
}
