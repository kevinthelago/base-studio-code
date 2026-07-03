// Activity heatmap card — 28-week × 7-day contribution calendar (#1644).

import { useState } from "react";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { SkeletonChart } from "@/shared/ui/feedback/Skeleton";
import { heatFill } from "../heatFill";
import { formatHeatDate } from "../lib/githubSummary";

export function ActivityHeatmap({
  cells, rawCounts, rawDates, totalContribs, totalMerged, loading,
}: {
  cells: number[];
  rawCounts: number[];
  rawDates: string[];
  totalContribs: number;
  totalMerged: number;
  loading: boolean;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const cols = 28, rows = 7;
  const cell = 12, gap = 3;
  const W = cols * cell + (cols - 1) * gap;
  const H = rows * cell + (rows - 1) * gap;
  const svgW = W + 30, svgH = H + 8;

  const tooltip = hoveredIdx !== null ? (() => {
    const c = Math.floor(hoveredIdx / rows);
    const r = hoveredIdx % rows;
    const count = rawCounts[hoveredIdx] ?? 0;
    const date = rawDates[hoveredIdx] ?? "";
    const label = date
      ? (count === 0 ? `No activity · ${formatHeatDate(date)}` : `${count} contribution${count !== 1 ? "s" : ""} · ${formatHeatDate(date)}`)
      : null;
    if (!label) return null;
    const tipW = 152, tipH = 16;
    const cellCx = 30 + c * (cell + gap) + cell / 2;
    const cellTop = r * (cell + gap) + 4;
    const tipX = Math.max(0, Math.min(svgW - tipW, cellCx - tipW / 2));
    const above = r >= 2;
    const tipY = above ? cellTop - tipH - 4 : cellTop + cell + 4;
    return { label, tipX, tipY, tipW, tipH };
  })() : null;

  return (
    <Card
      style={{ padding: "14px 16px" }}
      title="Activity · last 28 weeks"
      hint="all contributions · GitHub calendar"
      right={
        <Box as="span" className="mono" style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10, color: "var(--fg-dim)" }}>
          less
          {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
            <Box as="span" key={i} bg={heatFill(v)} radius={2} style={{ width: 10, height: 10, display: "inline-block"}} />
          ))}
          more
        </Box>
      }
      headMb={10}
    >
      {loading ? <SkeletonChart height={H} /> : (
      <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ display: "block", width: "100%", overflow: "visible" }}>
        {["Mon", "", "Wed", "", "Fri", "", ""].map((d, i) => (
          <text key={i} x={0} y={4 + i * (cell + gap) + cell / 2}
            dominantBaseline="middle"
            fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{d}</text>
        ))}
        {cells.map((v, i) => {
          const c = Math.floor(i / rows), r = i % rows;
          return (
            <rect key={i}
              x={30 + c * (cell + gap)} y={r * (cell + gap) + 4}
              width={cell} height={cell} rx={2}
              fill={heatFill(v)}
              style={{ cursor: "default" }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            />
          );
        })}
        {tooltip && (
          <g pointerEvents="none">
            <rect x={tooltip.tipX} y={tooltip.tipY} width={tooltip.tipW} height={tooltip.tipH} rx={3}
              fill="var(--bg-panel)" stroke="var(--border-soft)" strokeWidth="0.8" />
            <text x={tooltip.tipX + tooltip.tipW / 2} y={tooltip.tipY + tooltip.tipH / 2}
              dominantBaseline="middle" textAnchor="middle"
              fontFamily="var(--mono)" fontSize="8.5" fill="var(--fg)">
              {tooltip.label}
            </text>
          </g>
        )}
      </svg>
      )}
      <Row className="mono" justify="between" align="stretch" style={{ marginTop: 6, fontSize: 9.5, color: "var(--fg-dim)", paddingLeft: 30 }}>
        <Text>28 weeks ago</Text><Text>today</Text>
      </Row>
      <Row className="mono" gap={24} align="stretch" style={{ marginTop: 12, fontSize: 10.5, color: "var(--fg-muted)" }}>
        <Text><b style={{ color: "var(--fg)" }}>{loading ? "…" : totalContribs}</b> contributions</Text>
        <Text><b style={{ color: "var(--fg)" }}>{loading ? "…" : totalMerged}</b> PRs merged</Text>
      </Row>
    </Card>
  );
}
