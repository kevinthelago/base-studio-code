// MCP server model + per-session resolution + `.mcp.json` payload + catalog templates.
//
// An MCP server is an external process (stdio) or endpoint (http) Claude connects to.
// Pure (no React / Tauri) so it's shared by the store, the MCP screen, and TerminalView.
// Split out of the former unified `extensions.ts` (mcp + hook discriminated union).

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
 * The enabled servers that apply to a session in `projectId`: a server applies when it is
 * enabled AND either global (`projects` empty) or scoped to this project. An empty
 * `projectId` (no project) yields only global servers.
 */
export function resolveMcpServers(all: McpServer[], projectId: string): McpServer[] {
  return all.filter(
    e => e.enabled && (e.projects.length === 0 || (!!projectId && e.projects.includes(projectId))),
  );
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

// ── Catalog templates ─────────────────────────────────────────────────────────
// Pre-filled config for well-known catalog entries (keyed by catalog item name).
// Unknown names fall back to a blank stdio server the user completes.

const MCP_CATALOG_TEMPLATES: Record<string, Partial<McpServer>> = {
  // First-party servers (#858) — downloaded to ~/.base-studio-code/mcp/<repo>, so the command
  // runs the built entrypoint from there. `{dir}` is replaced with the resolved clone path
  // when the entry is added (addFromCatalog); the user downloads + builds via the card.
  // `python -m uv` (not a bare `uv`): uv is installed as a Python module and its console-script
  // shim often isn't on PATH on a fresh machine — `python -m uv` runs without any PATH setup (#887).
  "Compliance":          { transport: "stdio", command: "python", args: "-m uv run --directory {dir} compliance-mcp" },
  "Complexity Analyzer": { transport: "stdio", command: "node", args: "{dir}/dist/mcp/index.js" },
  "Dependency Graph":    { transport: "stdio", command: "node", args: "{dir}/dist/index.js" },
  // Python/uv like Compliance — console-script `plan-grader-mcp` (#897).
  "Plan Grader":         { transport: "stdio", command: "python", args: "-m uv run --directory {dir} plan-grader-mcp" },
  // Node/tsup → dist/index.js, like Dependency Graph (#1056). Runs offline by default (arXiv/
  // Semantic Scholar/PubMed/Crossref need no key; local embeddings); optional API keys + GROBID
  // are env/Docker config the user adds, so no required env here.
  "Research":            { transport: "stdio", command: "node", args: "{dir}/dist/index.js" },
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
