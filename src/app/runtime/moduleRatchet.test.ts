// THE FRONTEND RATCHET: no NEW non-test module appears under `src/`.
//
// The twin of `crates/bsc-graph/src/migration_ratchet.rs`, which does the same job for `.rs` files
// under `crates/` and `src-tauri/src/`, and it is here for the same measured reason: a migration is a
// one-time sweep and authoring is continuous, so the sweep loses. MEASURED and written down in
// CLAUDE.md: the non-test module count under `src/` went 69 -> 77 -> 91 while the harvest was
// described as finished, with 40 modules added in the three weeks to 2026-09-03. Nothing observed
// that; the count was re-derived by hand, months apart, and the prose in between was simply wrong.
//
// WHAT THIS CATCHES THAT NOTHING ELSE DOES. Every other guard here judges what a module DOES —
// `platformBoundary` the imports it may write, `recordImports` the specifiers a record may carry,
// `styleReachability` the stylesheets it drags. None of them can see a module that should not be a
// FILE at all, and a migrated module RE-CREATED as a file is the worst shape of that: the record
// keeps the old body, the file is the copy somebody edits, and every gate is green
// (`docs/records.md`, "a file left behind is a second live copy").
//
// WHY AN ALLOW-LIST AND WHY SUBSET, NOT EQUALITY. Copied from the Rust ratchet, because the
// reasoning is the same and a second shape would be a second thing to learn. Migrating a module
// never requires editing [`ON_DISK`] to stay green, so cleaning up is never a merge conflict for
// whoever lands first — while ADDING a module goes red, and the edit that makes it green again is
// the conversation this guard exists to force. A COUNT would let one module migrate and another
// appear with the total unchanged.
//
// WHY THE POPULATION IS ASSERTED. A scanner that silently stops matching finds nothing, reports no
// offenders, and reads as a pass. So the scan asserts it found the tree before it says anything
// about what is in it — the same vacuous-green this repo keeps getting caught by.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** Every non-test `.ts`/`.tsx` under `src/`, repo-relative with `/` separators, sorted. */
function modules(dir = SRC, prefix = "src"): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) out.push(...modules(join(dir, e.name), rel));
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(rel);
  }
  return out.sort();
}

/** The non-test modules that were on disk when this guard was written.
 *
 *  GENERATED FROM THE TREE, never typed: `find src -name "*.ts" -o -name "*.tsx" | grep -vE
 *  "\.(test|spec)\."`. Each survives for one of the shapes `CLAUDE.md` lists — module state on a
 *  specifier something ELSE registers, `import.meta.glob`, a `.d.ts`, the entry, the test setup, a
 *  module `vite.config.ts` imports or names in `server.warmup.clientFiles`, or an
 *  `src/shared/lib/algorithms/*` module that exists precisely to BE a file so
 *  `seedAlgorithms.gen.test.ts` can generate a packaged node's `code` from it.
 *
 *  Those shapes are the reason a module is here; they are NOT a licence to add one. A new entry is a
 *  decision, and this list is where it gets made rather than noticed a quarter later. */
const ON_DISK: string[] = [
  "src/app/App.tsx",
  "src/app/console/ConsoleGraphHost.tsx",
  "src/app/console/lib/detachWindow.ts",
  "src/app/console/lib/terminalAdmission.ts",
  "src/app/console/lib/usePaneActivityFeed.ts",
  "src/app/console/terminal/TerminalHost.tsx",
  "src/app/main.tsx",
  "src/app/runtime/appModules.ts",
  "src/app/runtime/shadowMode.ts",
  "src/app/runtime/shadowPages.ts",
  "src/features/algorithms/viz/examples/registry.ts",
  "src/features/algorithms/viz/examples/vizSandbox.ts",
  "src/features/designs/lib/componentBridge.ts",
  "src/features/designs/lib/componentPreview.ts",
  "src/features/designs/lib/graphHealth.ts",
  "src/features/designs/lib/previewRegistry.ts",
  "src/features/designs/lib/seed.ts",
  "src/features/designs/store.ts",
  "src/features/glance/lib/useGlanceProjects.ts",
  "src/features/personas/lib/persona.ts",
  "src/features/planner/preview/registry.ts",
  "src/features/planner/stages/blueprintBuiltins.ts",
  "src/features/planner/stages/planStageDerive.ts",
  "src/features/planner/stages/planTopics.ts",
  "src/features/sounds/lib/soundKits.ts",
  "src/features/sounds/lib/synth.ts",
  "src/features/teams/lib/team.ts",
  "src/shared/data/skills.ts",
  // The screen registry `bsc app go` reads (`the-shared-navigation-mechanism-drill-select-and-show`):
  // module state on a specifier `appModules` registers for the graph-loaded pages, so a record would be a
  // second copy of the registry — the shape `bsc graph impl set` refuses.
  "src/shared/hooks/useScreenDescriptor.ts",
  "src/shared/lib/a11y/announcer.ts",
  "src/shared/lib/algorithms/groupTotals.ts",
  "src/shared/lib/algorithms/llmEnergy.ts",
  "src/shared/lib/algorithms/orderByRank.ts",
  "src/shared/lib/algorithms/precedenceResolve.ts",
  "src/shared/lib/algorithms/streamMerge.ts",
  "src/shared/lib/algorithms/windowedTally.ts",
  "src/shared/lib/core/achievements.ts",
  "src/shared/lib/core/configOverrides.ts",
  "src/shared/lib/core/devWatchIgnore.ts",
  "src/shared/lib/core/log.ts",
  "src/shared/lib/core/perf.ts",
  "src/shared/lib/core/startupTrace.ts",
  "src/shared/lib/github/githubProbe.ts",
  "src/shared/lib/graph/cssColor.ts",
  "src/shared/lib/preview/componentBundle.ts",
  "src/shared/lib/runtime/attest.ts",
  "src/shared/lib/runtime/GraphComponent.tsx",
  "src/shared/lib/runtime/renderGate.ts",
  "src/shared/lib/security/agentProfiles.ts",
  "src/shared/ui/kit/ThemeProvider.tsx",
  "src/shared/ui/kit/theme.ts",
  "src/shared/ui/layouts/pageNav.ts",
  "src/shared/ui/spec/graphPrimitive.tsx",
  "src/store/index.ts",
  "src/test/setup.ts",
  "src/types/picomatch.d.ts",
  "src/vite-env.d.ts",
];

describe("the frontend migration ratchets", () => {
  it("finds the module tree at all", () => {
    // NON-VACUITY. A broken walk returns [], every assertion below passes, and the guard is a
    // comment. The floor is deliberately well under the census so a legitimate migration tranche
    // does not have to move it.
    expect(modules().length).toBeGreaterThan(30);
  });

  it("adds no module that is not on the list — a migrated file cannot reappear", () => {
    const known = new Set(ON_DISK);
    const unlisted = modules().filter((m) => !known.has(m));
    expect(
      unlisted,
      `${unlisted.length} module(s) under src/ are not in ON_DISK. A NEW module belongs in the ` +
        `graph (bsc graph harvest <file> --module --apply, then promote), not in src/; see ` +
        `docs/records.md. If it genuinely must be a file, add it here WITH ITS REASON:\n` +
        unlisted.join("\n"),
    ).toEqual([]);
  });

  it("names no module that is gone — the list cannot rot into a list of lies", () => {
    // The Rust ratchet's `every_named_exception_is_a_crate_that_exists`, for the same reason: half
    // the entries there had become stale and the verdict was still green, which is what forced it to
    // be rewritten rather than trusted.
    const live = new Set(modules());
    const stale = ON_DISK.filter((m) => !live.has(m));
    expect(stale, `ON_DISK names ${stale.length} module(s) that no longer exist — prune them`).toEqual([]);
  });
});
