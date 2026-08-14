// Materialize retired modules from their packaged seeds into a generated, git-ignored tree.
//
// WHY NOT A BUNDLER PLUGIN. I wrote one first, and deleting a single file proved it insufficient in three
// different ways at once:
//
//   vite build  — failed on `'./layout/Spacer'`, a RELATIVE import. A plugin matching `@/…` never sees it.
//   tsc         — TS2307 from three files. The type checker has no plugin API of this kind; it resolves
//                 modules its own way and knows nothing about Vite.
//   vitest      — has its OWN config, so the plugin was never loaded, and the colocated test imported
//                 `./Spacer` besides.
//
// Three resolvers, three mechanisms, and a plugin only ever fixes one. The thing all three DO agree on is
// a file on disk. So instead of teaching each tool about records, emit the record AS a file into a
// generated tree and let `tsconfig.paths` fallback order do the rest:
//
//     "@/*": ["src/*", ".bsc-records/*"]     // src wins; the record answers only what src no longer has
//
// tsc supports that natively, Vite and vitest can be given the same two-step resolve, and a relative
// import resolves because the emitted file sits at the same relative position in the mirrored layout.
//
// ⚠️ THIS IS NOT "MOVING THE FILE". The emitted tree is GIT-IGNORED and regenerated from the seed on every
// build/typecheck/test. The repository genuinely loses the module; what exists on disk afterwards is a
// derived cache, the same status `node_modules` has. If the emitted copy is ever edited, the next run
// overwrites it — the seed is the source of truth, which is the entire point of the migration.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO, ".bsc-records");

/** Every specifier a packaged seed can serve, with the source to serve for it. */
function collectSeeds() {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      if (statSync(p).size > 4_000_000) continue; // the generated kit closure, not a per-record seed
      let rec;
      try {
        rec = JSON.parse(readFileSync(p, "utf8"));
      } catch {
        continue;
      }
      const spec = typeof rec?.provides === "string" ? rec.provides.trim() : "";
      const code = typeof rec?.srcText === "string" ? rec.srcText : "";
      if (spec.startsWith("@/") && code.trim() && rec.id) out.set(spec, { id: rec.id, code });
    }
  };
  walk(join(REPO, "src-tauri", "data", "components"));

  try {
    const k = JSON.parse(readFileSync(join(REPO, "src-tauri", "data", "knowledge", "algorithms.json"), "utf8"));
    for (const im of k?.implementations ?? []) {
      const spec = typeof im?.provides === "string" ? im.provides.trim() : "";
      const code = typeof im?.code === "string" ? im.code : "";
      // Components win a collision — `resolveGraphSource` checks them first, so the emitted tree must agree
      // with what the runtime loader would have picked.
      if (spec.startsWith("@/") && code.trim() && im.id && !out.has(spec)) out.set(spec, { id: im.id, code });
    }
  } catch {
    /* a checkout without the algorithm seed is still valid */
  }
  return out;
}

/** Does `src/` still hold this specifier? If so the record must NOT be emitted — the file wins. */
function fileExists(spec) {
  const base = join(REPO, "src", ...spec.slice(2).split("/"));
  return [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"].some((e) => existsSync(base + e));
}

/** JSX needs `.tsx`; a module without it gets `.ts` so `tsc` does not widen every generic to a JSX tag. */
const extFor = (code) => (/<[A-Za-z][^>]*>/.test(code) ? ".tsx" : ".ts");

export function emitRecords({ quiet = false } = {}) {
  const seeds = collectSeeds();
  // A full rebuild each run: a stale emitted file for a module that came BACK would shadow nothing (src
  // wins) but would still be dead weight the next reader has to explain.
  rmSync(OUT, { recursive: true, force: true });

  const emitted = [];
  for (const [spec, rec] of seeds) {
    if (fileExists(spec)) continue; // the file is still there and authoritative
    const rel = spec.slice(2);
    const path = join(OUT, ...rel.split("/")) + extFor(rec.code);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `// GENERATED from the packaged seed for \`${rec.id}\` — do not edit, and do not commit.\n` +
        `// The record is the source of truth; this file is a derived cache so tsc/vite/vitest can resolve\n` +
        `// \`${spec}\` after the original module was retired. Regenerate with \`npm run emit:records\`.\n` +
        rec.code,
      "utf8",
    );
    emitted.push(spec);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, ".gitignore"), "*\n", "utf8"); // the tree ignores itself, wherever it is checked out
  if (!quiet) {
    console.log(`emit-records: ${emitted.length} retired specifier(s) materialized from seeds`);
    for (const s of emitted.sort()) console.log("   " + s);
  }
  return emitted;
}

// Still a CLI: `tsc` does not run through vite, so `npm run typecheck` needs a way to materialize the
// tree before type resolution. Everything that DOES go through vite is served by the plugin instead.
if (process.argv[1] && process.argv[1].endsWith("emit-records.mjs")) emitRecords();
