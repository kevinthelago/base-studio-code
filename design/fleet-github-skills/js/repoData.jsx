/* global window */
// Mock repo data for the GitHub → Pulse analytics page. Models real progress &
// changes in kevinthelago/base-studio-code, with commits/PRs attributed to both
// humans and fleet worker agents (clearly distinguished).

const A = "var(--accent)", I = "var(--info)", G = "var(--success)", D = "var(--danger)",
  V = "oklch(0.7 0.12 290)", DIM = "var(--fg-dim)";

const REPO = {
  name: "kevinthelago/base-studio-code",
  branch: "main",
  desc: "Desktop host for Studio Code — orchestrate parallel Claude coding agents.",
  lang: "rust", pushedMin: 4,
};

// ── 14-day velocity ───────────────────────────────────────────────────────────
const DAYS = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(Date.now() - (13 - i) * 86400000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
});
const COMMITS = [9, 14, 11, 18, 16, 5, 3, 12, 21, 19, 24, 17, 28, 22];
const PRS_MERGED = [2, 3, 3, 4, 3, 1, 1, 3, 5, 4, 6, 4, 7, 5];
const PRS_OPENED = [3, 4, 2, 5, 4, 1, 2, 4, 5, 5, 6, 5, 7, 6];

// net lines (additions / deletions per day) — deletions stored positive
const ADDS = [420, 780, 510, 940, 720, 180, 90, 640, 1180, 860, 1420, 760, 1680, 1240];
const DELS = [180, 320, 260, 410, 380, 60, 40, 290, 540, 470, 690, 360, 820, 610];

function vrange(range) {
  const n = range === "7d" ? 7 : 14;
  return {
    labels: DAYS.slice(-n),
    commits: COMMITS.slice(-n),
    merged: PRS_MERGED.slice(-n),
    opened: PRS_OPENED.slice(-n),
    adds: ADDS.slice(-n),
    dels: DELS.slice(-n),
  };
}

// ── churn by area (last 14d, added vs removed) ───────────────────────────────
const CHURN_AREAS = [
  { area: "crates/orch",     add: 1840, del: 720, files: 14, color: A },
  { area: "crates/ws-server", add: 1320, del: 540, files: 9, color: I },
  { area: "crates/gh",       add: 960,  del: 410, files: 7, color: G },
  { area: "src/",            add: 2210, del: 1180, files: 22, color: V },
  { area: "crates/kb",       add: 740,  del: 230, files: 6, color: "oklch(0.7 0.06 90)" },
  { area: "crates/ui-bridge", add: 280, del: 120, files: 3, color: DIM },
];

// ── file churn heatmap (real-ish paths from Overview.tsx FileHeatmap) ────────
const CHURN_FILES = [
  { p: "crates/orch/src/agent.rs", w: 34 }, { p: "crates/orch/src/stream.rs", w: 28 },
  { p: "crates/orch/src/tools/mod.rs", w: 18 }, { p: "crates/orch/src/director.rs", w: 41 },
  { p: "crates/ws-server/src/proto.rs", w: 42 }, { p: "crates/ws-server/src/frame.rs", w: 24 },
  { p: "crates/gh/src/webhook.rs", w: 25 }, { p: "crates/gh/src/oauth.rs", w: 6 },
  { p: "crates/kb/src/store.rs", w: 22 }, { p: "crates/kb/src/fts.rs", w: 11 },
  { p: "src/screens/projects/Planning.tsx", w: 38 }, { p: "src/screens/projects/ProjectsSummary.tsx", w: 31 },
  { p: "src/screens/github/Overview.tsx", w: 19 }, { p: "src/App.tsx", w: 14 },
  { p: "src/store/index.ts", w: 23 }, { p: "schema.json", w: 9 },
];

// ── contributors (agents vs humans) ──────────────────────────────────────────
const CONTRIB = [
  { name: "api",         bot: true,  commits: 64, add: 1840, del: 620, color: A },
  { name: "emitter",     bot: true,  commits: 52, add: 1320, del: 480, color: A },
  { name: "kevinthelago", bot: false, commits: 41, add: 980, del: 1240, color: "oklch(0.68 0.12 250)" },
  { name: "dashboard",   bot: true,  commits: 38, add: 1180, del: 360, color: A },
  { name: "infra",       bot: true,  commits: 22, add: 540, del: 210, color: G },
  { name: "docs",        bot: true,  commits: 19, add: 320, del: 90, color: "oklch(0.7 0.06 90)" },
  { name: "lina",        bot: false, commits: 14, add: 410, del: 280, color: "oklch(0.68 0.12 30)" },
];
const HUMAN_COMMITS = CONTRIB.filter(c => !c.bot).reduce((s, c) => s + c.commits, 0);
const BOT_COMMITS = CONTRIB.filter(c => c.bot).reduce((s, c) => s + c.commits, 0);

// ── CI / Actions ─────────────────────────────────────────────────────────────
const CI = {
  passRate: 91,
  runs: 142,
  passed: 129,
  failed: 9,
  cancelled: 4,
  avgMin: 4.2,
  durationTrend: [5.1, 4.8, 5.2, 4.4, 4.6, 4.1, 3.9, 4.0, 4.3, 3.8, 4.2, 4.0, 3.7, 4.2],
};
const WORKFLOWS = [
  { name: "ci.yml", runs: 64, pass: 96, min: 3.8 },
  { name: "rust-test.yml", runs: 41, pass: 88, min: 6.1 },
  { name: "typecheck.yml", runs: 28, pass: 100, min: 1.4 },
  { name: "release.yml", runs: 9, pass: 78, min: 8.7 },
];

// ── branches & worktrees ─────────────────────────────────────────────────────
const BRANCHES = [
  { n: "fleet/api", owner: "api", bot: true, ahead: 6, behind: 0, status: "open-pr", age: "2h", color: A },
  { n: "fleet/emitter", owner: "emitter", bot: true, ahead: 4, behind: 1, status: "ci-running", age: "1h", color: A },
  { n: "fleet/dashboard", owner: "dashboard", bot: true, ahead: 3, behind: 2, status: "draft", age: "3h", color: A },
  { n: "fleet/infra", owner: "infra", bot: true, ahead: 2, behind: 4, status: "blocked", age: "4h", color: G },
  { n: "fleet/docs", owner: "docs", bot: true, ahead: 1, behind: 1, status: "commit-only", age: "5h", color: "oklch(0.7 0.06 90)" },
  { n: "develop", owner: "director", bot: true, ahead: 0, behind: 0, status: "integration", age: "8m", color: "var(--accent)" },
];
const BRANCH_STATUS = {
  "open-pr": { label: "PR open", color: G }, "ci-running": { label: "CI running", color: A },
  draft: { label: "draft", color: DIM }, blocked: { label: "blocked", color: D },
  "commit-only": { label: "commit-only", color: DIM }, integration: { label: "integration", color: A },
};

// ── review latency (open → merge), hours ─────────────────────────────────────
const REVIEW_BUCKETS = [
  { label: "<30m", v: 14 }, { label: "30m–1h", v: 9 }, { label: "1–3h", v: 7 },
  { label: "3–8h", v: 4 }, { label: "8h+", v: 2 },
];

// ── KPIs ─────────────────────────────────────────────────────────────────────
const KPIS = {
  commitsWeek: COMMITS.slice(-7).reduce((s, v) => s + v, 0),
  prsMerged: PRS_MERGED.slice(-7).reduce((s, v) => s + v, 0),
  netLines: ADDS.slice(-7).reduce((s, v) => s + v, 0) - DELS.slice(-7).reduce((s, v) => s + v, 0),
  passRate: CI.passRate,
  reviewLatencyH: 1.3,
  contributors: CONTRIB.length,
  botShare: Math.round(BOT_COMMITS / (BOT_COMMITS + HUMAN_COMMITS) * 100),
};

window.REPODATA = {
  REPO, DAYS, vrange, CHURN_AREAS, CHURN_FILES, CONTRIB, HUMAN_COMMITS, BOT_COMMITS,
  CI, WORKFLOWS, BRANCHES, BRANCH_STATUS, REVIEW_BUCKETS, KPIS,
  C: { A, I, G, D, V, DIM },
};
