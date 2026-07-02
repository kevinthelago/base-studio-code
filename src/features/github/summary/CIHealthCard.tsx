// CI health card — pass/fail matrix over the last 7 days per repo (#1644).

import { Text } from "@/shared/ui/typography/Text";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Card } from "@/shared/ui/data/Card";
import type { CiRow } from "../lib/githubSummary";

export function CIHealthCard({ matrix, loading }: {
  matrix: CiRow[];
  loading: boolean;
}) {
  return (
    <Card style={{ padding: "14px 16px" }}>
      <Row align="baseline" gap={10} style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>CI health</h3>
        <Box as="span" className="hint">last 7 days · all branches</Box>
      </Row>
      {matrix.length === 0 && !loading && (
        <Text mono size="sm" tone="dim" as="div" style={{ padding: "4px 0" }}>No CI runs found.</Text>
      )}
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
