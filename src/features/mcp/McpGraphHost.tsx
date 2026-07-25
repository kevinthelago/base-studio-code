// The MCP page host (#3656, epic #3604) — renders the MCP (servers) workspace FROM THE GRAPH. The page + its
// Analytics tab are sourced from the components graph (the authored `mcppage` node + the `mcp-analytics`
// sibling, seeded from `data/components/app/**`), not bundled files. It registers the mcp feature's injected
// platform surface (the install/catalog/telemetry logic + the ./shared helpers), then mounts `mcppage`
// through the runtime loader. Mirrors the fleet/automations/security/github/skills hosts.
//
// `pageOverride` (a torn-off single tab, DetachedWindow) forwards to the graph component as a prop —
// GraphComponent spreads props onto the loaded component, and the graph `McpWorkspace` reads it.
//
// The CSS still ships as a normal bundled import here (the loader can't resolve a CSS side-effect import, so
// it was stripped from the graph source): the host owns the stylesheet the graph page's classes need.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerMcpPlatform } from "./graphPlatform";
import "./mcp.css";

// Register at module load — before the workspace ever renders — so the injected modules are in the registry
// when the graph page's compiled `require()` runs. Idempotent.
registerMcpPlatform();

export function McpGraphHost({ pageOverride }: { pageOverride?: string } = {}) {
  // Fallback offers Reload-to-apply / Re-seed (#3648/#3652) when the source isn't in the library yet.
  return (
    <GraphComponent
      id="mcppage"
      props={pageOverride ? { pageOverride } : undefined}
      fallback={<GraphPageFallback page="MCP" icon="⧉" />}
    />
  );
}
