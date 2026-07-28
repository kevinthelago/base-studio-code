// The project pane's graph-platform surface (#3901, epic #3604) — the modules a graph-loaded pane
// component imports but does NOT redraw.
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545).
// Mirrors the fleet/list/security/github/skills/mcp platforms.
//
// Currently ONE entry, and that is the point of the preparation survey: the pane's whole platform surface
// is 17 specifiers, and 16 of them already resolve — 13 were registered before this issue and 2 more
// (BackButton, ModalCard) are shared primitives that belong in the shell's `appModules.ts`, not here. The
// seventeenth, `@/app/console/lib/models`, needs NOTHING: it is imported type-only in all three sites, so
// it erases at compile time (the doctor already returns no findings for a type-only import; only the
// harvest's stricter `buildable` flag counts it).
//
// So this file exists for the one genuine CROSS-FEATURE value import: `FocusedBodies` composes
// `PlannerComponentsPane` from the `@/features/designs` barrel. That coupling already exists in the live
// source, so registering it adds no new de-lazy — but it is a feature's dependency, not the shell's.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as Designs from "@/features/designs";

let done = false;

/** Register the project pane's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerPanePlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/designs", Designs);
}
