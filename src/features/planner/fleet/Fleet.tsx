// Projects → Fleet (#401). A live orchestration dashboard for a project's agent
// fleet. The roster + run/idle + coordination status come from the running app
// state (#412); throughput / merge queue / time-to-land come from GitHub across
// the fleet's repos (#415). No fabrication — tokens/spend still need per-session
// accounting (#416) and show an explicit note.
import { useMemo, useState } from "react";
import { ColorSwatch } from "@/shared/ui/ColorSwatch";
import { Donut, Bars, LineArea, RangeToggle, Legend, StatCard, CardHead, Avatar, useTip } from "@/shared/ui/charts";
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
    <div className="card">
      <CardHead title="Worker board" hint="one agent per stream · click a worker to open it"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>{workers.length} live</span>} />
      <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        <div style={{
          display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "7px 12px",
          background: "var(--bg-elev2)", borderBottom: "1px solid var(--border-soft)",
          fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em",
        }}>
          <span>worker</span><span>status</span><span>current</span><span style={{ textAlign: "right" }}>issues</span><span />
        </div>
        {workers.map((w, i) => {
          const st = STATUS[w.status];
          return (
            <div key={w.id} className="hrow" onClick={() => onOpen(w)} style={{
              display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "9px 12px", alignItems: "center", fontSize: 11,
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              borderLeft: `2px solid ${w.profileColor}`, cursor: "pointer",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <Avatar login={w.name} bot size={18} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--mono)", color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: w.profileColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.profileLabel}</div>
                </div>
              </div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 10, color: st.color }}>
                <span className={`wd ${w.status}`} />{st.label}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.issue}</div>
                {w.note && <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.note}</div>}
              </div>
              <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>{w.ownedTotal}</span>
              <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-dim)" }}>›</span>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
        {Object.values(STATUS).map(s => (
          <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <ColorSwatch color={s.color} />{s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function FleetStatus({ counts, total }: { counts: Partial<Record<LiveWorker["status"], number>>; total: number }) {
  const slices = (Object.entries(counts) as Array<[LiveWorker["status"], number]>)
    .map(([k, v]) => ({ name: STATUS[k].label, value: v, color: STATUS[k].color }));
  return (
    <div className="card">
      <CardHead title="Fleet status" hint="right now" />
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Donut slices={slices} center={{ value: total, label: "workers" }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          {slices.map(s => (
            <div key={s.name} style={{ display: "grid", gridTemplateColumns: "12px 1fr 24px", gap: 8, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
              <ColorSwatch color={s.color} />
              <span>{s.name}</span>
              <span style={{ textAlign: "right", color: "var(--fg)" }}>{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
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
    <div className="card">
      <CardHead title="Fleet throughput" hint="issues landed vs PRs merged"
        right={<RangeToggle value={range} onChange={setRange} options={["7d", "14d"]} />} />
      {gh.loading && total === 0 ? <div className="hint" style={{ padding: "8px 2px" }}>Loading from GitHub…</div>
        : total === 0 ? <div className="hint" style={{ padding: "8px 2px" }}>No landed issues or merged PRs in the window.</div>
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
    </div>
  );
}

function TimeToLand({ gh }: { gh: FleetGithub }) {
  const tip = useTip();
  const total = gh.timeToLand.reduce((a, b) => a + b.v, 0);
  return (
    <div className="card">
      <CardHead title="Time-to-land" hint="PR open → merged · last 14d" />
      {total === 0 ? <div className="hint" style={{ padding: "8px 2px" }}>{gh.loading ? "Loading from GitHub…" : "No merged PRs in the window."}</div>
        : <>
            <Bars labels={gh.timeToLand.map(b => b.label)} height={116} tip={tip}
              groups={[{ name: "PRs", color: "var(--info)", data: gh.timeToLand.map(b => b.v) }]} />
            <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "center" }}>
              median <b style={{ color: "var(--fg)" }}>{gh.medianLandH}h</b> over {total} merged PR{total === 1 ? "" : "s"}
            </div>
          </>}
      {tip.node}
    </div>
  );
}

function MergeQueue({ gh }: { gh: FleetGithub }) {
  const tone: Record<string, string> = { green: "var(--success)", running: "var(--accent)", blocked: "var(--danger)", draft: "var(--fg-dim)" };
  return (
    <div className="card">
      <CardHead title="Merge queue" hint="open PRs across the fleet's repos"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>{gh.mergeQueue.length}</span>} />
      {gh.mergeQueue.length === 0
        ? <div className="hint" style={{ padding: "8px 2px" }}>{gh.loading ? "Loading from GitHub…" : "No open PRs."}</div>
        : (
          <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
            {gh.mergeQueue.map((q, i) => (
              <div key={`${q.repo}${q.pr}`} className="hrow" style={{ display: "grid", gridTemplateColumns: "42px 1fr 64px", gap: 8, alignItems: "center", padding: "9px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
                <span style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>{q.pr}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.title}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.repo}</div>
                </div>
                <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10, color: tone[q.state] }}>● {q.state}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

/** Tokens/spend still need per-session accounting (#416) — honest note, no fake numbers. */
function SpendNote() {
  return (
    <div className="card">
      <CardHead title="Tokens & spend" hint="not measured yet" />
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", lineHeight: 1.6 }}>
        Per-session token + cost accounting doesn't exist yet (#416). Once it lands, token burn and spend appear here.
      </div>
    </div>
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
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 48, textAlign: "center" }}>
          <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 18 }}>No fleet running</h2>
          <p className="hint" style={{ maxWidth: 380, margin: 0 }}>
            Launch a fleet from a project's plan to orchestrate parallel agents — workers, status, and coordination appear here live.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="an-page">
      <div className="an-wrap">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Fleet</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
              {activeProjectName ? `${activeProjectName} · ` : ""}{kpis.total} worker{kpis.total === 1 ? "" : "s"} · {kpis.active} running · {kpis.needAttention} need attention
            </div>
          </div>
          <button className="btn ghost" onClick={() => setRefreshNonce(n => n + 1)} disabled={gh.loading}>
            {gh.loading ? "refreshing…" : "↻ refresh"}
          </button>
          <button className="btn" title="Launch the fleet from this project's plan"
            onClick={() => { setProjectsPageMode("projects"); setProjectsView("planning"); }}>
            launch worker
          </button>
        </div>

        <div className="statgrid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
          <StatCard k="active workers" v={`${kpis.active}/${kpis.total}`} sub="running now" tone="accent" />
          <StatCard k="need attention" v={String(kpis.needAttention)} sub="blocked · asking · waiting" tone={kpis.needAttention > 0 ? "danger" : "fg"} />
          <StatCard k="idle" v={String(kpis.idle)} sub="at rest" tone="fg" />
          <StatCard k="landed today" v={String(gh.kpis.landedToday)} sub="issues closed" tone="success" />
          <StatCard k="PRs merged · 7d" v={String(gh.kpis.prsMergedWeek)} sub="across the fleet's repos" tone="info" />
          <StatCard k="time-to-land" v={gh.kpis.avgLandH ? `${gh.kpis.avgLandH}h` : "—"} sub="open → merge median" tone="fg" />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <WorkerBoard workers={workers} onOpen={setSelected} />
            <Throughput gh={gh} />
            <TimeToLand gh={gh} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <FleetStatus counts={counts} total={kpis.total} />
            <MergeQueue gh={gh} />
            <SpendNote />
          </div>
        </div>
      </div>
    </section>
  );
}
