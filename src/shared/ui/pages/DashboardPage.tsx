// DashboardPage — the Pages-tier metrics-board composition (#2505): a complete analytics dashboard
// built strictly from kit components. Under the titled header bar: a Grid of StatCard KPI tiles
// (each with an optional inline Spark trend), a chart column — a LineArea trend Card and a
// Donut + Legend breakdown Card — and an ActivityFeed column. Everything renders from the typed
// `stats` / `trend` / `breakdown` / `activity` inputs — pure/presentational, data in via props only.
//
// Data-shape note (#2475): a dashboard is deliberately NOT shape-stamped — it renders a
// heterogeneous BOARD of metrics, series, slices, and events; no single canonical data shape is
// "the page's shape", so stamping one would fake an ideal (see the kit guidance).
import type { ReactNode } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Grid } from "@/shared/ui/layout/Grid";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Card } from "@/shared/ui/data/Card";
import { StatCard, type StatTone } from "@/shared/ui/charts/primitives";
import { LineArea, Donut, Legend, Spark, type LineSeries, type DonutSlice } from "@/shared/ui/charts/Charts";
import { ActivityFeed, type ActivityItem } from "@/shared/ui/data/ActivityFeed";
import { PageHeader } from "./pageHeader";

/** One KPI tile — StatCard's inputs plus an optional inline trend sparkline. */
export interface DashboardStat {
  k: string;
  v: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  /** A tiny inline trend rendered as a Spark in the tile's sub-line (needs ≥2 points). */
  trend?: number[];
  /** Spark color. Default var(--accent). */
  trendColor?: string;
}

/** The trend card's data — a multi-series line/area chart. */
export interface DashboardTrend {
  title: string;
  hint?: string;
  labels: string[];
  series: LineSeries[];
}

/** The breakdown card's data — a donut + legend. */
export interface DashboardBreakdown {
  title: string;
  hint?: string;
  slices: DonutSlice[];
}

/** The activity column's data — the ActivityFeed inputs. */
export interface DashboardActivity {
  hint: string;
  items: ActivityItem[];
  /** action → color map (each caller keeps its own EVENT_TONE). */
  tone: Record<string, string>;
}

export interface DashboardPageProps {
  /** Page title (the header bar). */
  title: ReactNode;
  /** Dimmed hint after the title. */
  hint?: ReactNode;
  /** Right-aligned header controls (range toggle, filters). */
  toolbar?: ReactNode;
  /** The KPI tiles, in display order. */
  stats: DashboardStat[];
  /** The trend chart card. Omit to drop the card. */
  trend?: DashboardTrend;
  /** The breakdown donut card. Omit to drop the card. */
  breakdown?: DashboardBreakdown;
  /** The activity feed column. Omit to drop the column. */
  activity?: DashboardActivity;
  /** Extra class on the root (a page scoping hook). */
  className?: string;
}

export function DashboardPage({
  title, hint, toolbar,
  stats, trend, breakdown, activity, className,
}: DashboardPageProps) {
  const charts = (
    <Stack gap={16} style={{ minWidth: 0 }}>
      {trend && (
        <Card title={trend.title} hint={trend.hint}>
          <LineArea series={trend.series} labels={trend.labels} height={150} />
        </Card>
      )}
      {breakdown && (
        <Card title={breakdown.title} hint={breakdown.hint}>
          <Row gap={20} align="center" wrap>
            <Donut slices={breakdown.slices} />
            <Legend items={breakdown.slices.map((s) => ({ color: s.color, label: s.name, value: s.value }))} />
          </Row>
        </Card>
      )}
    </Stack>
  );

  return (
    <Stack gap={0} className={className} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      <PageHeader title={title} hint={hint} toolbar={toolbar} />
      <Box pad={16} style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Stack gap={16}>
          {stats.length > 0 && (
            <Grid cols="repeat(auto-fit, minmax(150px, 1fr))" gap={12}>
              {stats.map((s) => (
                <StatCard key={s.k} k={s.k} v={s.v} tone={s.tone}
                  sub={
                    s.trend && s.trend.length >= 2
                      ? <Row gap={8} align="center" inline>{s.sub}<Spark data={s.trend} color={s.trendColor ?? "var(--accent)"} /></Row>
                      : s.sub
                  } />
              ))}
            </Grid>
          )}
          {(trend || breakdown || activity) && (
            activity ? (
              <Grid cols="minmax(0, 2fr) minmax(0, 1fr)" gap={16} align="start">
                {charts}
                <ActivityFeed items={activity.items} hint={activity.hint} tone={activity.tone} loading={false} />
              </Grid>
            ) : charts
          )}
        </Stack>
      </Box>
    </Stack>
  );
}
