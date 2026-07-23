// Fleet health & errors card (#2240) — a recent-errors feed unifying real signals that weren't shown:
// permission denials (`bsc logs perm`), coordination stalls/deadlocks, warden quarantine trips, and
// auto-end needs-attention/blocked verdicts. Uses the slice-1 empty ("all clear") + loading skeleton.
import { useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { bscJson } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";
import { useCoordLog } from "@/shared/lib/fleet/useCoordLog";
import { coordinationSummary } from "@/shared/lib/fleet/coordinationWakes";
import { CardHead } from "@/shared/ui/charts";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { CardEmpty, SkeletonRows } from "@/shared/ui/feedback/CardStates";
import { buildFleetHealth, HEALTH_LABEL, type PermEvent } from "@/features/planner/fleet/lib/fleetHealth";
// Aliased: the lib's result type and the host component below share the name `FleetHealth`.
import type { FleetHealth as FleetHealthData } from "@/features/planner/fleet/lib/fleetHealth";
import type { LiveWorker } from "@/shared/lib/fleet/fleetLive";

/** The health & errors card as PURE presentation — the built feed in, markup out (#3481).
 *
 *  Split from the host below so the card renders from any `FleetHealth`, is testable without mocking
 *  three separate signal sources (a store read, the coord poll, and `bsc logs perm`), and has a real
 *  prop contract to catalogue. `dangerCount` is derived here rather than passed: it is a pure function
 *  of `health.counts`, so making it a prop would let a caller contradict the data it is rendering. */
export function FleetHealthView({ health, permLoaded }: { health: FleetHealthData; permLoaded: boolean }) {
  const dangerCount = health.counts.deadlock + health.counts.stalled + health.counts.quarantine + health.counts.blocked;

  return (
    <Card>
      <CardHead title="Health & errors" hint="denials · stalls · quarantine · ended"
        right={health.total > 0
          ? <Text as="span" mono size={10.5} style={{ color: dangerCount > 0 ? "var(--danger)" : "var(--warn, #f2b155)" }}>{health.total}</Text>
          : undefined} />
      {!permLoaded && !health.hasIssues
        ? <SkeletonRows rows={3} h={30} />
        : !health.hasIssues
        ? <CardEmpty icon="✓" title="All clear"
            hint="Permission denials, stalls, quarantines, and blocked workers show up here." />
        : (
          <Stack gap={5}>
            {health.items.slice(0, 12).map((it, i) => (
              <Row key={`${it.kind}${it.label}${i}`} gap={9} align="center" style={{ padding: "6px 8px", borderRadius: 6, background: i % 2 ? "var(--bg-panel)" : "transparent" }}>
                <Chip tone={it.danger ? "danger" : undefined} style={it.danger ? undefined : { color: "var(--warn, #f2b155)", borderColor: "color-mix(in oklch, #f2b155, transparent 65%)" }}>{HEALTH_LABEL[it.kind]}</Chip>
                <Text as="span" mono size={11} weight={500} style={{ flex: "0 0 auto", maxWidth: 130, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</Text>
                <Text as="span" mono size={10} tone="dim" style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.detail}</Text>
              </Row>
            ))}
            {health.total > 12 && <Text as="div" mono size={9.5} tone="dim" style={{ padding: "2px 8px" }}>+{health.total - 12} more</Text>}
          </Stack>
        )}
    </Card>
  );
}

/** The HOST: gathers the three signal sources — two store reads, the coordination log, and the
 *  `bsc logs perm` poll — merges them via `buildFleetHealth`, and renders the pure view above. */
export function FleetHealth({ workers }: { workers: LiveWorker[] }) {
  const quarantined = useAppStore((s) => s.quarantinedPanes);
  const ended = useAppStore((s) => s.endedPanes);
  const { state } = useCoordLog({ limit: 1000, ms: 4000 });

  const [perm, setPerm] = useState<PermEvent[]>([]);
  const [permLoaded, setPermLoaded] = useState(false);
  usePoll(async (isCancelled) => {
    const rows = await bscJson<PermEvent[]>(null, ["logs", "perm", "--json"], []);
    if (isCancelled()) return;
    setPerm(rows ?? []);
    setPermLoaded(true);
  }, 5000);

  const nameByPane = new Map(workers.map((w) => [w.id, w.name]));
  const blocked = coordinationSummary(state).map((b) => ({ session: b.session, stalled: b.stalled, deadlocked: b.deadlocked, deps: b.deps }));
  const health = buildFleetHealth({ perm, quarantined, ended, blocked, nameByPane });

  return <FleetHealthView health={health} permLoaded={permLoaded} />;
}
