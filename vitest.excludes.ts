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
 *
 * `e2e/**` is the OTHER discovery exclusion (#3264/#3411): the Playwright browser harness is
 * deliberately outside the default gate, and its specs match vitest's default `*.spec.ts` include
 * glob. It was documented as excluded from vitest discovery but never actually listed here, so a
 * root `npx vitest run` collected `e2e/previewInteraction.spec.ts` and the suite failed to resolve
 * `@playwright/test` — a browser dep a zero-install worktree is not meant to need. Playwright runs
 * it via `npm run test:e2e` (its own `playwright.config.ts`), never through vitest.
 */
export const testExclude: string[] = [
  ...configDefaults.exclude, // node_modules, dist, .idea, .git, .cache
  "**/wt*/**",
  "**/.claude/worktrees/**",
  "e2e/**",
];
