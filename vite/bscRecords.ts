// The record fallback for Vite and vitest — the same two-step resolve `tsconfig.paths` gets natively.
//
// `tsconfig.json` can express this in one line (`"@/*": ["./src/*", "./.bsc-records/*"]`) because tsc
// takes an ORDERED list. Vite's `resolve.alias` takes a single target, so the fallback needs a resolver
// hook. That asymmetry is the entire reason this file exists — it is not doing anything tsc isn't.
//
// It resolves to a real path in the generated tree rather than serving source from memory. An earlier
// version returned the seed's `srcText` as a virtual module, and deleting one file broke three ways at
// once: a RELATIVE import (`./layout/Spacer`) never reaches a plugin matching `@/…`; `tsc` has no such
// plugin API at all; and vitest loads a different config so the plugin was never installed. A file on
// disk is the one thing all three already agree on — see `scripts/emit-records.mjs`.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { emitRecords } from "../scripts/emit-records.mjs";

/** ONCE PER PROCESS, across every plugin instance — module-level on purpose.
 *
 *  `emitRecords` starts by `rmSync`-ing the whole tree and rebuilding it, which is right for one emitter
 *  and catastrophic for two. A WORKER is a separate build with its own plugin list, and its `buildStart`
 *  fires from inside the MAIN build's transform phase — so a second instance deleted the tree while
 *  rolldown was concurrently loading modules out of it. The failure surfaced as "Could not load
 *  .bsc-records/…", naming a DIFFERENT module on every run, for files that were plainly on disk by the
 *  time anyone looked. Nothing about the seeds changes mid-build, so emitting once is not just a fix for
 *  the race — it is the only emission that was ever meaningful. */
let emitted = false;

export function bscRecords(opts: { repoRoot: string }): Plugin {
  const { repoRoot } = opts;
  const records = resolve(repoRoot, ".bsc-records");

  const hit = (base: string) =>
    [".tsx", ".ts", "/index.tsx", "/index.ts"].map((e) => base + e).find(existsSync) ?? null;

  return {
    name: "bsc-records",

    // GENERATE HERE, not in an npm script. Wiring generation into `typecheck`/`test`/`build` meant the
    // tree existed only if a developer typed one of those — `npm run dev`, `npx vite`, `npm run tauri --
    // dev` and an IDE launch all skipped it, and the dev server booted with a retired module unresolvable:
    // "Failed to fetch dynamically imported module: /src/app/runtime/appModules.ts", which killed the whole
    // boot chain. The tree is a precondition of RESOLUTION, so it belongs to the thing that resolves.
    // It also explains why the gate stayed green: every gate command regenerated first, so no gate could
    // observe the broken state — and the one command nobody gates on is the one a person runs all day.
    buildStart() {
      if (emitted) return; // see `emitted` above — a second emitter deletes the tree mid-build
      emitted = true;
      emitRecords({ quiet: true });
    },
    // Ahead of the `@` alias, so the specifier is still in `@/…` form and matches exactly instead of
    // guessing which extension the alias resolved to.
    enforce: "pre",
    resolveId(source) {
      // BOTH forms, and the second is the one that actually fires. `resolve.alias` is itself an
      // `enforce: "pre"` plugin and wins the race, so by the time this hook runs the specifier is no
      // longer `@/shared/ui/layout/Spacer` — it is the aliased path `<repo>/src/shared/ui/layout/Spacer`,
      // extensionless and non-existent. Matching only the `@/` form looks correct and never fires.
      let rel: string[] | null = null;
      if (source.startsWith("@/")) {
        rel = source.slice(2).split("/");
      } else {
        // `split("\\").join("/")` rather than a regex: a backslash class inside a shell-written file is
        // one escaping layer too many, and it collapsed to an unterminated regex the first time.
        const norm = source.split("\\").join("/");
        const root = resolve(repoRoot, "src").split("\\").join("/") + "/";
        if (norm.startsWith(root)) rel = norm.slice(root.length).split("/");
      }
      if (!rel) return null;
      // The file wins while it exists. Installing this plugin is therefore a no-op until a deletion.
      if (hit(join(repoRoot, "src", ...rel))) return null;
      return hit(join(records, ...rel));
    },
  };
}
