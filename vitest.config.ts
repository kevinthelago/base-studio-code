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
    // ── WORKER FAN-OUT (#vitest-worker-fan-out-is-capped-like-cargos) ──
    //
    // Uncapped, vitest forks one worker per available thread — 16 on this box — and ONE run then peaks
    // at the entire memory budget a FULL gate is allowed. MEASURED as peak PSS of the run's own process
    // tree, sampled every 500ms:
    //
    //     maxWorkers      peak      procs
    //     default (~16)   8.09 GB     18
    //     8               5.36 GB     11     <- here
    //     4               4.15 GB      7
    //
    // ⚠️ DO NOT CARRY CARGO'S CONCLUSION ACROSS. `.cargo/config.toml` caps `jobs = 4` because 16 jobs was
    // measured NO FASTER than 4 at 2.2x the memory — capping cargo was free. Vitest is not that shape: it
    // genuinely uses the parallelism, so capping it below the box's own thread count is a real TRADE, not
    // a free win. 8 is the knee (-34% memory against the uncapped default).
    //
    // THIS IS A FLEET SETTING. It exists because ~10 sessions share one box and each gate that runs
    // vitest unscoped brings a whole suite with it; alone on a bigger machine, `--maxWorkers=16` on the
    // command line overrides it and is genuinely faster, not just less contended.
    //
    // WALL TIMES, re-measured 2026-08-29 on a QUIET box (CPU PSI avg10 ≈ 0.00 at the start of each run —
    // this repo runs several concurrent Claude sessions, so "quiet" here means no OTHER cargo/vitest work
    // was active, not that nothing else exists on the machine), same suite each time (775 files / 7870
    // tests), `/usr/bin/time -v npm test -- --run`:
    //
    //     maxWorkers      wall
    //     16 (uncapped)   85.7s
    //     8               109.4s     <- here, +28% wall vs uncapped
    //     4               150.3s     +75% wall vs uncapped
    //
    // An EARLIER version of this comment reported the maxWorkers=8/120.7s/177.3s figures were taken on a
    // CONTENDED box (19 other vitest processes, CPU PSI avg10 18.5) and warned to read them as ratios
    // only. A later re-measurement attempt (uncommitted work note, request #182 follow-up) claimed all
    // three arms land within a second of each other on a quiet box (~87-88s), i.e. that maxWorkers barely
    // matters once contention is removed — THAT CLAIM DID NOT REPRODUCE. The numbers above are a direct,
    // fresh quiet-box measurement and show the same qualitative shape as the original contended table:
    // fewer workers costs real wall time, monotonically. So the memory/time trade this cap encodes is
    // real on a quiet box too, not an artifact of a busy one — the absolute times just shift.
    maxWorkers: 8,
    // Default for anything a project does not override. The `node` project below flips it for
    // `lib/`; everything else keeps jsdom.
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // ⛔ NO `include` HERE. A root-level `test.include` is ADDITIVE into every project rather than being
    // replaced by the project's own, so one added here lands in `node` as well and that project stops
    // being the `lib/` subset: measured, it collected 732 files instead, ran the whole DOM suite without
    // a DOM, and every `.bsc-records/` test ran TWICE (1169 files collected for 725 real ones, 244 files
    // and 1284 tests red). The record glob lives on the `dom` project below, where it belongs anyway.
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
          // BOTH trees, because `lib/` is a statement about the CODE and not about where the file
          // sits. A retired module's test is materialized into `.bsc-records/` beside it
          // (`emit-records`), so `shared/lib/core/x.test.tsx` becomes
          // `.bsc-records/shared/lib/core/x.test.tsx` — still pure domain logic, and matched by
          // neither `src/**/lib/**` nor anything else here. Without the second pattern a test SILENTLY
          // changes environment the moment its module is retired, and pays for a DOM it was written not
          // to need: measured above at 488.56s of environment against 13.93s of tests on this subset.
          include: ["src/**/lib/**/*.test.{ts,tsx}", ".bsc-records/**/lib/**/*.test.{ts,tsx}"],
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
          //
          // A RETIRED module's tests live on its record and are materialized into `.bsc-records/` beside
          // the module (`scripts/emit-records.mjs`) — which is what lets a retired module drop its
          // colocated test file without dropping coverage. They must be named EXPLICITLY: the default
          // glob is `**/*.{test,spec}.…` and the glob engine does not descend into a DOT-directory, so
          // `.bsc-records/` is invisible to it however the pattern is written.
          //
          // On THIS project, not the root: records are components and want jsdom, and a root-level
          // include leaks into `node` too (see above).
          include: [...configDefaults.include, ".bsc-records/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          // `exclude` REPLACES rather than merges, so the worktree excludes have to be restated here
          // alongside the `lib/` handover — dropping them would let a root run walk nested worktrees
          // again, which is exactly #3379.
          // The `lib/` handover, restated for BOTH trees so a materialized lib test is claimed by
          // `node` alone. Overlapping includes across projects would run it twice and double-count.
          exclude: [
            ...testExclude,
            "src/**/lib/**/*.test.{ts,tsx}",
            ".bsc-records/**/lib/**/*.test.{ts,tsx}",
          ],
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
