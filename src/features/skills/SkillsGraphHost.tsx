// The Skills page host (#3654, epic #3604) — renders the Skills workspace FROM THE GRAPH. The page + its 6
// composed views (list/cards/grouped row views, the editor drawer, the KPI digest, the Lessons + Runs tabs,
// the new-group dialog) are sourced from the components graph (the authored `skillspage` node + siblings,
// seeded from `data/components/app/**`), not bundled files. It registers the skills feature's injected
// platform surface (the skills domain logic + style helper), then mounts `skillspage` through the runtime
// loader. Mirrors the fleet/automations/security/github hosts.
//
// `pageOverride` (a torn-off single tab, DetachedWindow) forwards to the graph component as a prop —
// GraphComponent spreads props onto the loaded component, and the graph `SkillsWorkspace` reads it.
//
// The CSS still ships as a normal bundled import here (the loader can't resolve a CSS side-effect import, so
// it was stripped from the graph source): the host owns the stylesheet the graph page's classes need.
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerSkillsPlatform } from "./graphPlatform";
import "./skills.css";

// Register at module load — before the workspace ever renders — so the injected modules are in the registry
// when the graph page's compiled `require()` runs. Idempotent.
registerSkillsPlatform();

export function SkillsGraphHost({ pageOverride }: { pageOverride?: string } = {}) {
  // Fallback offers Reload-to-apply / Re-seed (#3648/#3652) when the source isn't in the library yet.
  return (
    <GraphComponent
      id="skillspage"
      props={pageOverride ? { pageOverride } : undefined}
      fallback={<GraphPageFallback page="Skills" icon="✦" />}
    />
  );
}
