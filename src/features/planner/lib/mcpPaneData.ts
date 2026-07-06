// Pure mapping from the MCP-servers store → the planning page's MCP pane view-model (#878).
// Joins each MCP server scoped to a project with its catalog metadata (description, transport,
// first-party/official, download link) and an optional install-state map, so the pane is a
// dumb view. No React/Tauri — unit-tested.
//
// `McpServerDef` is the stored data model (lib/mcpServers); `McpServer` is the pane view-model.

import type { McpServer as McpServerDef } from "@/features/mcp";
import { MCP_CATALOG } from "@/shared/data/mcpCatalog";
import { catalogLink } from "@/features/mcp";
import type { McpServer } from "../pane/projectPane.types";
import type { FleetPlan } from "../fleet/planFleet";

/** Per-server install lifecycle the pane tracks (seeded by a disk probe, advanced by the
 *  download/build buttons). Keyed by server id. */
export type McpInstallState = Record<string, McpServer["status"]>;

/** An MCP server applies to a project when it's global (`projects: []`) or scoped to it. */
function appliesToProject(e: McpServerDef, projectKey: string): boolean {
  return e.projects.length === 0 || e.projects.includes(projectKey);
}

/** The catalog entry for a server name (description / official flag), if any. */
function catalogMeta(name: string): { desc: string; official: boolean } {
  const c = MCP_CATALOG.find((x) => x.name === name);
  return {
    desc: c?.desc ?? "",
    // "official" = built by the MCP org; first-party (kevinthelago) servers are NOT official.
    official: !!c && c.by.startsWith("@modelcontextprotocol"),
  };
}

/** The launch command line shown in the pane: `command args` for stdio, the URL for http. */
function commandLine(e: McpServerDef): string {
  if (e.transport === "http") return e.url ?? "";
  return [e.command, e.args].filter(Boolean).join(" ").trim();
}

/**
 * Build the MCP pane view-model for a project: every MCP server that applies to it,
 * joined with catalog metadata, fleet reach, and install state.
 *
 * A project-scoped enabled server reaches the whole fleet (director + every worker) via the
 * launch wiring, so `scope` is "fleet" and `agents` is every fleet stream id (plus the
 * director). `status` comes from `installState` for downloadable servers (default
 * "available" until probed/built); a remote/built-in server is always "ready".
 */
export function buildMcpServers(
  servers: McpServerDef[],
  projectKey: string,
  fleet: FleetPlan | undefined,
  installState: McpInstallState = {},
): McpServer[] {
  const fleetAgents = (fleet?.streams ?? []).map((s) => s.id);
  const directorOn = fleet?.director.enabled ?? false;
  const agents = directorOn ? ["director", ...fleetAgents] : fleetAgents;

  return servers
    .filter((e) => appliesToProject(e, projectKey))
    .map((e) => {
      const { desc, official } = catalogMeta(e.name);
      const downloadable = !!catalogLink(e.name);
      // Remote/built-in servers are "ready" once enabled; downloadable ones follow their
      // install lifecycle (probe/build), defaulting to "available" until known.
      const status: McpServer["status"] = downloadable
        ? (installState[e.id] ?? "available")
        : "ready";
      return {
        id: e.id,
        name: e.name,
        transport: e.transport ?? "stdio",
        cmd: commandLine(e),
        desc,
        enabled: e.enabled,
        official,
        downloadable,
        status,
        // Only an enabled server actually reaches the fleet; a disabled one is configured
        // but not granted, so it has no scope yet.
        scope: e.enabled ? "fleet" : "—",
        agents: e.enabled ? agents : [],
        tools: [],
      };
    });
}
