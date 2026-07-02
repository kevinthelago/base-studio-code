// GitHub → Pulse analytics (#402; live data #413). Repo progress & changes from
// the GitHub API for the active repo — velocity, CI, churn, contributors,
// branches. Pure GitHub data (no fleet inference; fleet lives on the Fleet page).
// Fetch + assembly is in hooks/useRepoPulse; this renders the view model with
// loading / empty / error states using the shared chart primitives (#399).
import { useState } from "react";
import { Chip } from "@/shared/ui/data/Chip";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Card } from "@/shared/ui/data/Card";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  LineArea, Bars, Donut, HBars, Legend,
  StatCard, CardHead, RangeToggle, Avatar, useTip, fmt,
  type HBarRow, type StatTone,
} from "@/shared/ui/charts";
import type { GithubRepo } from "@/store";
import { BranchGraph } from "./BranchGraph";
import { useRepoPulse, type RepoPulseLive } from "./lib/useRepoPulse";
import type { VelocitySlice, ChurnArea, ChurnFile, Contributor, Workflow, Branch } from "@/shared/data/repoPulse";
import type { CiHealth, PulseKpis } from "./lib/repoPulseLive";
import { BRANCH_STATUS } from "@/shared/data/repoPulse";

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
    <Card style={{
      padding: "13px 18px", marginBottom: 14,
      background: "linear-gradient(135deg, color-mix(in oklch, var(--accent), transparent 88%), var(--bg-panel) 60%)",
      border: "1px solid var(--accent-dim)",
    }}>
      <Row gap={12} align="stretch">
        <Row className="mono" justify="center" style={{
          flexShrink: 0, width: 28, height: 28, borderRadius: 7,
          background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
          color: "#1a120a", fontWeight: 700, fontSize: 13,
        }}>G</Row>
        <Box style={{ flex: 1, fontSize: 12, lineHeight: 1.6, color: "var(--fg-muted)" }}>
          <Row align="baseline" gap={8} style={{ marginBottom: 3 }}>
            <Text as="span" mono size={11} tone="accent" style={{ textTransform: "uppercase", letterSpacing: ".06em" }}>repo pulse · last 14 days</Text>
            <Box as="span" className="hint">live from the GitHub API</Box>
          </Row>
          <Text as="p" style={{ margin: 0 }}>
            <Text weight={700} style={{ color: "var(--fg)" }}>{kpis.commitsWeek} commits</Text> and <Text weight={700} style={{ color: "var(--fg)" }}>{kpis.prsMerged} merged PRs</Text> in the last 7 days
            {kpis.contributors > 0 && <> across <Text weight={700} style={{ color: "var(--fg)" }}>{kpis.contributors} contributors</Text> ({kpis.botShare}% bot)</>}.
            CI pass rate is <Text weight={700} tone={ci.passRate >= 90 ? "success" : "danger"}>{ci.passRate}%</Text>.
            {hottest && <> Hottest area: <Text weight={700} style={{ color: "oklch(0.7 0.12 290)" }}>{hottest.area}</Text>.</>}
            {partialDiffs && <Box as="span" className="hint"> · line/churn panels reflect the most recent commits</Box>}
          </Text>
        </Box>
      </Row>
    </Card>
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
    <Box className="statgrid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
      {cards.map(c => <StatCard key={c.k} {...c} />)}
    </Box>
  );
}

// ── commit & PR velocity ─────────────────────────────────────────────────────
function Velocity({ velocity }: { velocity: VelocitySlice }) {
  const [range, setRange] = useState("14d");
  const tip = useTip();
  const d = sliceVelocity(velocity, range);
  return (
    <Box className="card">
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
    </Box>
  );
}

// ── lines changed ────────────────────────────────────────────────────────────
function NetLines({ velocity, partialDiffs }: { velocity: VelocitySlice; partialDiffs: boolean }) {
  const [range, setRange] = useState("14d");
  const tip = useTip();
  const d = sliceVelocity(velocity, range);
  return (
    <Box className="card">
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
    </Box>
  );
}

// ── churn by area ────────────────────────────────────────────────────────────
function ChurnByArea({ areas }: { areas: ChurnArea[] }) {
  if (!areas.length) return null;
  const rows: HBarRow[] = areas.map(a => ({
    label: a.area, value: a.add + a.del, color: a.color, strong: true,
    tag: <Text as="span" mono size={9} tone="dim">
      <Text as="span" tone="success">+{fmt(a.add)}</Text> / <Text as="span" tone="danger">−{fmt(a.del)}</Text> · {a.files}f
    </Text>,
  }));
  return (
    <Box className="card">
      <CardHead title="Churn by area" hint="lines changed · recent commits" />
      <HBars rows={rows} fmtV={(v) => fmt(v)} />
    </Box>
  );
}

// ── hottest files (heatmap grid) ─────────────────────────────────────────────
function FileChurn({ files }: { files: ChurnFile[] }) {
  if (!files.length) return null;
  const max = Math.max(...files.map(f => f.w));
  return (
    <Box className="card">
      <CardHead title="Hottest files" hint="±lines · recent commits · darker = hotter" />
      <Grid cols={4} gap={4}>
        {files.map(f => {
          const t = f.w / max;
          const a = 0.16 + 0.74 * t;
          const dark = t > 0.55;
          return (
            <Stack key={f.p} title={`${f.p} · ±${f.w}`} className="mono" justify="between" style={{
              padding: "8px 9px", borderRadius: 4, minHeight: 52,
              background: `color-mix(in oklch, var(--accent) ${Math.round(a * 100)}%, var(--bg-elev))`,
              border: "1px solid var(--border-soft)",
              fontSize: 9.5, lineHeight: 1.35,
              overflow: "hidden",
            }}>
              <Box as="span" style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: dark ? "#1a120a" : "var(--fg)" }}>{f.p.split("/").pop()}</Box>
              <Box as="span" style={{ fontSize: 8.5, color: dark ? "#1a120a" : "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.p.replace(/\/[^/]+$/, "") || "/"}</Box>
              <Text as="span" size={9.5} weight={600} style={{ color: dark ? "#1a120a" : "var(--fg-muted)" }}>±{f.w}</Text>
            </Stack>
          );
        })}
      </Grid>
    </Box>
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
    <Box className="card">
      <CardHead title="Contributors" hint="commits · bots vs humans (per GitHub)"
        right={<Text as="span" mono size={10} tone="dim">
          <Text as="span" tone="accent">◆ {botCommits}</Text> bot · <Text as="span" style={{ color: "var(--fg)" }}>{humanCommits}</Text> human
        </Text>} />
      <Row align="stretch" style={{ height: 8, borderRadius: 4, overflow: "hidden", background: "var(--bg-elev2)", marginBottom: 12 }}>
        <Box title="bots" bg="var(--accent)" style={{ width: `${botShare}%`}} />
        <Box title="humans" bg="oklch(0.68 0.12 250)" style={{ flex: 1}} />
      </Row>
      <Stack gap={7}>
        {sorted.map(c => (
          <Grid key={c.name} className="hrow" cols="minmax(0,1fr) 40px" gap={10} align="center" style={{ padding: "1px 2px", borderRadius: 4 }}>
            <Box style={{ minWidth: 0 }}>
              <Row className="mono" gap={7} style={{ marginBottom: 3, fontSize: 10.5, color: "var(--fg)" }}>
                <Avatar login={c.name} bot={c.bot} size={15} />
                <Box as="span" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</Box>
                <Chip tone={c.bot ? "accent" : "neutral"} style={{ fontSize: 8.5 }}>{c.bot ? "bot" : "human"}</Chip>
                {(c.add > 0 || c.del > 0) && (
                  <Text as="span" mono size={8.5} tone="dim">
                    <Text as="span" tone="success">+{fmt(c.add)}</Text> <Text as="span" tone="danger">−{fmt(c.del)}</Text>
                  </Text>
                )}
              </Row>
              <Box className="meter"><i style={{ width: `${c.commits / max * 100}%`, background: c.bot ? "var(--accent)" : "oklch(0.68 0.12 250)" }} /></Box>
            </Box>
            <Text as="div" mono size={11} style={{ textAlign: "right", color: "var(--fg)" }}>{c.commits}</Text>
          </Grid>
        ))}
      </Stack>
    </Box>
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
    <Box className="card">
      <CardHead title="CI health" hint={`${ci.runs} runs · 14d`} />
      {ci.runs === 0 ? (
        <Box className="hint" pad={[8, 2]}>No workflow runs in the window.</Box>
      ) : (
        <>
          <Row gap={16} style={{ marginBottom: 12 }}>
            <Donut slices={slices} size={112} thickness={14} center={{ value: `${ci.passRate}%`, label: "pass" }} />
            <Stack gap={6} style={{ flex: 1 }}>
              {slices.map(s => (
                <Grid key={s.name} className="mono" cols="12px 1fr 28px" gap={8} align="center" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
                  <ColorSwatch color={s.color} />
                  <Text>{s.name}</Text><Text as="span" style={{ textAlign: "right", color: "var(--fg)" }}>{s.value}</Text>
                </Grid>
              ))}
              <Box className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)", marginTop: 2 }}>avg duration {ci.avgMin}m</Box>
            </Stack>
          </Row>
          <Stack gap={5}>
            {workflows.map(w => (
              <Grid key={w.name} className="mono" cols="120px 1fr 34px" gap={8} align="center" style={{ fontSize: 10, color: "var(--fg-muted)" }}>
                <Box as="span" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.name}</Box>
                <Box className="meter" style={{ height: 5 }}><i style={{ width: `${w.pass}%`, background: w.pass >= 90 ? "var(--success)" : w.pass >= 80 ? "var(--accent)" : "var(--danger)" }} /></Box>
                <Text as="span" style={{ textAlign: "right", color: w.pass >= 90 ? "var(--success)" : "var(--fg)" }}>{w.pass}%</Text>
              </Grid>
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}

// ── branches ─────────────────────────────────────────────────────────────────
function Branches({ branches }: { branches: Branch[] }) {
  if (!branches.length) return null;
  return (
    <Box className="card">
      <CardHead title="Active branches" hint="ahead/behind the default branch"
        right={<Text as="span" mono size={10.5} tone="accent">{branches.length}</Text>} />
      <Stack gap={1} style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        {branches.map((b, i) => {
          const st = BRANCH_STATUS[b.status];
          return (
            <Grid key={b.n} className="hrow" cols="1fr 70px 70px" gap={8} align="center" style={{ padding: "8px 11px", fontSize: 11, background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)" }}>
              <Row gap={7} style={{ minWidth: 0 }}>
                {b.owner && <Avatar login={b.owner} bot={b.bot} size={15} />}
                <Box as="span" className="mono" style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.n}</Box>
              </Row>
              <Text as="span" mono size={9.5} tone="dim">
                <Text as="span" tone="success">↑{b.ahead}</Text> <Text as="span" tone="danger">↓{b.behind}</Text>
              </Text>
              <Text as="span" mono size={9.5} style={{ textAlign: "right", color: st.color }}>● {st.label}</Text>
            </Grid>
          );
        })}
      </Stack>
    </Box>
  );
}

// ── review latency ───────────────────────────────────────────────────────────
function ReviewLatency({ buckets, medianH }: { buckets: Array<{ label: string; v: number }>; medianH: number }) {
  const tip = useTip();
  const total = buckets.reduce((s, b) => s + b.v, 0);
  return (
    <Box className="card">
      <CardHead title="Review latency" hint="PR open → merged · last 14d" />
      {total === 0 ? (
        <Box className="hint" pad={[8, 2]}>No merged PRs in the window.</Box>
      ) : (
        <>
          <Bars labels={buckets.map(b => b.label)} height={116} tip={tip}
            groups={[{ name: "PRs", color: "var(--info)", data: buckets.map(b => b.v) }]} />
          <Box className="mono" style={{ marginTop: 6, fontSize: 10, color: "var(--fg-dim)", textAlign: "center" }}>
            median <b style={{ color: "var(--fg)" }}>{medianH}h</b> over {total} merged PR{total === 1 ? "" : "s"}
          </Box>
        </>
      )}
      {tip.node}
    </Box>
  );
}

// ── states ───────────────────────────────────────────────────────────────────
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <Box as="section" className="an-page">
      <Row className="mono" justify="center" style={{ flex: 1, padding: 48, color: "var(--fg-muted)", fontSize: 13 }}>
        {children}
      </Row>
    </Box>
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
    <Box as="section" className="an-page">
      <Box className="an-wrap">
        <Row align="start" gap={14} style={{ marginBottom: 14 }}>
          <Box style={{ flex: 1 }}>
            <Row align="baseline" gap={10} wrap>
              <Text as="h2" mono size={20} weight={600} style={{ margin: 0 }}>Pulse</Text>
              <Text as="span" mono size={13} tone="muted">{r.name}</Text>
              <Chip tone="accent">● {r.pushedMin}m ago</Chip>
              <Chip>{r.lang}</Chip>
            </Row>
            {r.desc && <Text as="div" tone="muted" size="md" style={{ marginTop: 4 }}>{r.desc}</Text>}
          </Box>
          <Button variant="ghost" onClick={() => openUrl(`https://github.com/${r.name}`)}>open on github →</Button>
        </Row>

        <PulseDigest kpis={data.kpis} churnAreas={data.churnAreas} ci={data.ci} partialDiffs={data.partialDiffs} />
        <KpiRow kpis={data.kpis} runs={data.ci.runs} />

        {/* The branches map — carried over from the old Repositories view. */}
        <Box style={{ marginBottom: 14 }}>
          <BranchGraph repo={repo} />
        </Box>

        <Grid cols="1.6fr 1fr" gap={14}>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <Velocity velocity={data.velocity} />
            <NetLines velocity={data.velocity} partialDiffs={data.partialDiffs} />
            <ChurnByArea areas={data.churnAreas} />
            <FileChurn files={data.hottestFiles} />
          </Stack>
          <Stack gap={14} style={{ minWidth: 0 }}>
            <CIHealth ci={data.ci} workflows={data.workflows} />
            <Contributors contributors={data.contributors} />
            <Branches branches={data.branches} />
            <ReviewLatency buckets={data.reviewBuckets} medianH={data.kpis.reviewLatencyH} />
          </Stack>
        </Grid>
      </Box>
    </Box>
  );
}
