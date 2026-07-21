// Live GitHub → Repo Pulse data (#413). PURE mappers from GitHub REST payloads to
// the typed Pulse shapes (data/repoPulse.ts) — no fleet inference, just what the
// API returns. The fetch orchestration lives in hooks/useRepoPulse.ts; these
// functions are framework-free and unit-tested with payload fixtures.
//
// Bot vs human is GitHub's own signal (account `type === "Bot"` / `[bot]` login),
// NOT fleet-agent attribution (that's the Fleet page, #412).

import type {
  VelocitySlice, ChurnArea, ChurnFile, Contributor, Workflow, Branch, BranchStatusKey,
} from "@/shared/data/repoPulse";
import { dayWindow, windowedTally, type DayWindow } from "@/shared/lib/algorithms/windowedTally";
import { loginColor } from "@/shared/lib/core/format";

// ── GitHub payload shapes (subset of the fields we use) ──────────────────────
export interface GhAccount { login: string; type?: string }
export interface GhCommitItem {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: GhAccount | null;
}
export interface GhCommitFile { filename: string; additions: number; deletions: number; changes: number; status?: string }
export interface GhCommitDetail extends GhCommitItem {
  stats?: { additions: number; deletions: number; total: number };
  files?: GhCommitFile[];
}
export interface GhPull {
  number: number;
  title: string;
  user: GhAccount | null;
  created_at: string;
  merged_at: string | null;
  draft: boolean;
  state: string;
  head: { ref: string };
}
export interface GhBranchItem { name: string; commit: { sha: string } }
export interface GhWorkflowItem { id: number; name: string; path: string; state: string }
export interface GhRun {
  id: number; name: string; conclusion: string | null; status: string;
  created_at: string; updated_at: string; workflow_id: number;
}
export interface GhCompare { ahead_by: number; behind_by: number }

// ── bot detection (GitHub's own signal) ──────────────────────────────────────
export function isBot(acct: GhAccount | null, fallbackName = ""): boolean {
  const login = acct?.login ?? fallbackName;
  return acct?.type === "Bot" || /\[bot\]$/i.test(login);
}

// ── day bucketing ─────────────────────────────────────────────────────────────
// Both live in `shared/lib/algorithms/windowedTally` since #3465 — the generic, dependency-free
// version the algorithms graph also ships as a node. Re-exported here so this module's long-standing
// public surface (and `repoPulseLive.test.ts`) is unchanged; there is one implementation, not two.
export { dayWindow, tallyByDay, type DayWindow } from "@/shared/lib/algorithms/windowedTally";
/** Sum values bucketed by their day — the SUM counterpart to `tallyByDay`'s count. Kept here because it
 *  aggregates a per-event value, not timestamps, so it is not the same algorithm as the shared tally. */
export function sumByDay(win: DayWindow, entries: Array<{ date: string; value: number }>): number[] {
  const idx = new Map(win.keys.map((k, i) => [k, i]));
  const out = new Array(win.keys.length).fill(0);
  for (const e of entries) {
    const i = idx.get(e.date.slice(0, 10));
    if (i !== undefined) out[i] += e.value;
  }
  return out;
}

// ── velocity (commits + PRs per day) ──────────────────────────────────────────
export function mapVelocity(
  commits: GhCommitItem[], pulls: GhPull[], details: GhCommitDetail[], days: number, now: Date,
): VelocitySlice {
  // The three COUNT series share one window (#3465) — that is what makes them aligned by construction
  // rather than by three separate calls happening to agree.
  const { labels, series } = windowedTally(
    {
      commits: commits.map(c => c.commit.author?.date),
      opened: pulls.map(p => p.created_at),
      merged: pulls.map(p => p.merged_at),
    },
    days,
    now,
  );
  // adds/dels are SUMS of a per-event value, not counts, so they keep `sumByDay` over the same window.
  const win = dayWindow(days, now);
  const adds = sumByDay(win, details.flatMap(d => d.commit.author?.date && d.stats ? [{ date: d.commit.author.date, value: d.stats.additions }] : []));
  const dels = sumByDay(win, details.flatMap(d => d.commit.author?.date && d.stats ? [{ date: d.commit.author.date, value: d.stats.deletions }] : []));
  return { labels, commits: series.commits, opened: series.opened, merged: series.merged, adds, dels };
}

// ── churn by top-level area + hottest files (from bounded commit details) ─────
/** Group a file path into a display "area": `crates/<x>` two deep, else `<top>/`. */
export function areaOf(path: string): string {
  const seg = path.split("/");
  if (seg[0] === "crates" && seg.length > 1) return `crates/${seg[1]}`;
  if (seg.length > 1) return `${seg[0]}/`;
  return "(root)";
}
const AREA_COLORS = ["var(--accent)", "var(--info)", "var(--success)", "oklch(0.7 0.12 290)", "oklch(0.7 0.06 90)", "var(--fg-dim)"];

export function mapChurnAreas(details: GhCommitDetail[]): ChurnArea[] {
  const acc = new Map<string, { add: number; del: number; files: Set<string> }>();
  for (const d of details) for (const f of d.files ?? []) {
    const a = areaOf(f.filename);
    const e = acc.get(a) ?? { add: 0, del: 0, files: new Set<string>() };
    e.add += f.additions; e.del += f.deletions; e.files.add(f.filename);
    acc.set(a, e);
  }
  return [...acc.entries()]
    .map(([area, e]) => ({ area, add: e.add, del: e.del, files: e.files.size, color: "" }))
    .sort((a, b) => (b.add + b.del) - (a.add + a.del))
    .slice(0, 6)
    .map((a, i) => ({ ...a, color: AREA_COLORS[i % AREA_COLORS.length] }));
}

export function mapHottestFiles(details: GhCommitDetail[], topN = 16): ChurnFile[] {
  const acc = new Map<string, number>();
  for (const d of details) for (const f of d.files ?? []) {
    acc.set(f.filename, (acc.get(f.filename) ?? 0) + f.additions + f.deletions);
  }
  return [...acc.entries()]
    .map(([p, w]) => ({ p, w }))
    .sort((a, b) => b.w - a.w)
    .slice(0, topN);
}

// ── contributors (bot vs human, GitHub-attributed) ───────────────────────────
export function mapContributors(commits: GhCommitItem[], details: GhCommitDetail[]): Contributor[] {
  const acc = new Map<string, { bot: boolean; commits: number; add: number; del: number }>();
  const keyOf = (c: GhCommitItem) => c.author?.login ?? c.commit.author?.name ?? "unknown";
  for (const c of commits) {
    const k = keyOf(c);
    const e = acc.get(k) ?? { bot: isBot(c.author, c.commit.author?.name), commits: 0, add: 0, del: 0 };
    e.commits += 1;
    acc.set(k, e);
  }
  for (const d of details) {
    const k = keyOf(d);
    const e = acc.get(k);
    if (e && d.stats) { e.add += d.stats.additions; e.del += d.stats.deletions; }
  }
  return [...acc.entries()]
    .map(([name, e]) => ({ name, bot: e.bot, commits: e.commits, add: e.add, del: e.del, color: e.bot ? "var(--accent)" : loginColor(name) }))
    .sort((a, b) => b.commits - a.commits);
}

// ── CI health + per-workflow pass rate ────────────────────────────────────────
export interface CiHealth { passRate: number; runs: number; passed: number; failed: number; cancelled: number; avgMin: number }
const FAIL = new Set(["failure", "timed_out", "startup_failure"]);
export function mapCI(runs: GhRun[], workflows: GhWorkflowItem[]): { ci: CiHealth; workflows: Workflow[] } {
  const done = runs.filter(r => r.status === "completed");
  const passed = done.filter(r => r.conclusion === "success").length;
  const failed = done.filter(r => r.conclusion && FAIL.has(r.conclusion)).length;
  const cancelled = done.filter(r => r.conclusion === "cancelled").length;
  const decisive = passed + failed;
  const durMin = (r: GhRun) => (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 60000;
  const avgMin = done.length ? round1(done.reduce((s, r) => s + durMin(r), 0) / done.length) : 0;
  const ci: CiHealth = {
    passRate: decisive ? Math.round((passed / decisive) * 100) : 0,
    runs: done.length, passed, failed, cancelled, avgMin,
  };
  const byWf = new Map<number, { name: string; runs: number; pass: number; mins: number[] }>();
  const wfName = new Map(workflows.map(w => [w.id, w.name]));
  for (const r of done) {
    const w = byWf.get(r.workflow_id) ?? { name: wfName.get(r.workflow_id) ?? r.name, runs: 0, pass: 0, mins: [] };
    w.runs += 1;
    if (r.conclusion === "success") w.pass += 1;
    w.mins.push(durMin(r));
    byWf.set(r.workflow_id, w);
  }
  const wf: Workflow[] = [...byWf.values()]
    .map(w => ({ name: w.name, runs: w.runs, pass: w.runs ? Math.round((w.pass / w.runs) * 100) : 0, min: w.mins.length ? round1(w.mins.reduce((a, b) => a + b, 0) / w.mins.length) : 0 }))
    .sort((a, b) => b.runs - a.runs);
  return { ci, workflows: wf };
}
function round1(n: number): number { return Math.round(n * 10) / 10; }

// ── review latency (merged PR open→merge) ─────────────────────────────────────
export function mapReviewLatency(pulls: GhPull[]): Array<{ label: string; v: number }> {
  const buckets = [
    { label: "<30m", v: 0 }, { label: "30m–1h", v: 0 }, { label: "1–3h", v: 0 },
    { label: "3–8h", v: 0 }, { label: "8h+", v: 0 },
  ];
  for (const p of pulls) {
    if (!p.merged_at) continue;
    const h = (new Date(p.merged_at).getTime() - new Date(p.created_at).getTime()) / 3_600_000;
    const i = h < 0.5 ? 0 : h < 1 ? 1 : h < 3 ? 2 : h < 8 ? 3 : 4;
    buckets[i].v += 1;
  }
  return buckets;
}
/** Median merge latency (hours) over merged PRs, or 0. */
export function medianLatencyH(pulls: GhPull[]): number {
  const hs = pulls.filter(p => p.merged_at)
    .map(p => (new Date(p.merged_at as string).getTime() - new Date(p.created_at).getTime()) / 3_600_000)
    .sort((a, b) => a - b);
  if (!hs.length) return 0;
  const mid = Math.floor(hs.length / 2);
  return round1(hs.length % 2 ? hs[mid] : (hs[mid - 1] + hs[mid]) / 2);
}

// ── active branches ───────────────────────────────────────────────────────────
const BRANCH_COLORS = ["var(--accent)", "var(--info)", "var(--success)", "oklch(0.7 0.12 290)", "oklch(0.7 0.06 90)", "var(--fg-dim)"];
export function mapBranches(
  branches: GhBranchItem[], pulls: GhPull[], compares: Record<string, GhCompare>, defaultBranch: string,
): Branch[] {
  const prByRef = new Map<string, GhPull>();
  for (const p of pulls) if (p.state === "open" && !prByRef.has(p.head.ref)) prByRef.set(p.head.ref, p);
  return branches.map((b, i) => {
    const pr = prByRef.get(b.name);
    const cmp = compares[b.name];
    const owner = pr?.user?.login ?? "";
    const status: BranchStatusKey =
      b.name === defaultBranch ? "integration"
      : pr ? (pr.draft ? "draft" : "open-pr")
      : "commit-only";
    return {
      n: b.name, owner, bot: isBot(pr?.user ?? null),
      ahead: cmp?.ahead_by ?? 0, behind: cmp?.behind_by ?? 0,
      status, age: "", color: BRANCH_COLORS[i % BRANCH_COLORS.length],
    };
  });
}

// ── KPIs ──────────────────────────────────────────────────────────────────────
export interface PulseKpis {
  commitsWeek: number; prsMerged: number; netLines: number; passRate: number;
  reviewLatencyH: number; contributors: number; botShare: number;
}
export function deriveKpis(
  velocity: VelocitySlice, ci: CiHealth, pulls: GhPull[], contributors: Contributor[], now: Date,
): PulseKpis {
  // Last-7-day slices of the (up to 14-day) velocity series.
  const last7 = <T,>(a: T[]) => a.slice(-7);
  const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
  const within7 = (iso: string | null) => !!iso && (now.getTime() - new Date(iso).getTime()) <= 7 * 86_400_000;
  const botCommits = contributors.filter(c => c.bot).reduce((s, c) => s + c.commits, 0);
  const allCommits = contributors.reduce((s, c) => s + c.commits, 0);
  return {
    commitsWeek: sum(last7(velocity.commits)),
    prsMerged: pulls.filter(p => within7(p.merged_at)).length,
    netLines: sum(last7(velocity.adds)) - sum(last7(velocity.dels)),
    passRate: ci.passRate,
    reviewLatencyH: medianLatencyH(pulls.filter(p => within7(p.merged_at))),
    contributors: contributors.length,
    botShare: allCommits ? Math.round((botCommits / allCommits) * 100) : 0,
  };
}
