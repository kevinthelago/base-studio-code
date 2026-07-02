import { Card } from "@/shared/ui/data/Card";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { computeAllocation, type GhProject } from "@/features/planner/list/projectsSummaryDerive";

// ── Where the team is (project allocation) ────────────────────────────────────

export function ProjectAllocation({ projects }: { projects: GhProject[] }) {
  const items = computeAllocation(projects);

  if (items.length === 0) {
    return (
      <Card style={{ padding: "14px 16px" }}>
        <h3 style={{ margin: 0, marginBottom: 10 }}>Where the team is</h3>
        <Text as="div" mono size={11} tone="dim">No active projects with items.</Text>
      </Card>
    );
  }

  return (
    <Card style={{ padding: "14px 16px" }}>
      <Row gap={10} align="baseline" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Where the team is</h3>
        <Box as="span" className="hint">share of in-progress work by project items</Box>
      </Row>
      <Row align="stretch" style={{ height: 10, borderRadius: 5, overflow: "hidden", background: "var(--bg-elev2)", marginBottom: 12 }}>
        {items.map(it => (
          <Box key={it.n} title={`${it.n} · ${it.pct}%`} bg={it.c} style={{ width: `${it.pct}%`}} />
        ))}
      </Row>
      <Stack gap={5} className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
        {items.map(it => (
          <Grid key={it.n} cols="12px 1fr 40px" gap={8} align="center">
            <ColorSwatch color={it.c} />
            <Box as="span" style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.n}</Box>
            <Text tone="dim" style={{ textAlign: "right" }}>{it.pct}%</Text>
          </Grid>
        ))}
      </Stack>
    </Card>
  );
}
