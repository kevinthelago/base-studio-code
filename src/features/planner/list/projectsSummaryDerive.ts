// Pure parsing + derivation for the Portfolio summary (ProjectsSummary.tsx).
// React-free so it can be unit-tested directly; the components consume the shapes
// returned here. Everything derives from the Projects-v2 GraphQL data — the per-repo
// issue/milestone/event derivations were dropped with their cards (#3675).

// ── Types ─────────────────────────────────────────────────────────────────────

/** A viewer Projects V2 node, as returned by PROJECTS_SUMMARY_QUERY. */
export interface GhProject {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  closed: boolean;
  updatedAt: string;
  items: { totalCount: number };
  repositories: { nodes: Array<{ nameWithOwner: string }> };
}

// ── Palette ───────────────────────────────────────────────────────────────────

export const PROJECT_COLORS = [
  "oklch(0.78 0.14 70)",
  "oklch(0.7 0.10 220)",
  "oklch(0.7 0.12 145)",
  "oklch(0.6 0.06 50)",
  "oklch(0.7 0.12 290)",
  "oklch(0.45 0 0)",
];

// ── Project allocation ────────────────────────────────────────────────────────

export interface AllocationItem { n: string; pct: number; c: string }

/** Share of in-progress work (by item count) across active projects. */
export function computeAllocation(projects: GhProject[]): AllocationItem[] {
  const active = projects.filter(p => !p.closed && p.items.totalCount > 0);
  const total = active.reduce((s, p) => s + p.items.totalCount, 0);
  return active.map((p, i) => ({
    n: p.title,
    pct: total > 0 ? Math.round(p.items.totalCount / total * 100) : 0,
    c: PROJECT_COLORS[i % PROJECT_COLORS.length],
  }));
}

// ── Projects grid stats ───────────────────────────────────────────────────────

export type ProjectStatus = "shipped" | "drafting" | "active";

export interface ProjectStat {
  p: GhProject;
  c: string;
  status: ProjectStatus;
  repo: string;
}

/** Per-project card stats: color, status, lead repo — all from the project data (#3675). */
export function computeProjectStats(projects: GhProject[]): ProjectStat[] {
  return projects.map((p, i) => {
    const c = PROJECT_COLORS[i % PROJECT_COLORS.length];
    const status: ProjectStatus = p.closed ? "shipped" : p.items.totalCount === 0 ? "drafting" : "active";
    const repo = p.repositories.nodes[0]?.nameWithOwner ?? "(no repo)";
    return { p, c, status, repo };
  });
}

/** Distinct repo count linked across all projects (header stat). */
export function countLinkedRepos(projects: GhProject[]): number {
  return new Set(projects.flatMap(p => p.repositories.nodes.map(r => r.nameWithOwner))).size;
}
