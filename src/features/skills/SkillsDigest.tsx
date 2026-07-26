// SkillsDigest (#2813) — split into two pieces so it fits the unified Library layout:
//   • SkillsDigestToggle — the "Fleet digest · 7d" expand toggle, in the list header. It used to carry
//     inline KPI stats too (total/enabled/pinned/today/avg-success); #3854 dropped those — the header's
//     leading slot is the SEARCH field now, and always-on numbers did not earn it. The toggle stays so
//     the panel below is still reachable.
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
import { successColor } from "./skillStyles";

/** The "Fleet digest" expand toggle — rendered in the Library list header (#2813/#3854). Stats-free: it
 *  exists so {@link SkillsDigestPanel} stays reachable now that the header leads with search. */
export function SkillsDigestToggle({ digestOpen, onToggle }: {
  digestOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost" size="sm" onClick={onToggle}
      title={digestOpen ? "Hide the fleet digest" : "Show the fleet digest — stat tiles + the most-invoked leaderboard"}
      style={{ border: "none", padding: 0, height: "auto", color: "var(--fg-dim)", fontSize: 11, flex: "none" }}
    >
      <Text as="span" size={9} style={{ display: "inline-block", transform: digestOpen ? "rotate(90deg)" : "none" }}>▸</Text>
      <Text as="span" mono size={9.5} style={{ textTransform: "uppercase", letterSpacing: ".08em" }}>Fleet digest · 7d</Text>
    </Button>
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
