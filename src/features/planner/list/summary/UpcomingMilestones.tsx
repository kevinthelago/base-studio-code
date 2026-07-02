import { useMemo } from "react";
import { Card } from "@/shared/ui/data/Card";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { GhMilestone } from "@/shared/lib/github/types";
import { computeUpcomingMilestones } from "@/features/planner/list/projectsSummaryDerive";

// ── Upcoming milestones ───────────────────────────────────────────────────────

export function UpcomingMilestones({ repoMilestones, loading }: {
  repoMilestones: Record<string, GhMilestone[]>;
  loading: boolean;
}) {
  const upcoming = useMemo(() => computeUpcomingMilestones(repoMilestones), [repoMilestones]);

  const hasData = Object.keys(repoMilestones).length > 0;
  const numLines = upcoming.length;

  return (
    <Card
      style={{ padding: "14px 16px" }}
      title="Upcoming milestones"
      hint={loading ? "loading…" : hasData ? `across all project repos · 8-week view` : "no data"}
      right={upcoming.length > 0 ? (
        <Text mono size={10.5} tone="accent">
          {upcoming.length} due in next 8w
        </Text>
      ) : undefined}
      headMb={14}
    >
      {!hasData && !loading && (
        <Text as="div" mono size={11} tone="dim" style={{ padding: "4px 0" }}>No milestones due in the next 8 weeks.</Text>
      )}

      {(hasData || loading) && (
        <>
          <Grid cols="220px 1fr" gap={14} style={{ marginBottom: 8 }}>
            <Box />
            <Grid cols={8} style={{ position: "relative", height: 18 }}>
              {Array.from({ length: 8 }, (_, i) => (
                <Box key={i} className="mono" style={{
                  fontSize: 9.5, color: "var(--fg-dim)",
                  borderLeft: i === 0 ? "none" : "1px dashed var(--border-soft)",
                  paddingLeft: 6, paddingTop: 2,
                }}>w{i + 1}</Box>
              ))}
              <Box style={{
                position: "absolute", top: 0, bottom: -(numLines * 30 + 10),
                left: 0, width: 0,
                borderLeft: "1.5px dashed var(--accent)", zIndex: 2,
              }}>
                <Box as="span" className="mono" style={{ position: "absolute", top: -2, left: 4, fontSize: 9.5, color: "var(--accent)" }}>today</Box>
              </Box>
            </Grid>
          </Grid>
          <Stack gap={6}>
            {upcoming.map((m, idx) => {
              const barEnd = Math.max(0.01, Math.min(8, m.weeksFromNow));
              const barStart = Math.max(0, barEnd - 0.7);
              const c = m.overdue ? "var(--danger)" : "var(--accent)";
              const bgC = m.overdue ? "oklch(0.65 0.15 10)" : "oklch(0.78 0.14 70)";
              return (
                <Grid key={idx} cols="220px 1fr" gap={14} align="center">
                  <Box>
                    <Box className="mono" style={{ fontSize: 10.5, color: m.overdue ? "var(--danger)" : "var(--accent)" }}>{m.title}</Box>
                    <Text as="div" mono size={9.5} tone="dim">{m.repo}</Text>
                  </Box>
                  <Box style={{ position: "relative", height: 24 }}>
                    {Array.from({ length: 8 }, (_, i) => (
                      <Box key={i} bg="var(--border-soft)" style={{ position: "absolute", top: 0, bottom: 0, left: `${i / 8 * 100}%`, width: 1}} />
                    ))}
                    <Box bg={`color-mix(in oklch, ${bgC}, transparent 65%)`} radius={4} style={{
                      position: "absolute", top: 3, bottom: 3,
                      left: `${barStart / 8 * 100}%`, width: `${(barEnd - barStart) / 8 * 100}%`,
                      minWidth: 12,
                      border: `1px solid ${c}`,
                      overflow: "hidden",
                    }}>
                      {m.pct > 0 && (
                        <Box bg={`color-mix(in oklch, ${bgC}, transparent 30%)`} style={{ position: "absolute", inset: 0, width: `${m.pct * 100}%`}} />
                      )}
                    </Box>
                  </Box>
                </Grid>
              );
            })}
          </Stack>
        </>
      )}
    </Card>
  );
}
