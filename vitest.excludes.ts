import { configDefaults } from "vitest/config";

/**
 * Test-DISCOVERY excludes for `vitest.config.ts` (#3379).
 *
 * Distinct from that file's `coverage.exclude`, which governs INSTRUMENTATION only. The original
 * bug was placement: an `exclude` list existed, but only under `coverage`, so with no top-level
 * `test.exclude` the default include glob walked nested git worktrees — the `wt<issue>/` and
 * `.claude/worktrees/<branch>/` checkouts the parallel-agent workflow creates. A root run then
 * collected every test file once PER worktree (5477 files instead of 612 with eight worktrees
 * present), so a single failure was reported nine times and the counts were meaningless.
 *
 * These patterns are matched RELATIVE to the config root, so they only stop a ROOT run reaching
 * DOWN into a nested checkout. Running vitest from INSIDE a worktree keeps the root at that
 * worktree, where its own tests are plain `src/**` paths that match nothing here — so the
 * zero-install nested-worktree workflow (#1669) is unaffected.
 *
 * Lives in its own module so the config's excludes are importable by tests without evaluating
 * `vitest.config.ts`, whose `import.meta.url` is not a file URL once Vitest transforms it.
 */
export const testExclude: string[] = [
  ...configDefaults.exclude, // node_modules, dist, .idea, .git, .cache
  "**/wt*/**",
  "**/.claude/worktrees/**",
  // `e2e/` is the PLAYWRIGHT suite (#3264), run by `npm run test:e2e`, never by vitest. Without this
  // a root run collects `previewInteraction.spec.ts` and dies on `Failed to resolve import
  // "@playwright/test"`, since that package resolves only where playwright was installed (#3409).
  // #3264 intended `e2e/` to be outside vitest discovery but only ever put it outside `tsconfig`;
  // "outside the gate" has to be ASSERTED, not intended — see the test in scripts/.
  "e2e/**",
];
