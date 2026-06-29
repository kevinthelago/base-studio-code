// Branch graph — a visual commit/branch DAG for a repo (the "branches map").
// Lifted out of the old Overview tab when Pulse absorbed the Repositories view
// (#413 merge): self-fetching now (commits + branches + compares via the
// ETag-cached githubRequest) so it drops straight into the Pulse dashboard.
import { useState, useEffect } from "react";
import { githubRequest } from "@/shared/lib/github/github";
import { useAppStore, type GithubRepo } from "@/store";

interface GhCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } };
  author: { login: string } | null;
}
interface GhBranch { name: string }
interface GhCompare { merge_base_commit: { sha: string }; commits: GhCommit[]; ahead_by: number }

interface GraphPoint { sha: string; x: number; lane: number; isHead: boolean; message: string; author: string }
interface GraphEdge { x1: number; y1: number; x2: number; y2: number; color: string; curved: boolean }
interface GraphResult { points: GraphPoint[]; edges: GraphEdge[]; laneNames: string[]; height: number }

const LANE_COLORS = ["var(--accent)", "var(--info)", "var(--success)", "var(--fg-muted)"];
const LANE_Y = [30, 74, 118, 162];
const X_LEFT = 62;
const X_RIGHT = 630;

function buildGraphLayout(
  mainCommits: GhCommit[],
  defaultBranch: string,
  branchComps: Array<{ name: string; mergeBaseSha: string; commits: GhCommit[] }>,
): GraphResult {
  const activeBranches = branchComps.filter(b => b.commits.length > 0).slice(0, 3);
  const laneNames = [defaultBranch, ...activeBranches.map(b => b.name)];
  const laneCount = Math.min(laneNames.length, 4);

  type Entry = { sha: string; date: number; lane: number; commit: GhCommit };
  const entries: Entry[] = [
    ...mainCommits.map(c => ({ sha: c.sha, date: new Date(c.commit.author.date).getTime(), lane: 0, commit: c })),
    ...activeBranches.flatMap((b, i) =>
      b.commits.map(c => ({ sha: c.sha, date: new Date(c.commit.author.date).getTime(), lane: i + 1, commit: c }))),
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

  const points: GraphPoint[] = unique.map(e => ({
    sha: e.sha, x: xMap.get(e.sha)!, lane: e.lane, isHead: false,
    message: e.commit.commit.message.split("\n")[0],
    author: e.commit.author?.login ?? e.commit.commit.author.name,
  }));
  for (let lane = 0; lane < laneCount; lane++) {
    const lp = points.filter(p => p.lane === lane);
    if (lp.length > 0) lp.reduce((a, b) => (a.x > b.x ? a : b)).isHead = true;
  }

  const edges: GraphEdge[] = [];
  for (let lane = 0; lane < laneCount; lane++) {
    const lp = points.filter(p => p.lane === lane).sort((a, b) => a.x - b.x);
    const y = LANE_Y[lane];
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

  return { points, edges, laneNames: laneNames.slice(0, laneCount), height: LANE_Y[laneCount - 1] + 30 };
}

export function BranchGraph({ repo }: { repo: GithubRepo }) {
  const githubToken = useAppStore(s => s.githubToken);
  const [commits, setCommits] = useState<GhCommit[]>([]);
  const [branches, setBranches] = useState<GhBranch[]>([]);
  const [layout, setLayout] = useState<GraphResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Fetch the default-branch commits + branch list (cached; shared with Pulse's calls).
  useEffect(() => {
    if (!githubToken) return;
    let cancelled = false;
    Promise.all([
      githubRequest<GhCommit[]>(`repos/${repo.full_name}/commits?per_page=30`).catch(() => [] as GhCommit[]),
      githubRequest<GhBranch[]>(`repos/${repo.full_name}/branches?per_page=50`).catch(() => [] as GhBranch[]),
    ]).then(([c, b]) => {
      if (cancelled) return;
      setCommits(Array.isArray(c) ? c : []);
      setBranches(Array.isArray(b) ? b : []);
    });
    return () => { cancelled = true; };
  }, [repo.full_name, githubToken]);

  // Resolve up to 3 feature branches against the default branch and lay out the graph.
  useEffect(() => {
    if (!githubToken || commits.length === 0) return;
    let cancelled = false;
    const featureBranches = branches.filter(b => b.name !== repo.default_branch).slice(0, 3);
    if (featureBranches.length === 0) {
      setLayout(buildGraphLayout(commits, repo.default_branch, []));
      return;
    }
    setBusy(true);
    Promise.all(featureBranches.map(b =>
      githubRequest<GhCompare>(`repos/${repo.full_name}/compare/${repo.default_branch}...${b.name}`).catch(() => null)))
      .then(results => {
        if (cancelled) return;
        const comps = featureBranches
          .map((b, i) => results[i] ? { name: b.name, mergeBaseSha: results[i]!.merge_base_commit.sha, commits: results[i]!.commits } : null)
          .filter((x): x is NonNullable<typeof x> => x !== null);
        setLayout(buildGraphLayout(commits, repo.default_branch, comps));
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [repo.full_name, repo.default_branch, branches, commits, githubToken]);

  const laneColors = layout?.laneNames.map((_, i) => LANE_COLORS[i]) ?? [];

  return (
    <div className="card" style={{ padding: "14px 16px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Branch graph</h3>
        <span className="hint">
          {busy ? "loading…" : layout ? `${layout.laneNames.length} branches · ${layout.points.length} commits` : "—"}
        </span>
      </div>

      {busy && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", padding: "20px 0", textAlign: "center" }}>
          Fetching branch history…
        </div>
      )}
      {!busy && layout && layout.points.length === 0 && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", padding: "20px 0" }}>
          No commit history found.
        </div>
      )}
      {!busy && layout && layout.points.length > 0 && (
        <div style={{ overflow: "auto" }}>
          <svg width={X_RIGHT + 30} height={layout.height + 10} style={{ display: "block" }}>
            {layout.laneNames.map((name, i) => (
              <g key={`lane-${i}`}>
                <line x1={X_LEFT - 4} y1={LANE_Y[i]} x2={X_RIGHT + 10} y2={LANE_Y[i]}
                  stroke="var(--border-soft)" strokeWidth="1" strokeDasharray="2 4" />
                <text x={X_LEFT - 8} y={LANE_Y[i] + 4} textAnchor="end" fontFamily="var(--mono)" fontSize="9.5" fill={laneColors[i]}>
                  {name.length > 20 ? name.slice(0, 18) + "…" : name}
                </text>
              </g>
            ))}
            {layout.edges.map((e, idx) => e.curved ? (
              <path key={`e-${idx}`} d={`M ${e.x1} ${e.y1} C ${(e.x1 + e.x2) / 2} ${e.y1}, ${(e.x1 + e.x2) / 2} ${e.y2}, ${e.x2} ${e.y2}`}
                fill="none" stroke={e.color} strokeWidth="1.5" opacity="0.85" />
            ) : (
              <line key={`e-${idx}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke={e.color} strokeWidth="1.5" />
            ))}
            {layout.points.map(p => {
              const y = LANE_Y[p.lane];
              const color = laneColors[p.lane];
              const r = p.isHead ? 6 : 4;
              return (
                <g key={p.sha} style={{ cursor: "default" }}>
                  <title>{p.sha.slice(0, 7)} · {p.message} · @{p.author}</title>
                  <circle cx={p.x} cy={y} r={r} fill={p.isHead ? color : "var(--bg-canvas)"} stroke={color} strokeWidth={p.isHead ? 0 : 1.5} />
                  {p.isHead && (
                    <>
                      <rect x={p.x - 14} y={y - 22} width="32" height="14" rx="2" fill={color} opacity="0.92" />
                      <text x={p.x + 2} y={y - 12} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="#1a120a" fontWeight="700">HEAD</text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {layout && layout.laneNames.length > 0 && (
        <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
          {layout.laneNames.map((name, i) => (
            <span key={name} className="mono" style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 10.5, color: "var(--fg-muted)" }}>
              <span style={{ width: 10, height: 2, background: laneColors[i], borderRadius: 1, flexShrink: 0 }} />
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
