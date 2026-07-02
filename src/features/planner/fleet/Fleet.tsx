// Projects → Fleet (#401). A live orchestration dashboard for a project's agent
// fleet. The roster + run/idle + coordination status come from the running app
// state (#412); throughput / merge queue / time-to-land come from GitHub across
// the fleet's repos (#415). No fabrication — tokens/spend still need per-session
// accounting (#416) and show an explicit note.
import { useMemo, useState } from "react";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Button } from "@/shared/ui/controls/Button";
import { Donut, Bars, LineArea, RangeToggle, Legend, StatCard, CardHead, Avatar, useTip } from "@/shared/ui/charts";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { useAppStore } from "@/store";
import { STATUS } from "@/shared/data/fleet";
import { useFleetLive } from "@/shared/hooks/useFleetLive";
import { useFleetGithub, type FleetGithub } from "./useFleetGithub";
import { WorkerDetail } from "./WorkerDetail";
import type { LiveWorker } from "@/shared/lib/fleet/fleetLive";
import type { ThroughputSlice } from "@/features/github/lib/fleetGithub";

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
        {workers.map((w, i) => {
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
      <Row gap={16}>
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
      </Row>
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
      {gh.loading && total === 0 ? <Box className="hint" pad={[8, 2]}>Loading from GitHub…</Box>
        : total === 0 ? <Box className="hint" pad={[8, 2]}>No landed issues or merged PRs in the window.</Box>
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
      {total === 0 ? <Box className="hint" pad={[8, 2]}>{gh.loading ? "Loading from GitHub…" : "No merged PRs in the window."}</Box>
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
      {gh.mergeQueue.length === 0
        ? <Box className="hint" pad={[8, 2]}>{gh.loading ? "Loading from GitHub…" : "No open PRs."}</Box>
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

/** Tokens/spend still need per-session accounting (#416) — honest note, no fake numbers. */
function SpendNote() {
  return (
    <Card>
      <CardHead title="Tokens & spend" hint="not measured yet" />
      <Text as="div" mono size={11} tone="dim" style={{ lineHeight: 1.6 }}>
        Per-session token + cost accounting doesn't exist yet (#416). Once it lands, token burn and spend appear here.
      </Text>
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

  if (selected) {
    return <WorkerDetail worker={selected} onBack={() => setSelected(null)} />;
  }

  if (!hasFleet) {
    return (
      <section className="an-page">
        <EmptyState
          iconVariant="dashed"
          title="No fleet running"
          description="Launch a fleet from a project's plan to orchestrate parallel agents — workers, status, and coordination appear here live."
        />
      </section>
    );
  }

  return (
    <section className="an-page">
      <Box className="an-wrap">
        <Row align="start" gap={14} style={{ marginBottom: 14 }}>
          <Box style={{ flex: 1 }}>
            <Text as="h2" mono size={20} weight={600} style={{ margin: 0 }}>Fleet</Text>
            <Text as="div" size={12} tone="muted" style={{ marginTop: 4 }}>
              {activeProjectName ? `${activeProjectName} · ` : ""}{kpis.total} worker{kpis.total === 1 ? "" : "s"} · {kpis.active} running · {kpis.needAttention} need attention
            </Text>
          </Box>
          <Button variant="ghost" onClick={() => setRefreshNonce(n => n + 1)} disabled={gh.loading}>
            {gh.loading ? "refreshing…" : "↻ refresh"}
          </Button>
          <Button title="Launch the fleet from this project's plan"
            onClick={() => { setProjectsPageMode("projects"); setProjectsView("planning"); }}>
            launch worker
          </Button>
        </Row>

        <Box className="statgrid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
          <StatCard k="active workers" v={`${kpis.active}/${kpis.total}`} sub="running now" tone="accent" />
          <StatCard k="need attention" v={String(kpis.needAttention)} sub="blocked · asking · waiting" tone={kpis.needAttention > 0 ? "danger" : "fg"} />
          <StatCard k="idle" v={String(kpis.idle)} sub="at rest" tone="fg" />
          <StatCard k="landed today" v={String(gh.kpis.landedToday)} sub="issues closed" tone="success" />
          <StatCard k="PRs merged · 7d" v={String(gh.kpis.prsMergedWeek)} sub="across the fleet's repos" tone="info" />
          <StatCard k="time-to-land" v={gh.kpis.avgLandH ? `${gh.kpis.avgLandH}h` : "—"} sub="open → merge median" tone="fg" />
        </Box>

        <Grid cols="1.6fr 1fr" gap={14}>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <WorkerBoard workers={workers} onOpen={setSelected} />
            <Throughput gh={gh} />
            <TimeToLand gh={gh} />
          </Stack>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <FleetStatus counts={counts} total={kpis.total} />
            <MergeQueue gh={gh} />
            <SpendNote />
          </Stack>
        </Grid>
      </Box>
    </section>
  );
}
