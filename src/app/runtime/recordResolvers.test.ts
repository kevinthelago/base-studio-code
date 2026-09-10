// EVERY resolver must know about records — the list, asserted, so the next one added is not found the
// hard way.
//
// A retired module exists only as a packaged seed materialized into `.bsc-records/`, so anything that
// turns a `@/…` specifier into code has to consult that tree. There is no single place to configure it:
// each tool has its own resolver and they were each discovered by a different failure.
//
//   tsconfig.json          `paths` — tsc. `npm run typecheck` reads this and nothing else.
//   vite.config.ts         the `bscRecords` plugin — the dev server and the app bundle.
//   vite.config.ts         `worker.plugins` — a WORKER IS A SEPARATE BUILD WITH A SEPARATE PLUGIN LIST.
//                          `resolve.alias` is config-level so a worker inherits it, but `plugins` is not:
//                          `worker.plugins` defaults to EMPTY, so a worker aliased `@/…` straight to a
//                          path on disk and nothing answered for the record. Only `vite build` can see
//                          it — tsc reads `paths`, vitest never bundles a worker.
//   vitest.config.ts       the same plugin — the default gate.
//   e2e/vite.config.ts     its OWN config, outside the root tsconfig. Retiring `Spacer` broke the whole
//                          Playwright harness because this one was missed.
//   reactUiKit.gen.test.ts the kit generator walks the import graph itself.
//   graph/algorithms.json  the RUST closure walker (`bsc ui emit`), record `bsc-ui--emit--mod.rs`. The
//                          SEVENTH, and the only one
//                          outside the TS build: it vendors an alias-free tree by resolving each `@/…`
//                          against the packaged kit artifact overlaid with the store, so a module that
//                          exists only as a record still has to be reachable. When it was not, an alias
//                          survived into the emitted file and the closure invariant broke — visible ONLY
//                          to `cargo test -p bsc-ui`, which is why it went unnoticed
//                          (`bsc-ui-emit-cannot-resolve-a-retired-module`).
//
// This test is deliberately TEXTUAL. Importing each config would run it, and the point is to notice a
// config that has *stopped* mentioning the resolver, which a loaded config cannot report.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// The MERGED store loader (`epic-retire-json-ledgers-for-db-and-git-drivers`). A relative reach into
// `scripts/` rather than an `@/…` alias, deliberately: this is build tooling shared with the gate
// scripts, not frontend source, and the file it loads is already resolved relative to REPO below.
import { loadStore, resolveStorePath } from "../../../scripts/lib/recordStore.mjs";

const REPO = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

describe("record resolvers (#3604)", () => {
  it("tsc resolves @/… through .bsc-records", () => {
    const tsconfig = read("tsconfig.json");
    expect(tsconfig).toContain(".bsc-records/*");
    // Order matters: `./src/*` first, so a file that still exists always beats its record.
    const paths = tsconfig.slice(tsconfig.indexOf('"@/*"'));
    expect(paths.indexOf("./src/*")).toBeLessThan(paths.indexOf(".bsc-records/*"));
  });

  it.each([
    ["vite.config.ts", "the app bundle + dev server"],
    ["vitest.config.ts", "the default gate"],
    ["e2e/vite.config.ts", "the Playwright harness"],
  ])("%s installs the bscRecords plugin (%s)", (file) => {
    expect(read(file)).toContain("bscRecords(");
  });

  it("the WORKER sub-build installs it too — its plugin list is separate", () => {
    const cfg = read("vite.config.ts");
    // `worker.plugins` is a FUNCTION returning plugins, and it defaults to none of the root ones.
    expect(cfg).toMatch(/worker:\s*\{\s*plugins:\s*\(\)\s*=>\s*\[[^\]]*bscRecords\(/);
  });

  it("the kit generator resolves records as well as files", () => {
    expect(read("src/features/designs/lib/reactUiKit.gen.test.ts")).toContain("bscRecords");
  });

  // The seventh resolver is RUST, so this side cannot assert the resolution itself — `cargo test -p
  // bsc-ui` owns that. What it CAN do is keep the list complete: if the whole-kit closure guard is ever
  // dropped, the emit walker goes back to being watched by a single-component test that a retired module
  // in some OTHER closure would slip straight past.
  it("the Rust emit walker still has its whole-kit closure guard", () => {
    // `bsc-ui` COMPILES FROM THE GRAPH now, so `crates/bsc-ui/src/emit.rs` no longer exists — the
    // module is the record `bsc-ui--emit--mod.rs` in the repo store, which is the file
    // `crates/graph-materialize/build.rs` actually materializes for the compiler. Reading the store is
    // therefore the same evidence this assertion always wanted, taken one step closer to the source of
    // truth; reading the file would now be reading nothing at all.
    // Through the MERGED loader: `bsc-ui--emit--mod.rs` may live in `graph/records/` rather than in
    // the store file, and `JSON.parse(read(...))` would then find no record and report the guard
    // dropped when it is right there.
    const store = loadStore(resolveStorePath(REPO)) as {
      implementations?: { id?: string; code?: string }[];
    };
    const impls = store.implementations ?? [];
    // NON-VACUITY, twice over: a store that parsed to nothing, or a record id that has been renamed,
    // must fail LOUDLY here. A `?? ""` fallback would turn either into a silent `toContain` failure
    // that reads as "the guard was dropped" and sends the next reader to the wrong place.
    expect(impls.length).toBeGreaterThan(100);
    const emit = impls.find((i) => i.id === "bsc-ui--emit--mod.rs")?.code;
    expect(emit, "no `bsc-ui--emit--mod.rs` record in graph/algorithms.json").toBeTypeOf("string");
    expect(emit).toContain("fn the_whole_packaged_kit_plans_an_alias_free_closure");
    expect(emit).toContain("unvendored_aliases");
  });
});
