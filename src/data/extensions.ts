// Typed mock data for the Extensions screen, transcribed from design/Extensions.html.
// This is sample data only — the real backend (MCP config writer, in-process
// server, hooks) lands later (#33 follow-ups). The screen renders entirely off
// these structures so swapping in live data is a drop-in later.

export type ExtGroup = "firstparty" | "mcp" | "hook";
export type ExtHealth = "ok" | "fail" | "off";
export type LogLevel = "ok" | "warn" | "fail";

export interface ExtProject {
  id: string;
  name: string;
  full: string;
  branch: string;
  /** oklch color used for the project's dot/chip. */
  color: string;
}

export interface ExtConfig {
  /** "in-process" | "http+sse" | "stdio" | "hook" */
  transport: string;
  endpoint?: string;
  command?: string;
  args?: string;
  event?: string;
  env: Array<[string, string]>;
  secrets: Array<[string, string]>;
  log: Array<[string, LogLevel, string]>;
}

export interface Extension {
  id: string;
  group: ExtGroup;
  name: string;
  /** Free-text kind label, e.g. "first-party", "mcp · http", "hook · PostToolUse". */
  kind: string;
  desc: string;
  tools: string[];
  health: ExtHealth;
  on: boolean;
  /** [] = enabled globally (every project); otherwise the project ids it applies to. */
  projects: string[];
  lastUsed: string;
  calls: number;
  error?: string;
  config: ExtConfig;
}

export interface CatalogItem {
  name: string;
  by: string;
  icon: string;
  desc: string;
}

export const SCOPE_COPY: Record<string, string> = {
  global: "on every project",
  project: "for the projects you pick",
  console: "for one console only",
};

export const EXT_PROJECTS: ExtProject[] = [
  { id: "acme/payments",    name: "payments",    full: "acme/payments",    branch: "main",    color: "oklch(0.78 0.13 70)" },
  { id: "acme/ledger-core", name: "ledger-core", full: "acme/ledger-core", branch: "main",    color: "oklch(0.74 0.13 145)" },
  { id: "acme/web",         name: "web",         full: "acme/web",         branch: "develop", color: "oklch(0.72 0.10 230)" },
  { id: "acme/docs",        name: "docs",        full: "acme/docs",        branch: "main",    color: "oklch(0.78 0.10 320)" },
  { id: "lina/playground",  name: "playground",  full: "lina/playground",  branch: "main",    color: "oklch(0.66 0.05 260)" },
];

export const EXTENSIONS: Extension[] = [
  // ── First-party (in-process) ──────────────────────────────────────────────
  {
    id: "context", group: "firstparty", name: "Context", kind: "first-party",
    desc: "Repo map and file-relevance scoring so agents ask for fewer files. Builds a lightweight index over your project on connect.",
    tools: ["rank_files", "repo_map", "related_files"],
    health: "ok", on: true, projects: [], lastUsed: "2m ago", calls: 41,
    config: {
      transport: "in-process", endpoint: "host://extensions/context",
      env: [["INDEX_TTL", "1h"], ["MAX_FILES", "2000"]], secrets: [],
      log: [
        ["14:24:11", "ok", "rank_files('payments/charge.ts') · 12ms · 18 hits"],
        ["14:23:48", "ok", "repo_map() · 92ms · cached"],
        ["14:22:02", "ok", "related_files('charge.ts') · 18ms"],
      ],
    },
  },
  {
    id: "checkpoint", group: "firstparty", name: "Checkpoint", kind: "first-party",
    desc: "Persists where the agent left off per repo — open files, focus, scratch notes. Replaces the legacy shell helper.",
    tools: ["save_checkpoint", "read_checkpoint"],
    health: "ok", on: true, projects: [], lastUsed: "18m ago", calls: 12,
    config: {
      transport: "in-process", endpoint: "host://extensions/checkpoint",
      env: [["STORE_PATH", "~/.base-studio/checkpoints"]], secrets: [],
      log: [
        ["14:08:02", "ok", "save_checkpoint('acme/payments') · 6ms"],
        ["13:42:11", "ok", "read_checkpoint('acme/payments') · 4ms"],
      ],
    },
  },
  // ── MCP servers (third-party) ─────────────────────────────────────────────
  {
    id: "github", group: "mcp", name: "GitHub", kind: "mcp · http",
    desc: "Issues, PRs, repos, releases. Shares the host's cached GitHub access — no separate token needed.",
    tools: ["list_issues", "create_pr", "get_pr", "list_workflows", "get_release"],
    health: "ok", on: true, projects: ["acme/payments", "acme/ledger-core"], lastUsed: "42s ago", calls: 88,
    config: {
      transport: "http+sse", endpoint: "https://mcp.github.com/sse", env: [],
      secrets: [["GITHUB_TOKEN", "reuses host credential · gho_••••8a2c"]],
      log: [
        ["14:24:02", "ok", "list_issues(state='open') · 412ms · 14 issues"],
        ["14:21:30", "ok", "get_pr(#284) · 188ms"],
        ["14:18:09", "ok", "list_workflows() · 244ms · 7 workflows"],
        ["14:12:51", "ok", "create_pr · base=develop · 612ms"],
      ],
    },
  },
  {
    id: "filesystem", group: "mcp", name: "Filesystem", kind: "mcp · stdio",
    desc: "Scoped read/write/move under a sandboxed root. Off by default — agents already have Read/Edit; turn this on only if you want them to move or rename files.",
    tools: ["read_file", "write_file", "move_file", "list_directory"],
    health: "off", on: false, projects: [], lastUsed: "never", calls: 0,
    config: {
      transport: "stdio", command: "npx", args: "@modelcontextprotocol/server-filesystem /Users/lina/code",
      env: [["ALLOW_ROOT", "/Users/lina/code"], ["DENY_GLOBS", "**/.env, **/secrets/**"]],
      secrets: [], log: [],
    },
  },
  {
    id: "playwright", group: "mcp", name: "Playwright", kind: "mcp · stdio",
    desc: "Headless browser automation — navigate, click, screenshot, scrape. Useful for testing flows the agent has just changed.",
    tools: ["navigate", "click", "fill", "screenshot", "extract"],
    health: "fail", on: true, projects: [], lastUsed: "4m ago", calls: 6, error: "spawn npx ENOENT",
    config: {
      transport: "stdio", command: "npx", args: "@playwright/mcp@latest --headless",
      env: [["DISPLAY", ":99"]], secrets: [],
      log: [
        ["14:20:04", "fail", "connect() · spawn npx ENOENT"],
        ["14:18:51", "fail", "connect() · spawn npx ENOENT"],
        ["14:14:22", "ok", "screenshot() · 1.8s · 2.4MB"],
        ["14:12:08", "ok", "navigate('http://localhost:5173') · 312ms"],
      ],
    },
  },
  // ── Hooks ───────────────────────────────────────────────────────────────────
  {
    id: "log-tools", group: "hook", name: "Log tool usage", kind: "hook · PostToolUse",
    desc: "Fires after every tool call and writes a row to the local audit log. Powers the per-extension call counts you see here.",
    tools: ["PostToolUse"],
    health: "ok", on: true, projects: [], lastUsed: "2s ago", calls: 1284,
    config: {
      transport: "hook", event: "PostToolUse", command: "~/.base-studio/hooks/log-tool.sh",
      env: [["LOG_PATH", "~/.base-studio/audit.log"]], secrets: [],
      log: [
        ["14:24:11", "ok", "PostToolUse('rank_files') · 1ms"],
        ["14:24:02", "ok", "PostToolUse('list_issues') · 1ms"],
        ["14:23:48", "ok", "PostToolUse('repo_map') · 1ms"],
      ],
    },
  },
  {
    id: "guard-lockfiles", group: "hook", name: "Guard lockfiles", kind: "hook · PreToolUse",
    desc: "Blocks any Edit / Write that targets a lockfile (Cargo.lock, package-lock.json, yarn.lock, Gemfile.lock). Surfaces a diff to you instead.",
    tools: ["PreToolUse"],
    health: "ok", on: true, projects: ["acme/payments", "acme/ledger-core", "acme/web"], lastUsed: "22m ago", calls: 4,
    config: {
      transport: "hook", event: "PreToolUse", command: "~/.base-studio/hooks/guard-lockfiles.sh",
      env: [["BLOCK_GLOBS", "*.lock,package-lock.json,yarn.lock"]], secrets: [],
      log: [
        ["13:58:14", "warn", "PreToolUse blocked write_file('Cargo.lock')"],
        ["11:22:08", "warn", "PreToolUse blocked write_file('package-lock.json')"],
      ],
    },
  },
];

export const EXT_CATALOG: CatalogItem[] = [
  { name: "Sentry",       by: "sentry",                  icon: "S",  desc: "Fetch unresolved issues, drill into event payloads, suggest fixes." },
  { name: "Linear",       by: "linear",                  icon: "L",  desc: "Search, create, and update Linear issues from any pane." },
  { name: "Postgres",     by: "@modelcontextprotocol",   icon: "pg", desc: "Read-only SELECT and schema introspection on a database connection." },
  { name: "Slack",        by: "@modelcontextprotocol",   icon: "#",  desc: "Read channels, post messages, look up users." },
  { name: "Stripe",       by: "stripe",                  icon: "$",  desc: "Inspect charges, refunds, customers — test mode by default." },
  { name: "Brave Search", by: "@modelcontextprotocol",   icon: "B",  desc: "Web search via the Brave API." },
  { name: "SQLite",       by: "@modelcontextprotocol",   icon: "sq", desc: "Local SQLite query and schema browser." },
  { name: "Notion",       by: "community",               icon: "N",  desc: "Read and append to a Notion workspace." },
  { name: "Block PII",    by: "first-party",             icon: "⊘",  desc: "Hook · PreToolUse — scans outbound tool inputs for PII patterns." },
  { name: "Auto-format",  by: "first-party",             icon: "§",  desc: "Hook · PostToolUse — runs project formatter on every Write." },
];
