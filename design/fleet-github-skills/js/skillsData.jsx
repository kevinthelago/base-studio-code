/* global window */
// Mock data for the Skills library. A "skill" is a reusable capability bundle —
// a named procedure (prompt + bundled tools + guardrails) that any worker running
// an allowed permission-profile can invoke. Modeled on the Extensions data shape
// so swapping in live data later is a drop-in. Stats are fleet-wide, last 7d.

const A = "var(--accent)", I = "var(--info)", G = "var(--success)", D = "var(--danger)",
  V = "oklch(0.7 0.12 290)", DOCSC = "oklch(0.7 0.06 90)", DIM = "var(--fg-dim)";

// kind → glyph + color (matches the catalog-icon style on the Extensions screen)
const KIND = {
  workflow: { label: "workflow", glyph: "⌁", color: A },
  scaffold: { label: "scaffold", glyph: "▤", color: I },
  codemod:  { label: "codemod",  glyph: "↻", color: V },
  review:   { label: "review",   glyph: "◇", color: G },
  docs:     { label: "docs",     glyph: "¶", color: DOCSC },
};

// profile keys mirror agentProfiles.ts / fleetData PROFILE
const PROFILE_COLOR = {
  build: "oklch(0.78 0.14 70)", review: "oklch(0.72 0.10 230)",
  docs: "oklch(0.7 0.06 90)", auto: "oklch(0.74 0.13 145)", sandbox: "oklch(0.68 0.18 25)",
};

const SKILLS = [
  {
    id: "scaffold-tauri-cmd", name: "Scaffold Tauri command", kind: "scaffold", source: "first-party",
    desc: "Adds a #[tauri::command], wires it into the invoke handler, generates the TS binding, and stubs a test.",
    tools: ["write_file", "edit", "repo_map", "rust_check"],
    profiles: ["build", "auto"], invocations: 142, success: 96, avgTokensK: 18, lastUsed: "3m ago",
    trend: [12, 18, 14, 22, 19, 28, 29], pinned: true,
  },
  {
    id: "add-screen-slice", name: "Add screen + store slice", kind: "scaffold", source: "first-party",
    desc: "Creates a screen folder, a Zustand slice, the rail entry, and a smoke test — following the existing screens/ layout.",
    tools: ["write_file", "edit", "related_files"],
    profiles: ["build"], invocations: 88, success: 92, avgTokensK: 24, lastUsed: "21m ago",
    trend: [6, 9, 8, 14, 11, 16, 18],
  },
  {
    id: "open-pr", name: "Open a clean PR", kind: "workflow", source: "first-party",
    desc: "Writes a conventional-commit title, a summary + test-plan body from the diff, links the issue, and requests review.",
    tools: ["create_pr", "get_pr", "git_diff"],
    profiles: ["build", "auto", "review"], invocations: 261, success: 99, avgTokensK: 7, lastUsed: "42s ago",
    trend: [22, 28, 25, 34, 31, 40, 47], pinned: true,
  },
  {
    id: "triage-failing-test", name: "Triage a failing test", kind: "workflow", source: "team",
    desc: "Reproduces the failure, bisects the offending change, proposes a minimal fix, and re-runs the suite before handing back.",
    tools: ["rust_check", "run_tests", "git_diff", "repo_map"],
    profiles: ["build", "auto"], invocations: 64, success: 81, avgTokensK: 41, lastUsed: "1h ago",
    trend: [4, 7, 6, 9, 8, 12, 11],
  },
  {
    id: "bump-dep-safely", name: "Bump dependency safely", kind: "codemod", source: "team",
    desc: "Updates one crate/package, reads the changelog for breaking changes, applies codemods, and gates on a green build.",
    tools: ["edit", "run_tests", "rust_check"],
    profiles: ["build"], invocations: 37, success: 78, avgTokensK: 33, lastUsed: "2h ago",
    trend: [2, 4, 3, 6, 5, 8, 7],
  },
  {
    id: "wire-mcp-tool", name: "Wire a new MCP tool", kind: "workflow", source: "first-party",
    desc: "Registers an MCP tool in the extension manifest, adds the transport config, and posts a usage example to the knowledge store.",
    tools: ["write_file", "edit", "kb_write"],
    profiles: ["build", "auto"], invocations: 29, success: 90, avgTokensK: 21, lastUsed: "4h ago",
    trend: [1, 3, 2, 4, 5, 6, 8],
  },
  {
    id: "security-review", name: "Security review pass", kind: "review", source: "first-party",
    desc: "Read-only sweep for secrets, unsafe blocks, missing auth checks, and injection sinks — leaves inline review comments only.",
    tools: ["git_diff", "get_pr", "rank_files"],
    profiles: ["review"], invocations: 53, success: 94, avgTokensK: 16, lastUsed: "12m ago",
    trend: [5, 6, 7, 8, 9, 10, 8],
  },
  {
    id: "api-docs", name: "Generate API docs", kind: "docs", source: "first-party",
    desc: "Derives reference docs + a changelog entry from a merged contract, writes them to /docs, and opens a docs-only PR.",
    tools: ["write_file", "git_diff", "kb_write"],
    profiles: ["docs"], invocations: 41, success: 97, avgTokensK: 12, lastUsed: "34m ago",
    trend: [3, 4, 5, 6, 5, 7, 11],
  },
  {
    id: "rename-symbol", name: "Project-wide rename", kind: "codemod", source: "imported",
    desc: "Type-aware symbol rename across Rust + TS, updates imports and call-sites, and verifies with a typecheck.",
    tools: ["edit", "repo_map", "rust_check"],
    profiles: ["build", "sandbox"], invocations: 19, success: 84, avgTokensK: 28, lastUsed: "6h ago",
    trend: [1, 2, 2, 3, 4, 3, 4],
  },
];

const CATALOG = [
  { name: "Add DB migration", by: "first-party", glyph: "▤", desc: "Scaffold a reversible migration + model update." },
  { name: "Flaky-test quarantine", by: "team", glyph: "◇", desc: "Tag and isolate intermittently-failing tests." },
  { name: "Perf profiling pass", by: "community", glyph: "↻", desc: "Profile a hot path and propose targeted fixes." },
  { name: "Release notes", by: "first-party", glyph: "¶", desc: "Draft notes from the merged-PR range since last tag." },
];

const SOURCE_TAG = {
  "first-party": { label: "first-party", cls: "amber" },
  team: { label: "team", cls: "info" },
  imported: { label: "imported", cls: "" },
  community: { label: "community", cls: "" },
};

// derived KPIs
const totalInv = SKILLS.reduce((s, k) => s + k.invocations, 0);
const wAvgSuccess = Math.round(SKILLS.reduce((s, k) => s + k.success * k.invocations, 0) / totalInv);
const topSkill = [...SKILLS].sort((a, b) => b.invocations - a.invocations)[0];
const SKILL_KPIS = {
  total: SKILLS.length,
  invToday: 318,
  invWeek: totalInv,
  avgSuccess: wAvgSuccess,
  top: topSkill.name,
  enabled: SKILLS.filter(k => k.pinned).length,
  tokensSavedM: 4.7,
};

window.SKILLDATA = {
  KIND, PROFILE_COLOR, SKILLS, CATALOG, SOURCE_TAG, SKILL_KPIS,
  C: { A, I, G, D, V, DOCSC, DIM },
};
