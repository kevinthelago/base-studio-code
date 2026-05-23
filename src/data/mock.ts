// These types mirror the view component interfaces in src/components/pane/views/.
// Defined here so this module compiles independently of branch #4.

export interface TextBlock     { kind: "text";     text: string }
export interface ThinkingBlock { kind: "thinking"; text: string; dur: string; collapsed?: boolean }
export interface ToolBlock     { kind: "tool";     tool: string; args: string; ok?: boolean; summary?: string; preview?: string }
type Block = TextBlock | ThinkingBlock | ToolBlock;
type AssistantTurn = { role: "assistant"; blocks: Block[] };
type UserTurn      = { role: "user";      text: string };
export type Turn = AssistantTurn | UserTurn;

export interface FileRow {
  name: string; path: string;
  depth?: number; dir?: boolean; open?: boolean;
  status?: "M" | "A" | "??" | "D";
}

export interface Branch {
  n: string; cur?: boolean;
  ahead?: number; behind?: number;
  age: string; merged?: boolean; stale?: boolean;
}

export interface DiffLine { sign: " " | "+" | "-"; text: string }
export interface DiffHunk { file: string; add: number; del: number; sample: DiffLine[] }

export interface Commit { s: string; m: string; who: string; t: string; head?: boolean; merge?: boolean }

// ─── Console sample data ───────────────────────────────────────────────────

export const REVIEW_TURNS: Turn[] = [
  { role: "user", text: "review the retry loop in crates/ws-server/src/tunnel.rs around line 212" },
  { role: "assistant", blocks: [
    { kind: "thinking", dur: "2s", collapsed: false,
      text: "user wants a focused review. read the file, find the loop, critique with line numbers." },
    { kind: "tool", tool: "Read", args: "crates/ws-server/src/tunnel.rs · L200-260",
      ok: true, summary: "60 lines",
      preview: "L212  loop {\nL213      let delay = base_ms * 2u64.pow(attempts);\nL214      let jitter = rand::random::<f32>();\nL215      tokio::time::sleep(delay).await;\nL216      attempts += 1;\nL217      if let Ok(c) = connect().await { break c; }\nL218  }" },
    { kind: "text", text: "Three things at L212–218:\n\n  1.  base_ms = 100 is too small under a sustained outage. Suggest 500ms or read from config.\n  2.  attempts isn't capped; with current exponent you'd retry past 9 min. Cap at 6.\n  3.  Jitter uses raw rand::random::<f32>(); switch to ±25% of base so it stays bounded.\n\nWant me to draft the patch?" },
  ]},
  { role: "user", text: "yes, please" },
  { role: "assistant", blocks: [
    { kind: "tool", tool: "Write", args: "crates/ws-server/src/tunnel.rs · L212-220", ok: true, summary: "+12 −7" },
    { kind: "tool", tool: "Bash", args: "cargo clippy -p ws-server", ok: true, summary: "0 warnings" },
    { kind: "text", text: "Patched and clippy is clean. The diff is in the **Changes** tab if you want to eyeball it before I commit." },
  ]},
];

// ─── File tree ─────────────────────────────────────────────────────────────

export const TREE: FileRow[] = [
  { name: "acme/payments",  dir: true, open: true, depth: 0, path: "_" },
  { name: "crates",          dir: true, open: true, depth: 1, path: "crates" },
  { name: "ws-server",       dir: true, open: true, depth: 2, path: "crates/ws-server" },
  { name: "src",             dir: true, open: true, depth: 3, path: "crates/ws-server/src" },
  { name: "proto.rs",                   depth: 4, path: "crates/ws-server/src/proto.rs", status: "M" },
  { name: "frame.rs",                   depth: 4, path: "crates/ws-server/src/frame.rs" },
  { name: "tunnel.rs",                  depth: 4, path: "crates/ws-server/src/tunnel.rs" },
  { name: "orch",            dir: true,  depth: 2, path: "crates/orch" },
  { name: "kb",              dir: true,  depth: 2, path: "crates/kb" },
  { name: "gh",              dir: true,  depth: 2, path: "crates/gh" },
  { name: "src",             dir: true, open: true, depth: 1, path: "src" },
  { name: "App.tsx",                    depth: 2, path: "src/App.tsx" },
  { name: "console",         dir: true,  depth: 2, path: "src/console" },
  { name: "docs",            dir: true,  depth: 1, path: "docs" },
  { name: "automations.md",             depth: 2, path: "docs/automations.md", status: "??" },
  { name: "Cargo.toml",                 depth: 1, path: "Cargo.toml" },
  { name: "README.md",                  depth: 1, path: "README.md" },
];

// ─── Branches ──────────────────────────────────────────────────────────────

export const BRANCHES: Branch[] = [
  { n: "main",               cur: true, ahead: 0, behind: 0, age: "3m" },
  { n: "feat/tunnel-v2",     ahead: 5,  behind: 2, age: "24m" },
  { n: "fix/retry-loop",     ahead: 0,  behind: 0, age: "4h", merged: true },
  { n: "docs/migrate-store", ahead: 2,  behind: 0, age: "1h" },
  { n: "chore/bump-sdk",     ahead: 1,  behind: 8, age: "3d" },
  { n: "wip/audit-log",      ahead: 11, behind: 14, age: "1w", stale: true },
];

// ─── Diff ──────────────────────────────────────────────────────────────────

export const HUNKS: DiffHunk[] = [
  { file: "crates/ws-server/src/proto.rs", add: 14, del: 2, sample: [
    { sign: " ", text: " pub struct Hello {" },
    { sign: "-", text: "     pub v: u8," },
    { sign: "+", text: "     pub v: u16," },
    { sign: "+", text: "     pub capabilities: Vec<String>," },
    { sign: " ", text: "     pub host_name: String," },
    { sign: " ", text: " }" },
  ]},
  { file: "crates/orch/src/agent.rs", add: 4, del: 1, sample: [
    { sign: " ", text: " fn dispatch_tool(name: &str) -> Result<()> {" },
    { sign: "-", text: '     trace!("tool {}", name);' },
    { sign: "+", text: '     trace!(target:"tool", name);' },
    { sign: "+", text: "     ensure_repo_scope()?;" },
  ]},
];

// ─── Log ───────────────────────────────────────────────────────────────────

export const COMMITS: Commit[] = [
  { s: "a05", m: "release: v0.5.0 — icon tabs", who: "lina", t: "3m",  head: true },
  { s: "b05", m: "net: pairing flow",            who: "lina", t: "24m" },
  { s: "d02", m: "docs: store migration",        who: "bot",  t: "1h"  },
  { s: "b04", m: "net: schema.json gen",         who: "alex", t: "3h"  },
  { s: "a04", m: "merge fix/retry-loop",         who: "lina", t: "4h", merge: true },
  { s: "c02", m: "retry: exponential w/ jitter", who: "alex", t: "6h"  },
  { s: "b03", m: "net: frame v2 encoder",        who: "lina", t: "8h"  },
  { s: "a03", m: "docs: readme overview",        who: "alex", t: "yesterday" },
];

// ─── Knowledge Store ───────────────────────────────────────────────────────

export interface KbTag   { name: string; n: number; on?: boolean }
export interface KbBlock { id: string; title: string; tags: string[]; updated: string; lines: number; sel?: boolean }

export const KB_TAGS: KbTag[] = [
  { name: "all",           n: 142, on: true },
  { name: "architecture",  n: 18 },
  { name: "decisions",     n: 24 },
  { name: "review-policy", n: 7, on: true },
  { name: "agents",        n: 21 },
  { name: "tunnel",        n: 9 },
  { name: "repro",         n: 14 },
  { name: "glossary",      n: 6 },
  { name: "runbooks",      n: 11 },
  { name: "prompts",       n: 32 },
];

export const KB_BLOCKS: KbBlock[] = [
  { id: "blk_9a2c", title: "Review policy — TS / Rust",       tags: ["review-policy", "decisions"], updated: "14:02",     lines: 42, sel: true },
  { id: "blk_71fe", title: "Tunnel framing v2",               tags: ["tunnel", "architecture"],      updated: "yesterday", lines: 88 },
  { id: "blk_4ad8", title: "Agent: @reviewer system prompt",  tags: ["agents", "prompts"],           updated: "2d",        lines: 64 },
  { id: "blk_2199", title: "Decision · SQLite over LMDB",     tags: ["decisions", "architecture"],   updated: "3d",        lines: 31 },
  { id: "blk_aa17", title: "Glossary — console, tab, pane",   tags: ["glossary"],                    updated: "5d",        lines: 22 },
  { id: "blk_cd03", title: "Repro pattern — flaky retry loop",tags: ["repro", "runbooks"],           updated: "1w",        lines: 17 },
  { id: "blk_55fd", title: "Webhook routing table",           tags: ["architecture", "decisions"],   updated: "1w",        lines: 54 },
];

// ─── GitHub ────────────────────────────────────────────────────────────────

export interface PullRequest {
  n: string; t: string; who: string;
  st: "review" | "changes" | "approved" | "draft";
  age: string; ci: "ok" | "fail";
}

export const PULL_REQUESTS: PullRequest[] = [
  { n: "#418", t: "net: framing v2 + schema regen",     who: "lina", st: "review",   age: "2h",        ci: "ok"   },
  { n: "#416", t: "orch: tool dispatch refactor",       who: "alex", st: "changes",  age: "yesterday", ci: "fail" },
  { n: "#414", t: "kb: backlinks + FTS5",               who: "lina", st: "approved", age: "2d",        ci: "ok"   },
  { n: "#411", t: "docs: store migration",              who: "bot",  st: "draft",    age: "3d",        ci: "ok"   },
  { n: "#406", t: "chore: bump anthropic-sdk 0.9",      who: "alex", st: "review",   age: "1w",        ci: "ok"   },
];

export const RECENT_COMMITS: Commit[] = [
  { s: "a05", m: "release: v0.5.0",            who: "lina", t: "3m"  },
  { s: "b05", m: "net: pairing flow",          who: "lina", t: "24m" },
  { s: "d02", m: "docs: store migration",      who: "bot",  t: "1h"  },
  { s: "b04", m: "net: schema.json gen",       who: "alex", t: "3h"  },
  { s: "a04", m: "merge fix/retry-loop",       who: "lina", t: "4h"  },
  { s: "c02", m: "retry: exponential w/jitter",who: "alex", t: "6h"  },
];

// ─── Automations ───────────────────────────────────────────────────────────

export interface Schedule {
  id: string; name: string; on: boolean; sel?: boolean;
  when: string; target: string;
  action: "command" | "knowledge";
  detail: string; lastRun: string; nextRun: string;
}

export interface Command {
  id: string; name: string; cmd: string;
  kind?: "claude"; used: number; tags: string[];
}

export const SCHEDULES: Schedule[] = [
  { id: "S-01", name: "Nightly review digest",   on: true,  sel: true,
    when: "every day · 02:00",      target: "orchestrator › @scratch",
    action: "knowledge", detail: "summarize blocks tagged #decisions, #architecture into a digest block",
    lastRun: "02:00 today · ✓",  nextRun: "02:00 tomorrow" },
  { id: "S-02", name: "Pre-standup repo sync",   on: true,
    when: "weekdays · 08:45",       target: "orchestrator › @github",
    action: "command",  detail: "git fetch --all && gh pr list --state open",
    lastRun: "08:45 today · ✓",  nextRun: "08:45 tomorrow" },
  { id: "S-03", name: "Bump weekly deps",         on: true,
    when: "every Monday · 09:00",   target: "feat/tunnel › @scratch",
    action: "command",  detail: "cargo update && cargo test --workspace",
    lastRun: "09:00 Mon · ✓",    nextRun: "09:00 next Mon" },
  { id: "S-04", name: "Refresh review policy",   on: true,
    when: "every hour · :15",       target: "orchestrator › @reviewer",
    action: "knowledge", detail: "pin blk_9a2c (Review policy — TS / Rust) into the pane context",
    lastRun: "14:15 · ✓",        nextRun: "15:15 · in 22m" },
  { id: "S-05", name: "Pause overnight",          on: false,
    when: "every day · 22:00",      target: "all consoles",
    action: "command",  detail: "base-studio mute --all && base-studio resume --at 07:00",
    lastRun: "paused",           nextRun: "—" },
];

export const COMMANDS: Command[] = [
  { id: "cmd_lint",    name: "Lint workspace",         cmd: "cargo fmt --check && cargo clippy --workspace",                                    used: 8,  tags: ["rust", "check"]  },
  { id: "cmd_test",    name: "Quick test pass",         cmd: "cargo test --workspace --quiet",                                                   used: 5,  tags: ["rust", "check"]  },
  { id: "cmd_sync",    name: "Fetch + PR sync",         cmd: "git fetch --all && gh pr list --state open --json number,title,headRefName",        used: 12, tags: ["git", "github"]  },
  { id: "cmd_rebuild", name: "Clean rebuild",           cmd: "cargo clean && cargo build --release",                                             used: 1,  tags: ["rust"]           },
  { id: "cmd_migrate", name: "Run pending migrations",  cmd: "sqlx migrate run --source crates/kb/migrations",                                   used: 3,  tags: ["sqlite", "kb"]   },
  { id: "cmd_seed",    name: "Seed dev data",           cmd: "cargo run -p tools --bin seed -- --reset",                                         used: 2,  tags: ["dev"]            },
  { id: "cmd_pin",     name: "Pin review policy",       cmd: "/pin blk_9a2c",   kind: "claude",                                                  used: 21, tags: ["claude", "prompt"]},
  { id: "cmd_scan",    name: "Scan repo into context",  cmd: "/scan",           kind: "claude",                                                  used: 34, tags: ["claude", "prompt"]},
];

// ─── Settings repos ────────────────────────────────────────────────────────

export interface Repo {
  name: string; on: boolean; branch: string; desc: string;
  priv: boolean; hooks: string;
}

export const SETTINGS_REPOS: Repo[] = [
  { name: "acme/payments",    on: true,  branch: "main",    desc: "Stripe + Tipalti adapters",    priv: true,  hooks: "PR · push · issue" },
  { name: "acme/ledger-core", on: true,  branch: "main",    desc: "Double-entry ledger (Rust)",   priv: true,  hooks: "PR · push" },
  { name: "acme/web",         on: false, branch: "develop", desc: "Customer dashboard (Next.js)", priv: true,  hooks: "—" },
  { name: "acme/docs",        on: true,  branch: "main",    desc: "Public engineering docs",       priv: false, hooks: "push" },
  { name: "lina/playground",  on: false, branch: "main",    desc: "Personal scratch repos",        priv: false, hooks: "—" },
];
