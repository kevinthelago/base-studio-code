// MCP server model + per-session resolution + `.mcp.json` payload + catalog templates.
//
// An MCP server is an external process (stdio) or endpoint (http) Claude connects to.
// Pure (no React / Tauri) so it's shared by the store, the MCP screen, and TerminalView.
// Split out of the former unified `extensions.ts` (mcp + hook discriminated union).

import builtinServersEmbedded from "@data/mcp/builtin-servers.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

export type McpTransport = "stdio" | "http";

/** A user-configured MCP server. Scoped per-server via {@link McpServer.projects}. */
export interface McpServer {
  id: string;
  name: string;
  enabled: boolean;
  /** `[]` = every project (global); otherwise the project ids it applies to. */
  projects: string[];
  transport: McpTransport;
  command?: string;   // stdio binary
  args?: string;      // stdio args (space-split at write time)
  url?: string;       // http endpoint
  env?: Array<[string, string]>;
}

/**
 * Built-in MCP servers (#1196) — shipped compiled in the app bundle (native sidecars), so they're
 * **always available** with no download/build/Docker and need no store entry. `command` is a marker
 * the Rust side rewrites to the bundled binary's absolute path when writing `.mcp.json` (Claude Code
 * spawns `.mcp.json` commands directly, with no PATH/shell-rc). They behave like a global, enabled
 * server: the planner/director see them, and every session (incl. workers) gets them by default.
 *
 * The DATA is externalized to `@data/mcp/builtin-servers.json` (#2146, epic #2027 tail) — editable
 * without touching code + part of the exportable config bundle; the config-dir copy (#2047) overlays
 * the embedded default via `overlayFile`.
 */
export const BUILTIN_MCP_SERVERS: McpServer[] = overlayFile("mcp/builtin-servers.json", builtinServersEmbedded as McpServer[]);

/** Prepend the built-in servers, skipping any a user entry already shadows by name (case-insensitive). */
function withBuiltins(servers: McpServer[]): McpServer[] {
  const taken = new Set(servers.map(s => s.name.toLowerCase()));
  return [...BUILTIN_MCP_SERVERS.filter(b => !taken.has(b.name.toLowerCase())), ...servers];
}

/**
 * The enabled servers that apply to a session in `projectId`: a server applies when it is
 * enabled AND either global (`projects` empty) or scoped to this project. An empty
 * `projectId` (no project) yields only global servers. The built-in servers (#1196) are always
 * included (they're global + enabled by construction).
 */
export function resolveMcpServers(all: McpServer[], projectId: string): McpServer[] {
  return withBuiltins(all.filter(
    e => e.enabled && (e.projects.length === 0 || (!!projectId && e.projects.includes(projectId))),
  ));
}

/**
 * Every **downloaded** server, regardless of the enable toggle or project scope (#1054). The
 * planner sees all installed servers — so a freshly downloaded one (which lands disabled) is
 * available immediately, and the planner can call it while planning and decide which workers need
 * it. The director gets the same set since it coordinates the whole fleet. "Downloaded" = has a
 * runnable config (`toMcpPayload` non-null: stdio with a command, http with a url); half-configured
 * entries are skipped so a broken `.mcp.json` line never reaches a session.
 */
export function resolveAllInstalledMcp(all: McpServer[]): McpServer[] {
  // Built-in servers (#1196) are always "installed" — the planner/director see them by default.
  return withBuiltins(all).filter(e => toMcpPayload(e) !== null);
}

/**
 * A worker's servers (#1054): the fleet-wide baseline — {@link resolveMcpServers} (enabled global +
 * this-project servers, the #876 behavior every worker shares) — PLUS any server the worker's
 * stream explicitly assigned by name (`stream.mcp`, case-insensitive). Stream assignment is intent,
 * so an assigned extra is included regardless of the enable toggle / project scope, as long as it
 * has a runnable config (`toMcpPayload` non-null). This is how the planner gives one worker the
 * extra tools its lane needs without handing them to the whole fleet, while project-wide tools
 * (a DB everyone touches) still ride the baseline.
 */
export function resolveStreamMcp(all: McpServer[], streamMcp: string[] = [], projectId = ""): McpServer[] {
  const base = resolveMcpServers(all, projectId);
  const baseIds = new Set(base.map(e => e.id));
  const assigned = new Set(streamMcp.map(n => n.toLowerCase()));
  const extra = all.filter(
    e => toMcpPayload(e) !== null && assigned.has(e.name.toLowerCase()) && !baseIds.has(e.id),
  );
  return [...base, ...extra];
}

// ── Backend payload ───────────────────────────────────────────────────────────
// Shape handed to `ensure_session_settings`; field names match the Rust struct.

export interface McpServerPayload {
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  env: Array<[string, string]>;
}

/** An MCP server → its `.mcp.json` payload, or null if it's incomplete
 *  (stdio without a command, http without a url). */
export function toMcpPayload(e: McpServer): McpServerPayload | null {
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

/** The `$BSC_AGENT_MCP` config bsc-agent reads (#1078 P3) — its MCP client is **stdio-only**, so
 *  http servers are dropped; `env` becomes a plain object (matching the Rust `McpServerCfg`). */
export interface BscAgentMcpCfg {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function toBscAgentMcp(payloads: McpServerPayload[]): BscAgentMcpCfg[] {
  return payloads
    .filter((p) => p.transport === "stdio" && !!p.command)
    .map((p) => ({
      name: p.name,
      command: p.command as string,
      args: p.args,
      env: Object.fromEntries(p.env),
    }));
}

// ── Catalog templates ─────────────────────────────────────────────────────────
// Pre-filled config for well-known catalog entries (keyed by catalog item name).
// Unknown names fall back to a blank stdio server the user completes.

const MCP_CATALOG_TEMPLATES: Record<string, Partial<McpServer>> = {
  // First-party servers (#858) — downloaded to ~/.base-studio-code/mcp/<repo>, so the command
  // runs the built entrypoint from there. `{dir}` is replaced with the resolved clone path
  // when the entry is added (addFromCatalog); the user downloads + builds via the card.
  // `python -m uv` (not a bare `uv`): uv is installed as a Python module and its console-script
  // shim often isn't on PATH on a fresh machine — `python -m uv` runs without any PATH setup (#887).
  // Built-in native server (#1005): no download/build/Docker. `bsc-compliance-mcp` is a marker the
  // Rust side rewrites to the bundled binary's absolute path when writing .mcp.json — same model as
  // Research. Kept here so the planner's `<mcp_assign name="Compliance" />` path also resolves to
  // the native binary.
  "Compliance":          { transport: "stdio", command: "bsc-compliance-mcp", args: "" },
  "Complexity Analyzer": { transport: "stdio", command: "node", args: "{dir}/dist/mcp/index.js" },
  "Dependency Graph":    { transport: "stdio", command: "node", args: "{dir}/dist/index.js" },
  // Python/uv like Compliance — console-script `plan-grader-mcp` (#897).
  "Plan Grader":         { transport: "stdio", command: "python", args: "-m uv run --directory {dir} plan-grader-mcp" },
  // Built-in native server (#1196): no download/build/Docker. `bsc-research-mcp` is a marker the
  // Rust side rewrites to the bundled binary's absolute path when writing .mcp.json. Kept here so the
  // planner's `<mcp_assign name="Research" />` path also resolves to the native binary. Offline +
  // key-less by default (optional API keys raise rate limits).
  "Research":            { transport: "stdio", command: "bsc-research-mcp", args: "" },
  // Well-known third-party servers — pruned from the browse catalog (#870) but kept here so the
  // planner's `<mcp_assign name="…" />` (planExtensions.ts) still resolves them to a working config.
  "Postgres":     { transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-postgres", env: [["POSTGRES_CONNECTION_STRING", ""]] },
  "SQLite":       { transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-sqlite --db-path ./data.db" },
  "Slack":        { transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-slack", env: [["SLACK_BOT_TOKEN", ""], ["SLACK_TEAM_ID", ""]] },
  "Brave Search": { transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-brave-search", env: [["BRAVE_API_KEY", ""]] },
  "Stripe":       { transport: "stdio", command: "npx", args: "-y @stripe/mcp --tools=all", env: [["STRIPE_SECRET_KEY", ""]] },
  "Sentry":       { transport: "http", url: "https://mcp.sentry.dev/sse" },
  "Linear":       { transport: "http", url: "https://mcp.linear.app/sse" },
  "Notion":       { transport: "http", url: "https://mcp.notion.com/mcp" },
};

/** A ready-to-add MCP server (minus id) for a catalog entry — disabled + global
 *  by default; the caller assigns the id and the user fills any blank config. */
export function mcpFromCatalog(name: string): Omit<McpServer, "id"> {
  const t = MCP_CATALOG_TEMPLATES[name] ?? { transport: "stdio" as McpTransport, command: "", args: "" };
  return {
    name,
    enabled: false,
    projects: [],
    transport: t.transport ?? "stdio",
    command: t.command,
    args: t.args,
    url: t.url,
    env: t.env,
  };
}

/** A blank custom MCP server, ready for the add-custom form. */
export function blankMcpServer(): Omit<McpServer, "id"> {
  return { name: "", enabled: false, projects: [], transport: "stdio", command: "", args: "", env: [] };
}
