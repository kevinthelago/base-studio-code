/* =====================================================================
   data.jsx — mock planning content for the focused planner pane.
   Lifted from the app's own ProjectPane sample (the "Settlement webhooks
   v2" project on acme/payments) and extended across all seven blueprint
   phases so each focused view has authentic-feeling material.
   Exposed on window for the other babel scripts.
   ===================================================================== */

// ── role palette ───────────────────────────────────────────────
const ROLES = {
  planner:  { c: "oklch(0.72 0.10 230)", label: "planner" },
  worker:   { c: "oklch(0.80 0.14 70)",  label: "worker" },
  reviewer: { c: "oklch(0.70 0.12 300)", label: "reviewer" },
  triage:   { c: "oklch(0.72 0.10 195)", label: "triage" },
  tester:   { c: "oklch(0.72 0.13 145)", label: "tester" },
  director: { c: "oklch(0.70 0.14 350)", label: "director" },
};

// ── the 7 permission capabilities (columns of the matrix) ──
const CAPS = [
  { k: "read",   g: "R", label: "read files" },
  { k: "edit",   g: "E", label: "edit files" },
  { k: "create", g: "C", label: "create / delete" },
  { k: "run",    g: "$", label: "run commands" },
  { k: "net",    g: "N", label: "network" },
  { k: "push",   g: "⇡", label: "commit & push" },
  { k: "pkg",    g: "P", label: "install pkgs" },
];

const PRESETS = {
  Plan:   { read: "allow", edit: "deny",  create: "deny",  run: "ask",   net: "ask",   push: "deny",  pkg: "deny" },
  Build:  { read: "allow", edit: "allow", create: "allow", run: "allow", net: "ask",   push: "ask",   pkg: "ask" },
  Review: { read: "allow", edit: "deny",  create: "deny",  run: "allow", net: "deny",  push: "deny",  pkg: "deny" },
  Triage: { read: "allow", edit: "deny",  create: "ask",   run: "deny",  net: "allow", push: "deny",  pkg: "deny" },
  Full:   { read: "allow", edit: "allow", create: "allow", run: "allow", net: "allow", push: "allow", pkg: "allow" },
};

// ── the fleet ──────────────────────────────────────────────────
const AGENTS = [
  { id: "planner", name: "@planner", role: "planner", status: "wait", repo: "acme/payments",
    color: ROLES.planner.c, initial: "P", owns: ["docs/**", "specs/**"], issues: ["M1", "M2"],
    preset: "Plan", perm: { ...PRESETS.Plan }, flow: { autonomy: "confirm", push: "none", gate: "soft" } },
  { id: "framer", name: "@framer", role: "worker", status: "run", repo: "acme/payments",
    color: ROLES.worker.c, initial: "F", owns: ["crates/ws-server/**"], issues: ["#418", "#416"], focus: true,
    preset: "Build", perm: { ...PRESETS.Build }, flow: { autonomy: "checkpoint", push: "push-confirm", gate: "hard" } },
  { id: "auth", name: "@auth", role: "worker", status: "run", repo: "acme/payments",
    color: "oklch(0.78 0.13 50)", initial: "A", owns: ["crates/auth/**", "crates/gh/**"], issues: ["#417", "#413"],
    preset: "Build", perm: { ...PRESETS.Build, push: "allow" }, flow: { autonomy: "continuous", push: "auto-PR", gate: "hard" } },
  { id: "tester", name: "@tester", role: "tester", status: "on", repo: "acme/payments",
    color: ROLES.tester.c, initial: "T", owns: ["tests/**"], issues: ["#408"],
    preset: "Review", perm: { ...PRESETS.Review, run: "allow" }, flow: { autonomy: "continuous", push: "commit-only", gate: "hard" } },
  { id: "triage", name: "@triage", role: "triage", status: "on", repo: "both",
    color: ROLES.triage.c, initial: "Δ", owns: ["— issues only"], issues: ["board"],
    preset: "Triage", perm: { ...PRESETS.Triage }, flow: { autonomy: "continuous", push: "none", gate: "soft" } },
  { id: "reviewer", name: "@reviewer", role: "reviewer", status: "idle", repo: "acme/web-dashboard",
    color: ROLES.reviewer.c, initial: "R", owns: ["src/**"], issues: ["#414"],
    preset: "Review", perm: { ...PRESETS.Review }, flow: { autonomy: "checkpoint", push: "commit-only", gate: "hard" } },
];

// ── repos ──────────────────────────────────────────────────────
const REPOS = [
  { id: "acme/payments", branch: "main", primary: true, cloned: true, ahead: 2, behind: 0,
    lang: "Rust", desc: "Settlement engine + webhook publisher",
    agents: ["planner", "framer", "auth", "tester"],
    branches: [
      { n: "feat/framing-v2",      issue: 418, state: "active", ahead: 5, behind: 2 },
      { n: "feat/webhook-emitter", issue: 416, state: "draft",  ahead: 0, behind: 0 },
      { n: "feat/hmac-mw",         issue: 417, state: "active", ahead: 3, behind: 0 },
      { n: "fix/token-revocation", issue: 413, state: "review", ahead: 2, behind: 1 },
    ] },
  { id: "acme/web-dashboard", branch: "main", primary: false, cloned: true, ahead: 0, behind: 0,
    lang: "TypeScript", desc: "Operator dashboard — delivery monitoring",
    agents: ["reviewer", "triage"],
    branches: [
      { n: "feat/live-updates", issue: 414, state: "review", ahead: 3, behind: 1 },
      { n: "feat/cutover-flag", issue: 420, state: "draft",  ahead: 0, behind: 0 },
    ] },
];

// ── github structure: milestone → epic → issue → sub-issue ─────
const STRUCTURE = [
  { id: "M1", title: "Publisher MVP", repo: "acme/payments", pct: 0.72, state: "doing",
    epics: [
      { id: "E1", title: "Framing v2", pct: 0.7, issues: [
        { n: 418, t: "net: framing v2 + schema regen", state: "doing", owner: "framer",
          ac: 3, branch: "feat/framing-v2", deps: [], sub: [
            { t: "spec the v2 frame shape", done: true },
            { t: "encoder + round-trip tests", done: false },
            { t: "regen schema.json on build", done: false },
          ] },
        { n: 416, t: "worker → webhook emitter", state: "doing", owner: "framer",
          ac: 2, branch: "feat/webhook-emitter", deps: [418], sub: [
            { t: "emit on settlement event", done: false },
            { t: "backpressure + retry", done: false },
          ] },
      ] },
      { id: "E2", title: "Auth surface", pct: 0.5, issues: [
        { n: 417, t: "HMAC verification middleware", state: "doing", owner: "auth",
          ac: 4, branch: "feat/hmac-mw", deps: [], sub: [
            { t: "verify signature header", done: true },
            { t: "timing-safe compare", done: false },
            { t: "key rotation hook", done: false },
          ] },
        { n: 413, t: "tokenized webhook path + revocation", state: "review", owner: "auth",
          ac: 2, branch: "fix/token-revocation", deps: [417], sub: [] },
      ] },
    ] },
  { id: "M2", title: "Dashboard live-update", repo: "acme/web-dashboard", pct: 0.32, state: "doing",
    epics: [
      { id: "E3", title: "Live updates", pct: 0.3, issues: [
        { n: 414, t: "subscribe + render live deliveries", state: "review", owner: "reviewer",
          ac: 3, branch: "feat/live-updates", deps: [], sub: [
            { t: "websocket client hook", done: true },
            { t: "optimistic row updates", done: false },
          ] },
        { n: 420, t: "cutover plan + flag wiring", state: "backlog", owner: "planner",
          ac: 1, branch: "feat/cutover-flag", deps: [413, 414], sub: [] },
      ] },
    ] },
];

// ── context files ──────────────────────────────────────────────
const CONTEXT = [
  { name: "settlement-webhooks.spec.md", kind: "spec",   tok: "4.1k", pinned: true,  scope: "project",
    content: "# Settlement webhooks v2\n\nDelivery contract for settlement events: emit on settle, retry with backoff, sign each payload with an HMAC header.\n\n## Frame\n{ id, type, ts, payload }" },
  { name: "CLAUDE.md", kind: "claude", tok: "1.2k", pinned: true, scope: "global",
    content: "# CLAUDE.md\n\nProject-wide guidance for agents. Build with the existing primitives; keep changes minimal and tested." },
  { name: "blk_71fe · framing v2", kind: "kb", tok: "0.8k", pinned: true, scope: "project",
    content: "Framing v2 — length-prefixed binary frames, schema regenerated on build, round-trip tested." },
  { name: "blk_2199 · sqlite>lmdb", kind: "kb", tok: "0.6k", pinned: true, scope: "project",
    content: "Decision: SQLite over LMDB for the local store — simpler ops, sufficient throughput, easy backups." },
  { name: "acme/payments · CLAUDE.md", kind: "claude", tok: "0.9k", pinned: false, scope: "repo",
    content: "# acme/payments\n\nRepo guidance: the HMAC middleware owns request verification; never log raw signatures." },
  { name: "docs/architecture.md", kind: "doc", tok: "3.4k", pinned: false, scope: "repo",
    content: "# Architecture\n\nWS server → framer → webhook emitter. The auth surface verifies HMAC + tokens; the dashboard subscribes for live updates." },
  { name: "blk_44a1 · retry policy", kind: "kb", tok: "0.5k", pinned: false, scope: "project",
    content: "Retry policy — exponential backoff, max 6 attempts, jitter, dead-letter after exhaustion." },
  { name: "openapi.settlements.yaml", kind: "doc", tok: "2.2k", pinned: false, scope: "repo",
    content: "openapi: 3.1.0\n# Settlement + webhook endpoints, request/response schemas." },
];
const CTX_KIND = {
  spec:   { c: "oklch(0.72 0.10 230)", label: "spec" },
  claude: { c: "oklch(0.80 0.14 70)",  label: "claude.md" },
  kb:     { c: "oklch(0.70 0.12 300)", label: "knowledge" },
  doc:    { c: "oklch(0.66 0.06 200)", label: "doc" },
};

const ISSUE_STATE = {
  doing:   "var(--accent)",
  review:  "var(--success)",
  backlog: "var(--fg-dim)",
  done:    "var(--fg-muted)",
};

// ── UI design — screen skeletons for the render-preview walkthrough ──
const SCREENS = [
  { id: "deliveries", name: "Deliveries", route: "/deliveries", approved: true,
    blocks: ["topbar", "filters", "delivery-table", "detail-drawer"] },
  { id: "delivery", name: "Delivery detail", route: "/deliveries/:id", approved: true,
    blocks: ["topbar", "payload-view", "attempt-timeline", "replay-action"] },
  { id: "endpoints", name: "Endpoints", route: "/endpoints", approved: false, active: true,
    blocks: ["topbar", "endpoint-list", "secret-rotation", "add-endpoint"] },
  { id: "alerts", name: "Alerts", route: "/alerts", approved: false,
    blocks: ["topbar", "alert-rules", "channels"] },
  { id: "settings", name: "Settings", route: "/settings", approved: false,
    blocks: ["topbar", "general", "api-keys", "team"] },
];

// ── automations — cron commands + knowledge injections ──
const AUTOMATIONS = [
  { id: "a1", name: "Nightly schema regen", kind: "command", cron: "0 3 * * *", next: "in 6h 12m",
    target: "acme/payments", detail: "cargo run -p schema-gen && git commit", on: true },
  { id: "a2", name: "Inject retry policy", kind: "knowledge", cron: "on session start", next: "every launch",
    target: "all workers", detail: "blk_44a1 · retry policy → system prompt", on: true },
  { id: "a3", name: "Stale PR sweep", kind: "command", cron: "0 */4 * * *", next: "in 1h 48m",
    target: "director", detail: "gh pr list --search 'draft updated:<-2d'", on: true },
  { id: "a4", name: "Dependency audit", kind: "command", cron: "0 9 * * 1", next: "Mon 09:00",
    target: "acme/payments", detail: "cargo audit --deny warnings", on: false },
  { id: "a5", name: "Inject HMAC guidance", kind: "knowledge", cron: "on session start", next: "every launch",
    target: "@auth", detail: "acme/payments · CLAUDE.md → @auth prompt", on: true },
];

// ── skills — reusable skill library to index for this project ──
const SKILLS = [
  { id: "s1", name: "rust-hmac-middleware", tags: ["rust", "auth"], indexed: true,
    desc: "Drop-in HMAC request verification + timing-safe compare for axum services." },
  { id: "s2", name: "webhook-retry-backoff", tags: ["rust", "reliability"], indexed: true,
    desc: "Exponential backoff with jitter + dead-letter, used by the emitter." },
  { id: "s3", name: "ws-live-table", tags: ["typescript", "react"], indexed: true,
    desc: "WebSocket-backed live table with optimistic row updates." },
  { id: "s4", name: "schema-codegen", tags: ["rust", "build"], indexed: false,
    desc: "Regenerate schema.json from frame definitions at build time." },
  { id: "s5", name: "gh-milestone-sync", tags: ["github", "ops"], indexed: false,
    desc: "Reconcile a plan's milestones/issues with a GitHub project board." },
];

// ── the seven blueprint phases ──────────────────────────────────
// status: done | active | locked | upcoming
const PHASES = [
  { key: "context",     title: "Context",     n: 1, view: "context",
    blurb: "Gather the specs, decisions, and knowledge blocks the fleet will plan against.",
    gate: { name: "lint-plan", note: "no empty or unresolved context files" } },
  { key: "repos",       title: "Repos",       n: 2, view: "repos",
    blurb: "Link and clone the repositories this project will build across.",
    gate: { name: "clone-check", note: "every linked repo is cloned locally" } },
  { key: "ui",          title: "UI Design",   n: 3, view: "ui",
    blurb: "Generate screen skeletons and approve them in a live walkthrough.",
    gate: { name: "render-preview", note: "all screens approved in the preview" } },
  { key: "structure",   title: "Structure",   n: 4, view: "structure",
    blurb: "Shape milestones, epics, issues, and sub-issues for the GitHub board.",
    gate: { name: "lint-plan", note: "no issue missing acceptance criteria" } },
  { key: "permissions", title: "Permissions", n: 5, view: "permissions",
    blurb: "Assign each work stream a least-privilege permission posture.",
    gate: { name: "policy-check", note: "no worker has unscoped push access" } },
  { key: "automations", title: "Automations", n: 6, view: "automations",
    blurb: "Schedule recurring commands and knowledge injections for the fleet.",
    gate: null },
  { key: "skills",      title: "Skills",      n: 7, view: "skills",
    blurb: "Index reusable skills so every worker inherits proven patterns.",
    gate: null },
];

Object.assign(window, {
  ROLES, CAPS, PRESETS, AGENTS, REPOS, STRUCTURE, CONTEXT, CTX_KIND,
  ISSUE_STATE, SCREENS, AUTOMATIONS, SKILLS, PHASES,
});
