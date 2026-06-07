// GitHub → Pulse analytics (#402; live data #413). Repo progress & changes from
// the GitHub API for the active repo — velocity, CI, churn, contributors,
// branches. Pure GitHub data (no fleet inference; fleet lives on the Fleet page).
// Fetch + assembly is in hooks/useRepoPulse; this renders the view model with
// loading / empty / error states using the shared chart primitives (#399).
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  LineArea, Bars, Donut, HBars, Legend,
  StatCard, CardHead, RangeToggle, Avatar, useTip, fmt,
  type HBarRow, type StatTone,
} from "../../components/charts";
import type { GithubRepo } from "../../store";
import { BranchGraph } from "./BranchGraph";
import { useRepoPulse, type RepoPulseLive } from "../../hooks/useRepoPulse";
import type { VelocitySlice, ChurnArea, ChurnFile, Contributor, Workflow, Branch } from "../../data/repoPulse";
import type { CiHealth, PulseKpis } from "../../lib/repoPulseLive";
import { BRANCH_STATUS } from "../../data/repoPulse";

/** Last 7 or 14 days of a velocity slice (the series are stored 14-wide). */
function sliceVelocity(v: VelocitySlice, range: string): VelocitySlice {
  const n = range === "7d" ? 7 : v.labels.length;
  const last = <T,>(a: T[]) => a.slice(-n);
  return { labels: last(v.labels), commits: last(v.commits), merged: last(v.merged), opened: last(v.opened), adds: last(v.adds), dels: last(v.dels) };
}

// ── digest (factual summary derived from live data) ──────────────────────────
function PulseDigest({ kpis, churnAreas, ci, partialDiffs }: { kpis: PulseKpis; churnAreas: ChurnArea[]; ci: CiHealth; partialDiffs: boolean }) {
  const hottest = churnAreas[0];
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
        }}>G</div>
        <div style={{ flex: 1, fontSize: 12, lineHeight: 1.6, color: "var(--fg-muted)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".06em" }}>repo pulse · last 14 days</span>
            <span className="hint">live from the GitHub API</span>
          </div>
          <p style={{ margin: 0 }}>
            <b style={{ color: "var(--fg)" }}>{kpis.commitsWeek} commits</b> and <b style={{ color: "var(--fg)" }}>{kpis.prsMerged} merged PRs</b> in the last 7 days
            {kpis.contributors > 0 && <> across <b style={{ color: "var(--fg)" }}>{kpis.contributors} contributors</b> ({kpis.botShare}% bot)</>}.
            CI pass rate is <b style={{ color: ci.passRate >= 90 ? "var(--success)" : "var(--danger)" }}>{ci.passRate}%</b>.
            {hottest && <> Hottest area: <b style={{ color: "oklch(0.7 0.12 290)" }}>{hottest.area}</b>.</>}
            {partialDiffs && <span className="hint"> · line/churn panels reflect the most recent commits</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── KPI row ──────────────────────────────────────────────────────────────────
function KpiRow({ kpis, runs }: { kpis: PulseKpis; runs: number }) {
  const cards: Array<{ k: string; v: string; sub: string; tone?: StatTone }> = [
    { k: "commits · 7d", v: String(kpis.commitsWeek), sub: "on the default branch", tone: "fg" },
    { k: "PRs merged · 7d", v: String(kpis.prsMerged), sub: "merged pull requests", tone: "accent" },
    { k: "net lines · 7d", v: `${kpis.netLines >= 0 ? "+" : ""}${fmt(kpis.netLines)}`, sub: "added − removed", tone: kpis.netLines >= 0 ? "success" : "danger" },
    { k: "CI pass rate", v: `${kpis.passRate}%`, sub: `${runs} runs`, tone: kpis.passRate >= 90 ? "success" : "fg" },
    { k: "review latency", v: kpis.reviewLatencyH ? `${kpis.reviewLatencyH}h` : "—", sub: "open → merge median", tone: "fg" },
    { k: "contributors", v: String(kpis.contributors), sub: `${kpis.botShare}% bot commits`, tone: "info" },
  ];
  return (
    <div className="statgrid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
      {cards.map(c => <StatCard key={c.k} {...c} />)}
    </div>
  );
}

// ── commit & PR velocity ─────────────────────────────────────────────────────
function Velocity({ velocity }: { velocity: VelocitySlice }) {
  const [range, setRange] = useState("14d");
  const tip = useTip();
  const d = sliceVelocity(velocity, range);
  return (
    <div className="card">
      <CardHead title="Commit & PR velocity" hint="daily commits, PRs opened vs merged"
        right={<RangeToggle value={range} onChange={setRange} options={["7d", "14d"]} />} />
      <LineArea labels={d.labels} height={160} tip={tip} series={[
        { name: "commits", color: "var(--info)", data: d.commits },
        { name: "PRs opened", color: "var(--fg-muted)", data: d.opened, fill: false, dash: "4 3", dotR: 1.8 },
        { name: "PRs merged", color: "var(--accent)", data: d.merged, fill: false },
      ]} />
      <Legend style={{ marginTop: 8 }} items={[
        { color: "var(--info)", label: "commits" },
        { color: "var(--fg-muted)", label: "PRs opened" },
        { color: "var(--accent)", label: "PRs merged" },
      ]} />
      {tip.node}
    </div>
  );
}

// ── lines changed ────────────────────────────────────────────────────────────
function NetLines({ velocity, partialDiffs }: { velocity: VelocitySlice; partialDiffs: boolean }) {
  const [range, setRange] = useState("14d");
  const tip = useTip();
  const d = sliceVelocity(velocity, range);
  return (
    <div className="card">
      <CardHead title="Lines changed" hint={partialDiffs ? "additions vs deletions · recent commits" : "additions vs deletions / day"}
        right={<RangeToggle value={range} onChange={setRange} options={["7d", "14d"]} />} />
      <Bars labels={d.labels} height={140} fmtY={(v) => fmt(v)} tip={tip} groups={[
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
function ChurnByArea({ areas }: { areas: ChurnArea[] }) {
  if (!areas.length) return null;
  const rows: HBarRow[] = areas.map(a => ({
    label: a.area, value: a.add + a.del, color: a.color, strong: true,
    tag: <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
      <span style={{ color: "var(--success)" }}>+{fmt(a.add)}</span> / <span style={{ color: "var(--danger)" }}>−{fmt(a.del)}</span> · {a.files}f
    </span>,
  }));
  return (
    <div className="card">
      <CardHead title="Churn by area" hint="lines changed · recent commits" />
      <HBars rows={rows} fmtV={(v) => fmt(v)} />
    </div>
  );
}

// ── hottest files (heatmap grid) ─────────────────────────────────────────────
function FileChurn({ files }: { files: ChurnFile[] }) {
  if (!files.length) return null;
  const max = Math.max(...files.map(f => f.w));
  return (
    <div className="card">
      <CardHead title="Hottest files" hint="±lines · recent commits · darker = hotter" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        {files.map(f => {
          const t = f.w / max;
          const a = 0.16 + 0.74 * t;
          const dark = t > 0.55;
          return (
            <div key={f.p} title={`${f.p} · ±${f.w}`} style={{
              padding: "8px 9px", borderRadius: 4, minHeight: 52,
              background: `color-mix(in oklch, var(--accent) ${Math.round(a * 100)}%, var(--bg-elev))`,
              border: "1px solid var(--border-soft)",
              fontFamily: "var(--mono)", fontSize: 9.5, lineHeight: 1.35,
              display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden",
            }}>
              <span style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: dark ? "#1a120a" : "var(--fg)" }}>{f.p.split("/").pop()}</span>
              <span style={{ fontSize: 8.5, color: dark ? "#1a120a" : "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.p.replace(/\/[^/]+$/, "") || "/"}</span>
              <span style={{ fontSize: 9.5, fontWeight: 600, color: dark ? "#1a120a" : "var(--fg-muted)" }}>±{f.w}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── contributors (bot vs human, GitHub-attributed) ───────────────────────────
function Contributors({ contributors }: { contributors: Contributor[] }) {
  if (!contributors.length) return null;
  const sorted = [...contributors].sort((a, b) => b.commits - a.commits);
  const max = Math.max(...sorted.map(c => c.commits), 1);
  const botCommits = sorted.filter(c => c.bot).reduce((s, c) => s + c.commits, 0);
  const humanCommits = sorted.filter(c => !c.bot).reduce((s, c) => s + c.commits, 0);
  const botShare = botCommits + humanCommits ? Math.round(botCommits / (botCommits + humanCommits) * 100) : 0;
  return (
    <div className="card">
      <CardHead title="Contributors" hint="commits · bots vs humans (per GitHub)"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
          <span style={{ color: "var(--accent)" }}>◆ {botCommits}</span> bot · <span style={{ color: "var(--fg)" }}>{humanCommits}</span> human
        </span>} />
      <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", background: "var(--bg-elev2)", marginBottom: 12 }}>
        <div title="bots" style={{ width: `${botShare}%`, background: "var(--accent)" }} />
        <div title="humans" style={{ flex: 1, background: "oklch(0.68 0.12 250)" }} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {sorted.map(c => (
          <div key={c.name} className="hrow" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 40px", gap: 10, alignItems: "center", padding: "1px 2px", borderRadius: 4 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>
                <Avatar login={c.name} bot={c.bot} size={15} />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                <span className={"tag " + (c.bot ? "amber" : "")} style={{ fontSize: 8.5 }}>{c.bot ? "bot" : "human"}</span>
                {(c.add > 0 || c.del > 0) && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)" }}>
                    <span style={{ color: "var(--success)" }}>+{fmt(c.add)}</span> <span style={{ color: "var(--danger)" }}>−{fmt(c.del)}</span>
                  </span>
                )}
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

// ── CI health ────────────────────────────────────────────────────────────────
function CIHealth({ ci, workflows }: { ci: CiHealth; workflows: Workflow[] }) {
  const slices = [
    { name: "passed", value: ci.passed, color: "var(--success)" },
    { name: "failed", value: ci.failed, color: "var(--danger)" },
    { name: "cancelled", value: ci.cancelled, color: "var(--fg-dim)" },
  ];
  return (
    <div className="card">
      <CardHead title="CI health" hint={`${ci.runs} runs · 14d`} />
      {ci.runs === 0 ? (
        <div className="hint" style={{ padding: "8px 2px" }}>No workflow runs in the window.</div>
      ) : (
        <>
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
            {workflows.map(w => (
              <div key={w.name} style={{ display: "grid", gridTemplateColumns: "120px 1fr 34px", gap: 8, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</span>
                <div className="meter" style={{ height: 5 }}><i style={{ width: `${w.pass}%`, background: w.pass >= 90 ? "var(--success)" : w.pass >= 80 ? "var(--accent)" : "var(--danger)" }} /></div>
                <span style={{ textAlign: "right", color: w.pass >= 90 ? "var(--success)" : "var(--fg)" }}>{w.pass}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── branches ─────────────────────────────────────────────────────────────────
function Branches({ branches }: { branches: Branch[] }) {
  if (!branches.length) return null;
  return (
    <div className="card">
      <CardHead title="Active branches" hint="ahead/behind the default branch"
        right={<span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>{branches.length}</span>} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        {branches.map((b, i) => {
          const st = BRANCH_STATUS[b.status];
          return (
            <div key={b.n} className="hrow" style={{ display: "grid", gridTemplateColumns: "1fr 70px 70px", gap: 8, alignItems: "center", padding: "8px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                {b.owner && <Avatar login={b.owner} bot={b.bot} size={15} />}
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
function ReviewLatency({ buckets, medianH }: { buckets: Array<{ label: string; v: number }>; medianH: number }) {
  const tip = useTip();
  const total = buckets.reduce((s, b) => s + b.v, 0);
  return (
    <div className="card">
      <CardHead title="Review latency" hint="PR open → merged · last 14d" />
      {total === 0 ? (
        <div className="hint" style={{ padding: "8px 2px" }}>No merged PRs in the window.</div>
      ) : (
        <>
          <Bars labels={buckets.map(b => b.label)} height={116} tip={tip}
            groups={[{ name: "PRs", color: "var(--info)", data: buckets.map(b => b.v) }]} />
          <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "center" }}>
            median <b style={{ color: "var(--fg)" }}>{medianH}h</b> over {total} merged PR{total === 1 ? "" : "s"}
          </div>
        </>
      )}
      {tip.node}
    </div>
  );
}

// ── states ───────────────────────────────────────────────────────────────────
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <section className="an-page">
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 48, color: "var(--fg-muted)", fontFamily: "var(--mono)", fontSize: 13 }}>
        {children}
      </div>
    </section>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export function Pulse({ repo }: { repo: GithubRepo | null }) {
  const { data, loading, error } = useRepoPulse(repo);

  if (!repo) return <Centered>Select a repository to see its pulse.</Centered>;
  if (error) return <Centered>{error}</Centered>;
  if (!data) return <Centered>{loading ? "Loading repo data from GitHub…" : "No data."}</Centered>;
  return <PulseBody data={data} repo={repo} />;
}

function PulseBody({ data, repo }: { data: RepoPulseLive; repo: GithubRepo }) {
  const r = data.repo;
  return (
    <section className="an-page">
      <div className="an-wrap">
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Pulse</h2>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-muted)" }}>{r.name}</span>
              <span className="tag amber">● {r.pushedMin}m ago</span>
              <span className="tag">{r.lang}</span>
            </div>
            {r.desc && <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>{r.desc}</div>}
          </div>
          <button className="btn ghost" onClick={() => openUrl(`https://github.com/${r.name}`)}>open on github →</button>
        </div>

        <PulseDigest kpis={data.kpis} churnAreas={data.churnAreas} ci={data.ci} partialDiffs={data.partialDiffs} />
        <KpiRow kpis={data.kpis} runs={data.ci.runs} />

        {/* The branches map — carried over from the old Repositories view. */}
        <div style={{ marginBottom: 14 }}>
          <BranchGraph repo={repo} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <Velocity velocity={data.velocity} />
            <NetLines velocity={data.velocity} partialDiffs={data.partialDiffs} />
            <ChurnByArea areas={data.churnAreas} />
            <FileChurn files={data.hottestFiles} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <CIHealth ci={data.ci} workflows={data.workflows} />
            <Contributors contributors={data.contributors} />
            <Branches branches={data.branches} />
            <ReviewLatency buckets={data.reviewBuckets} medianH={data.kpis.reviewLatencyH} />
          </div>
        </div>
      </div>
    </section>
  );
}
