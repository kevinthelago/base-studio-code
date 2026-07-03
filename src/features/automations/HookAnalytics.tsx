import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { bscJson } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";
import { parseHookLog, aggregateHookTelemetry, type HookAnalytics } from "@/features/mcp/lib/hookTelemetry";
import { StatCard, StackedDayBars, TelemetryPanel, ItemBars, SplitBar } from "@/shared/ui/charts";
import { Grid } from "@/shared/ui/layout/Grid";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Skeleton, SkeletonChart } from "@/shared/ui/feedback/Skeleton";

// Hook Analytics tab (#865 PR 2) — KPI cards + 3 charts over the hook-fire telemetry
// (~/.base-studio-code/hooks.log via `bsc logs tail hook` + hookTelemetry.ts). The over-time chart + KPI
// cards are shared primitives (StackedDayBars / StatCard); the per-hook/results charts stay local.
// `activeHooks`/`preCount` come from the live store (enabled hooks); the rest from the parsed log.
// Per-card loading + empty states (#2247): the card LAYOUT always renders — each body is a loading
// skeleton while the async log loads, a compact empty state when there's no telemetry, else the content.

const DAYS = 14;

/** A compact empty state for a card body (#2247) — the panel frame + head stay; the body shows this. */
function CardEmpty({ icon = "○", title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return <EmptyState size="sm" iconVariant="dashed" icon={icon} title={title} description={hint} style={{ padding: "20px 12px" }} />;
}

/** A stack of shimmer rows — a loading placeholder for a telemetry-panel body (#2247). */
function SkeletonRows({ rows = 3, h = 34 }: { rows?: number; h?: number }) {
  return <Stack gap={10}>{Array.from({ length: rows }).map((_, i) => <Skeleton key={i} h={h} radius={6} />)}</Stack>;
}

export function HookAnalyticsTab() {
  // Select the raw array (stable ref) and derive in a memo — a selector returning
  // `.filter()` makes a new array every call, which loops forever in zustand v5.
  const hooks = useAppStore(s => s.hooks);
  const enabledHooks = useMemo(() => hooks.filter(e => e.enabled), [hooks]);
  const activeHooks = enabledHooks.length;
  const preCount = enabledHooks.filter(h => h.event === "PreToolUse").length;

  const [an, setAn] = useState<HookAnalytics | null>(null);
  useEffect(() => {
    let cancelled = false;
    bscJson<string[]>(null, ["logs", "tail", "hook", "--limit", "8000", "--json"], [])
      .then(lines => { if (!cancelled) setAn(aggregateHookTelemetry(parseHookLog((lines ?? []).join("\n")), new Date(), DAYS)); });
    return () => { cancelled = true; };
  }, []);

  // The card layout ALWAYS renders (#2247): the an-derived tiles/charts shimmer while the log loads
  // (`an === null`) and show a compact empty when the parsed telemetry has no fires.
  const loading = an === null;
  const maxHookFires = Math.max(1, ...(an?.perHook.map(h => h.fires) ?? []));

  return (
    <Box style={{ padding: "4px 0 12px" }}>
      {/* KPI cards — the log-derived tiles shimmer until the telemetry loads (#2247) */}
      <Grid cols={4} gap={8} style={{ marginBottom: 12 }}>
        <StatCard k="Total fires" v={an?.total ?? 0} sub={`last ${DAYS} days`} loading={loading} />
        <StatCard k="Blocks" v={an?.blocks ?? 0} sub="PreToolUse denied" tone="danger" loading={loading} />
        <StatCard k="Allow rate" v={`${an?.allowRate ?? 0}%`} sub={`${an?.allows ?? 0} allowed`} tone="success" loading={loading} />
        <StatCard k="Active hooks" v={activeHooks} sub={`${preCount} PreToolUse`} />
      </Grid>

      {/* Fires over time — SkeletonChart while loading, compact empty until any fire is recorded */}
      {loading
        ? <SkeletonChart height={160} />
        : an.total === 0
        ? <CardEmpty icon="▤" title="No fires yet" hint="Daily hook fires (allow vs block) chart here once your hooks fire." />
        : <StackedDayBars
            data={an.daily.map(d => ({ day: d.day, upper: d.allows, lower: d.blocks }))}
            title="Fires over time" subtitle="daily hook fires · allow vs block"
            upperLabel="allow" lowerLabel="block"
          />}

      <Grid cols={2} gap={10}>
        {/* Fires per hook */}
        <TelemetryPanel title="Fires per hook" hint="by event · matcher">
          {loading
            ? <SkeletonRows />
            : <ItemBars
                rows={an.perHook.map(h => ({ key: h.hook, label: h.hook, meta: h.event, value: h.fires, fraction: h.fires / maxHookFires }))}
                empty={<CardEmpty title="No hook fires yet" hint="Per-hook fire counts appear here once your hooks run." />}
              />}
        </TelemetryPanel>

        {/* Blocks vs allows */}
        <TelemetryPanel title="Blocks vs allows" hint="PreToolUse hooks only">
          {loading
            ? <SkeletonRows />
            : an.perPreHook.length === 0
            ? <CardEmpty title="No PreToolUse decisions yet" hint="Allow vs block splits for PreToolUse hooks appear here." />
            : <Stack gap={14}>
                {an.perPreHook.map(p => (
                  <SplitBar key={p.hook} label={p.hook} a={p.allows} b={p.blocks} aLabel="allow" bLabel="block" />
                ))}
              </Stack>}
          <Box style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
            Parsed from <Text as="span" mono tone="muted">~/.base-studio-code/hooks.log</Text> via <Text as="span" mono tone="muted">hookTelemetry.ts</Text> — one line per fire (ts · event · hook · outcome).
          </Box>
        </TelemetryPanel>
      </Grid>
    </Box>
  );
}
