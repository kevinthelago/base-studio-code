// The projects page's graph-platform surface (#3874, regenerated #4232, epic #3604) — originally
// generated from the specifiers the `projectspage` records carry, now HAND-MAINTAINED:
// `scripts/gen-projects-graph.cjs` was retired with the rest of the one-off generators, because it read
// source files the migration deletes and would break the moment one went. Edit this by hand and keep it
// in step with the records' specifiers; git history holds the generator if it needs re-reading.
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545).
//
// ONE SPELLING PER MODULE NOW. This file used to register each sibling twice — the relative `./X` the
// hand-authored page was transcribed with, and the absolute `@/features/planner/list/X` — because the
// record could carry either. #4232 regenerated the page absolute, so the relative half is gone and
// `platformBoundary` rejects a relative specifier in a record outright.
//
// The list's OWN components are registered too: each is `provides`-resolved from the graph first, and
// the module behind it is the fallback for a record that will not load.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as Designs from "@/features/designs";
import * as BlueprintCatalog from "@/features/planner/blueprints/blueprintCatalog";
import * as BlueprintShare from "@/features/planner/blueprints/blueprintShare";
import * as Gist from "@/features/planner/lib/gist/gist";
import * as ReopenProjectModal from "@/features/planner/list/ReopenProjectModal";
import * as BlueprintLibraryhelpers from "@/features/planner/list/blueprintLibrary.helpers";
import * as Drafts from "@/features/planner/list/drafts";
import * as LocalPublished from "@/features/planner/list/localPublished";
import * as ProjectsDbBridge from "@/features/planner/list/projectsDbBridge";
import * as ProjectsFilter from "@/features/planner/list/projectsFilter";
import * as PublishedModel from "@/features/planner/list/published/publishedModel";
import * as ReopenProject from "@/features/planner/list/reopenProject";
import * as Blueprints from "@/features/planner/stages/blueprints";
// `blueprintBuiltins` is an `import.meta.glob` module and therefore permanently a FILE — the glob is a
// VITE build-time transform, not a function at runtime. Registering it costs NOTHING new here:
// `blueprints` above already imports it, so it is in this surface's bundle either way. Registration
// is not migration; it is what lets the RECORDS that import it load.
import * as BlueprintBuiltins from "@/features/planner/stages/blueprintBuiltins";
import * as PlanTopics from "@/features/planner/stages/planTopics";

let done = false;

/** Register the projects page's injected graph-platform modules. Idempotent. */
export function registerProjectsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/designs", Designs);
  registerAppModule("@/features/planner/blueprints/blueprintCatalog", BlueprintCatalog);
  registerAppModule("@/features/planner/blueprints/blueprintShare", BlueprintShare);
  registerAppModule("@/features/planner/lib/gist/gist", Gist);
  registerAppModule("@/features/planner/list/ReopenProjectModal", ReopenProjectModal);
  registerAppModule("@/features/planner/list/blueprintLibrary.helpers", BlueprintLibraryhelpers);
  registerAppModule("@/features/planner/list/drafts", Drafts);
  registerAppModule("@/features/planner/list/localPublished", LocalPublished);
  registerAppModule("@/features/planner/list/projectsDbBridge", ProjectsDbBridge);
  registerAppModule("@/features/planner/list/projectsFilter", ProjectsFilter);
  registerAppModule("@/features/planner/list/published/publishedModel", PublishedModel);
  registerAppModule("@/features/planner/list/reopenProject", ReopenProject);
  registerAppModule("@/features/planner/stages/blueprints", Blueprints);
  registerAppModule("@/features/planner/stages/blueprintBuiltins", BlueprintBuiltins);
  registerAppModule("@/features/planner/stages/planTopics", PlanTopics);
}
