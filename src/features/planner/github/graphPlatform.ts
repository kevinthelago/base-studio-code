// The planner-github board's graph-platform surface (`record-link-debt`, epic #3604) — the board leaves a
// graph-loaded column/issue record composes but does NOT redraw.
//
// WHY A NEW FILE. `@/features/planner/github/IssueCard` was registered nowhere, so the `column` record
// threw the loader's named error the moment anything mounted it. The four other planner graph-platforms
// (`session`, `list`, `pane`, `bodies`) are AUTO-GENERATED from their page's records and must not be
// hand-edited, and the github FEATURE cannot register a deep planner path without breaking the
// barrel-only rule (#1545) its own header calls out. So the registration lives inside the planner, next
// to the module it names.
//
// WHY THE FILE AND NOT THE RECORD. An `issuecard` record already exists, so giving it a `provides` field
// looked equivalent. It is not: `resolveGraphSource` matches `provides` GLOBALLY, so that record would
// override the bundled `IssueCard` for every graph consumer — and it is drifted from its file. Registering
// the file resolves to the newer copy. Flipping to `provides` (and deleting the file) is
// `record-src-reconcile`'s move, after the fold has made the record the newer copy.
//
// Called by `registerGithubPlatform`, which is the surface that drills into these board views — so this
// has a LIVE caller rather than being a registration only the guards can see.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as IssueCard from "@/features/planner/github/IssueCard";

let done = false;

/** Register the planner-github board's injected graph-platform modules. Idempotent. */
export function registerPlannerGithubPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/planner/github/IssueCard", IssueCard);
}
