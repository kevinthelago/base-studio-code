// Fleet cost & energy card (#2237) — REAL per-worker + fleet-total tokens and priced USD (from
// `usePaneTokenUsage` → `bsc logs cost`), plus a clearly-labeled ESTIMATED energy readout. Replaces the
// old "not measured yet (#416)" SpendNote — the accounting exists now. Energy is directional, not metered.
import { CardHead, fmt } from "@/shared/ui/charts";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { usePaneTokenUsage } from "@/app/console/lib/usePaneTokenUsage";
import { aggregateFleetCost, CO2_KG_PER_KWH } from "./lib/fleetCost";
import type { LiveWorker } from "@/shared/lib/fleet/fleetLive";

/** Format Wh compactly: 940 → "0.94 kWh", 12 → "12 Wh". */
function fmtEnergy(wh: number): string {
  return wh >= 1000 ? `${(wh / 1000).toFixed(2)} kWh` : `${wh < 10 ? wh.toFixed(1) : Math.round(wh)} Wh`;
}

function Total({ k, v, sub, tone }: { k: string; v: string; sub?: string; tone?: string }) {
  return (
    <Box style={{ flex: 1, minWidth: 0 }}>
      <Text as="div" mono size={9.5} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".05em" }}>{k}</Text>
      <Text as="div" mono size={17} weight={600} style={{ color: tone ?? "var(--fg)", marginTop: 2 }}>{v}</Text>
      {sub && <Text as="div" mono size={9} tone="dim" style={{ marginTop: 1 }}>{sub}</Text>}
    </Box>
  );
}

export function CostEnergy({ workers }: { workers: LiveWorker[] }) {
  const usage = usePaneTokenUsage(128);
  const cost = aggregateFleetCost(workers, usage);
  const co2 = (cost.totalEnergyWh / 1000) * CO2_KG_PER_KWH; // kg

  return (
    <Card>
      <CardHead title="Cost & energy" hint="session tokens · priced · est. energy"
        right={cost.hasData ? <Text as="span" mono size={10.5} tone="accent">${cost.totalCostUsd.toFixed(2)}</Text> : undefined} />
      {!cost.hasData ? (
        <EmptyState size="sm" iconVariant="dashed" icon="⌁" title="No token usage yet"
          description="Cost and energy appear after a worker's first turn completes and its usage is recorded." style={{ padding: "20px 12px" }} />
      ) : (
        <Stack gap={12}>
          <Row gap={12} align="start">
            <Total k="tokens" v={fmt(cost.totalTokens)} sub={`${fmt(cost.totalInput)} in · ${fmt(cost.totalOutput)} out`} />
            <Total k="cost" v={`$${cost.totalCostUsd.toFixed(2)}`} sub="priced · actual model" tone="var(--accent)" />
            <Total k="energy · est." v={`~${fmtEnergy(cost.totalEnergyWh)}`} sub={`~${co2.toFixed(3)} kg CO₂`} tone="var(--success)" />
          </Row>

          {/* by model */}
          <Stack gap={4}>
            <Text as="div" mono size={9} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>by model</Text>
            {cost.byModel.map((m) => (
              <Grid key={m.model} cols="1fr 64px 58px 64px" gap={8} align="center" className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
                <Text as="span" style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.model}</Text>
                <Text as="span" style={{ textAlign: "right" }}>{fmt(m.tokens)}</Text>
                <Text as="span" style={{ textAlign: "right", color: "var(--accent)" }}>${m.costUsd.toFixed(2)}</Text>
                <Text as="span" style={{ textAlign: "right", color: "var(--success)" }}>~{fmtEnergy(m.energyWh)}</Text>
              </Grid>
            ))}
          </Stack>

          <Text as="div" mono size={9} tone="dim" style={{ lineHeight: 1.5 }}>
            Cost is priced from each session's actual model. Energy is a rough estimate (tokens × a per-model
            coefficient), not a measurement.
          </Text>
        </Stack>
      )}
    </Card>
  );
}
