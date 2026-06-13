import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useAppStore } from "../../store";
import { githubRequest, githubGraphql } from "../../lib/github";
import { parseProjectIteration, type BurndownResult, type ProjectIterationNode } from "./burndown";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GhProject {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  closed: boolean;
  updatedAt: string;
  items: { totalCount: number };
  repositories: { nodes: Array<{ nameWithOwner: string }> };
}

interface GhMilestone {
  number: number;
  title: string;
  due_on: string | null;
  open_issues: number;
  closed_issues: number;
  state: string;
}

interface GhIssue {
  number: number;
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  pull_request?: unknown;
}

interface GHEvent {
  id: string;
  type: string;
  actor: { login: string };
  repo: { name: string };
  payload: unknown;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function loginColor(login: string): string {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  return `oklch(0.68 0.12 ${h % 360})`;
}

const PROJECT_COLORS = [
  "oklch(0.78 0.14 70)",
  "oklch(0.7 0.10 220)",
  "oklch(0.7 0.12 145)",
  "oklch(0.6 0.06 50)",
  "oklch(0.7 0.12 290)",
  "oklch(0.45 0 0)",
];

// ── GraphQL query ─────────────────────────────────────────────────────────────

const PROJECTS_SUMMARY_QUERY = `{
  viewer {
    projectsV2(first: 20) {
      nodes {
        id number title shortDescription closed updatedAt
        items { totalCount }
        repositories(first: 5) { nodes { nameWithOwner } }
      }
    }
  }
}`;

// Fetches one project's Iteration + Status fields and items (with close times) so
// the burn-down can be computed from real iteration data. See burndown.ts.
const PROJECT_ITERATION_QUERY = `query ProjectIteration($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      title
      fields(first: 30) {
        nodes {
          __typename
          ... on ProjectV2IterationField {
            name
            configuration {
              iterations { id title startDate duration }
              completedIterations { id title startDate duration }
            }
          }
          ... on ProjectV2SingleSelectField { name options { id name } }
        }
      }
      items(first: 100) {
        nodes {
          content {
            __typename
            ... on Issue { closed closedAt }
            ... on PullRequest { closed closedAt }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldIterationValue { iterationId field { ... on ProjectV2IterationField { name } } }
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
            }
          }
        }
      }
    }
  }
}`;

// ── Data hook ─────────────────────────────────────────────────────────────────

function useProjectsSummaryData() {
  const { githubToken, githubUser } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<GhProject[]>([]);
  const [events, setEvents] = useState<GHEvent[]>([]);
  const [repoMilestones, setRepoMilestones] = useState<Record<string, GhMilestone[]>>({});
  const [repoIssues, setRepoIssues] = useState<Record<string, GhIssue[]>>({});
  const [burndown, setBurndown] = useState<BurndownResult | null>(null);

  useEffect(() => {
    if (!githubToken || !githubUser) return;
    const login = githubUser.login;
    setLoading(true);

    const projectsP = githubGraphql<{ viewer: { projectsV2: { nodes: GhProject[] } } }>(PROJECTS_SUMMARY_QUERY, null)
      .then(d => d?.viewer?.projectsV2?.nodes ?? []).catch((): GhProject[] => []);

    const eventsP = githubRequest<GHEvent[]>(`users/${login}/events?per_page=100`).catch((): GHEvent[] => []);

    Promise.all([projectsP, eventsP]).then(([projs, evts]) => {
      const projArr = Array.isArray(projs) ? projs : [];
      const evtArr = Array.isArray(evts) ? evts : [];
      setProjects(projArr);
      setEvents(evtArr);

      // Iteration burn-down for the lead project (first active with items): pull
      // its Iteration/Status fields + items and resolve the current iteration.
      const lead = projArr.find(p => !p.closed && p.items.totalCount > 0);
      if (lead) {
        githubGraphql<{ node: ProjectIterationNode | null }>(PROJECT_ITERATION_QUERY, { projectId: lead.id })
          .then(d => setBurndown(parseProjectIteration(d?.node ?? null, Date.now())))
          .catch(() => setBurndown({ status: "no-field" }));
      } else {
        setBurndown({ status: "no-field" });
      }

      // Collect unique repos from all projects
      const slugSet = new Set<string>();
      projArr.forEach(p => p.repositories.nodes.forEach(r => slugSet.add(r.nameWithOwner)));
      const slugs = Array.from(slugSet).slice(0, 6);

      if (slugs.length === 0) { setLoading(false); return; }

      const eightWeeksAgo = new Date(Date.now() - 56 * 86400000).toISOString();

      Promise.all(slugs.map(slug => Promise.all([
        githubRequest<GhMilestone[]>(
          `repos/${slug}/milestones?state=open&sort=due_on&direction=asc&per_page=10`,
        ).catch((): GhMilestone[] => []),
        githubRequest<GhIssue[]>(
          `repos/${slug}/issues?state=all&per_page=100&sort=created&direction=desc&since=${eightWeeksAgo}`,
        ).catch((): GhIssue[] => []),
      ]))).then(results => {
        const ms: Record<string, GhMilestone[]> = {};
        const is: Record<string, GhIssue[]> = {};
        slugs.forEach((slug, i) => {
          const [milestones, issues] = results[i] as [GhMilestone[], GhIssue[]];
          ms[slug] = Array.isArray(milestones) ? milestones : [];
          is[slug] = Array.isArray(issues) ? issues : [];
        });
        setRepoMilestones(ms);
        setRepoIssues(is);
        setLoading(false);
      }).catch(() => setLoading(false));
    }).catch(() => setLoading(false));
  }, [githubToken, githubUser?.login]); // eslint-disable-line react-hooks/exhaustive-deps

  return { loading, projects, events, repoMilestones, repoIssues, burndown };
}

// ── Shared page-mode strip ────────────────────────────────────────────────────

export function ProjectsPageModeStrip() {
  const { projectsPageMode, setProjectsPageMode } = useAppStore();
  const modes = [
    { k: "projects",   label: "Projects",    hint: "drill into a project" },
    { k: "fleet",      label: "Fleet",       hint: "live orchestration" },
    { k: "blueprints", label: "Blueprints",  hint: "planning presets" },
    { k: "dataModels", label: "Data Models", hint: "canonical schemas" },
  ] as const;
  return (
    <div style={{
      padding: "0 24px",
      borderBottom: "1px solid var(--border-soft)",
      background: "var(--bg-panel)",
      display: "flex", alignItems: "center", gap: 6,
      fontFamily: "var(--mono)", fontSize: 11.5,
      height: 34, flex: "0 0 34px",
    }}>
      {modes.map(m => {
        const on = m.k === projectsPageMode;
        return (
          <div key={m.k} onClick={() => setProjectsPageMode(m.k)} style={{
            padding: "0 12px", height: 34,
            display: "flex", alignItems: "center", gap: 8,
            borderBottom: "2px solid " + (on ? "var(--accent)" : "transparent"),
            color: on ? "var(--accent)" : "var(--fg-muted)",
            cursor: "pointer",
          }}>
            {m.label}
            {on && <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>· {m.hint}</span>}
          </div>
        );
      })}
      <div style={{ flex: 1 }} />
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Avatar({ login, size = 20 }: { login: string; size?: number }) {
  const color = loginColor(login);
  return (
    <span style={{
      width: size, height: size, borderRadius: "50%",
      background: color, color: "#1a120a",
      fontFamily: "var(--mono)", fontWeight: 700, fontSize: size * 0.5,
      display: "flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      {login[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

function ProjectSparkline({ data, color, w = 80, h = 18 }: { data: number[]; color: string; w?: number; h?: number }) {
  if (data.length < 2 || data.every(v => v === 0)) return null;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── AI weekly digest (static — generated by Claude) ───────────────────────────

function AISummary() {
  return (
    <div className="card" style={{
      padding: "14px 18px",
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
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".06em" }}>
              weekly digest · claude
            </span>
            <span className="hint">generated 02:00 today · run #14</span>
            <div style={{ flex: 1 }} />
            <button className="btn ghost" style={{ height: 22, fontSize: 10 }}>regenerate</button>
          </div>
          <p style={{ margin: 0 }}>
            Portfolio is on track — active projects are progressing against open milestones.
            Cross-project activity shows consistent momentum. Check upcoming milestones
            and velocity trends below for details.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Iteration burn-down (real, from the project's Projects V2 Iteration field) ──

function BurnCard({ hint, badge, children }: {
  hint: string;
  badge?: { text: string; tone: string };
  children?: ReactNode;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Iteration burn-down</h3>
        <span className="hint">{hint}</span>
        <div style={{ flex: 1 }} />
        {badge && <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: badge.tone }}>● {badge.text}</span>}
      </div>
      {children}
    </div>
  );
}

const burnNote = (text: string): ReactNode => (
  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "12px 0" }}>{text}</div>
);

function IterationBurnDown({ data, loading }: { data: BurndownResult | null; loading: boolean }) {
  if (loading && !data) return <BurnCard hint="loading…">{burnNote("loading…")}</BurnCard>;
  if (!data || data.status === "no-field")
    return <BurnCard hint="Projects V2 Iteration field">{burnNote("No Iteration field on the lead project — add one in the project's field settings to see a real burn-down.")}</BurnCard>;
  if (data.status === "no-active-iteration")
    return <BurnCard hint={data.projectTitle}>{burnNote("No active iteration right now (today is between iterations).")}</BurnCard>;

  const { series, projectTitle, iterationTitle } = data;
  if (series.total === 0)
    return <BurnCard hint={`${projectTitle} · ${iterationTitle}`}>{burnNote("No items assigned to this iteration yet.")}</BurnCard>;

  const { total, daysTotal, daysElapsed, ideal, actual, remaining, onTrack } = series;
  const W = 720, H = 180, PAD = { l: 36, r: 20, t: 14, b: 24 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (i / daysTotal) * innerW;
  const y = (v: number) => PAD.t + (1 - v / total) * innerH;
  const idealPath = ideal.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(v)}`).join(" ");
  const pts = actual.flatMap((v, i) => (v != null ? [{ v, i }] : []));
  const actualPath = pts.map((p, k) => `${k === 0 ? "M" : "L"} ${x(p.i)} ${y(p.v)}`).join(" ");
  const yTicks = [0, Math.round(total * 0.25), Math.round(total * 0.5), Math.round(total * 0.75), total];

  return (
    <BurnCard
      hint={`${projectTitle} · ${iterationTitle} · day ${daysElapsed + 1}/${daysTotal}`}
      badge={{ text: onTrack ? "on track" : "behind", tone: onTrack ? "var(--success)" : "var(--danger)" }}
    >
      <svg width={W} height={H} style={{ width: "100%", maxWidth: W, display: "block" }}>
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PAD.l} y1={y(v)} x2={W - PAD.r} y2={y(v)} stroke="var(--border-soft)" strokeDasharray="2 3" />
            <text x={PAD.l - 4} y={y(v) + 3} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{v}</text>
          </g>
        ))}
        {ideal.map((_, i) => i % 2 === 0 ? (
          <text key={i} x={x(i)} y={H - PAD.b + 12} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">d{i + 1}</text>
        ) : null)}
        <path d={idealPath} fill="none" stroke="var(--fg-dim)" strokeDasharray="3 4" strokeWidth="1.5" />
        <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {pts.map(p => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r="2.5" fill="var(--accent)" />)}
        <line x1={x(daysElapsed)} y1={PAD.t} x2={x(daysElapsed)} y2={H - PAD.b} stroke="var(--accent)" strokeDasharray="2 3" strokeWidth="1" />
        <text x={x(daysElapsed)} y={PAD.t - 3} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">today</text>
        <text x={x(daysTotal) - 2} y={y(remaining) - 6} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">remaining · {remaining}</text>
        <text x={x(daysTotal) - 2} y={y(0) - 6} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">ideal · 0</text>
      </svg>
    </BurnCard>
  );
}

// ── Where the team is (project allocation) ────────────────────────────────────

function ProjectAllocation({ projects }: { projects: GhProject[] }) {
  const active = projects.filter(p => !p.closed && p.items.totalCount > 0);
  const total = active.reduce((s, p) => s + p.items.totalCount, 0);

  const items = active.map((p, i) => ({
    n: p.title,
    pct: total > 0 ? Math.round(p.items.totalCount / total * 100) : 0,
    c: PROJECT_COLORS[i % PROJECT_COLORS.length],
  }));

  if (items.length === 0) {
    return (
      <div className="card" style={{ padding: "14px 16px" }}>
        <h3 style={{ margin: 0, marginBottom: 10 }}>Where the team is</h3>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>No active projects with items.</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Where the team is</h3>
        <span className="hint">share of in-progress work by project items</span>
      </div>
      <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "var(--bg-elev2)", marginBottom: 12 }}>
        {items.map(it => (
          <div key={it.n} title={`${it.n} · ${it.pct}%`} style={{ width: `${it.pct}%`, background: it.c }} />
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
        {items.map(it => (
          <div key={it.n} style={{ display: "grid", gridTemplateColumns: "12px 1fr 40px", gap: 8, alignItems: "center" }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: it.c, display: "inline-block" }} />
            <span style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.n}</span>
            <span style={{ textAlign: "right", color: "var(--fg-dim)" }}>{it.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Velocity ──────────────────────────────────────────────────────────────────

function VelocityCard({ repoIssues, loading }: {
  repoIssues: Record<string, GhIssue[]>;
  loading: boolean;
}) {
  const { opened, closed, weekLabels, avgClosed } = useMemo(() => {
    const opened = new Array(8).fill(0);
    const closed = new Array(8).fill(0);
    const now = Date.now();

    Object.values(repoIssues).forEach(issues => {
      issues.forEach(issue => {
        if (issue.pull_request) return;
        const createdWeeksAgo = Math.floor((now - new Date(issue.created_at).getTime()) / (7 * 86400000));
        if (createdWeeksAgo < 8) opened[7 - createdWeeksAgo]++;
        if (issue.state === "closed" && issue.closed_at) {
          const closedWeeksAgo = Math.floor((now - new Date(issue.closed_at).getTime()) / (7 * 86400000));
          if (closedWeeksAgo < 8) closed[7 - closedWeeksAgo]++;
        }
      });
    });

    const weekLabels = Array.from({ length: 8 }, (_, i) => {
      const d = new Date(now - (7 - i) * 7 * 86400000);
      const start = new Date(d.getFullYear(), 0, 0);
      const week = Math.floor((d.getTime() - start.getTime()) / (7 * 86400000));
      return `w${week}`;
    });

    const avgClosed = (closed.reduce((s, v) => s + v, 0) / 8).toFixed(1);
    return { opened, closed, weekLabels, avgClosed };
  }, [repoIssues]);

  const hasData = Object.keys(repoIssues).length > 0;
  const maxV = Math.max(...opened, ...closed, 1);

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Velocity</h3>
        <span className="hint">{loading ? "loading…" : hasData ? "issues opened vs closed · last 8 weeks" : "no data"}</span>
      </div>
      {!hasData && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "4px 0" }}>No issue data available.</div>
      )}
      {(hasData || loading) && (
        <>
          <svg width="100%" height="100" viewBox="0 0 320 100">
            {[0, Math.round(maxV * 0.25), Math.round(maxV * 0.5), Math.round(maxV * 0.75), maxV].map(v => (
              <line key={v} x1={30} y1={90 - (v / maxV) * 80} x2={310} y2={90 - (v / maxV) * 80}
                stroke="var(--border-soft)" strokeDasharray="2 3" />
            ))}
            {weekLabels.map((w, i) => {
              const cx = 30 + (i / (weekLabels.length - 1)) * 280;
              const colW = 14;
              const oH = (opened[i] / maxV) * 80;
              const cH = (closed[i] / maxV) * 80;
              return (
                <g key={w}>
                  <rect x={cx - colW} y={90 - oH} width={colW - 1} height={oH}
                    fill="color-mix(in oklch, var(--info), transparent 50%)" />
                  <rect x={cx + 1} y={90 - cH} width={colW - 1} height={cH}
                    fill="var(--accent)" />
                  <text x={cx} y={99} textAnchor="middle" fontFamily="var(--mono)" fontSize="8" fill="var(--fg-dim)">{w}</text>
                </g>
              );
            })}
          </svg>
          <div style={{ display: "flex", gap: 14, marginTop: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
            <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "color-mix(in oklch, var(--info), transparent 50%)" }} /> opened</span>
            <span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--accent)" }} /> closed</span>
            <div style={{ flex: 1 }} />
            <span>avg <b style={{ color: "var(--fg)" }}>{loading ? "…" : `${avgClosed} closed/wk`}</b></span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Upcoming milestones ───────────────────────────────────────────────────────

function UpcomingMilestones({ repoMilestones, loading }: {
  repoMilestones: Record<string, GhMilestone[]>;
  loading: boolean;
}) {
  const upcoming = useMemo(() => {
    const now = Date.now();
    const all: Array<{ title: string; repo: string; weeksFromNow: number; pct: number; overdue: boolean }> = [];
    Object.entries(repoMilestones).forEach(([slug, milestones]) => {
      const repoName = slug.split("/")[1] ?? slug;
      milestones.forEach(ms => {
        if (!ms.due_on) return;
        const weeksFromNow = (new Date(ms.due_on).getTime() - now) / (7 * 86400000);
        if (weeksFromNow > 8) return; // beyond window
        const total = ms.open_issues + ms.closed_issues;
        const pct = total > 0 ? ms.closed_issues / total : 0;
        all.push({ title: ms.title, repo: repoName, weeksFromNow, pct, overdue: weeksFromNow < 0 });
      });
    });
    return all.sort((a, b) => a.weeksFromNow - b.weeksFromNow).slice(0, 6);
  }, [repoMilestones]);

  const hasData = Object.keys(repoMilestones).length > 0;
  const numLines = upcoming.length;

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>Upcoming milestones</h3>
        <span className="hint">{loading ? "loading…" : hasData ? `across all project repos · 8-week view` : "no data"}</span>
        <div style={{ flex: 1 }} />
        {upcoming.length > 0 && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--accent)" }}>
            {upcoming.length} due in next 8w
          </span>
        )}
      </div>

      {!hasData && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "4px 0" }}>No milestones due in the next 8 weeks.</div>
      )}

      {(hasData || loading) && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 14, marginBottom: 8 }}>
            <div />
            <div style={{ position: "relative", height: 18, display: "grid", gridTemplateColumns: "repeat(8, 1fr)" }}>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} style={{
                  fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)",
                  borderLeft: i === 0 ? "none" : "1px dashed var(--border-soft)",
                  paddingLeft: 6, paddingTop: 2,
                }}>w{i + 1}</div>
              ))}
              <div style={{
                position: "absolute", top: 0, bottom: -(numLines * 30 + 10),
                left: 0, width: 0,
                borderLeft: "1.5px dashed var(--accent)", zIndex: 2,
              }}>
                <span style={{ position: "absolute", top: -2, left: 4, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--accent)" }}>today</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {upcoming.map((m, idx) => {
              const barEnd = Math.max(0.01, Math.min(8, m.weeksFromNow));
              const barStart = Math.max(0, barEnd - 0.7);
              const c = m.overdue ? "var(--danger)" : "var(--accent)";
              const bgC = m.overdue ? "oklch(0.65 0.15 10)" : "oklch(0.78 0.14 70)";
              return (
                <div key={idx} style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 14, alignItems: "center" }}>
                  <div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: m.overdue ? "var(--danger)" : "var(--accent)" }}>{m.title}</div>
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{m.repo}</div>
                  </div>
                  <div style={{ position: "relative", height: 24 }}>
                    {Array.from({ length: 8 }, (_, i) => (
                      <div key={i} style={{ position: "absolute", top: 0, bottom: 0, left: `${i / 8 * 100}%`, width: 1, background: "var(--border-soft)" }} />
                    ))}
                    <div style={{
                      position: "absolute", top: 3, bottom: 3,
                      left: `${barStart / 8 * 100}%`, width: `${(barEnd - barStart) / 8 * 100}%`,
                      minWidth: 12, borderRadius: 4,
                      background: `color-mix(in oklch, ${bgC}, transparent 65%)`,
                      border: `1px solid ${c}`,
                      overflow: "hidden",
                    }}>
                      {m.pct > 0 && (
                        <div style={{ position: "absolute", inset: 0, width: `${m.pct * 100}%`, background: `color-mix(in oklch, ${bgC}, transparent 30%)` }} />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── Risk register (manual — from plan sessions) ───────────────────────────────

function RiskRegister() {
  const risks = [
    { sev: "med", proj: "Settlement",    r: "HMAC secret leaks via env dump",             own: "alex" },
    { sev: "med", proj: "Notion sync",   r: "Rate-limit on Notion's API on backfill",     own: "pete" },
    { sev: "low", proj: "Settlement",    r: "Replay storm during cutover",                own: "alex" },
    { sev: "low", proj: "Offline pair",  r: "Bonjour discovery on enterprise wifi",       own: "lina" },
  ];
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Risk register</h3>
        <span className="hint">2 medium · 2 low across active projects</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>view all</button>
      </div>
      <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "50px 110px 1fr 60px",
          gap: 8, padding: "7px 12px",
          background: "var(--bg-elev2)", borderBottom: "1px solid var(--border-soft)",
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
          textTransform: "uppercase", letterSpacing: ".06em",
        }}>
          <span>sev</span><span>project</span><span>risk</span><span>owner</span>
        </div>
        {risks.map((r, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "50px 110px 1fr 60px",
            gap: 8, padding: "8px 12px", alignItems: "center",
            background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
            borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
            fontSize: 11.5,
          }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: r.sev === "high" ? "var(--danger)" : r.sev === "med" ? "var(--accent)" : "var(--fg-dim)" }}>
              ● {r.sev}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.proj}</span>
            <span style={{ color: "var(--fg)" }}>{r.r}</span>
            <Avatar login={r.own} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Cross-project activity ────────────────────────────────────────────────────

const EVENT_TONE: Record<string, string> = {
  closed: "var(--success)", merged: "var(--info)", opened: "var(--accent)",
  moved: "var(--info)", linked: "var(--fg-muted)", published: "var(--accent)",
  commented: "var(--fg-dim)", created: "var(--accent)", reviewed: "var(--fg-muted)",
  pushed: "var(--success)",
};

function mapGHEvent(evt: GHEvent): { action: string; target: string } | null {
  const p = evt.payload as Record<string, unknown>;
  switch (evt.type) {
    case "PushEvent": {
      const commits = p.commits as Array<{ message: string }> | undefined;
      const sha = (p.head as string | undefined)?.slice(0, 7) ?? "";
      const msg = commits?.[0]?.message?.split("\n")[0] ?? "";
      if (!sha && !msg) return null;
      return { action: "pushed", target: sha ? `${sha} ${msg}` : msg };
    }
    case "PullRequestEvent": {
      const pr = p.pull_request as { number: number; title: string; merged?: boolean } | undefined;
      if (!pr) return null;
      const action = p.action === "closed" && pr.merged ? "merged" : (p.action as string) ?? "updated";
      return { action, target: `#${pr.number} ${pr.title}` };
    }
    case "IssuesEvent": {
      const issue = p.issue as { number: number; title: string } | undefined;
      if (!issue) return null;
      return { action: (p.action as string) ?? "updated", target: `#${issue.number} ${issue.title}` };
    }
    case "IssueCommentEvent": {
      const issue = p.issue as { number: number; title: string } | undefined;
      if (!issue) return null;
      return { action: "commented", target: `#${issue.number} ${issue.title}` };
    }
    case "CreateEvent": {
      const ref = p.ref as string | undefined;
      if (!ref) return null;
      return { action: "created", target: `${(p.ref_type as string) ?? "branch"} ${ref}` };
    }
    default:
      return null;
  }
}

function CrossProjectActivity({ events, projects, loading }: {
  events: GHEvent[];
  projects: GhProject[];
  loading: boolean;
}) {
  const feed = useMemo(() => {
    const projectRepos = new Set<string>();
    projects.forEach(p => p.repositories.nodes.forEach(r => projectRepos.add(r.nameWithOwner)));

    // Prefer events from project repos; fall back to all events
    let filtered = events.filter(e => projectRepos.has(e.repo.name));
    if (filtered.length < 3) filtered = events;

    return filtered.slice(0, 60).map(evt => {
      const mapped = mapGHEvent(evt);
      if (!mapped) return null;
      const repoShort = evt.repo.name.split("/").pop() ?? evt.repo.name;
      return { login: evt.actor.login, ...mapped, repo: repoShort, createdAt: evt.created_at };
    }).filter((e): e is NonNullable<typeof e> => e !== null).slice(0, 6);
  }, [events, projects]);

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Recent activity</h3>
        <span className="hint">across all projects</span>
      </div>
      {feed.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No recent activity.</div>
      )}
      {loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>Loading…</div>
      )}
      {feed.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
          {feed.map((e, i) => (
            <div key={i} style={{
              padding: "10px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              display: "grid", gridTemplateColumns: "22px 80px 1fr 110px 50px",
              gap: 10, alignItems: "center", fontSize: 11,
            }}>
              <Avatar login={e.login} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: EVENT_TONE[e.action] ?? "var(--fg-muted)" }}>{e.action}</span>
              <span style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.target}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{e.repo}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>{timeAgo(e.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Projects grid ─────────────────────────────────────────────────────────────

function ProjectsGrid({ projects, repoIssues, loading }: {
  projects: GhProject[];
  repoIssues: Record<string, GhIssue[]>;
  loading: boolean;
}) {
  const { setProjectsPageMode, setScreen, setActiveProjectMeta, openGithubBoard } = useAppStore();
  // This portfolio lives in the GitHub screen (#421); "view list" jumps to the
  // Projects tab for planning, while opening a card shows that project's board
  // right here on the GitHub page (#498).
  const openProjects = () => { setScreen("projects"); setProjectsPageMode("projects"); };
  const openBoard = (p: GhProject) => {
    const repos = p.repositories?.nodes?.map(r => r.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, repos[0] ?? "", p.number, repos);
    openGithubBoard("board");
  };

  const projectsWithStats = useMemo(() => {
    return projects.map((p, i) => {
      const c = PROJECT_COLORS[i % PROJECT_COLORS.length];
      const status = p.closed ? "shipped" : p.items.totalCount === 0 ? "drafting" : "active";

      // Build weekly close sparkline from linked repos' issues
      const spark = new Array(9).fill(0);
      const now = Date.now();
      p.repositories.nodes.forEach(r => {
        const issues = repoIssues[r.nameWithOwner] ?? [];
        issues.forEach(issue => {
          if (issue.pull_request || issue.state !== "closed" || !issue.closed_at) return;
          const weeksAgo = Math.floor((now - new Date(issue.closed_at).getTime()) / (7 * 86400000));
          if (weeksAgo < 9) spark[8 - weeksAgo]++;
        });
      });

      const repo = p.repositories.nodes[0]?.nameWithOwner ?? "(no repo)";
      return { p, c, status, spark, repo };
    });
  }, [projects, repoIssues]);

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Projects</h3>
        <span className="hint">{loading ? "loading…" : `${projects.length} project${projects.length !== 1 ? "s" : ""} · click to open the board`}</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}
          onClick={openProjects}>view list →</button>
      </div>
      {projects.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No projects found. Create one on GitHub.</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
        {projectsWithStats.map(({ p, c, status, spark, repo }) => (
          <div key={p.id} onClick={() => openBoard(p)} style={{
            padding: "12px 14px", borderRadius: 6,
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            cursor: "pointer", minWidth: 0, overflow: "hidden",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: c, flexShrink: 0, display: "inline-block" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>{p.title}</span>
              <span className={"tag " + (status === "active" ? "green" : status === "shipped" ? "" : "amber")} style={{ fontSize: 9 }}>{status}</span>
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", marginBottom: 8 }}>
              {repo}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
              <span><b style={{ color: "var(--fg)" }}>{p.items.totalCount}</b> items</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{timeAgo(p.updatedAt)}</span>
              <div style={{ flex: 1 }} />
              <ProjectSparkline data={spark} color={c} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function ProjectsSummary() {
  const { setProjectsPageMode, setScreen } = useAppStore();
  // Hosted in the GitHub screen (#421) — "browse projects" jumps to the Projects tab.
  const openProjects = () => { setScreen("projects"); setProjectsPageMode("projects"); };
  const { loading, projects, events, repoMilestones, repoIssues, burndown } = useProjectsSummaryData();

  const activeProjects = projects.filter(p => !p.closed);
  const draftingCount = activeProjects.filter(p => p.items.totalCount === 0).length;
  const activeCount = activeProjects.filter(p => p.items.totalCount > 0).length;
  const shippedCount = projects.filter(p => p.closed).length;

  const totalOpenIssues = useMemo(() =>
    Object.values(repoIssues).reduce((s, issues) =>
      s + issues.filter(i => !i.pull_request && i.state === "open").length, 0),
    [repoIssues]
  );

  const totalMilestones = useMemo(() =>
    Object.values(repoMilestones).reduce((s, ms) => {
      const now = Date.now();
      return s + ms.filter(m => {
        if (!m.due_on) return false;
        const weeksOut = (new Date(m.due_on).getTime() - now) / (7 * 86400000);
        return weeksOut >= 0 && weeksOut <= 2;
      }).length;
    }, 0),
    [repoMilestones]
  );

  const avgVelocity = useMemo(() => {
    const closed = new Array(8).fill(0);
    const now = Date.now();
    Object.values(repoIssues).forEach(issues => {
      issues.forEach(issue => {
        if (issue.pull_request || issue.state !== "closed" || !issue.closed_at) return;
        const weeksAgo = Math.floor((now - new Date(issue.closed_at).getTime()) / (7 * 86400000));
        if (weeksAgo < 8) closed[7 - weeksAgo]++;
      });
    });
    return (closed.reduce((s, v) => s + v, 0) / 8).toFixed(1);
  }, [repoIssues]);

  return (
    <section style={{ flex: 1, overflow: "auto", padding: "20px 24px", minWidth: 0, background: "var(--bg-canvas)" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Portfolio</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
              {loading ? "loading…" : `${activeCount} active · ${draftingCount} drafting · ${shippedCount} shipped`}
            </div>
          </div>
          <button className="btn" onClick={openProjects}>browse projects →</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <AISummary />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 14 }}>
          {([
            ["projects",    loading ? "…" : String(projects.length),    `${activeCount} active · ${draftingCount} drafting`,  "fg"    ],
            ["open issues", loading ? "…" : String(totalOpenIssues),    "across project repos",              "accent" ],
            ["active",      loading ? "…" : String(activeCount),        "in-progress projects",              "info"   ],
            ["velocity",    loading ? "…" : `${avgVelocity}/wk`,        "avg issues closed",                 "muted"  ],
            ["milestones",  loading ? "…" : String(totalMilestones),    "due in next 2 weeks",               "info"   ],
            ["repos",       loading ? "…" : String(new Set(projects.flatMap(p => p.repositories.nodes.map(r => r.nameWithOwner))).size), "linked across projects", "muted"],
          ] as const).map(([k, v, sub, tone]) => (
            <div key={k} className="card" style={{ padding: "10px 12px" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{k}</div>
              <div style={{
                fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, marginTop: 2,
                color: tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" : "var(--fg)",
              }}>{v}</div>
              <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <ProjectsGrid projects={projects} repoIssues={repoIssues} loading={loading} />
            <IterationBurnDown data={burndown} loading={loading} />
            <UpcomingMilestones repoMilestones={repoMilestones} loading={loading} />
            <CrossProjectActivity events={events} projects={projects} loading={loading} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <ProjectAllocation projects={projects} />
            <VelocityCard repoIssues={repoIssues} loading={loading} />
            <RiskRegister />
          </div>
        </div>
      </div>
    </section>
  );
}
