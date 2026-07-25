// The GitHub page host (#3650, epic #3604) — renders the GitHub workspace FROM THE GRAPH. The page + its
// composed views (Summary + its 8 cards, Pulse + BranchGraph, Empty) are sourced from the components graph
// (the authored `githubpage` node + siblings, seeded from `data/components/app/**`), not bundled files. It
// registers the github feature's injected platform surface (the summary/pulse logic + hooks + the planner
// board views the page drills into), then mounts `githubpage` through the runtime loader. Mirrors the
// fleet/automations/security hosts.
//
// `pageOverride` (a torn-off single tab, DetachedWindow) forwards to the graph component as a prop —
// GraphComponent spreads props onto the loaded component, and the graph `GitHubWorkspace` reads it.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerGithubPlatform } from "./graphPlatform";

// Register at module load — before the workspace ever renders — so the injected modules are in the registry
// when the graph page's compiled `require()` runs. Idempotent.
registerGithubPlatform();

export function GitHubGraphHost({ pageOverride }: { pageOverride?: string } = {}) {
  // Fallback offers a one-click re-seed (#3648) when the source isn't in the library yet.
  return (
    <GraphComponent
      id="githubpage"
      props={pageOverride ? { pageOverride } : undefined}
      fallback={<GraphPageFallback page="GitHub" icon="⎇" />}
    />
  );
}
