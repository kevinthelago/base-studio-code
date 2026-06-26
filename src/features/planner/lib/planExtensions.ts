// MCP-server assignment from the planner (#174). The planner's "Automations & extensions"
// step can assign an MCP server to a project with a `<mcp_assign name="Postgres" />` tag.
// Rather than invent a parallel store, an assignment reuses the MCP-servers subsystem
// (src/lib/mcpServers.ts): it adds (or enables) a catalog-derived {@link McpServer} scoped
// to the project, so the SAME launch wiring that powers the MCP screen — `resolveMcpServers`
// → `paneMcpServers` → `.mcp.json` at build/triage launch — loads it with no extra glue.
//
// Pure (no React/Tauri) so the tag parsing + catalog mapping are unit-testable and
// shared between Planning.tsx and its tests.

import { mcpFromCatalog, type McpServer } from "@/features/mcp/lib/mcpServers";
import { resolveMcpInstallDir, catalogLink } from "@/features/mcp/lib/mcpInstall";

// Quote-flexible: matches a straight double quote and both curly quotes, so an LLM's
// smart-quote output doesn't silently break tag detection (mirrors Planning.tsx's Q).
const Q = '["“”]';
const MCP_ASSIGN_RE = new RegExp(`<mcp_assign\\b([^/]*?)\\/>`, "g");

/** Read a `name=` (or its `id=` alias) attribute value from a tag's attribute blob. */
function readName(attrs: string): string | null {
  const m =
    new RegExp(`\\bname=${Q}([^"“”]*)${Q}`).exec(attrs) ??
    new RegExp(`\\bid=${Q}([^"“”]*)${Q}`).exec(attrs);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/**
 * Parse every `<mcp_assign name="..." />` (or `id="..."`) tag out of a text buffer
 * into a deduped, order-preserving list of catalog names. Tolerant of straight/curly
 * quotes and extra attributes; a tag missing a name is skipped.
 */
export function parseMcpAssigns(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  MCP_ASSIGN_RE.lastIndex = 0;
  while ((m = MCP_ASSIGN_RE.exec(text)) !== null) {
    const name = readName(m[1]);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Remove every `<mcp_assign … />` tag from a buffer once its assignments are applied. */
export function stripMcpAssigns(text: string): string {
  return text.replace(new RegExp(`<mcp_assign\\b[^/]*?\\/>`, "g"), "");
}

/**
 * The {@link McpServer} (minus id) a `<mcp_assign name>` resolves to: the catalog
 * template for `name`, **enabled** and **scoped to `projectId`** so it applies to that
 * project's build/triage sessions. An unknown name yields a blank stdio server the user
 * completes; required env values stay blank (never invent secrets).
 *
 * For a downloadable (first-party) server, `baseDir` resolves the `{dir}` placeholder in
 * the run config to its on-disk install path (`~/.base-studio-code/mcp/<repo>`). Without
 * this the launched config keeps a literal `--directory {dir}` and the server never starts.
 */
export function mcpAssignToServer(name: string, projectId: string, baseDir = ""): Omit<McpServer, "id"> {
  const def = resolveMcpInstallDir(mcpFromCatalog(name), name, baseDir);
  return { ...def, enabled: true, projects: projectId ? [projectId] : [] };
}

/** Whether a `<mcp_assign>` name is a downloadable first-party server (has a catalog
 *  download link) — i.e. assigning it should also clone its repo. */
export function isDownloadableMcp(name: string): boolean {
  return !!catalogLink(name);
}

export interface McpStoreLike {
  mcpServers: McpServer[];
  addMcpServer: (def: Omit<McpServer, "id">) => void;
  updateMcpServer: (id: string, patch: Partial<McpServer>) => void;
}

/**
 * Idempotently apply one `<mcp_assign>` to the MCP-servers store: if a server with this
 * name already exists, just ensure it's enabled and scoped to the project (a global
 * server — `projects: []` — is left global); otherwise add a fresh catalog-derived def.
 * Returns whether a NEW server was added (vs. an existing one updated), for callers that
 * want to report it. Keeping this here (not in the React component) makes the dedup/scope
 * rule unit-testable.
 */
export function applyMcpAssign(store: McpStoreLike, name: string, projectId: string, baseDir = ""): boolean {
  const existing = store.mcpServers.find(
    (e) => e.name.toLowerCase() === name.toLowerCase(),
  );
  if (existing) {
    const projects =
      existing.projects.length === 0 || existing.projects.includes(projectId)
        ? existing.projects
        : [...existing.projects, projectId];
    store.updateMcpServer(existing.id, { enabled: true, projects });
    return false;
  }
  store.addMcpServer(mcpAssignToServer(name, projectId, baseDir));
  return true;
}
