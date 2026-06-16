// Pure helpers for the Extensions feature — the ExtensionDef model, per-session
// resolution, catalog → definition templates, and the conversion to the backend
// payloads written into a session's `.mcp.json` / `.claude/settings.json`.
//
// Free of React / Tauri imports so it can be unit-tested and shared between the
// store, the Extensions screen, and TerminalView.

export type ExtKind = "mcp" | "hook";
export type McpTransport = "stdio" | "http";

/**
 * A user-configured extension: an MCP server Claude connects to, or a lifecycle
 * hook Claude runs. Scoped per-extension via {@link ExtensionDef.projects}.
 */
export interface ExtensionDef {
  id: string;
  kind: ExtKind;
  name: string;
  enabled: boolean;
  /** `[]` = every project (global); otherwise the project ids it applies to. */
  projects: string[];
  // ── MCP server ──
  transport?: McpTransport;
  command?: string;   // stdio binary
  args?: string;      // stdio args (space-split at write time)
  url?: string;       // http endpoint
  // ── Hook ──
  event?: string;     // PreToolUse | PostToolUse | Stop | …
  matcher?: string;   // optional tool matcher (regex)
  hookCommand?: string;
  // ── shared ──
  env?: Array<[string, string]>;
}

/**
 * The enabled extensions that apply to a session in `projectId`: a def applies when
 * it is enabled AND either global (`projects` empty) or scoped to this project. An
 * empty `projectId` (no project) yields only global defs.
 */
export function resolveExtensions(all: ExtensionDef[], projectId: string): ExtensionDef[] {
  return all.filter(
    e => e.enabled && (e.projects.length === 0 || (!!projectId && e.projects.includes(projectId))),
  );
}

// ── Backend payloads ──────────────────────────────────────────────────────────
// Shapes handed to `ensure_session_settings`; field names match the Rust structs.

export interface McpServerPayload {
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  env: Array<[string, string]>;
}

export interface HookPayload {
  event: string;
  matcher: string;
  command: string;
}

/** An MCP `ExtensionDef` → its `.mcp.json` payload, or null if it's incomplete
 *  (stdio without a command, http without a url, or not an MCP def). */
export function toMcpPayload(e: ExtensionDef): McpServerPayload | null {
  if (e.kind !== "mcp") return null;
  if (e.transport === "http") {
    if (!e.url) return null;
    return { name: e.name, transport: "http", args: [], url: e.url, env: e.env ?? [] };
  }
  if (!e.command) return null;
  return {
    name: e.name,
    transport: "stdio",
    command: e.command,
    args: (e.args ?? "").split(/\s+/).filter(Boolean),
    env: e.env ?? [],
  };
}

/** POSIX single-quote escape: wrap in '…', and turn any embedded ' into '\''. Robust +
 *  portable (no base64) so the wrapper command can't be broken or injected by the name/cmd. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * A hook `ExtensionDef` → its settings.json payload, or null if incomplete.
 *
 * The user's command is wrapped with `bsc-hook '<name>' '<command>'` (#867 follow-up) so each
 * fire is logged to `~/.base-studio-code/hooks.log` for the Hook Analytics tab — `bsc-hook`
 * runs the command, records the outcome (PreToolUse block/allow), and propagates the exit
 * code. Only USER hooks pass through here; the security hooks are injected backend-side and
 * are never wrapped.
 */
export function toHookPayload(e: ExtensionDef): HookPayload | null {
  if (e.kind !== "hook" || !e.event || !e.hookCommand) return null;
  const command = `bsc-hook ${shQuote(e.name || "hook")} ${shQuote(e.hookCommand)}`;
  return { event: e.event, matcher: e.matcher ?? "", command };
}

/** Split a resolved extension list into the two backend payload lists. */
export function toSessionPayloads(defs: ExtensionDef[]): { mcp: McpServerPayload[]; hooks: HookPayload[] } {
  const mcp: McpServerPayload[] = [];
  const hooks: HookPayload[] = [];
  for (const e of defs) {
    const m = toMcpPayload(e);
    if (m) { mcp.push(m); continue; }
    const h = toHookPayload(e);
    if (h) hooks.push(h);
  }
  return { mcp, hooks };
}

// ── Catalog templates ─────────────────────────────────────────────────────────
// Pre-filled config for well-known catalog entries (keyed by catalog item name).
// Unknown names fall back to a blank stdio MCP the user completes.

const CATALOG_TEMPLATES: Record<string, Partial<ExtensionDef>> = {
  // First-party servers (#858) — downloaded to ~/.base-studio-code/mcp/<repo>, so the command
  // runs the built entrypoint from there. `{dir}` is replaced with the resolved clone path
  // when the entry is added (addFromCatalog); the user downloads + builds via the card.
  // `python -m uv` (not a bare `uv`): uv is installed as a Python module and its console-script
  // shim often isn't on PATH on a fresh machine — `python -m uv` runs without any PATH setup (#887).
  "Compliance":          { kind: "mcp", transport: "stdio", command: "python", args: "-m uv run --directory {dir} compliance-mcp" },
  "Complexity Analyzer": { kind: "mcp", transport: "stdio", command: "node", args: "{dir}/dist/mcp/index.js" },
  "Dependency Graph":    { kind: "mcp", transport: "stdio", command: "node", args: "{dir}/dist/index.js" },
  // Well-known third-party servers — pruned from the browse catalog (#870) but kept here so the
  // planner's `<mcp_assign name="…" />` (planExtensions.ts) still resolves them to a working config.
  "Postgres":     { kind: "mcp", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-postgres", env: [["POSTGRES_CONNECTION_STRING", ""]] },
  "SQLite":       { kind: "mcp", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-sqlite --db-path ./data.db" },
  "Slack":        { kind: "mcp", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-slack", env: [["SLACK_BOT_TOKEN", ""], ["SLACK_TEAM_ID", ""]] },
  "Brave Search": { kind: "mcp", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-brave-search", env: [["BRAVE_API_KEY", ""]] },
  "Stripe":       { kind: "mcp", transport: "stdio", command: "npx", args: "-y @stripe/mcp --tools=all", env: [["STRIPE_SECRET_KEY", ""]] },
  "Sentry":       { kind: "mcp", transport: "http", url: "https://mcp.sentry.dev/sse" },
  "Linear":       { kind: "mcp", transport: "http", url: "https://mcp.linear.app/sse" },
  "Notion":       { kind: "mcp", transport: "http", url: "https://mcp.notion.com/mcp" },
  "Block PII":    { kind: "hook", event: "PreToolUse",  matcher: "Write|Edit", hookCommand: "" },
  "Auto-format":  { kind: "hook", event: "PostToolUse", matcher: "Write|Edit", hookCommand: "" },
};

/** A ready-to-add ExtensionDef (minus id) for a catalog entry — disabled + global
 *  by default; the caller assigns the id and the user fills any blank config. */
export function defFromCatalog(name: string): Omit<ExtensionDef, "id"> {
  const t = CATALOG_TEMPLATES[name] ?? { kind: "mcp" as ExtKind, transport: "stdio" as McpTransport, command: "", args: "" };
  return {
    kind: t.kind ?? "mcp",
    name,
    enabled: false,
    projects: [],
    transport: t.transport,
    command: t.command,
    args: t.args,
    url: t.url,
    event: t.event,
    matcher: t.matcher,
    hookCommand: t.hookCommand,
    env: t.env,
  };
}

/** A blank custom extension of the given kind, ready for the add-custom form. */
export function blankExtension(kind: ExtKind): Omit<ExtensionDef, "id"> {
  return kind === "hook"
    ? { kind, name: "", enabled: false, projects: [], event: "PostToolUse", matcher: "", hookCommand: "" }
    : { kind, name: "", enabled: false, projects: [], transport: "stdio", command: "", args: "", env: [] };
}
