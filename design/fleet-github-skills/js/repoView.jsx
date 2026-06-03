/* global React, ReactDOM, REPODATA, Titlebar, Rail, ModeStrip, StatusBar, Avatar, CardHead, StatCard, RangeToggle, useTip, LineArea, Bars, Donut, HBars, Swimlane, Heat, Legend, fmt */
const { useState } = React;
const R = window.REPODATA;

// ── repo pulse digest ────────────────────────────────────────────────────────
function PulseDigest() {
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
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".06em" }}>
              repo pulse · claude
            </span>
            <span className="hint">generated 02:00 today · run #14</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" style={{ height: 22, fontSize: 10 }}>regenerate</button>
          </div>
          <p style={{ margin: 0 }}>
            Commit volume is up <b style={{ color: "var(--success)" }}>+38%</b> week-over-week, driven by the
            settlement fleet — <b style={{ color: "var(--fg)" }}>{R.KPIS.botShare}%</b> of commits now land from worker agents.
            Hottest area is <b style={{ color: "oklch(0.7 0.12 290)" }}>src/</b> (Planning + Summary rework).
            CI holds at <b style={{ color: "var(--success)" }}>{R.CI.passRate}%</b>; <b style={{ color: "var(--danger)" }}>release.yml</b> is the weak spot at 78%.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── KPI row ──────────────────────────────────────────────────────────────────
function KpiRow() {
  const k = R.KPIS;
  const cards = [
    { k: "commits · 7d", v: String(k.commitsWeek), sub: "on main + branches", tone: "fg", delta: { dir: "up", text: "+38%" } },
    { k: "PRs merged · 7d", v: String(k.prsMerged), sub: "into develop", tone: "accent", delta: { dir: "up", text: "+9" } },
    { k: "net lines · 7d", v: `+${fmt(k.netLines)}`, sub: "added − removed", tone: "success" },
    { k: "CI pass rate", v: `${k.passRate}%`, sub: `${R.CI.runs} runs`, tone: "success", delta: { dir: "up", text: "+3%" } },
    { k: "review latency", v: `${k.reviewLatencyH}h`, sub: "open → merge median", tone: "fg", delta: { dir: "down", text: "−0.4h" } },
    { k: "agent commits", v: `${k.botShare}%`, sub: `${R.CONTRIB.length} contributors`, tone: "info" },
  ];
  return (
    <div className="statgrid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
      {cards.map(c => <StatCard key={c.k} {...c} />)}
    </div>
  );
}

// ── commit & PR velocity ─────────────────────────────────────────────────────
function Velocity() {
  const [range, setRange] = useState("14d");
  const tip = useTip();
  const d = R.vrange(range);
  return (
    <div className="card">
      <CardHead title="Commit & PR velocity" hint="daily commits, PRs opened vs merged"
        right={<RangeToggle value={range} onChange={setRange} options={["7d", "14d"]} />} />
      <LineArea labels={d.labels} height={160} series={[
        { name: "commits", color: "var(--info)", data: d.commits },
        { name: "PRs opened", color: "var(--fg-muted)", data: d.opened, area: false, dash: "4 3", dotR: 1.8 },
        { name: "PRs merged", color: "var(--accent)", data: d.merged, area: false },
      ]} tip={tip} fmtY={(v) => v} />
      <Legend style={{ marginTop: 8 }} items={[
        { color: "var(--info)", label: "commits" },
        { color: "var(--fg-muted)", label: "PRs opened" },
        { color: "var(--accent)", label: "PRs merged" },
      ]} />
      {tip.node}
    </div>
  );
}

// ── net lines (additions vs deletions) ───────────────────────────────────────
function NetLines() {
  const [range, setRange] = useState("14d");
  const tip = useTip();
  const d = R.vrange(range);
  return (
    <div className="card">
      <CardHead title="Lines changed" hint="additions vs deletions / day"
        right={<RangeToggle value={range} onChange={setRange} options={["7d", "14d"]} />} />
      <Bars labels={d.labels} height={140} stacked={false} fmtY={(v) => fmt(v)} tip={tip} groups={[
        { name: "added", color: "var(--success)", data: d.adds },
        { name: "removed", color: "var(--danger)", data: d.dels },
      ]} />
      <Legend style={{ marginTop: 8 }} items={[
        { color: "var(--success)", label: "added" },
        { color: "var(--danger)", label: "removed" },
      ]} />
      {tip.node}
    </div>
  );
}

// ── churn by area ────────────────────────────────────────────────────────────
function ChurnByArea() {
  const tip = useTip();
  const rows = R.CHURN_AREAS.map(a => ({
    label: a.area, value: a.add + a.del, color: a.color, strong: true,
    tag: <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
      <span style={{ color: "var(--success)" }}>+{fmt(a.add)}</span> / <span style={{ color: "var(--danger)" }}>−{fmt(a.del)}</span> · {a.files}f
    </span>,
  }));
  return (
    <div className="card">
      <CardHead title="Churn by area" hint="lines changed · last 14 days" />
      <HBars rows={rows} fmtV={(v) => fmt(v)} />
    </div>
  );
}

// ── file churn heatmap ───────────────────────────────────────────────────────
function FileChurn() {
  const max = Math.max(...R.CHURN_FILES.map(f => f.w));
  return (
    <div className="card">
      <CardHead title="Hottest files" hint="±lines in last 14d · darker = hotter" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        {R.CHURN_FILES.map(f => {
          const t = f.w / max;
          const a = 0.16 + 0.74 * t;
          return (
            <div key={f.p} title={`${f.p} · ±${f.w}`} style={{
              padding: "8px 9px", borderRadius: 4, minHeight: 52,
              background: `color-mix(in oklch, var(--accent) ${Math.round(a * 100)}%, var(--bg-elev))`,
              border: "1px solid var(--border-soft)",
              fontFamily: "var(--mono)", fontSize: 9.5, lineHeight: 1.35,
              display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden",
            }}>
              <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: t > 0.55 ? "#1a120a" : "var(--fg)" }}>{f.p.split("/").pop()}</span>
              <span style={{ fontSize: 8.5, color: t > 0.55 ? "#1a120a" : "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.p.replace(/\/[^/]+$/, "") || "/"}</span>
              <span style={{ fontSize: 9.5, fontWeight: 600, color: t > 0.55 ? "#1a120a" : "var(--fg-muted)" }}>±{f.w}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── contributors (agents vs humans) ──────────────────────────────────────────
function Contributors() {
  const sorted = [...R.CONTRIB].sort((a, b) => b.commits - a.commits);
  const max = Math.max(...sorted.map(c => c.commits));
  return (
    <div className="card">
      <CardHead title="Contributors" hint="commits · agents vs humans"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
          <span style={{ color: "var(--accent)" }}>◆ {R.BOT_COMMITS}</span> agent · <span style={{ color: "var(--fg)" }}>{R.HUMAN_COMMITS}</span> human
        </span>} />
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--bg-elev2)", marginBottom: 12 }}>
        <div title="agents" style={{ width: `${R.KPIS.botShare}%`, background: "var(--accent)" }} />
        <div title="humans" style={{ flex: 1, background: "oklch(0.68 0.12 250)" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {sorted.map(c => (
          <div key={c.name} className="hrow" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 40px", gap: 10, alignItems: "center", padding: "1px 2px", borderRadius: 4 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>
                <Avatar login={c.name} bot={c.bot} size={15} />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                <span className={"tag " + (c.bot ? "amber" : "")} style={{ fontSize: 8.5 }}>{c.bot ? "agent" : "human"}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)" }}>
                  <span style={{ color: "var(--success)" }}>+{fmt(c.add)}</span> <span style={{ color: "var(--danger)" }}>−{fmt(c.del)}</span>
                </span>
              </div>
              <div className="meter"><i style={{ width: `${c.commits / max * 100}%`, background: c.bot ? "var(--accent)" : "oklch(0.68 0.12 250)" }} /></div>
            </div>
            <div style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{c.commits}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── CI / Actions ─────────────────────────────────────────────────────────────
function CIHealth() {
  const tip = useTip();
  const ci = R.CI;
  const slices = [
    { name: "passed", value: ci.passed, color: "var(--success)" },
    { name: "failed", value: ci.failed, color: "var(--danger)" },
    { name: "cancelled", value: ci.cancelled, color: "var(--fg-dim)" },
  ];
  return (
    <div className="card">
      <CardHead title="CI health" hint={`${ci.runs} runs · 14d`} />
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
        <Donut slices={slices} size={112} thickness={14} center={{ value: `${ci.passRate}%`, label: "pass" }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
          {slices.map(s => (
            <div key={s.name} style={{ display: "grid", gridTemplateColumns: "12px 1fr 28px", gap: 8, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color }} />
              <span>{s.name}</span><span style={{ textAlign: "right", color: "var(--fg)" }}>{s.value}</span>
            </div>
          ))}
          <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginTop: 2 }}>avg duration {ci.avgMin}m</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {R.WORKFLOWS.map(w => (
          <div key={w.name} style={{ display: "grid", gridTemplateColumns: "120px 1fr 34px", gap: 8, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
            <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</span>
            <div className="meter" style={{ height: 5 }}><i style={{ width: `${w.pass}%`, background: w.pass >= 90 ? "var(--success)" : w.pass >= 80 ? "var(--accent)" : "var(--danger)" }} /></div>
            <span style={{ textAlign: "right", color: w.pass >= 90 ? "var(--success)" : "var(--fg)" }}>{w.pass}%</span>
          </div>
        ))}
      </div>
      {tip.node}
    </div>
  );
}

// ── branches & worktrees ─────────────────────────────────────────────────────
function Branches() {
  return (
    <div className="card">
      <CardHead title="Active branches" hint="fleet worktrees → develop"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>{R.BRANCHES.length}</span>} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        {R.BRANCHES.map((b, i) => {
          const st = R.BRANCH_STATUS[b.status];
          return (
            <div key={b.n} className="hrow" style={{
              display: "grid", gridTemplateColumns: "1fr 70px 70px", gap: 8, alignItems: "center",
              padding: "8px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <Avatar login={b.owner} bot={b.bot} size={15} />
                <span style={{ fontFamily: "var(--mono)", color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.n}</span>
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>
                <span style={{ color: "var(--success)" }}>↑{b.ahead}</span> <span style={{ color: "var(--danger)" }}>↓{b.behind}</span>
              </span>
              <span style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 9.5, color: st.color }}>● {st.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── review latency ───────────────────────────────────────────────────────────
function ReviewLatency() {
  const tip = useTip();
  return (
    <div className="card">
      <CardHead title="Review latency" hint="PR open → merged · last 14d" />
      <Bars labels={R.REVIEW_BUCKETS.map(b => b.label)} height={116}
        groups={[{ name: "PRs", color: "var(--info)", data: R.REVIEW_BUCKETS.map(b => b.v) }]} tip={tip} />
      <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "center" }}>
        median <b style={{ color: "var(--fg)" }}>1.3h</b> · director auto-merges green PRs
      </div>
      {tip.node}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
function PulseView() {
  return (
    <div className="app">
      <Titlebar workspace="GitHub — base-studio-code — pulse"
        meta={[{ label: "branch", value: R.REPO.branch }, { label: "pushed", value: `${R.REPO.pushedMin}m ago` }]} />
      <div className="shell">
        <Rail active="github" />
        <div className="main">
          <ModeStrip active="pulse" sync="github sync"
            modes={[
              { k: "summary", label: "Summary", href: "#" },
              { k: "repos", label: "Repositories", href: "#" },
              { k: "pulse", label: "Pulse", hint: "progress & changes", href: "Repo Pulse.html" },
            ]} />
          <div className="page">
            <section className="an-page">
              <div className="an-wrap">
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Pulse</h2>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-muted)" }}>{R.REPO.name}</span>
                      <span className="tag amber">● {R.REPO.pushedMin}m ago</span>
                      <span className="tag">{R.REPO.lang}</span>
                    </div>
                    <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{R.REPO.desc}</div>
                  </div>
                  <button className="btn ghost">open on github →</button>
                </div>

                <PulseDigest />
                <KpiRow />

                <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                    <Velocity />
                    <NetLines />
                    <ChurnByArea />
                    <FileChurn />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
                    <CIHealth />
                    <Contributors />
                    <Branches />
                    <ReviewLatency />
                  </div>
                </div>
              </div>
            </section>
          </div>
          <StatusBar items={[
            { tone: "", text: `CI ${R.CI.passRate}% · ${R.CI.runs} runs` },
            { tone: "warn", text: "release.yml 78%" },
            { tone: "", text: `${R.KPIS.commitsWeek} commits this week` },
          ]} />
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<PulseView />);
