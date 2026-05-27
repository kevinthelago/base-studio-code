import { useState, useEffect } from "react";
import { githubRequest } from "../../lib/github";
import { useAppStore, type GithubRepo } from "../../store";

interface GhCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  author: { login: string } | null;
}

interface GhPR {
  number: number;
  title: string;
  user: { login: string };
  created_at: string;
  draft: boolean;
  head: { ref: string };
  base: { ref: string };
}

interface GhBranch { name: string }

interface GhCompare {
  merge_base_commit: { sha: string };
  commits: GhCommit[];
  ahead_by: number;
}

interface GraphPoint {
  sha: string;
  x: number;
  lane: number;
  isHead: boolean;
  message: string;
  author: string;
}

interface GraphEdge {
  x1: number; y1: number;
  x2: number; y2: number;
  color: string;
  curved: boolean;
}

interface GraphResult {
  points: GraphPoint[];
  edges: GraphEdge[];
  laneNames: string[];
  height: number;
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const LANE_COLORS = ["var(--accent)", "var(--info)", "var(--success)", "var(--fg-muted)"];
const LANE_Y      = [30, 74, 118, 162];
const X_LEFT      = 62;
const X_RIGHT     = 630;

function buildGraphLayout(
  mainCommits: GhCommit[],
  defaultBranch: string,
  branchComps: Array<{ name: string; mergeBaseSha: string; commits: GhCommit[] }>
): GraphResult {
  // Only use branches that have exclusive commits
  const activeBranches = branchComps.filter(b => b.commits.length > 0).slice(0, 3);
  const laneNames = [defaultBranch, ...activeBranches.map(b => b.name)];
  const laneCount = Math.min(laneNames.length, 4);

  // Assign every commit a lane, deduplicate by SHA (lane 0 wins ties)
  type Entry = { sha: string; date: number; lane: number; commit: GhCommit };
  const entries: Entry[] = [
    ...mainCommits.map(c => ({
      sha: c.sha, date: new Date(c.commit.author.date).getTime(), lane: 0, commit: c,
    })),
    ...activeBranches.flatMap((b, i) =>
      b.commits.map(c => ({
        sha: c.sha, date: new Date(c.commit.author.date).getTime(), lane: i + 1, commit: c,
      }))
    ),
  ];

  const seen = new Set<string>();
  const unique = entries.filter(e => { if (seen.has(e.sha)) return false; seen.add(e.sha); return true; });
  unique.sort((a, b) => a.date - b.date);

  if (unique.length === 0) {
    return { points: [], edges: [], laneNames: laneNames.slice(0, laneCount), height: 80 };
  }

  const n = unique.length;
  const xMap = new Map<string, number>();
  unique.forEach((e, i) => xMap.set(e.sha, n <= 1 ? (X_LEFT + X_RIGHT) / 2 : X_LEFT + (i / (n - 1)) * (X_RIGHT - X_LEFT)));

  // Build points; mark the rightmost point per lane as HEAD
  const points: GraphPoint[] = unique.map(e => ({
    sha: e.sha,
    x: xMap.get(e.sha)!,
    lane: e.lane,
    isHead: false,
    message: e.commit.commit.message.split("\n")[0],
    author: e.commit.author?.login ?? e.commit.commit.author.name,
  }));

  for (let lane = 0; lane < laneCount; lane++) {
    const lp = points.filter(p => p.lane === lane);
    if (lp.length > 0) lp.reduce((a, b) => a.x > b.x ? a : b).isHead = true;
  }

  // Build edges
  const edges: GraphEdge[] = [];

  for (let lane = 0; lane < laneCount; lane++) {
    const lp = points.filter(p => p.lane === lane).sort((a, b) => a.x - b.x);
    const y  = LANE_Y[lane];
    const color = LANE_COLORS[lane];
    for (let i = 0; i < lp.length - 1; i++) {
      edges.push({ x1: lp[i].x, y1: y, x2: lp[i + 1].x, y2: y, color, curved: false });
    }
    if (lane > 0) {
      const mergeX = xMap.get(activeBranches[lane - 1].mergeBaseSha);
      const first = lp[0];
      if (mergeX !== undefined && first) {
        edges.push({ x1: mergeX, y1: LANE_Y[0], x2: first.x, y2: y, color, curved: true });
      }
    }
  }

  return {
    points,
    edges,
    laneNames: laneNames.slice(0, laneCount),
    height: LANE_Y[laneCount - 1] + 30,
  };
}

// ─── Branch graph ─────────────────────────────────────────────────────────────

function BranchGraph({
  repo, branches, mainCommits, token,
}: {
  repo: GithubRepo;
  branches: GhBranch[];
  mainCommits: GhCommit[];
  token: string;
}) {
  const [layout, setLayout] = useState<GraphResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token || mainCommits.length === 0) return;
    const featureBranches = branches.filter(b => b.name !== repo.default_branch).slice(0, 3);

    if (featureBranches.length === 0) {
      setLayout(buildGraphLayout(mainCommits, repo.default_branch, []));
      return;
    }

    setBusy(true);
    Promise.all(
      featureBranches.map(b =>
        githubRequest<GhCompare>(
          `repos/${repo.full_name}/compare/${repo.default_branch}...${b.name}`,
        ).catch(() => null)
      )
    ).then(results => {
      const comps = featureBranches
        .map((b, i) => results[i] ? {
          name: b.name,
          mergeBaseSha: results[i]!.merge_base_commit.sha,
          commits: results[i]!.commits,
        } : null)
        .filter((x): x is NonNullable<typeof x> => x !== null);
      setLayout(buildGraphLayout(mainCommits, repo.default_branch, comps));
    }).finally(() => setBusy(false));
  }, [repo.full_name, branches.length, mainCommits.length, token]);

  const laneColors = layout?.laneNames.map((_, i) => LANE_COLORS[i]) ?? [];

  return (
    <div className="card" style={{ padding: "14px 16px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Branch graph</h3>
        <span className="hint">
          {busy ? "loading…" : layout ? `${layout.laneNames.length} branches · ${layout.points.length} commits` : "—"}
        </span>
        <div style={{ flex: 1 }} />
      </div>

      {busy && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "20px 0", textAlign: "center" }}>
          Fetching branch history…
        </div>
      )}

      {!busy && layout && layout.points.length === 0 && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "20px 0" }}>
          No commit history found.
        </div>
      )}

      {!busy && layout && layout.points.length > 0 && (() => {
        const svgH = layout.height + 10;
        return (
          <div style={{ overflow: "auto" }}>
            <svg width={X_RIGHT + 30} height={svgH} style={{ display: "block" }}>
              {/* Guide lines */}
              {layout.laneNames.map((name, i) => (
                <g key={`lane-${i}`}>
                  <line x1={X_LEFT - 4} y1={LANE_Y[i]} x2={X_RIGHT + 10} y2={LANE_Y[i]}
                    stroke="var(--border-soft)" strokeWidth="1" strokeDasharray="2 4" />
                  <text x={X_LEFT - 8} y={LANE_Y[i] + 4} textAnchor="end"
                    fontFamily="var(--mono)" fontSize="9.5" fill={laneColors[i]}>
                    {name.length > 20 ? name.slice(0, 18) + "…" : name}
                  </text>
                </g>
              ))}

              {/* Edges */}
              {layout.edges.map((e, idx) =>
                e.curved ? (
                  <path key={`e-${idx}`}
                    d={`M ${e.x1} ${e.y1} C ${(e.x1 + e.x2) / 2} ${e.y1}, ${(e.x1 + e.x2) / 2} ${e.y2}, ${e.x2} ${e.y2}`}
                    fill="none" stroke={e.color} strokeWidth="1.5" opacity="0.85" />
                ) : (
                  <line key={`e-${idx}`}
                    x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                    stroke={e.color} strokeWidth="1.5" />
                )
              )}

              {/* Commit dots */}
              {layout.points.map(p => {
                const y     = LANE_Y[p.lane];
                const color = laneColors[p.lane];
                const r     = p.isHead ? 6 : 4;
                return (
                  <g key={p.sha} style={{ cursor: "default" }}>
                    <title>{p.sha.slice(0, 7)} · {p.message} · @{p.author}</title>
                    <circle cx={p.x} cy={y} r={r}
                      fill={p.isHead ? color : "var(--bg-canvas)"}
                      stroke={color} strokeWidth={p.isHead ? 0 : 1.5} />
                    {p.isHead && (
                      <>
                        <rect x={p.x - 14} y={y - 22} width="32" height="14" rx="2"
                          fill={color} opacity="0.92" />
                        <text x={p.x + 2} y={y - 12} textAnchor="middle"
                          fontFamily="var(--mono)" fontSize="9" fill="#1a120a" fontWeight="700">HEAD</text>
                      </>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        );
      })()}

      {/* Legend */}
      {layout && layout.laneNames.length > 0 && (
        <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
          {layout.laneNames.map((name, i) => (
            <span key={name} style={{
              display: "inline-flex", gap: 6, alignItems: "center",
              fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
            }}>
              <span style={{ width: 10, height: 2, background: laneColors[i], borderRadius: 1, flexShrink: 0 }} />
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── File heatmap (static — requires git diff analysis) ──────────────────────

const HEATMAP_FILES = [
  { p: "crates/ws-server/src/proto.rs", w: 42 },
  { p: "crates/ws-server/src/frame.rs", w: 28 },
  { p: "crates/orch/src/agent.rs",      w: 34 },
  { p: "crates/orch/src/tools/mod.rs",  w: 18 },
  { p: "crates/orch/src/stream.rs",     w: 12 },
  { p: "crates/kb/src/store.rs",        w: 22 },
  { p: "crates/kb/src/fts.rs",          w:  9 },
  { p: "crates/kb/src/embed.rs",        w: 14 },
  { p: "crates/ui-bridge/src/main.rs",  w:  6 },
  { p: "crates/gh/src/webhook.rs",      w: 25 },
  { p: "crates/gh/src/oauth.rs",        w:  4 },
  { p: "src/App.tsx",                   w: 31 },
  { p: "src/console/Grid.tsx",          w: 24 },
  { p: "src/console/Pane.tsx",          w: 19 },
  { p: "src/settings/GitHub.tsx",       w:  8 },
  { p: "schema.json",                   w: 13 },
];

function FileHeatmap() {
  const maxW = Math.max(...HEATMAP_FILES.map(f => f.w));
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Churn heatmap</h3>
        <span className="hint">lines changed in last 14 days · darker = hotter</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4 }}>
        {HEATMAP_FILES.map(f => {
          const t = f.w / maxW;
          const a = 0.18 + 0.72 * t;
          return (
            <div key={f.p} title={`${f.p} · ±${f.w} lines`} style={{
              padding: "8px 9px", borderRadius: 4, minHeight: 54,
              background: `color-mix(in oklch, var(--accent) ${Math.round(a * 100)}%, var(--bg-elev))`,
              border: "1px solid var(--border-soft)",
              color: t > 0.55 ? "#1a120a" : "var(--fg-muted)",
              fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.35,
              display: "flex", flexDirection: "column", justifyContent: "space-between",
              overflow: "hidden",
            }}>
              <span style={{
                display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                color: t > 0.55 ? "#1a120a" : "var(--fg)",
              }}>{f.p.split("/").pop()}</span>
              <span style={{ fontSize: 9, opacity: .75 }}>{f.p.replace(/\/[^/]+$/, "")}</span>
              <span style={{ fontSize: 9.5, fontWeight: 600 }}>±{f.w}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Overview body ────────────────────────────────────────────────────────────

export function OverviewBody({ repo }: { repo: GithubRepo | null }) {
  const { githubToken } = useAppStore();

  const [prs, setPrs]           = useState<GhPR[]>([]);
  const [commits, setCommits]   = useState<GhCommit[]>([]);
  const [allCommits, setAllCommits] = useState<GhCommit[]>([]);
  const [branches, setBranches] = useState<GhBranch[]>([]);
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    if (!repo || !githubToken) return;
    setLoading(true);
    const slug = repo.full_name;

    Promise.all([
      githubRequest<GhPR[]>(`repos/${slug}/pulls?state=open&per_page=20`),
      githubRequest<GhCommit[]>(`repos/${slug}/commits?per_page=30`),
      githubRequest<GhBranch[]>(`repos/${slug}/branches?per_page=50`),
    ])
      .then(([prData, commitData, branchData]) => {
        setPrs(Array.isArray(prData) ? prData : []);
        const cs = Array.isArray(commitData) ? commitData : [];
        setAllCommits(cs);
        setCommits(cs.slice(0, 10));
        setBranches(Array.isArray(branchData) ? branchData : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [repo?.full_name, githubToken]);

  const statCards = [
    ["open PRs",      String(prs.length),                  `${prs.filter(p => !p.draft).length} ready to review`, "accent" ],
    ["branches",      String(branches.length),              `${branches.length} total`,                            "info"   ],
    ["open issues",   String(repo?.open_issues_count ?? "—"), "includes PRs",                                      "muted"  ],
    ["default",       repo?.default_branch ?? "—",          "primary branch",                                      "success"],
  ] as const;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        {statCards.map(([k, v, sub, tone]) => (
          <div key={k} className="card" style={{ padding: "10px 14px" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{k}</div>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, marginTop: 2,
              color: tone === "accent" ? "var(--accent)" : tone === "success" ? "var(--success)" : "var(--fg)",
            }}>{loading ? "…" : v}</div>
            <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.7fr 1fr", gap: 14 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {repo && githubToken && (
            <BranchGraph
              repo={repo}
              branches={branches}
              mainCommits={allCommits}
              token={githubToken}
            />
          )}
          <FileHeatmap />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Open PRs */}
          <div className="card" style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Open PRs</h3>
              <span className="hint">{loading ? "loading…" : `${prs.length} open`}</span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}
                onClick={() => repo && window.open(`https://github.com/${repo.full_name}/pulls`, "_blank")}>
                view all
              </button>
            </div>
            {prs.length === 0 && !loading && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No open pull requests.</div>
            )}
            {prs.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                {prs.slice(0, 8).map((p, i) => (
                  <div key={p.number} style={{
                    padding: "10px 12px",
                    background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
                    display: "grid", gridTemplateColumns: "40px 1fr 50px",
                    gap: 8, alignItems: "baseline", fontSize: 11,
                  }}>
                    <span style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>#{p.number}</span>
                    <div>
                      <div style={{ color: "var(--fg)" }}>{p.title}</div>
                      <div style={{ marginTop: 3, display: "flex", gap: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
                        <span>@{p.user.login}</span>
                        <span>{p.head.ref} → {p.base.ref}</span>
                        {p.draft && <span className="tag" style={{ fontSize: 9.5 }}>draft</span>}
                      </div>
                    </div>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>{timeAgo(p.created_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent commits */}
          <div className="card" style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Recent commits</h3>
              <span className="hint">{repo?.default_branch ?? "main"} · last {commits.length}</span>
            </div>
            {commits.length === 0 && !loading && (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No commits found.</div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {commits.map(c => (
                <div key={c.sha} style={{ display: "grid", gridTemplateColumns: "46px 1fr 40px", gap: 8, alignItems: "baseline", fontSize: 11 }}>
                  <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 10 }}>{c.sha.slice(0, 7)}</span>
                  <span style={{ color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {c.commit.message.split("\n")[0]}
                    <span style={{ color: "var(--fg-dim)" }}> · @{c.author?.login ?? c.commit.author.name}</span>
                  </span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>{timeAgo(c.commit.author.date)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
