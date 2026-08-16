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
