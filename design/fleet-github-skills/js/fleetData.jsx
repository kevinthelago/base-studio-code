/* global window */
// Mock fleet data for the Projects → Fleet analytics page. Internally consistent:
// a director coordinating six per-stream workers on the "Settlement webhooks v2"
// project, each in its own worktree/branch under a least-privilege profile.

const ACCENT = "var(--accent)", INFO = "var(--info)", OK = "var(--success)",
  DANGER = "var(--danger)", VIOLET = "oklch(0.7 0.12 290)", DIM = "var(--fg-dim)";

// profile palette (mirrors agentProfiles.ts colors)
const PROFILE = {
  build:   { label: "Build & test",   color: "oklch(0.78 0.14 70)" },
  review:  { label: "Read-only review", color: "oklch(0.72 0.10 230)" },
  docs:    { label: "Docs writer",     color: "oklch(0.7 0.06 90)" },
  auto:    { label: "Autonomous",      color: "oklch(0.74 0.13 145)" },
  sandbox: { label: "Sandboxed",       color: "oklch(0.68 0.18 25)" },
};

// status meta
const STATUS = {
  running: { label: "running", color: ACCENT },
  asking:  { label: "asking",  color: VIOLET },
  blocked: { label: "blocked", color: DANGER },
  waiting: { label: "waiting", color: INFO },
  idle:    { label: "idle",    color: DIM },
  done:    { label: "landed",  color: OK },
};

// six workers, one per stream + the director
const WORKERS = [
  { id: "api",       agent: "@scratch",  profile: "build",  branch: "fleet/api",       stream: "stream:api",
    status: "running", issue: "#218 webhook receiver endpoint", ownedDone: 4, ownedTotal: 6,
    tokensK: 312, costUsd: 1.84, lastMin: 1, flow: "continuous · auto-pr",
    note: "writing handler + signature verify" },
  { id: "emitter",   agent: "@scratch",  profile: "build",  branch: "fleet/emitter",   stream: "stream:worker",
    status: "running", issue: "#221 settlement event emitter", ownedDone: 3, ownedTotal: 5,
    tokensK: 268, costUsd: 1.57, lastMin: 2, flow: "continuous · auto-pr",
    note: "draining the outbox queue" },
  { id: "dashboard", agent: "@scratch",  profile: "build",  branch: "fleet/dashboard", stream: "stream:dashboard",
    status: "asking",  issue: "#224 sub-second dashboard push", ownedDone: 2, ownedTotal: 5,
    tokensK: 201, costUsd: 1.18, lastMin: 6, flow: "confirm · push-confirm",
    note: 'asks: "SSE or websocket for the live feed?"' },
  { id: "infra",     agent: "@github",   profile: "auto",   branch: "fleet/infra",     stream: "stream:infra",
    status: "blocked", issue: "#229 HMAC signing + rotate", ownedDone: 1, ownedTotal: 4,
    tokensK: 142, costUsd: 0.83, lastMin: 18, flow: "continuous · self-merge",
    note: "blocked on #218 (shared signer)" },
  { id: "docs",      agent: "@docs",     profile: "docs",   branch: "fleet/docs",      stream: "stream:docs",
    status: "waiting", issue: "#231 API docs + changelog", ownedDone: 2, ownedTotal: 3,
    tokensK: 64,  costUsd: 0.38, lastMin: 24, flow: "checkpoint · commit-only",
    note: "waiting on contract:webhook-v2" },
  { id: "review",    agent: "@reviewer", profile: "review", branch: "(read-only)",     stream: "stream:review",
    status: "running", issue: "reviewing #218, #221", ownedDone: 7, ownedTotal: 9,
    tokensK: 88,  costUsd: 0.52, lastMin: 3, flow: "continuous · none",
    note: "left 4 comments on #221" },
];

const DIRECTOR = { id: "director", drive: "event", mergedToday: 9, openPRs: 3, idleFor: 1 };

// fleet status distribution (for donut)
function statusCounts() {
  const c = {};
  WORKERS.forEach(w => { c[w.status] = (c[w.status] || 0) + 1; });
  return c;
}

// ── throughput: last 14 days, issues landed + PRs merged ─────────────────────
const DAYS14 = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(Date.now() - (13 - i) * 86400000);
  return `${d.getMonth() + 1}/${d.getDate()}`;
});
const LANDED_14 = [3, 5, 4, 6, 5, 2, 1, 4, 7, 6, 8, 5, 9, 7];
const MERGED_14 = [2, 4, 4, 5, 4, 2, 1, 3, 6, 5, 7, 5, 8, 6];
const TOKENS_14 = [0.9, 1.4, 1.1, 1.6, 1.3, 0.5, 0.3, 1.2, 2.0, 1.7, 2.3, 1.5, 2.6, 2.1]; // millions

// last 7 slices of the above
function rangeSlice(range) {
  const n = range === "7d" ? 7 : range === "30d" ? 14 : 14;
  return {
    labels: DAYS14.slice(-n).concat(range === "30d" ? [] : []),
    landed: LANDED_14.slice(-n),
    merged: MERGED_14.slice(-n),
    tokens: TOKENS_14.slice(-n),
  };
}

// ── coordination timeline (≈6h session) — t in [0,1] across the session ──────
// lane index = position in [director, ...WORKERS]
const COORD_LANES = [
  { name: "director", color: ACCENT },
  ...WORKERS.map(w => ({ name: w.id, color: PROFILE[w.profile].color })),
];
const COORD_EVENTS = [
  // worker run spans
  { lane: 1, t0: 0.02, t1: 0.30, color: PROFILE.build.color,  label: "api · #216 schema" },
  { lane: 1, t0: 0.34, t1: 0.62, color: PROFILE.build.color,  label: "api · #217 framing" },
  { lane: 1, t0: 0.66, t1: 1.0,  color: PROFILE.build.color,  label: "api · #218 receiver" },
  { lane: 2, t0: 0.05, t1: 0.42, color: PROFILE.build.color,  label: "emitter · #219 outbox" },
  { lane: 2, t0: 0.46, t1: 1.0,  color: PROFILE.build.color,  label: "emitter · #221 emit" },
  { lane: 3, t0: 0.10, t1: 0.55, color: PROFILE.build.color,  label: "dashboard · #223 feed" },
  { lane: 3, t0: 0.60, t1: 0.86, color: PROFILE.build.color,  label: "dashboard · #224 push" },
  { lane: 4, t0: 0.08, t1: 0.40, color: PROFILE.auto.color,   label: "infra · #228 deploy cfg" },
  { lane: 5, t0: 0.12, t1: 0.66, color: PROFILE.docs.color,   label: "docs · #230 guide" },
  { lane: 6, t0: 0.04, t1: 1.0,  color: PROFILE.review.color, label: "review · continuous" },
  // landed dots
  { lane: 1, t0: 0.30, color: OK, r: 4, label: "✔ landed #216" },
  { lane: 1, t0: 0.62, color: OK, r: 4, label: "✔ landed #217" },
  { lane: 2, t0: 0.42, color: OK, r: 4, label: "✔ landed #219" },
  { lane: 3, t0: 0.55, color: OK, r: 4, label: "✔ landed #223" },
  { lane: 4, t0: 0.40, color: OK, r: 4, label: "✔ landed #228" },
  { lane: 5, t0: 0.66, color: OK, r: 4, label: "✔ landed #230" },
  // director merges (on director lane)
  { lane: 0, t0: 0.33, color: ACCENT, r: 4.5, label: "director merged #216" },
  { lane: 0, t0: 0.45, color: ACCENT, r: 4.5, label: "director merged #219" },
  { lane: 0, t0: 0.64, color: ACCENT, r: 4.5, label: "director merged #217" },
  { lane: 0, t0: 0.69, color: ACCENT, r: 4.5, label: "director merged #230" },
  // blocked / asking
  { lane: 4, t0: 0.86, color: DANGER, r: 4, label: "⚠ blocked on #218" },
  { lane: 3, t0: 0.88, color: VIOLET, r: 4, label: "? asks: SSE or websocket?" },
  { lane: 5, t0: 0.70, color: INFO, r: 4, label: "waiting on contract:webhook-v2" },
];
const COORD_MARKS = [
  { t: 0.0, label: "09:00" }, { t: 0.33, label: "11:00" },
  { t: 0.66, label: "13:00" }, { t: 1.0, label: "now" },
];

// ── cycle time (time-to-land) distribution, hours ────────────────────────────
const CYCLE_BUCKETS = [
  { label: "<1h", v: 6 }, { label: "1–2h", v: 11 }, { label: "2–4h", v: 9 },
  { label: "4–8h", v: 5 }, { label: "8h+", v: 2 },
];

// fleet KPIs
const FLEET_KPIS = {
  activeWorkers: WORKERS.filter(w => w.status === "running").length,
  totalWorkers: WORKERS.length,
  landedToday: 7,
  mergedToday: DIRECTOR.mergedToday,
  inFlight: WORKERS.filter(w => w.status === "running").length,
  needAttention: WORKERS.filter(w => w.status === "blocked" || w.status === "asking" || w.status === "waiting").length,
  tokensTodayM: 2.1,
  costToday: WORKERS.reduce((s, w) => s + w.costUsd, 0),
  avgLandH: 2.4,
};

window.FLEET = {
  PROFILE, STATUS, WORKERS, DIRECTOR, statusCounts,
  DAYS14, LANDED_14, MERGED_14, TOKENS_14, rangeSlice,
  COORD_LANES, COORD_EVENTS, COORD_MARKS, CYCLE_BUCKETS, FLEET_KPIS,
  C: { ACCENT, INFO, OK, DANGER, VIOLET, DIM },
};
