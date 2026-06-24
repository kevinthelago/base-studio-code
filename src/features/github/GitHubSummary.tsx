import { useState, useEffect, useMemo } from "react";
import { useAppStore } from "@/store";
import { githubRequest, githubGraphql } from "./lib/github";
import { heatFill } from "./heatFill";
import { quartileScale } from "./heatScale";
import { languageStats } from "./languageStats";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GHEvent {
  id: string;
  type: string;
  actor: { login: string };
  repo: { name: string };
  payload: unknown;
  created_at: string;
}

interface GHPRItem {
  number: number;
  title: string;
  user: { login: string };
  created_at: string;
  draft: boolean;
}

interface GHRunItem {
  id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
}

interface GHContrib {
  author: { login: string } | null;
  total: number;
}

interface RepoData {
  prs: GHPRItem[];
  langBytes: Record<string, number>;
  runs: GHRunItem[];
  contribs: GHContrib[];
}

interface ContribDay {
  date: string;    // YYYY-MM-DD
  weekday: number; // 0=Sun … 6=Sat (GitHub convention)
  count: number;
}

const CONTRIB_QUERY = `
query GitHubContributions {
  viewer {
    contributionsCollection {
      contributionCalendar {
        weeks {
          contributionDays {
            contributionCount
            date
            weekday
          }
        }
      }
    }
  }
}`;

function formatHeatDate(iso: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
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

const LANG_COLORS: Record<string, string> = {
  Rust: "oklch(0.78 0.14 30)",
  TypeScript: "oklch(0.7 0.12 240)",
  JavaScript: "oklch(0.78 0.13 90)",
  Python: "oklch(0.78 0.12 90)",
  Go: "oklch(0.72 0.10 195)",
  Java: "oklch(0.7 0.12 50)",
  "C++": "oklch(0.75 0.10 240)",
  C: "oklch(0.72 0.08 220)",
  Shell: "oklch(0.72 0.10 145)",
  HTML: "oklch(0.7 0.12 30)",
  CSS: "oklch(0.7 0.10 260)",
};
function langColor(lang: string): string {
  return LANG_COLORS[lang] ?? "oklch(0.5 0 0)";
}

function mapEvent(evt: GHEvent): { action: string; target: string } | null {
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
      const action = p.action === "closed" && pr.merged ? "merged"
        : (p.action as string) ?? "updated";
      return { action, target: `#${pr.number} ${pr.title}` };
    }
    case "PullRequestReviewEvent": {
      const pr = p.pull_request as { number: number; title: string } | undefined;
      if (!pr) return null;
      return { action: "reviewed", target: `#${pr.number} ${pr.title}` };
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

// ── Data hook ─────────────────────────────────────────────────────────────────

/** The summary samples only the N most-recently-updated repos (GitHub returns
 *  `user/repos` sorted `updated`). Surfaced on the cards so the sample size is honest. */
const SUMMARY_REPO_SAMPLE = 6;

function useGitHubSummaryData() {
  const { githubToken, githubUser, githubRepos } = useAppStore();
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<GHEvent[]>([]);
  const [repoData, setRepoData] = useState<Record<string, RepoData>>({});
  const [contribDays, setContribDays] = useState<ContribDay[]>([]);

  const slugKey = githubRepos.slice(0, SUMMARY_REPO_SAMPLE).map(r => r.full_name).join(",");

  useEffect(() => {
    if (!githubToken || !githubUser) return;
    const login = githubUser.login;
    const slugs = githubRepos.slice(0, SUMMARY_REPO_SAMPLE).map(r => r.full_name);
    if (slugs.length === 0 && !login) return;

    setLoading(true);

    const eventsP = githubRequest<GHEvent[]>(`users/${login}/events?per_page=100`).catch((): GHEvent[] => []);

    const contribP = githubGraphql<{
      viewer: { contributionsCollection: { contributionCalendar: { weeks: Array<{ contributionDays: Array<{ contributionCount: number; date: string; weekday: number }> }> } } }
    }>(CONTRIB_QUERY, null).then(d => {
      const weeks = d?.viewer?.contributionsCollection?.contributionCalendar?.weeks ?? [];
      const days: ContribDay[] = [];
      weeks.forEach(w => w.contributionDays.forEach(cd => days.push({ date: cd.date, weekday: cd.weekday, count: cd.contributionCount })));
      return days;
    }).catch((): ContribDay[] => []);

    const repoPs = slugs.map(slug =>
      Promise.all([
        githubRequest<GHPRItem[]>(`repos/${slug}/pulls?state=open&per_page=20`).catch((): GHPRItem[] => []),
        githubRequest<Record<string, number>>(`repos/${slug}/languages`).catch((): Record<string, number> => ({})),
        githubRequest<{ workflow_runs: GHRunItem[] }>(`repos/${slug}/actions/runs?per_page=30`)
          .catch(() => ({ workflow_runs: [] as GHRunItem[] })),
        githubRequest<unknown>(`repos/${slug}/stats/contributors`)
          .then(d => Array.isArray(d) ? d as GHContrib[] : []).catch((): GHContrib[] => []),
      ])
    );

    Promise.all([eventsP, contribP, ...repoPs]).then(([evts, days, ...rows]) => {
      const evtArr = Array.isArray(evts) ? evts : [];
      const rd: Record<string, RepoData> = {};
      slugs.forEach((slug, i) => {
        const [prs, langs, runsResp, contribs] = rows[i] as [
          GHPRItem[],
          Record<string, number>,
          { workflow_runs: GHRunItem[] },
          GHContrib[],
        ];
        rd[slug] = {
          prs: Array.isArray(prs) ? prs : [],
          langBytes: langs && typeof langs === "object" && !Array.isArray(langs) ? langs : {},
          runs: Array.isArray(runsResp?.workflow_runs) ? runsResp.workflow_runs : [],
          contribs: Array.isArray(contribs) ? contribs : [],
        };
      });
      setEvents(evtArr);
      setContribDays(Array.isArray(days) ? days : []);
      setRepoData(rd);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [githubToken, githubUser?.login, slugKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { loading, events, repoData, contribDays };
}

// ── Shared page-mode strip ────────────────────────────────────────────────────

export function GitHubPageModeStrip() {
  const { githubPageMode, setGithubPageMode, githubUser } = useAppStore();
  const modes = [
    { k: "summary",  label: "Summary",      hint: "all repos · analytics" },
    { k: "projects", label: "Projects",     hint: "portfolio · analytics" },
    { k: "repos",    label: "Repositories", hint: "progress · changes · CI" },
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
        const on = m.k === githubPageMode;
        return (
          <div key={m.k} onClick={() => setGithubPageMode(m.k)} style={{
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
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
        <span style={{ color: "var(--success)" }}>● connected</span>
        {githubUser && <><span>·</span><span>{githubUser.login}</span></>}
      </div>
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

function Sparkline({ data, w = 90, h = 22, color = "var(--accent)" }: { data: number[]; w?: number; h?: number; color?: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w} cy={h - (data[data.length - 1] / max) * h} r="2" fill={color} />
    </svg>
  );
}

// ── Activity heatmap ──────────────────────────────────────────────────────────

function ActivityHeatmap({
  cells, rawCounts, rawDates, totalContribs, totalMerged, loading,
}: {
  cells: number[];
  rawCounts: number[];
  rawDates: string[];
  totalContribs: number;
  totalMerged: number;
  loading: boolean;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const cols = 28, rows = 7;
  const cell = 12, gap = 3;
  const W = cols * cell + (cols - 1) * gap;
  const H = rows * cell + (rows - 1) * gap;
  const svgW = W + 30, svgH = H + 8;

  const tooltip = hoveredIdx !== null ? (() => {
    const c = Math.floor(hoveredIdx / rows);
    const r = hoveredIdx % rows;
    const count = rawCounts[hoveredIdx] ?? 0;
    const date = rawDates[hoveredIdx] ?? "";
    const label = date
      ? (count === 0 ? `No activity · ${formatHeatDate(date)}` : `${count} contribution${count !== 1 ? "s" : ""} · ${formatHeatDate(date)}`)
      : null;
    if (!label) return null;
    const tipW = 152, tipH = 16;
    const cellCx = 30 + c * (cell + gap) + cell / 2;
    const cellTop = r * (cell + gap) + 4;
    const tipX = Math.max(0, Math.min(svgW - tipW, cellCx - tipW / 2));
    const above = r >= 2;
    const tipY = above ? cellTop - tipH - 4 : cellTop + cell + 4;
    return { label, tipX, tipY, tipW, tipH };
  })() : null;

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Activity · last 28 weeks</h3>
        <span className="hint">all contributions · GitHub calendar</span>
        <div style={{ flex: 1 }} />
        <span style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
          less
          {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
            <span key={i} style={{ width: 10, height: 10, borderRadius: 2, display: "inline-block", background: heatFill(v) }} />
          ))}
          more
        </span>
      </div>
      <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ display: "block", width: "100%", overflow: "visible" }}>
        {["Mon", "", "Wed", "", "Fri", "", ""].map((d, i) => (
          <text key={i} x={0} y={4 + i * (cell + gap) + cell / 2}
            dominantBaseline="middle"
            fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{d}</text>
        ))}
        {cells.map((v, i) => {
          const c = Math.floor(i / rows), r = i % rows;
          return (
            <rect key={i}
              x={30 + c * (cell + gap)} y={r * (cell + gap) + 4}
              width={cell} height={cell} rx={2}
              fill={heatFill(v)}
              style={{ cursor: "default" }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            />
          );
        })}
        {tooltip && (
          <g pointerEvents="none">
            <rect x={tooltip.tipX} y={tooltip.tipY} width={tooltip.tipW} height={tooltip.tipH} rx={3}
              fill="var(--bg-panel)" stroke="var(--border-soft)" strokeWidth="0.8" />
            <text x={tooltip.tipX + tooltip.tipW / 2} y={tooltip.tipY + tooltip.tipH / 2}
              dominantBaseline="middle" textAnchor="middle"
              fontFamily="var(--mono)" fontSize="8.5" fill="var(--fg)">
              {tooltip.label}
            </text>
          </g>
        )}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", paddingLeft: 30 }}>
        <span>28 weeks ago</span><span>today</span>
      </div>
      <div style={{ display: "flex", gap: 24, marginTop: 12, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
        <span><b style={{ color: "var(--fg)" }}>{loading ? "…" : totalContribs}</b> contributions</span>
        <span><b style={{ color: "var(--fg)" }}>{loading ? "…" : totalMerged}</b> PRs merged</span>
      </div>
    </div>
  );
}

// ── Language mix ──────────────────────────────────────────────────────────────

function LanguageMix({ langTotals, repoCount, totalRepos, loading }: {
  langTotals: Record<string, number>;
  /** Sampled repos that contributed language data. */
  repoCount: number;
  /** Total connected repos (the sample is capped at SUMMARY_REPO_SAMPLE). */
  totalRepos: number;
  loading: boolean;
}) {
  const entries = useMemo(() => {
    const total = Object.values(langTotals).reduce((s, b) => s + b, 0);
    if (total === 0) return [];
    return Object.entries(langTotals)
      .map(([n, b]) => ({ n, pct: Math.round(b / total * 100), c: langColor(n) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6);
  }, [langTotals]);

  // The summary only samples the most-recently-updated repos, so say so plainly:
  // "N of M repos" when capped, "N repos" otherwise. The tooltip spells out the cap.
  const sampled = Math.min(SUMMARY_REPO_SAMPLE, totalRepos);
  const capped = totalRepos > SUMMARY_REPO_SAMPLE;
  const repoLabel = capped
    ? `${repoCount} of ${sampled} sampled repos`
    : `${repoCount} repo${repoCount === 1 ? "" : "s"}`;
  const title = capped
    ? `Aggregated across the ${sampled} most-recently-updated of your ${totalRepos} repos${repoCount < sampled ? ` (${repoCount} had detected languages)` : ""}.`
    : undefined;

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 10, gap: 10 }}>
        <h3 style={{ margin: 0 }}>Languages</h3>
        <span className="hint" title={title}>{loading ? "loading…" : entries.length > 0 ? `by byte count · ${repoLabel}` : "no data"}</span>
      </div>
      {entries.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "4px 0" }}>No language data available.</div>
      )}
      {entries.length > 0 && (
        <>
          <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", background: "var(--bg-elev2)", marginBottom: 10 }}>
            {entries.map(l => (
              <div key={l.n} title={`${l.n} · ${l.pct}%`} style={{ width: `${l.pct}%`, background: l.c }} />
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
            {entries.map(l => (
              <div key={l.n} style={{ display: "grid", gridTemplateColumns: "12px 1fr 40px", gap: 8, alignItems: "center" }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: l.c, display: "inline-block" }} />
                <span style={{ color: "var(--fg)" }}>{l.n}</span>
                <span style={{ textAlign: "right", color: "var(--fg-dim)" }}>{l.pct}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Top contributors ──────────────────────────────────────────────────────────

function ContributorsCard({ contributors, loading }: {
  contributors: Array<{ login: string; commits: number }>;
  loading: boolean;
}) {
  const maxC = Math.max(...contributors.map(p => p.commits), 1);
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Top contributors</h3>
        <span className="hint">{loading ? "loading…" : contributors.length > 0 ? `${contributors.length} contributors · all repos` : "no data"}</span>
      </div>
      {contributors.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "4px 0" }}>
          No contributor data yet — GitHub is computing stats.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {contributors.map(p => (
          <div key={p.login} style={{ display: "grid", gridTemplateColumns: "22px 1fr 1fr 80px", gap: 10, alignItems: "center" }}>
            <Avatar login={p.login} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>@{p.login}</span>
            <div style={{ height: 5, borderRadius: 3, background: "var(--bg-elev2)", overflow: "hidden" }}>
              <div style={{ width: `${p.commits / maxC * 100}%`, height: "100%", background: "var(--accent)" }} />
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", textAlign: "right" }}>{p.commits} commits</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Cross-repo activity ───────────────────────────────────────────────────────

const EVENT_TONE: Record<string, string> = {
  merged: "var(--info)", opened: "var(--accent)", pushed: "var(--success)",
  reviewed: "var(--fg-muted)", closed: "var(--fg-dim)", created: "var(--accent)",
  commented: "var(--fg-dim)", "force-pushed": "var(--danger)",
};

function CrossRepoActivity({ events, loading }: {
  events: Array<{ login: string; action: string; target: string; repo: string; createdAt: string }>;
  loading: boolean;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Recent activity</h3>
        <span className="hint">across all connected repos</span>
        <div style={{ flex: 1 }} />
        <select className="input" style={{ height: 24, width: 100, fontSize: 10.5 }}>
          <option>all events</option><option>PRs only</option><option>commits</option>
        </select>
      </div>
      {events.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No recent activity.</div>
      )}
      {loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>Loading…</div>
      )}
      {events.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
          {events.map((e, i) => (
            <div key={i} style={{
              padding: "10px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              display: "grid", gridTemplateColumns: "22px 70px 1fr 110px 50px",
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

// ── Open PRs across repos ─────────────────────────────────────────────────────

function OpenPRsAllRepos({ prs, loading }: {
  prs: Array<{ n: string; t: string; who: string; repo: string; draft: boolean; age: string }>;
  loading: boolean;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Open pull requests</h3>
        <span className="hint">{loading ? "loading…" : `${prs.length} across all repos`}</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>filter by reviewer</button>
      </div>
      {prs.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No open pull requests.</div>
      )}
      {prs.length > 0 && (
        <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
          {prs.map((p, i) => (
            <div key={p.n + p.repo} style={{
              padding: "10px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              display: "grid", gridTemplateColumns: "50px 1fr auto 50px",
              gap: 10, alignItems: "baseline", fontSize: 11,
              borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
            }}>
              <span style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>{p.n}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.t}</div>
                <div style={{ marginTop: 3, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>@{p.who} · {p.repo}</div>
              </div>
              {p.draft && <span className="tag" style={{ fontSize: 9.5 }}>draft</span>}
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>{p.age}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Repos grid ────────────────────────────────────────────────────────────────

function ReposGrid({ repos, loading }: {
  repos: Array<{
    full_name: string;
    description: string | null;
    language: string | null;
    prCount: number;
    ciStatus: "passing" | "failing" | "unknown";
    lastPush: string;
    spark: number[];
  }>;
  loading: boolean;
}) {
  const { setGithubPageMode } = useAppStore();
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Repositories</h3>
        <span className="hint">{repos.length} connected · click to drill in</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>+ connect more</button>
      </div>
      {repos.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No repositories connected.</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {repos.map(r => (
          <div key={r.full_name} onClick={() => setGithubPageMode("repos")} style={{
            padding: "12px 14px", borderRadius: 6,
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            cursor: "pointer",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.language ? langColor(r.language) : "var(--fg-dim)", flexShrink: 0, display: "inline-block" }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{r.full_name}</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{timeAgo(r.lastPush)}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, marginBottom: 8 }}>{r.description ?? "No description."}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>
              <span>⊕ <b style={{ color: "var(--fg)" }}>{loading ? "…" : r.prCount}</b> PR</span>
              <span style={{ color: r.ciStatus === "passing" ? "var(--success)" : r.ciStatus === "failing" ? "var(--danger)" : "var(--fg-dim)" }}>
                ◉ ci {r.ciStatus}
              </span>
              <div style={{ flex: 1 }} />
              {r.spark.some(v => v > 0) && <Sparkline data={r.spark} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── CI health ─────────────────────────────────────────────────────────────────

function CIHealthCard({ matrix, loading }: {
  matrix: Array<{ name: string; days: (boolean | null)[] }>;
  loading: boolean;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>CI health</h3>
        <span className="hint">last 7 days · all branches</span>
      </div>
      {matrix.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "4px 0" }}>No CI runs found.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {matrix.map(({ name, days }) => (
          <div key={name} style={{ display: "grid", gridTemplateColumns: "80px 1fr 28px", gap: 8, alignItems: "center" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
            <div style={{ display: "flex", gap: 4 }}>
              {days.map((d, i) => (
                <div key={i} style={{
                  flex: 1, height: 14, borderRadius: 3,
                  background: d === null ? "var(--bg-elev2)" : d ? "var(--success)" : "var(--danger)",
                  opacity: d === null ? 0.4 : 0.85,
                }} />
              ))}
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", textAlign: "right" }}>
              {days.filter(d => d === true).length}/{days.filter(d => d !== null).length}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export function GitHubSummary() {
  const { githubRepos, setGithubPageMode } = useAppStore();
  const { loading, events, repoData, contribDays } = useGitHubSummaryData();

  // Heatmap: map contributionsCollection days → 28-week × 7-day cells
  const { heatmapCells, rawCounts, rawDates, totalContribs } = useMemo(() => {
    const counts = new Array(28 * 7).fill(0);
    const dates = new Array(28 * 7).fill("");
    let totalContribs = 0;

    const now = new Date();
    const todayDow = (now.getDay() + 6) % 7; // Mon=0
    const currentWeekMon = new Date(now);
    currentWeekMon.setHours(0, 0, 0, 0);
    currentWeekMon.setDate(currentWeekMon.getDate() - todayDow);

    contribDays.forEach(day => {
      const [y, m, d] = day.date.split("-").map(Number);
      const date = new Date(y, m - 1, d); // local date
      const dayDow = (date.getDay() + 6) % 7; // Mon=0
      const dayWeekMon = new Date(date);
      dayWeekMon.setDate(dayWeekMon.getDate() - dayDow);
      const weeksAgo = Math.round((currentWeekMon.getTime() - dayWeekMon.getTime()) / (7 * 86400000));
      if (weeksAgo < 0 || weeksAgo >= 28) return;
      const col = 27 - weeksAgo;
      const row = (day.weekday + 6) % 7; // GitHub: 0=Sun → row 6; 1=Mon → row 0
      const idx = col * 7 + row;
      counts[idx] = day.count;
      dates[idx] = day.date;
      totalContribs += day.count;
    });

    // Quartile (rank-based) intensity — robust to outlier days; see heatScale.
    return { heatmapCells: quartileScale(counts), rawCounts: counts, rawDates: dates, totalContribs };
  }, [contribDays]);

  // Merged PRs from event stream (last ~90 days)
  const totalMerged = useMemo(() =>
    events.reduce((n, evt) => {
      if (evt.type !== "PullRequestEvent") return n;
      const p = evt.payload as { action?: string; pull_request?: { merged?: boolean } };
      return n + (p?.action === "closed" && p?.pull_request?.merged ? 1 : 0);
    }, 0),
    [events]
  );

  // Cross-repo activity feed
  const crossRepoEvts = useMemo(() =>
    events.slice(0, 60).map(evt => {
      const mapped = mapEvent(evt);
      if (!mapped) return null;
      return { login: evt.actor.login, ...mapped, repo: evt.repo.name, createdAt: evt.created_at };
    }).filter((e): e is NonNullable<typeof e> => e !== null).slice(0, 8),
    [events]
  );

  // Open PRs across all repos
  const openPRs = useMemo(() => {
    const all: Array<{ n: string; t: string; who: string; repo: string; draft: boolean; age: string }> = [];
    Object.entries(repoData).forEach(([slug, rd]) => {
      rd.prs.slice(0, 3).forEach(pr => {
        all.push({ n: `#${pr.number}`, t: pr.title, who: pr.user.login, repo: slug, draft: pr.draft, age: timeAgo(pr.created_at) });
      });
    });
    return all.slice(0, 8);
  }, [repoData]);

  // Language mix — totals per language + how many sampled repos contributed data.
  const { totals: langTotals, repoCount: langRepoCount } = useMemo(
    () => languageStats(repoData),
    [repoData],
  );

  // Contributors
  const contributors = useMemo(() => {
    const totals: Record<string, number> = {};
    Object.values(repoData).forEach(rd => {
      rd.contribs.forEach(c => {
        if (!c.author) return;
        totals[c.author.login] = (totals[c.author.login] ?? 0) + c.total;
      });
    });
    return Object.entries(totals)
      .map(([login, commits]) => ({ login, commits }))
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 5);
  }, [repoData]);

  // CI matrix: last 7 days per repo
  const ciMatrix = useMemo(() =>
    githubRepos.slice(0, SUMMARY_REPO_SAMPLE).map(r => {
      const runs = repoData[r.full_name]?.runs ?? [];
      const name = r.full_name.split("/")[1] ?? r.full_name;
      const days = Array.from({ length: 7 }, (_, i) => {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        dayStart.setDate(dayStart.getDate() - (6 - i));
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const dayRuns = runs.filter(run => {
          const t = new Date(run.created_at).getTime();
          return t >= dayStart.getTime() && t < dayEnd.getTime() && run.status === "completed";
        });
        if (dayRuns.length === 0) return null as null;
        return dayRuns.some(run => run.conclusion === "success");
      });
      return { name, days };
    }).filter(m => m.days.some(d => d !== null)),
    [githubRepos, repoData]
  );

  // Repo grid data
  const repoGridData = useMemo(() =>
    githubRepos.slice(0, SUMMARY_REPO_SAMPLE).map(r => {
      const rd = repoData[r.full_name];
      const runs = rd?.runs ?? [];
      const latestRun = runs[0];
      const ciStatus = latestRun
        ? (latestRun.conclusion === "success" ? "passing" : "failing")
        : "unknown";
      // Build commit sparkline (12 weeks) from user events for this repo
      const spark = new Array(12).fill(0);
      events.forEach(evt => {
        if (evt.type !== "PushEvent" || evt.repo.name !== r.full_name) return;
        const weeksAgo = Math.floor((Date.now() - new Date(evt.created_at).getTime()) / (7 * 86400000));
        if (weeksAgo < 12) {
          const p = evt.payload as { commits?: unknown[] };
          spark[11 - weeksAgo] += p?.commits?.length ?? 1;
        }
      });
      return { full_name: r.full_name, description: r.description, language: r.language, prCount: rd?.prs.length ?? 0, ciStatus: ciStatus as "passing" | "failing" | "unknown", lastPush: r.pushed_at, spark };
    }),
    [githubRepos, repoData, events]
  );

  // KPIs
  const kpiOpenPRs = Object.values(repoData).reduce((s, rd) => s + rd.prs.length, 0);
  const kpiContribs = contributors.length || "—";
  const kpiCIPassing = (() => {
    const withRuns = githubRepos.slice(0, SUMMARY_REPO_SAMPLE).filter(r => (repoData[r.full_name]?.runs.length ?? 0) > 0);
    if (withRuns.length === 0) return null;
    const passing = withRuns.filter(r => repoData[r.full_name]?.runs[0]?.conclusion === "success");
    return Math.round(passing.length / withRuns.length * 100);
  })();

  return (
    <section style={{ flex: 1, overflow: "auto", padding: "20px 24px", minWidth: 0, background: "var(--bg-canvas)" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600 }}>Across all repositories</h2>
            <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 4 }}>
              {githubRepos.length} repo{githubRepos.length !== 1 ? "s" : ""} · 28-week view
            </div>
          </div>
          <button className="btn" onClick={() => setGithubPageMode("repos")}>browse repositories →</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 14 }}>
          {([
            ["repositories", String(githubRepos.length),               "all connected",                 "fg"     ],
            ["open PRs",     loading ? "…" : String(kpiOpenPRs),       `${openPRs.filter(p => !p.draft).length} ready to review`, "accent"],
            ["contributions · 28w", loading ? "…" : String(totalContribs), "commits · PRs · issues",      "success"],
            ["CI passing",   loading ? "…" : kpiCIPassing != null ? `${kpiCIPassing}%` : "—", "latest run per repo", "info"],
            ["contributors", loading ? "…" : String(kpiContribs),      "all repos",                     "muted"  ],
            ["merged PRs",       loading ? "…" : String(totalMerged),   "last ~90 days via events",      "muted"  ],
          ] as const).map(([k, v, sub, tone]) => (
            <div key={k} className="card" style={{ padding: "10px 12px" }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{k}</div>
              <div style={{
                fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, marginTop: 2,
                color: tone === "accent" ? "var(--accent)" : tone === "success" ? "var(--success)" : tone === "info" ? "var(--info)" : "var(--fg)",
              }}>{v}</div>
              <div style={{ fontSize: 10, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 14 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <ReposGrid repos={repoGridData} loading={loading} />
            <CrossRepoActivity events={crossRepoEvts} loading={loading} />
            <OpenPRsAllRepos prs={openPRs} loading={loading} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
            <ActivityHeatmap cells={heatmapCells} rawCounts={rawCounts} rawDates={rawDates} totalContribs={totalContribs} totalMerged={totalMerged} loading={loading} />
            <CIHealthCard matrix={ciMatrix} loading={loading} />
            <ContributorsCard contributors={contributors} loading={loading} />
            <LanguageMix langTotals={langTotals} repoCount={langRepoCount} totalRepos={githubRepos.length} loading={loading} />
          </div>
        </div>
      </div>
    </section>
  );
}
