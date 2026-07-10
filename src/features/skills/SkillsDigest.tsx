// SkillsDigest (#2813) — split into two pieces so it fits the unified Library layout:
//   • SkillsDigestBar   — the inline KPI stats + the "Fleet digest · 7d" expand toggle. Lives IN the
//     list header (over the list), so it hides first when the header is narrow (buttons stay).
//   • SkillsDigestPanel — the expandable panel (stat tiles + the "Most invoked" leaderboard) that drops
//     below the header when open.
// All numbers derive from the merged library + real telemetry (stats).
import { useMemo } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { Card } from "@/shared/ui/data/Card";
import { StatTile } from "@/shared/ui/data/StatTile";
import { SkeletonChart } from "@/shared/ui/feedback/Skeleton";
import { HBars } from "@/shared/ui/charts";
import { KIND, fmtCount } from "@/shared/data/skills";
import { deriveSkillKpis, type SkillDef } from "./lib/skills";
import { type SkillStats } from "./lib/skillTelemetry";
import { successColor } from "./skillStyles";

/** The inline KPI stats + the expand toggle — rendered in the Library list header (#2813). */
export function SkillsDigestBar({ merged, stats, kpis, digestOpen, onToggle }: {
  merged: SkillDef[];
  stats: Record<string, SkillStats>;
  kpis: ReturnType<typeof deriveSkillKpis>;
  digestOpen: boolean;
  onToggle: () => void;
}) {
  const invToday = useMemo(() => Object.values(stats).reduce((a, s) => a + s.today, 0), [stats]);
  return (
    <Row gap={16} align="center" style={{ fontSize: 11.5, color: "var(--fg-muted)", minWidth: 0, whiteSpace: "nowrap" }}>
      <Button variant="ghost" size="sm" onClick={onToggle} style={{ border: "none", padding: 0, height: "auto", color: "var(--fg-dim)", fontSize: 11, flex: "none" }}>
        <Text as="span" size={9} style={{ display: "inline-block", transform: digestOpen ? "rotate(90deg)" : "none" }}>▸</Text>
        <Text as="span" mono size={9.5} style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>Fleet digest · 7d</Text>
      </Button>
      <Box as="span"><b className="mono" style={{ color: "var(--fg)" }}>{kpis.total}</b> skills</Box>
      <Box as="span"><b className="mono" style={{ color: "var(--fg)" }}>{merged.filter((s) => s.enabled).length}</b> enabled</Box>
      <Text as="span" tone="accent">★ <b className="mono" style={{ color: "var(--fg)" }}>{kpis.pinned}</b></Text>
      <Box as="span"><b className="mono" style={{ color: "var(--fg)" }}>{invToday}</b> today</Box>
      <Box as="span"><b className="mono" style={{ color: "var(--success)" }}>{kpis.invWeek ? kpis.avgSuccess + "%" : "—"}</b> avg success</Box>
    </Row>
  );
}

/** The expandable "Fleet digest" panel — stat tiles + the "Most invoked" leaderboard (#2813). */
export function SkillsDigestPanel({ merged, kpis, statsLoaded }: {
  merged: SkillDef[];
  kpis: ReturnType<typeof deriveSkillKpis>;
  /** First telemetry poll has returned — false shows a loading skeleton in the leaderboard (#2245). */
  statsLoaded: boolean;
}) {
  const leaders = useMemo(
    () => [...merged].filter((s) => s.invocations > 0).sort((a, b) => b.invocations - a.invocations).slice(0, 5),
    [merged],
  );
  const neverRun = useMemo(() => merged.filter((s) => s.invocations === 0).length, [merged]);
  return (
    <Row gap={14} align="stretch" className="skills-digest" style={{ padding: "10px 16px 14px", borderBottom: "1px solid var(--border)" }}>
      {[
        { label: "Invoked 7d", value: fmtCount(kpis.invWeek), sub: leaders.length + " active skills" },
        { label: "Avg success", value: kpis.invWeek ? kpis.avgSuccess + "%" : "—", sub: "across active" },
        { label: "Never run", value: String(neverRun), sub: "candidates to prune" },
      ].map((t) => (
        <Box key={t.label} style={{ flex: "0 0 auto", width: 150 }}>
          <StatTile k={t.label} v={t.value} sub={t.sub} />
        </Box>
      ))}
      <Card className="skills-leaderboard" style={{ flex: 1 }}>
        <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 7 }}>Most invoked</Text>
        {!statsLoaded && leaders.length === 0 ? (
          // First poll pending — a chart-shaped placeholder, not a cold "no invocations" line.
          <SkeletonChart height={110} />
        ) : leaders.length === 0 ? (
          <Text as="div" size={11} tone="dim">No invocations yet — run the fleet to populate the leaderboard.</Text>
        ) : (
          <HBars
            rows={leaders.map((s, i) => ({
              label: `${i + 1}  ${s.name}`,
              value: s.invocations,
              color: KIND[s.kind].color,
              strong: true,
              tag: <Text as="span" mono size={10} style={{ color: successColor(s.success) }}>{s.success}%</Text>,
            }))}
            fmtV={(v) => fmtCount(v) + "×"}
          />
        )}
      </Card>
    </Row>
  );
}
