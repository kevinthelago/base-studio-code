// The projects page's graph-platform surface (#3874, regenerated #4232, epic #3604) — AUTO-GENERATED
// by scripts/gen-projects-graph.cjs. DO NOT EDIT BY HAND: it is derived from the specifiers the
// `projectspage` records actually carry, so it cannot drift from them.
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
import * as BlueprintModals from "@/features/planner/blueprints/BlueprintModals";
import * as BlueprintCatalog from "@/features/planner/blueprints/blueprintCatalog";
import * as BlueprintImporthelpers from "@/features/planner/blueprints/blueprintImport.helpers";
import * as BlueprintShare from "@/features/planner/blueprints/blueprintShare";
import * as Gist from "@/features/planner/lib/gist/gist";
import * as BlueprintCard from "@/features/planner/list/BlueprintCard";
import * as CloudBlueprints from "@/features/planner/list/CloudBlueprints";
import * as ProjectCard from "@/features/planner/list/ProjectCard";
import * as ProjectSetupPage from "@/features/planner/list/ProjectSetupPage";
import * as ProjectsRail from "@/features/planner/list/ProjectsRail";
import * as ReopenProjectModal from "@/features/planner/list/ReopenProjectModal";
import * as BlueprintLibraryhelpers from "@/features/planner/list/blueprintLibrary.helpers";
import * as Drafts from "@/features/planner/list/drafts";
import * as LocalPublished from "@/features/planner/list/localPublished";
import * as ProjectsDbBridge from "@/features/planner/list/projectsDbBridge";
import * as ProjectsFilter from "@/features/planner/list/projectsFilter";
import * as DeleteProjectModal from "@/features/planner/list/published/DeleteProjectModal";
import * as PublishedModel from "@/features/planner/list/published/publishedModel";
import * as ReopenProject from "@/features/planner/list/reopenProject";
import * as PlanStageBar from "@/features/planner/pane/PlanStageBar";
import * as Blueprints from "@/features/planner/stages/blueprints";
import * as PlanTopics from "@/features/planner/stages/planTopics";

let done = false;

/** Register the projects page's injected graph-platform modules. Idempotent. */
export function registerProjectsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/designs", Designs);
  registerAppModule("@/features/planner/blueprints/BlueprintModals", BlueprintModals);
  registerAppModule("@/features/planner/blueprints/blueprintCatalog", BlueprintCatalog);
  registerAppModule("@/features/planner/blueprints/blueprintImport.helpers", BlueprintImporthelpers);
  registerAppModule("@/features/planner/blueprints/blueprintShare", BlueprintShare);
  registerAppModule("@/features/planner/lib/gist/gist", Gist);
  registerAppModule("@/features/planner/list/BlueprintCard", BlueprintCard);
  registerAppModule("@/features/planner/list/CloudBlueprints", CloudBlueprints);
  registerAppModule("@/features/planner/list/ProjectCard", ProjectCard);
  registerAppModule("@/features/planner/list/ProjectSetupPage", ProjectSetupPage);
  registerAppModule("@/features/planner/list/ProjectsRail", ProjectsRail);
  registerAppModule("@/features/planner/list/ReopenProjectModal", ReopenProjectModal);
  registerAppModule("@/features/planner/list/blueprintLibrary.helpers", BlueprintLibraryhelpers);
  registerAppModule("@/features/planner/list/drafts", Drafts);
  registerAppModule("@/features/planner/list/localPublished", LocalPublished);
  registerAppModule("@/features/planner/list/projectsDbBridge", ProjectsDbBridge);
  registerAppModule("@/features/planner/list/projectsFilter", ProjectsFilter);
  registerAppModule("@/features/planner/list/published/DeleteProjectModal", DeleteProjectModal);
  registerAppModule("@/features/planner/list/published/publishedModel", PublishedModel);
  registerAppModule("@/features/planner/list/reopenProject", ReopenProject);
  registerAppModule("@/features/planner/pane/PlanStageBar", PlanStageBar);
  registerAppModule("@/features/planner/stages/blueprints", Blueprints);
  registerAppModule("@/features/planner/stages/planTopics", PlanTopics);
}
