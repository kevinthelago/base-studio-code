// The dev server's watch-ignore list (#perf) — a module rather than a literal in `vite.config.ts` so the
// patterns can be unit-tested. A typo here is invisible to tsc (they are strings) and its symptom lands
// nowhere near its cause: a `tauri dev` that never finishes, in a repo where nothing looks wrong.
//
// vite watches the project root, and this root holds three kinds of large NON-source tree:
//   1. `target/` — the Cargo workspace's build output, tens of thousands of churning artifacts.
//   2. `dist/` · `coverage/` — build outputs that accumulate.
//   3. `wt-*/` — the nested git worktrees the parallel-agent workflow creates.
//
// chokidar watching that many files starves vite's event loop on Windows, so the dev server answers the
// WebView's module requests slowly and the initial load stalls (instant on a fresh clone → ~50s once
// `target/` fills up).
//
// (3) is the one that was missing, and it is the worst of the three because it is driven by ANOTHER
// process. Each worktree is a second full copy of the repo (~3100 files) inside the watched root, so
// every gate an agent runs in one is a change storm at whatever dev server the maintainer has open:
// `npm run typecheck` alone materializes 184+ files into `.bsc-records/`, `UPDATE_KITS=1` rewrites the
// packaged kit artifacts, `npm test` transforms the tree. Measured with one sibling worktree active:
// vite held ~1.4 cores continuously while the tauri CLI sat at 0 CPU waiting for a frontend that never
// became responsive. The two supported workflows — run the app, and work items in parallel worktrees —
// must not fight.

/**
 * The `server.watch.ignored` patterns for a checkout at `repoRoot`.
 *
 * `repoRoot` must be an ABSOLUTE path with forward slashes and no trailing slash — chokidar matches
 * absolute paths, which is also why the build-output patterns carry a leading globstar rather than being
 * root-relative.
 *
 * The worktree patterns are root-ANCHORED, and both traps behind that are load-bearing:
 *
 * - **Anchored, not an unanchored globstar.** An unanchored pattern also matches any SOURCE file whose name starts
 *   with `wt-` (`src/shared/ui/wt-widget.tsx`), which would silently stop watching it — a bug that reads
 *   as "HMR is broken" rather than as a config mistake.
 * - **The directory itself is listed, not just its contents.** a contents-only pattern requires a child
 *   segment, and a dot-less matcher does not match `.`-prefixed children — so on its own it would leak
 *   exactly the heaviest churner, `wt-<x>/.bsc-records/`. Ignoring the DIRECTORY makes chokidar prune
 *   the whole subtree before it ever descends, which is dotfile-proof by construction.
 */
export function devWatchIgnored(repoRoot: string): string[] {
  return [
    "**/src-tauri/**",
    "**/target/**",
    "**/coverage/**",
    "**/dist/**",
    `${repoRoot}/wt-*`,
    `${repoRoot}/wt-*/**`,
  ];
}
