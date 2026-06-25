// The planner's live extensions.md (#1054). The planner + director are exposed to EVERY installed
// MCP server (so the planner can call them while planning — e.g. research sources for a skill — and
// decide which workers need them); each worker gets only the servers its stream was assigned, on
// top of the global baseline. This renders that guidance from the actual installed set, replacing
// the static catalogue the Rust setup used to write. Pure (no React/Tauri) so it's unit-testable
// and shared by the launch path; the counterpart to blueprintSkills.buildSkillContext.

import { type McpServer } from "@/features/extensions/lib/mcpServers";
import { MCP_CATALOG, type CatalogItem } from "@/shared/data/mcpCatalog";
import { writeProjectFile } from "@/shared/lib/core/projectFiles";

/** A one-line description for a server name — its catalog blurb if known, else a generic note. */
function describe(name: string, catalog: CatalogItem[]): string {
  const hit = catalog.find((c) => c.name.toLowerCase() === name.toLowerCase());
  return hit?.desc ?? "(custom server — see the MCP screen for its config)";
}

/**
 * Render the planner's extensions.md from the installed servers it is exposed to. `servers` is the
 * runnable installed set (see {@link resolveAllInstalledMcp}); `catalog` supplies descriptions.
 */
export function buildMcpContext(servers: McpServer[], catalog: CatalogItem[] = MCP_CATALOG): string {
  const available = servers.length
    ? servers.map((s) => `- **${s.name}** — ${describe(s.name, catalog)}`).join("\n")
    : "_No MCP servers installed yet. Browse and download one from the MCP screen; it appears here automatically._";
  return `# Extensions (MCP servers)

These MCP servers are installed and **exposed to you (the planner) right now** — you can call their
tools directly while planning (for example, to research real sources before authoring a skill). The
director sees the same set.

## Available now

${available}

## Assigning servers to workers

Each worker sees the **global** servers plus only the servers you assign to its stream. Assign by
adding the server name to that stream's \`mcp\` list in the fleet plan, e.g. \`"mcp": ["Research"]\`
(written with \`bsc-plan fleet set\`). Use this to give one worker a tool its lane needs without
handing it to the whole fleet; for a tool every worker needs, scope it project-wide with
\`bsc-plan mcp add <name>\` instead.

## Installing more

Some servers are **built in** (e.g. **Research**) — always available, no install needed. Others
install from source: browse and download them in the MCP screen, and a downloaded server shows up
here automatically and becomes assignable. Never invent secret env values; the user fills any
tokens/keys in the MCP screen.
`;
}

/** Write the project hub's extensions.md from the installed servers (#1054). */
export async function writeProjectMcpContext(args: { projectKey: string; servers: McpServer[] }): Promise<void> {
  await writeProjectFile(args.projectKey, "extensions.md", buildMcpContext(args.servers));
}
