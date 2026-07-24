// The Security page host (#3646, epic #3604) — renders the Security (Agents) workspace FROM THE GRAPH. The
// page + its 4 tab bodies (Profiles, Assignments, Activity, Flow) are sourced from the components graph (the
// authored `securitypage` node + siblings, seeded from `data/components/app/**`), not bundled files. It
// registers the security feature's injected platform surface (the agentProfiles/consoleModel/auditRows/
// badgeTone/appSession/flowModel logic the graph page imports), then mounts `securitypage` through the
// runtime loader. Mirrors FleetGraphHost / AutomationsGraphHost.
//
// `pageOverride` (a torn-off single tab, DetachedWindow) forwards to the graph component as a prop —
// GraphComponent spreads props onto the loaded component, and the graph `SecurityWorkspace` reads it.
//
// The CSS still ships as a normal bundled import here (the loader can't resolve a CSS side-effect import,
// so it was stripped from the graph source): the host owns the stylesheet the graph page's classes need.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerSecurityPlatform } from "./graphPlatform";
import "./security.css";

// Register at module load — before the workspace ever renders — so the injected modules are in the registry
// when the graph page's compiled `require()` runs. Idempotent.
registerSecurityPlatform();

export function SecurityGraphHost({ pageOverride }: { pageOverride?: string } = {}) {
  // Fallback offers a one-click re-seed (#3648) when the source isn't in the library yet.
  return (
    <GraphComponent
      id="securitypage"
      props={pageOverride ? { pageOverride } : undefined}
      fallback={<GraphPageFallback page="Security" icon="⛊" />}
    />
  );
}
