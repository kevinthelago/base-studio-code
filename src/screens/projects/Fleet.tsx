// Projects → Fleet analytics (#401) — a live orchestration dashboard for a
// project's agent fleet (workers, director, throughput, spend). Presentational:
// renders off data/fleet.ts (sample data; a live feed is a follow-up) using the
// shared chart primitives (#399). Rendered by the Projects index when the page
// mode is "fleet"; the mode strip + app status bar are the surrounding chrome.
import { useState } from "react";
import {
  LineArea, Bars, Donut, HBars, Swimlane, Legend,
  StatCard, CardHead, RangeToggle, Avatar, useTip,
  type HBarRow, type StatTone,
} from "../../components/charts";
import {
  PROFILE, STATUS, WORKERS, DIRECTOR, statusCounts, rangeSlice,
  COORD_LANES, COORD_EVENTS, COORD_MARKS, CYCLE_BUCKETS, MERGE_QUEUE, FLEET_KPIS, FLEET_PROJECT,
} from "../../data/fleet";

// ── digest ────────────────────────────────────────────────────────────────────
function FleetDigest() {
  return (
    <div className="card" style={{
      padding: "13px 18px", marginBottom: 14,
      background: "linear-gradient(135deg, color-mix(in oklch, var(--accent), transparent 88%), var(--bg-panel) 60%)",
      border: "1px solid var(--accent-dim)",
    }}>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{
          flexShrink: 0, width: 28, height: 28, borderRadius: 7,
          background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
          color: "#1a120a", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 13,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>C</div>
        <div style={{ flex: 1, fontSize: 12, lineHeight: 1.6, color: "var(--fg-muted)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".06em" }}>fleet digest · director</span>
            <span className="hint">event-driven · synced 1m ago</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" style={{ height: 22, fontSize: 10 }}>poke director</button>
          </div>
          <p style={{ margin: 0 }}>
            {FLEET_KPIS.totalWorkers} workers on <b style={{ color: "var(--fg)" }}>{FLEET_PROJECT}</b> — {FLEET_KPIS.activeWorkers} running, on pace for the iteration.
            Landed <b style={{ color: "var(--success)" }}>{FLEET_KPIS.landedToday} issues</b> today; director merged {FLEET_KPIS.mergedToday} PRs.
            <b style={{ color: "var(--danger)" }}> infra</b> is blocked on #218's shared signer, and
            <b style={{ color: "oklch(0.7 0.12 290)" }}> dashboard</b> is awaiting your answer on the live-feed transport.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── KPI row ──────────────────────────────────────────────────────────────────
function KpiRow() {
  const k = FLEET_KPIS;
  const cards: Array<{ k: string; v: string; sub: string; tone?: StatTone; delta?: { dir: "up" | "down" | "flat"; text: string } }> = [
    { k: "active workers", v: `${k.activeWorkers}/${k.totalWorkers}`, sub: "running now", tone: "accent" },
    { k: "landed today", v: String(k.landedToday), sub: "issues closed by fleet", tone: "success", delta: { dir: "up", text: "+3 vs avg" } },
    { k: "PRs merged", v: String(k.mergedToday), sub: "by director", tone: "fg", delta: { dir: "up", text: "+2" } },
    { k: "need attention", v: String(k.needAttention), sub: "blocked · asking · waiting", tone: "danger" },
    { k: "tokens today", v: `${k.tokensTodayM}M`, sub: "across all workers", tone: "info" },
    { k: "spend today", v: `$${k.costToday.toFixed(2)}`, sub: "est. API cost", tone: "fg" },
    { k: "avg time-to-land", v: `${k.avgLandH}h`, sub: "issue → merged", tone: "fg", delta: { dir: "down", text: "−0.6h" } },
  ];
  return (
    <div className="statgrid" style={{ gridTemplateColumns: "repeat(7, 1fr)" }}>
      {cards.map(c => <StatCard key={c.k} {...c} />)}
    </div>
  );
}

// ── worker board ─────────────────────────────────────────────────────────────
const GRID = "120px 92px 1fr 120px 64px 56px";
function WorkerBoard({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  return (
    <div className="card">
      <CardHead title="Worker board" hint="one agent per stream · own worktree + branch"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>{WORKERS.length} workers live</span>} />
      <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        <div style={{
          display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "7px 12px",
          background: "var(--bg-elev2)", borderBottom: "1px solid var(--border-soft)",
          fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em",
        }}>
          <span>worker</span><span>status</span><span>current</span><span>stream progress</span>
          <span style={{ textAlign: "right" }}>tokens</span><span style={{ textAlign: "right" }}>last</span>
        </div>
        {WORKERS.map((w, i) => {
          const st = STATUS[w.status];
          const pr = PROFILE[w.profile];
          const on = selected === w.id;
          const pct = Math.round(w.ownedDone / w.ownedTotal * 100);
          return (
            <div key={w.id} className="hrow" onMouseEnter={() => onSelect(w.id)} style={{
              display: "grid", gridTemplateColumns: GRID, gap: 10, padding: "9px 12px", alignItems: "center", fontSize: 11,
              background: on ? "var(--bg-elev2)" : (i % 2 ? "var(--bg-panel)" : "var(--bg-elev)"),
              borderLeft: `2px solid ${on ? pr.color : "transparent"}`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <Avatar login={w.id} bot size={18} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--mono)", color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.id}</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: pr.color }}>{w.agent}</div>
                </div>
              </div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 10, color: st.color }}>
                <span className={`wd ${w.status}`} />{st.label}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.issue}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.note}</div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", marginBottom: 3 }}>
                  <span>{w.ownedDone}/{w.ownedTotal}</span><span>{pct}%</span>
                </div>
                <div className="meter"><i style={{ width: `${pct}%`, background: pr.color }} /></div>
              </div>
              <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>{w.tokensK}k</span>
              <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{w.lastMin}m</span>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 10 }}>
        <Legend items={Object.values(STATUS).map(s => ({ color: s.color, label: s.label }))} />
      </div>
    </div>
  );
}

// ── throughput ───────────────────────────────────────────────────────────────
function Throughput() {
  const [range, setRange] = useState("14d");
  const tip = useTip();
  const d = rangeSlice(range);
  return (
    <div className="card">
      <CardHead title="Fleet throughput" hint="issues landed vs PRs merged"
        right={<RangeToggle value={range} onChange={setRange} options={["7d", "14d"]} />} />
      <LineArea labels={d.labels} height={150} tip={tip} series={[
        { name: "landed", color: "var(--success)", data: d.landed },
        { name: "merged", color: "var(--accent)", data: d.merged },
      ]} />
      <Legend style={{ marginTop: 8 }} items={[
        { color: "var(--success)", label: "issues landed" },
        { color: "var(--accent)", label: "PRs merged by director" },
      ]} />
      {tip.node}
    </div>
  );
}

// ── coordination timeline ────────────────────────────────────────────────────
function CoordTimeline() {
  const tip = useTip();
  return (
    <div className="card">
      <CardHead title="Coordination timeline" hint="run spans · ✔ landed · director merges · ⚠ blocks · ? asks · today's session" />
      <Swimlane lanes={COORD_LANES} events={COORD_EVENTS} marks={COORD_MARKS} tip={tip} height={26} />
      <Legend style={{ marginTop: 6 }} items={[
        { color: "var(--success)", label: "landed" },
        { color: "var(--accent)", label: "director merge" },
        { color: "var(--danger)", label: "blocked" },
        { color: "oklch(0.7 0.12 290)", label: "asking" },
        { color: "var(--info)", label: "waiting" },
      ]} />
      {tip.node}
    </div>
  );
}

// ── fleet status donut ───────────────────────────────────────────────────────
function FleetStatus() {
  const counts = statusCounts();
  const slices = (Object.entries(counts) as Array<[keyof typeof STATUS, number]>)
    .map(([k, v]) => ({ name: STATUS[k].label, value: v, color: STATUS[k].color }));
  return (
    <div className="card">
      <CardHead title="Fleet status" hint="right now" />
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Donut slices={slices} center={{ value: WORKERS.length, label: "workers" }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          {slices.map(s => (
            <div key={s.name} style={{ display: "grid", gridTemplateColumns: "12px 1fr 24px", gap: 8, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />
              <span>{s.name}</span>
              <span style={{ textAlign: "right", color: "var(--fg)" }}>{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── director / merge queue ───────────────────────────────────────────────────
function DirectorCard() {
  const tone: Record<string, string> = { green: "var(--success)", running: "var(--accent)", blocked: "var(--fg-dim)" };
  return (
    <div className="card">
      <CardHead title="Director · merge queue" hint={`drive: ${DIRECTOR.drive} · idle ${DIRECTOR.idleFor}m`}
        right={<span className="tag green" style={{ fontSize: 9 }}>{DIRECTOR.mergedToday} merged today</span>} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        {MERGE_QUEUE.map((q, i) => (
          <div key={q.pr} className="hrow" style={{ display: "grid", gridTemplateColumns: "42px 1fr 58px", gap: 8, alignItems: "center", padding: "9px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
            <span style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>{q.pr}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{q.title}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{q.w} · {q.checks}</div>
            </div>
            <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 10, color: tone[q.state] }}>● {q.state}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", lineHeight: 1.6 }}>
        re-prompts on worker events · merges green PRs · runs <span style={{ color: "var(--accent)" }}>bsc-merged</span> to wake parked workers
      </div>
    </div>
  );
}

// ── cost & token burn ────────────────────────────────────────────────────────
function CostBurn() {
  const rows: HBarRow[] = [...WORKERS].sort((a, b) => b.tokensK - a.tokensK).map(w => ({
    label: w.id, value: w.tokensK, color: PROFILE[w.profile].color,
    icon: <Avatar login={w.id} bot size={14} />,
    tag: <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>${w.costUsd.toFixed(2)}</span>,
  }));
  const totalK = WORKERS.reduce((s, w) => s + w.tokensK, 0);
  const totalUsd = WORKERS.reduce((s, w) => s + w.costUsd, 0);
  return (
    <div className="card">
      <CardHead title="Token & cost burn" hint="today · per worker"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>${totalUsd.toFixed(2)}</span>} />
      <HBars rows={rows} fmtV={(v) => `${v}k`} />
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-soft)", display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
        <span>total <b style={{ color: "var(--fg)" }}>{(totalK / 1000).toFixed(2)}M tok</b></span>
        <span>$0.0059 / 1k avg</span>
      </div>
    </div>
  );
}

// ── cycle-time distribution ──────────────────────────────────────────────────
function CycleTime() {
  const tip = useTip();
  return (
    <div className="card">
      <CardHead title="Time-to-land" hint="issue assigned → PR merged · last 7d" />
      <Bars labels={CYCLE_BUCKETS.map(b => b.label)} height={120} tip={tip}
        groups={[{ name: "issues", color: "var(--accent)", data: CYCLE_BUCKETS.map(b => b.v) }]} />
      <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "center" }}>
        median <b style={{ color: "var(--fg)" }}>2.1h</b> · p90 <b style={{ color: "var(--fg)" }}>6.4h</b>
      </div>
      {tip.node}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export function Fleet() {
  const [sel, setSel] = useState("api");
  return (
    <section className="an-page">
      <div className="an-wrap">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Fleet</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
              {FLEET_PROJECT} · {WORKERS.length} workers across {WORKERS.length} streams · director coordinating
            </div>
          </div>
          <button className="btn">pause fleet</button>
          <button className="btn primary">+ launch stream</button>
        </div>

        <FleetDigest />
        <KpiRow />

        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <WorkerBoard selected={sel} onSelect={setSel} />
            <Throughput />
            <CoordTimeline />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <FleetStatus />
            <DirectorCard />
            <CostBurn />
            <CycleTime />
          </div>
        </div>
      </div>
    </section>
  );
}
