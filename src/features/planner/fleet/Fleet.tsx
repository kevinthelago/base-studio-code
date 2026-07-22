// Projects → Fleet (#401). A live orchestration dashboard for a project's agent
// fleet. The roster + run/idle + coordination status come from the running app
// state (#412); throughput / merge queue / time-to-land come from GitHub across
// the fleet's repos (#415). No fabrication — tokens/spend still need per-session
// accounting (#416) and show an explicit note.
import { useMemo, useState } from "react";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Donut, Bars, LineArea, RangeToggle, Legend, CardHead, Avatar, useTip } from "@/shared/ui/charts";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { SkeletonChart } from "@/shared/ui/feedback/Skeleton";
import { CardEmpty, SkeletonRows } from "@/shared/ui/feedback/CardStates";
import { KitRenderer } from "@/shared/ui/spec";
import { resolveFleetSpec, FLEET_PAGE_ID } from "./fleetPageSpec";
import { useAppStore } from "@/store";
import { STATUS } from "@/shared/data/fleet";
import { useFleetLive } from "@/shared/hooks/useFleetLive";
import { useFleetGithub, type FleetGithub } from "./useFleetGithub";
import { WorkerDetail } from "./WorkerDetail";
import { CostEnergy } from "./CostEnergy";
import { FleetHealth } from "./FleetHealth";
import { FleetLessons } from "./FleetLessons";
import type { LiveWorker } from "@/shared/lib/fleet/fleetLive";
import type { ThroughputSlice } from "@/shared/lib/github/fleetGithub";

const GRID = "150px 96px 1fr 70px 22px";

function WorkerBoard({ workers, onOpen }: { workers: LiveWorker[]; onOpen: (w: LiveWorker) => void }) {
  return (
    <Card>
      <CardHead title="Worker board" hint="one agent per stream · click a worker to open it"
        right={<Text as="span" mono size={10.5} tone="accent">{workers.length} live</Text>} />
      <Box border="soft" radius={6} style={{ overflow: "hidden" }}>
        <Grid cols={GRID} gap={10} className="mono" style={{
          padding: "7px 12px",
          background: "var(--bg-elev2)", borderBottom: "1px solid var(--border-soft)",
          fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em",
        }}>
          <Box as="span">worker</Box><Box as="span">status</Box><Box as="span">current</Box><Box as="span" style={{ textAlign: "right" }}>issues</Box><Box as="span" />
        </Grid>
        {workers.length === 0 ? (
          <CardEmpty icon="◇" title="No workers running" hint="Launch a fleet from a project's plan to fill the board." />
        ) : workers.map((w, i) => {
          const st = STATUS[w.status];
          return (
            <Grid cols={GRID} gap={10} align="center" key={w.id} className="hrow" onClick={() => onOpen(w)} style={{
              padding: "9px 12px", fontSize: 11,
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              borderLeft: `2px solid ${w.profileColor}`, cursor: "pointer",
            }}>
              <Row gap={7} style={{ minWidth: 0 }}>
                <Avatar login={w.name} bot size={18} />
                <Box style={{ minWidth: 0 }}>
                  <Text as="div" mono style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</Text>
                  <Text as="div" mono size={9} style={{ color: w.profileColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.profileLabel}</Text>
                </Box>
              </Row>
              <Box as="span" className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: st.color }}>
                <Box as="span" className={`wd ${w.status}`} />{st.label}
              </Box>
              <Box style={{ minWidth: 0 }}>
                <Text as="div" style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.issue}</Text>
                {w.note && <Text as="div" mono size={9.5} tone="dim" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.note}</Text>}
              </Box>
              <Text as="span" mono size={10.5} tone="muted" style={{ textAlign: "right" }}>{w.ownedTotal}</Text>
              <Text as="span" mono size={13} tone="dim" style={{ textAlign: "right" }}>›</Text>
            </Grid>
          );
        })}
      </Box>
      <Row gap={14} align="stretch" wrap className="mono" style={{ marginTop: 10, fontSize: 10, color: "var(--fg-muted)" }}>
        {Object.values(STATUS).map(s => (
          <Box as="span" key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ColorSwatch color={s.color} />{s.label}
          </Box>
        ))}
      </Row>
    </Card>
  );
}

function FleetStatus({ counts, total }: { counts: Partial<Record<LiveWorker["status"], number>>; total: number }) {
  const slices = (Object.entries(counts) as Array<[LiveWorker["status"], number]>)
    .map(([k, v]) => ({ name: STATUS[k].label, value: v, color: STATUS[k].color }));
  return (
    <Card>
      <CardHead title="Fleet status" hint="right now" />
      {total === 0 ? <CardEmpty icon="◔" title="No workers running" hint="Status by state appears once a fleet is live." />
        : <Row gap={16}>
        <Donut slices={slices} center={{ value: total, label: "workers" }} />
        <Stack gap={6} style={{ flex: 1 }}>
          {slices.map(s => (
            <Grid key={s.name} cols="12px 1fr 24px" gap={8} align="center" className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
              <ColorSwatch color={s.color} />
              <Box as="span">{s.name}</Box>
              <Text as="span" style={{ textAlign: "right", color: "var(--fg)" }}>{s.value}</Text>
            </Grid>
          ))}
        </Stack>
      </Row>}
    </Card>
  );
}

// ── GitHub-derived panels (#415) ──────────────────────────────────────────────
function sliceThroughput(t: ThroughputSlice, range: string): ThroughputSlice {
  const n = range === "7d" ? 7 : t.labels.length;
  const last = <T,>(a: T[]) => a.slice(-n);
  return { labels: last(t.labels), landed: last(t.landed), merged: last(t.merged) };
}

function Throughput({ gh }: { gh: FleetGithub }) {
  const [range, setRange] = useState("14d");
  const tip = useTip();
  const d = sliceThroughput(gh.throughput, range);
  const total = d.landed.reduce((a, b) => a + b, 0) + d.merged.reduce((a, b) => a + b, 0);
  return (
    <Card>
      <CardHead title="Fleet throughput" hint="issues landed vs PRs merged"
        right={<RangeToggle value={range} onChange={setRange} options={["7d", "14d"]} />} />
      {gh.loading && total === 0 ? <SkeletonChart height={150} />
        : total === 0 ? <CardEmpty icon="⑃" title="No throughput yet" hint="Issues landed and PRs merged appear here once the fleet ships." />
        : <>
            <LineArea labels={d.labels} height={150} tip={tip} series={[
              { name: "landed", color: "var(--success)", data: d.landed },
              { name: "merged", color: "var(--accent)", data: d.merged },
            ]} />
            <Legend style={{ marginTop: 8 }} items={[
              { color: "var(--success)", label: "issues landed" },
              { color: "var(--accent)", label: "PRs merged" },
            ]} />
          </>}
      {tip.node}
    </Card>
  );
}

function TimeToLand({ gh }: { gh: FleetGithub }) {
  const tip = useTip();
  const total = gh.timeToLand.reduce((a, b) => a + b.v, 0);
  return (
    <Card>
      <CardHead title="Time-to-land" hint="PR open → merged · last 14d" />
      {gh.loading && total === 0 ? <SkeletonChart height={116} />
        : total === 0 ? <CardEmpty icon="◷" title="No merged PRs" hint="Open→merge times appear here once PRs land." />
        : <>
            <Bars labels={gh.timeToLand.map(b => b.label)} height={116} tip={tip}
              groups={[{ name: "PRs", color: "var(--info)", data: gh.timeToLand.map(b => b.v) }]} />
            <Text as="div" mono size={10} tone="dim" style={{ marginTop: 6, textAlign: "center" }}>
              median <b style={{ color: "var(--fg)" }}>{gh.medianLandH}h</b> over {total} merged PR{total === 1 ? "" : "s"}
            </Text>
          </>}
      {tip.node}
    </Card>
  );
}

function MergeQueue({ gh }: { gh: FleetGithub }) {
  const tone: Record<string, string> = { green: "var(--success)", running: "var(--accent)", blocked: "var(--danger)", draft: "var(--fg-dim)" };
  return (
    <Card>
      <CardHead title="Merge queue" hint="open PRs across the fleet's repos"
        right={<Text as="span" mono size={10.5} tone="accent">{gh.mergeQueue.length}</Text>} />
      {gh.loading && gh.mergeQueue.length === 0 ? <SkeletonRows rows={3} h={40} />
        : gh.mergeQueue.length === 0
        ? <CardEmpty icon="⇄" title="No open PRs" hint="Open PRs across the fleet's repos queue up here." />
        : (
          <Stack gap={1} style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
            {gh.mergeQueue.map((q, i) => (
              <Grid key={`${q.repo}${q.pr}`} cols="42px 1fr 64px" gap={8} align="center" className="hrow" style={{ padding: "9px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                <Text as="span" mono tone="dim">{q.pr}</Text>
                <Box style={{ minWidth: 0 }}>
                  <Text as="div" style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.title}</Text>
                  <Text as="div" mono size={9.5} tone="dim" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.repo}</Text>
                </Box>
                <Text as="span" mono size={10} style={{ textAlign: "right", color: tone[q.state] }}>● {q.state}</Text>
              </Grid>
            ))}
          </Stack>
        )}
    </Card>
  );
}

export function Fleet() {
  const activeProjectName = useAppStore(s => s.activeProjectName);
  const { workers, kpis, counts, hasFleet } = useFleetLive();
  const repos = useMemo(() => [...new Set(workers.map(w => w.repo).filter(Boolean))], [workers]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const gh = useFleetGithub(repos, refreshNonce);
  // The opened worker is held as a snapshot (its identity), so the per-agent page
  // survives the worker leaving the live roster — e.g. when you pause it (#499).
  // WorkerDetail re-reads live status/paused from the store itself.
  const [selected, setSelected] = useState<LiveWorker | null>(null);
  const setProjectsPageMode = useAppStore(s => s.setProjectsPageMode);
  const setProjectsView = useAppStore(s => s.setProjectsView);

  // The page's SKELETON now comes from the components STORE (#3569): the harvested `FleetPage` node's
  // `spec`, so editing it in the Design Studio reflects on this real page. `FLEET_PAGE_SPEC` is the
  // seed/fallback — used until the store node carries a VALID spec, so the page never renders blank and
  // a malformed store edit can't crash it (validate → fall back).
  const storeSpec = useAppStore(s => s.components.find(c => c.id === FLEET_PAGE_ID)?.spec);
  const fleetSpec = useMemo(() => resolveFleetSpec(storeSpec), [storeSpec]);

  if (selected) {
    return <WorkerDetail worker={selected} onBack={() => setSelected(null)} />;
  }

  // The page's STRUCTURE renders from a validated node tree (#3504) — the header, the six-tile stat
  // grid and the 1.6fr/1fr split live in `fleetPageSpec.ts`, not here. This host stays code because it
  // owns what a spec cannot: the live hooks, the GitHub query, and the `selected` routing above.
  //
  // `values` feeds the tiles + header prose; `slots` supplies the nine panels, which own hooks and app
  // state of their own. The card layout ALWAYS renders (#2234) — each panel shows a loading skeleton or
  // a compact empty state, rather than a page-wide blank screen when no fleet is running.
  const values = {
    summary: hasFleet
      ? `${activeProjectName ? `${activeProjectName} · ` : ""}${kpis.total} worker${kpis.total === 1 ? "" : "s"} · ${kpis.active} running · ${kpis.needAttention} need attention${kpis.maintenance > 0 ? ` · ${kpis.maintenance} parked` : ""}`
      : "No fleet running — launch one from a project's plan to populate these panels.",
    refreshLabel: gh.loading ? "refreshing…" : "↻ refresh",
    loading: gh.loading,
    activeOfTotal: `${kpis.active}/${kpis.total}`,
    needAttention: String(kpis.needAttention),
    attentionTone: kpis.needAttention > 0 ? "danger" : "fg",
    idle: String(kpis.idle),
    landedToday: String(gh.kpis.landedToday),
    prsMergedWeek: String(gh.kpis.prsMergedWeek),
    avgLand: gh.kpis.avgLandH ? `${gh.kpis.avgLandH}h` : "—",
  };

  const slots = {
    workerBoard: <WorkerBoard workers={workers} onOpen={setSelected} />,
    fleetHealth: <FleetHealth workers={workers} />,
    throughput: <Throughput gh={gh} />,
    timeToLand: <TimeToLand gh={gh} />,
    fleetStatus: <FleetStatus counts={counts} total={kpis.total} />,
    costEnergy: <CostEnergy workers={workers} />,
    fleetLessons: <FleetLessons />,
    mergeQueue: <MergeQueue gh={gh} />,
  };

  const on = {
    refresh: () => setRefreshNonce(n => n + 1),
    launchWorker: () => { setProjectsPageMode("projects"); setProjectsView("planning"); },
  };

  return <KitRenderer node={fleetSpec} values={values} slots={slots} on={on} />;
}
