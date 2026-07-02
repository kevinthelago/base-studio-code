import { useMemo } from "react";
import { Card } from "@/shared/ui/data/Card";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { GhIssueItem as GhIssue } from "@/shared/lib/github/types";
import { computeVelocity } from "@/features/planner/list/projectsSummaryDerive";

// ── Velocity ──────────────────────────────────────────────────────────────────

export function VelocityCard({ repoIssues, loading }: {
  repoIssues: Record<string, GhIssue[]>;
  loading: boolean;
}) {
  const { opened, closed, weekLabels, avgClosed } = useMemo(() => computeVelocity(repoIssues), [repoIssues]);

  const hasData = Object.keys(repoIssues).length > 0;
  const maxV = Math.max(...opened, ...closed, 1);

  return (
    <Card
      style={{ padding: "14px 16px" }}
      title="Velocity"
      hint={loading ? "loading…" : hasData ? "issues opened vs closed · last 8 weeks" : "no data"}
      headMb={10}
    >
      {!hasData && !loading && (
        <Text as="div" mono size={11} tone="dim" style={{ padding: "4px 0" }}>No issue data available.</Text>
      )}
      {(hasData || loading) && (
        <>
          <svg width="100%" height="100" viewBox="0 0 320 100">
            {[0, Math.round(maxV * 0.25), Math.round(maxV * 0.5), Math.round(maxV * 0.75), maxV].map(v => (
              <line key={v} x1={30} y1={90 - (v / maxV) * 80} x2={310} y2={90 - (v / maxV) * 80}
                stroke="var(--border-soft)" strokeDasharray="2 3" />
            ))}
            {weekLabels.map((w, i) => {
              const cx = 30 + (i / (weekLabels.length - 1)) * 280;
              const colW = 14;
              const oH = (opened[i] / maxV) * 80;
              const cH = (closed[i] / maxV) * 80;
              return (
                <g key={w}>
                  <rect x={cx - colW} y={90 - oH} width={colW - 1} height={oH}
                    fill="color-mix(in oklch, var(--info), transparent 50%)" />
                  <rect x={cx + 1} y={90 - cH} width={colW - 1} height={cH}
                    fill="var(--accent)" />
                  <text x={cx} y={99} textAnchor="middle" fontFamily="var(--mono)" fontSize="8" fill="var(--fg-dim)">{w}</text>
                </g>
              );
            })}
          </svg>
          <Row align="stretch" gap={14} className="mono" style={{ marginTop: 6, fontSize: 10, color: "var(--fg-muted)" }}>
            <Box as="span"><ColorSwatch color="color-mix(in oklch, var(--info), transparent 50%)" /> opened</Box>
            <Box as="span"><ColorSwatch color="var(--accent)" /> closed</Box>
            <Spacer />
            <Box as="span">avg <b style={{ color: "var(--fg)" }}>{loading ? "…" : `${avgClosed} closed/wk`}</b></Box>
          </Row>
        </>
      )}
    </Card>
  );
}
