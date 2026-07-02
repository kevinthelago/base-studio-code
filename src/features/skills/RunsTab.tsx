// RunsTab — the Skills "Runs" page: live skill invocations from the usage log (last 7 days),
// ranked by invocations with success rate + a 7-day sparkline. Clicking a row opens the skill
// in the library drawer (via onOpen).
import { useMemo } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Spark } from "@/shared/ui/charts";
import { KIND, fmtCount } from "@/shared/data/skills";
import { skillSlug, type SkillDef } from "./lib/skills";
import { type SkillStats } from "./lib/skillTelemetry";
import { successColor } from "./skillStyles";

export function RunsTab({ merged, stats, onOpen }: {
  merged: SkillDef[];
  stats: Record<string, SkillStats>;
  onOpen: (id: string) => void;
}) {
  const runRows = useMemo(() => [...merged].filter((s) => s.invocations > 0).sort((a, b) => b.invocations - a.invocations), [merged]);

  return (
    <Box as="section" className="an-page"><Box className="an-wrap">
      <h2 className="mono" style={{ margin: "0 0 4px", fontSize: 18 }}>Runs</h2>
      <Text as="div" tone="muted" size={12} style={{ marginBottom: 14 }}>Live skill invocations from the usage log · last 7 days</Text>
      {runRows.length === 0 ? (
        <EmptyState title="No runs yet" description="Run the fleet — each time an agent invokes a skill it's logged here with its success rate and 7-day trend." />
      ) : (
        <Box border="soft" radius={6} style={{ overflow: "hidden" }}>
          <Grid className="mono" cols="1.6fr 86px 60px 64px 90px" gap={10} style={{ padding: "8px 12px", background: "var(--bg-panel)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase" }}>
            <Box as="span">skill</Box><Box as="span" style={{ textAlign: "right" }}>invocations</Box><Box as="span" style={{ textAlign: "right" }}>today</Box><Box as="span" style={{ textAlign: "right" }}>success</Box><Box as="span" style={{ textAlign: "right" }}>7-day</Box>
          </Grid>
          {runRows.map((s, i) => { const sc = successColor(s.success); const today = stats[skillSlug(s.name)]?.today ?? 0; return (
            <Grid key={s.id} cols="1.6fr 86px 60px 64px 90px" gap={10} align="center" style={{ padding: "9px 12px", background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)", cursor: "pointer" }} onClick={() => onOpen(s.id)}>
              <Row inline gap={8} style={{ minWidth: 0 }}><Text as="span" style={{ color: KIND[s.kind].color }}>{KIND[s.kind].glyph}</Text><Text as="span" mono size={11} style={{ color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</Text></Row>
              <Text as="span" mono size={11} tone="muted" style={{ textAlign: "right" }}>{fmtCount(s.invocations)}</Text>
              <Text as="span" mono size={11} tone="muted" style={{ textAlign: "right" }}>{today}</Text>
              <Text as="span" mono size={11} style={{ textAlign: "right", color: sc }}>{s.success}%</Text>
              <Row justify="end">{s.trend.length > 1 ? <Spark data={s.trend} color={KIND[s.kind].color} /> : <Box as="span" className="hint">—</Box>}</Row>
            </Grid>
          ); })}
        </Box>
      )}
    </Box></Box>
  );
}
