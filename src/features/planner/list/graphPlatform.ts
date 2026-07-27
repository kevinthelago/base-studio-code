// The projects page's graph-platform surface (#3874, epic #3604) — the planner-list internals a
// graph-loaded Projects page imports but does NOT redraw: the card/rail/setup-page/modal components, the
// draft + local-published + projects.db derivations, and the published model.
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545). The
// projects host calls this synchronously before the graph page loads. Mirrors the
// fleet/automations/security/github/skills/mcp platforms.
//
// WHY THESE ARE INJECTED RATHER THAN REDRAWN. Projects is the largest page in the app — `ProjectsList.tsx`
// alone is ~31k chars against 13-26k for every completed page record, plus ~2,400 lines of siblings. #3833
// is the cautionary tale: the Skills record shipped as a preview-grade TRANSCRIPTION (sample data, none of
// the real wiring) and every revision after iterated on the reduced version for days, because the page still
// LOOKED right. Injecting the siblings keeps their behaviour real by construction — the graph owns the
// page's composition, not a hand-copied imitation of its parts.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as ProjectCard from "./ProjectCard";
import * as ProjectsRail from "./ProjectsRail";
import * as ProjectSetupPage from "./ProjectSetupPage";
import * as ReopenProjectModal from "./ReopenProjectModal";
import * as Drafts from "./drafts";
import * as LocalPublished from "./localPublished";
import * as ProjectsDbBridge from "./projectsDbBridge";
import * as ProjectsFilter from "./projectsFilter";
import * as DeleteProjectModal from "./published/DeleteProjectModal";
import * as PublishedModel from "./published/publishedModel";
import * as PlanTopics from "../stages/planTopics";

let done = false;

/** Register the projects page's injected graph-platform modules by the specifiers it imports. Idempotent.
 *
 *  Both spellings are registered for each sibling — the relative `./X` the source is authored with, and the
 *  absolute `@/features/planner/list/X` the loader may normalise to — so the record resolves whichever form
 *  its source carries. Registering a specifier twice is harmless; an UNRESOLVED one silently falls through
 *  to the external/code path, which is the failure this pairing exists to prevent. */
export function registerProjectsPlatform(): void {
  if (done) return;
  done = true;
  const mod: Record<string, unknown> = {
    "ProjectCard": ProjectCard,
    "ProjectsRail": ProjectsRail,
    "ProjectSetupPage": ProjectSetupPage,
    "ReopenProjectModal": ReopenProjectModal,
    "drafts": Drafts,
    "localPublished": LocalPublished,
    "projectsDbBridge": ProjectsDbBridge,
    "projectsFilter": ProjectsFilter,
    "published/DeleteProjectModal": DeleteProjectModal,
    "published/publishedModel": PublishedModel,
  };
  for (const [rel, value] of Object.entries(mod)) {
    registerAppModule(`./${rel}`, value);
    registerAppModule(`@/features/planner/list/${rel}`, value);
  }
  registerAppModule("@/features/planner/stages/planTopics", PlanTopics);
}
