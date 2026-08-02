// One-off generator (#4245, epic #3604) — the last three components the frontier sweep still names.
//
// #4238 claimed the frontier was closed. Re-running the sweep on `develop` showed FOURTEEN uncovered, not
// twelve: making `WorkerDetail` a record surfaced two of its own children. A component becoming a record
// makes the loader responsible for what IT reaches, so the frontier moves down a level rather than
// disappearing — and asserting closure without re-measuring is how that went unnoticed.
//
// It is not unbounded. The descent from those two terminates at three files, all in `planner/fleet/`:
// `WorkerModals` and `WorkerDetailPlaceholder` (reached by `fleet-worker-detail`) and `WorkerDetailModal`
// (reached by `WorkerModals`). Everything they import beyond that is already a record or already
// registered — which is why this closes it rather than moving it again.
//
// Same `provides` recipe as #4227 → #4238: no existing record is edited, the records reference each other
// by the specifier the live source already uses, and the registered module stays the fallback. No
// `graphPlatform.ts` here — `fleet/graphPlatform.ts` already registers `WorkerModals` and
// `WorkerDetailPlaceholder` (added in #4238 when `WorkerDetail` was vendored), and `platformBoundary`
// names anything else that is missing.
//
// THE SOURCE FILES STAY. Record and `.tsx` coexist, held identical by the record↔file parity guard —
// which since #4235 covers every record with a resolvable `src`, so these are guarded on creation with no
// catalogue entry needed.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "src-tauri/data/components/app/features/planner/fleet");
fs.mkdirSync(OUT, { recursive: true });

/** `[file under fleet/, id, display name, role, what]`. */
const RECORDS = [
  ["WorkerModals.tsx", "fleet-worker-modals", "WorkerModals", "composite", "Fleet → the worker detail's modals"],
  ["WorkerDetailModal.tsx", "fleet-worker-detail-modal", "WorkerDetailModal", "composite", "Fleet → the worker detail modal frame"],
  ["WorkerDetailPlaceholder.tsx", "fleet-worker-placeholder", "WorkerDetailPlaceholder", "primitive", "Fleet → the worker detail's empty state"],
];

/** Resolve one relative specifier against the importing file's directory → `@/<path under src>`. Records
 *  carry absolute specifiers; `platformBoundary` rejects relative ones since #4232. */
function absolutize(spec, fromRel) {
  const abs = path.resolve(path.dirname(path.join(SRC, fromRel)), spec);
  return "@/" + path.relative(SRC, abs).split(path.sep).join("/");
}

const HEADER = (what, provides) =>
  `// ${what}, AS GRAPH SOURCE (#4245, epic #3604) — the last three the frontier sweep named. Its\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS source\n` +
  `// wherever a graph component imports that specifier, with the registered module as the fallback.\n` +
  `// Transcribed from the live feature file; the CSS import is dropped (the host owns the stylesheet)\n` +
  `// and specifiers are absolute. Behaviour runs here.\n`;

for (const [file, id, name, role, what] of RECORDS) {
  const relPath = `features/planner/fleet/${file}`;
  const provides = "@/" + relPath.replace(/\.tsx$/, "");
  let code = fs.readFileSync(path.join(SRC, relPath), "utf8");
  // Both quote styles, and the tail swallows a trailing comment — the two shapes #4235 and #4238 each
  // lost time to. A `.css` side-effect import has no `from`, so `platformBoundary`'s scanner cannot see a
  // leftover; only the browser check can.
  code = code.replace(/^import ["'][^"']+\.css["'];[^\n]*\r?\n/gm, "");
  // Matched on `from <quote>…<quote>` ANYWHERE, not anchored to a line starting with `import`: a braced
  // import spanning lines puts its `from` on a line beginning with `}`.
  code = code.replace(
    /(\bfrom\s*)["'](\.[^"']*)["']/g,
    (_m, head, spec) => `${head}"${absolutize(spec, relPath)}"`,
  );
  const rec = {
    id, name,
    kitId: "base-studio-code",
    role,
    provides,
    srcText: HEADER(what, provides) + code,
    src: `src/${relPath}`,
    folder: "features/planner/fleet",
  };
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${id}.json  (${rec.srcText.length} chars)  provides ${provides}`);
  const rel = rec.srcText.match(/(?:from|import|export [^;]*from) ["']\.\.?\/[^"']+["']/g);
  if (rel) console.log(`  WARN ${id}: leftover relative import(s): ${[...new Set(rel)].join(", ")}`);
  const css = rec.srcText.match(/^import ["'][^"']+\.css["'];/gm);
  if (css) console.log(`  WARN ${id}: leftover CSS import: ${css.join(", ")}`);
}
