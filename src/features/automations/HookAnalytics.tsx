import { useEffect, useMemo, useState } from "react";
import { bscJson } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";
import { parseHookLog, aggregateHookTelemetry, type HookAnalytics } from "@/features/mcp/lib/hookTelemetry";
import { StatCard, StackedDayBars, TelemetryPanel, ItemBars, SplitBar } from "@/shared/ui/charts";
import { Grid } from "@/shared/ui/layout/Grid";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

// Hook Analytics tab (#865 PR 2) — KPI cards + 3 charts over the hook-fire telemetry
// (~/.base-studio-code/hooks.log via `bsc logs tail hook` + hookTelemetry.ts). The over-time chart + KPI
// cards are shared primitives (StackedDayBars / StatCard); the per-hook/results charts stay local.
// `activeHooks`/`preCount` come from the live store (enabled hooks); the rest from the parsed log.
// Empty until the hook wrappers emit fires (PR 3) — renders a clean zero state.

const DAYS = 14;

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

  if (!an) return <Box className="hint" pad={16}>Loading hook telemetry…</Box>;

  const maxHookFires = Math.max(1, ...an.perHook.map(h => h.fires));

  return (
    <Box style={{ padding: "4px 0 12px" }}>
      {/* KPI cards */}
      <Grid cols={4} gap={8} style={{ marginBottom: 12 }}>
        <StatCard k="Total fires" v={an.total} sub={`last ${DAYS} days`} />
        <StatCard k="Blocks" v={an.blocks} sub="PreToolUse denied" tone="danger" />
        <StatCard k="Allow rate" v={`${an.allowRate}%`} sub={`${an.allows} allowed`} tone="success" />
        <StatCard k="Active hooks" v={activeHooks} sub={`${preCount} PreToolUse`} />
      </Grid>

      {/* Fires over time */}
      <StackedDayBars
        data={an.daily.map(d => ({ day: d.day, upper: d.allows, lower: d.blocks }))}
        title="Fires over time" subtitle="daily hook fires · allow vs block"
        upperLabel="allow" lowerLabel="block"
      />

      <Grid cols={2} gap={10}>
        {/* Fires per hook */}
        <TelemetryPanel title="Fires per hook" hint="by event · matcher">
          <ItemBars
            rows={an.perHook.map(h => ({ key: h.hook, label: h.hook, meta: h.event, value: h.fires, fraction: h.fires / maxHookFires }))}
            empty={<Box as="span" className="hint">No hook fires recorded yet.</Box>}
          />
        </TelemetryPanel>

        {/* Blocks vs allows */}
        <TelemetryPanel title="Blocks vs allows" hint="PreToolUse hooks only">
          <Stack gap={14}>
            {an.perPreHook.length === 0 && <Box as="span" className="hint">No PreToolUse decisions yet.</Box>}
            {an.perPreHook.map(p => (
              <SplitBar key={p.hook} label={p.hook} a={p.allows} b={p.blocks} aLabel="allow" bLabel="block" />
            ))}
          </Stack>
          <Box style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
            Parsed from <Text as="span" mono tone="muted">~/.base-studio-code/hooks.log</Text> via <Text as="span" mono tone="muted">hookTelemetry.ts</Text> — one line per fire (ts · event · hook · outcome).
          </Box>
        </TelemetryPanel>
      </Grid>
    </Box>
  );
}
