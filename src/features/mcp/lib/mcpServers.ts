// MCP server model + per-session resolution + `.mcp.json` payload + catalog templates.
//
// An MCP server is an external process (stdio) or endpoint (http) Claude connects to.
// Pure (no React / Tauri) so it's shared by the store, the MCP screen, and TerminalView.
// Split out of the former unified `extensions.ts` (mcp + hook discriminated union).

import builtinServersEmbedded from "@data/mcp/builtin-servers.json";
import catalogTemplatesEmbedded from "@data/mcp/catalog-templates.json";
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

/** Prepend the built-in servers, skipping any a user entry already shadows by name (case-insensitive).
 *  Tolerates a nameless entry (malformed persisted state, #2515) — it shadows nothing.
 *  `onlyEnabled` limits the prepended built-ins to the enabled ones — the GLOBAL set every session
 *  gets. A DISABLED built-in (a per-stream channel, #3146: `channel-mock`) is catalog-present but NOT
 *  global; it reaches a session only by explicit stream assignment ({@link resolveStreamMcp}). */
function withBuiltins(servers: McpServer[], onlyEnabled = false): McpServer[] {
  const taken = new Set(servers.map(s => s.name?.toLowerCase()).filter((n): n is string => !!n));
  const builtins = BUILTIN_MCP_SERVERS.filter(b => (!onlyEnabled || b.enabled) && !taken.has(b.name.toLowerCase()));
  return [...builtins, ...servers];
}

/**
 * The enabled servers that apply to a session in `projectId`: a server applies when it is
 * enabled AND either global (`projects` empty) or scoped to this project. An empty
 * `projectId` (no project) yields only global servers. ENABLED built-in servers (#1196 —
 * research/compliance) are always included (global by construction); a DISABLED built-in (a marketing
 * channel, #3146) is deliberately NOT global — it's per-stream-assignable only, so the whole fleet
 * never gets `send_email`.
 */
export function resolveMcpServers(all: McpServer[], projectId: string): McpServer[] {
  return withBuiltins(
    all.filter(e => e.enabled && (e.projects.length === 0 || (!!projectId && e.projects.includes(projectId)))),
    true,
  );
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
  // Assignable candidates = the store's servers PLUS the bundled built-ins — so a per-stream CHANNEL
  // (a disabled built-in like `channel-mock`, #3146) can be handed to just the marketer stream, not
  // the whole fleet, exactly as a downloaded server is. A name already in the base isn't re-added.
  const candidates = [...BUILTIN_MCP_SERVERS, ...all];
  const extra = candidates.filter(
    e => toMcpPayload(e) !== null && !!e.name && assigned.has(e.name.toLowerCase()) && !baseIds.has(e.id),
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
//
// The DATA is externalized to `@data/mcp/catalog-templates.json` (#2419, epic #2027 tail) — editable
// without touching code + part of the exportable config bundle; the config-dir copy (#2047) overlays
// the embedded default via `overlayFile`. What the entries mean:
// - First-party servers (#858) — downloaded to ~/.base-studio-code/mcp/<repo>, so the command runs
//   the built entrypoint from there. `{dir}` is replaced with the resolved clone path when the entry
//   is added (addFromCatalog); the user downloads + builds via the card.
// - `python -m uv` (not a bare `uv`): uv is installed as a Python module and its console-script shim
//   often isn't on PATH on a fresh machine — `python -m uv` runs without any PATH setup (#887).
// - Built-in native servers (#1005 Compliance, #1196 Research): no download/build/Docker.
//   `bsc-compliance-mcp` / `bsc-research-mcp` are markers the Rust side rewrites to the bundled
//   binary's absolute path when writing .mcp.json. Kept in the templates so the planner's
//   `<mcp_assign name="…" />` path also resolves them to the native binary.
// - Well-known third-party servers (Postgres/Slack/Sentry/…) — pruned from the browse catalog (#870)
//   but kept here so the planner's `<mcp_assign name="…" />` (planExtensions.ts) still resolves them
//   to a working config.
// (`as unknown` for the `env` pairs: JSON can't express the `[string, string]` tuple type.)
const MCP_CATALOG_TEMPLATES: Record<string, Partial<McpServer>> =
  overlayFile("mcp/catalog-templates.json", catalogTemplatesEmbedded as unknown as Record<string, Partial<McpServer>>);

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
