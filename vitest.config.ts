/// <reference types="node" />
// ^ scopes Node types to THIS config file only (for node:url), so adding @types/node doesn't flip
//   setInterval/setTimeout return types across src (the DOM lib keeps them `number`). (#1309)
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { bscRecords } from "./vite/bscRecords";
import { fileURLToPath } from "node:url";
import { testExclude } from "./vitest.excludes";

export default defineConfig({
  // Same record fallback as the build. vitest loads THIS config, not vite.config.ts — a plugin added
  // only there is invisible here, which is one of the three ways deleting a single file broke.
  plugins: [bscRecords({ repoRoot: fileURLToPath(new URL(".", import.meta.url)) }), react()],
  // Disable Vite's fs sandbox for tests so a NESTED git worktree (e.g. .claude/worktrees/<branch>/)
  // running install-free can read files from the shared repo-root node_modules — specifically
  // esbuild-wasm's .wasm, which the preview tests load via `?url` and which lives in an ancestor dir.
  // Test-only; harmless for the main checkout (its files are already inside the root). See #1669.
  server: { fs: { strict: false } },
  resolve: { alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    "@data": fileURLToPath(new URL("./src-tauri/data", import.meta.url)),
  } },
  test: {
    // Default for anything a project does not override. The `node` project below flips it for
    // `lib/`; everything else keeps jsdom.
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // A RETIRED module's tests live on its record and are materialized into `.bsc-records/` beside the
    // module (`scripts/emit-records.mjs`). They have to be named explicitly: the default glob is
    // `**/*.{test,spec}.…`, and the glob engine does not descend into a DOT-directory, so `.bsc-records/`
    // is invisible to it no matter how the pattern is written. Verified by probe — a test placed there is
    // collected with this entry and silently ignored without it.
    //
    // This is what makes deleting a colocated test file safe: the record's copy takes over in the SAME
    // gate run, so coverage moves rather than disappearing.
    include: [...configDefaults.include, ".bsc-records/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    // Test DISCOVERY excludes — keeps a ROOT run out of nested worktrees. See vitest.excludes.ts (#3379).
    exclude: testExclude,

    // TWO ENVIRONMENTS, SPLIT ON THE `lib/` BOUNDARY.
    //
    // jsdom is built PER TEST FILE and costs ~1.2s each. Measured on the whole suite before this
    // split: `environment` 890.52s against `tests` 103.18s — nine times more wall spent constructing
    // DOMs than running the tests they exist for. On the `lib/` subset alone it was `environment`
    // 488.56s against `tests` 13.93s.
    //
    // The split is the frontend convention's own boundary, not a heuristic: `features/<x>/lib/` and
    // `shared/lib/` are defined as PURE, React-free domain logic, so by construction they should not
    // need a DOM. Anything else — components, hooks, the shell — keeps jsdom.
    //
    // A file that genuinely needs a DOM despite living under `lib/` says so ITSELF, with a
    // `@vitest-environment jsdom` docblock, which takes precedence over the project's environment.
    // That is deliberate: the requirement is stated where the reader can see it, and a NEW `lib/`
    // test lands on `node` automatically with nothing to remember. If it turns out to need a DOM it
    // fails loudly on the first run rather than silently paying for one forever.
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/lib/**/*.test.{ts,tsx}"],
          exclude: testExclude,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          // NOT `src/**` — this must stay vitest's DEFAULT discovery pattern, because 8 test files
          // live OUTSIDE src/ (`relay/test/*.test.ts`, `scripts/*.test.ts`). Scoping this to src/
          // dropped all 8 silently: 717 files ran instead of 725 and the suite still reported green.
          // One of the casualties was `scripts/vitest-discovery.test.ts`, the guard against exactly
          // this. Widening the project include is not optional.
          include: configDefaults.include,
          // `exclude` REPLACES rather than merges, so the worktree excludes have to be restated here
          // alongside the `lib/` handover — dropping them would let a root run walk nested worktrees
          // again, which is exactly #3379.
          exclude: [...testExclude, "src/**/lib/**/*.test.{ts,tsx}"],
        },
      },
    ],

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/test/**",
        "src/**/*.test.{ts,tsx}",
        "src/data/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
    },
  },
});
