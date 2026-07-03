// CI health card — pass/fail matrix over the last 7 days per repo (#1644).

import { Text } from "@/shared/ui/typography/Text";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Card } from "@/shared/ui/data/Card";
import type { CiRow } from "../lib/githubSummary";
import { CardEmpty, SkeletonRows } from "./cardStates";

export function CIHealthCard({ matrix, loading }: {
  matrix: CiRow[];
  loading: boolean;
}) {
  if (loading && matrix.length === 0) {
    return (
      <Card style={{ padding: "14px 16px" }} title="CI health" hint="last 7 days · all branches" headMb={10}>
        <SkeletonRows rows={4} h={14} />
      </Card>
    );
  }
  if (matrix.length === 0) {
    return (
      <Card style={{ padding: "14px 16px" }} title="CI health" hint="last 7 days · all branches" headMb={10}>
        <CardEmpty icon="◉" title="No CI runs found" hint="Workflow runs across your repos surface here." />
      </Card>
    );
  }
  return (
    <Card style={{ padding: "14px 16px" }} title="CI health" hint="last 7 days · all branches" headMb={10}>
      <Stack gap={6}>
        {matrix.map(({ name, days }) => (
          <Grid key={name} cols="80px 1fr 28px" gap={8} align="center">
            <Text mono size={10.5} tone="muted" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</Text>
            <Row gap={4} align="stretch">
              {days.map((d, i) => (
                <Box key={i} bg={d === null ? "var(--bg-elev2)" : d ? "var(--success)" : "var(--danger)"} radius={3} style={{
                  flex: 1, height: 14,
                  opacity: d === null ? 0.4 : 0.85,
                }} />
              ))}
            </Row>
            <Text mono size={10.5} tone="dim" style={{ textAlign: "right" }}>
              {days.filter(d => d === true).length}/{days.filter(d => d !== null).length}
            </Text>
          </Grid>
        ))}
      </Stack>
    </Card>
  );
}
