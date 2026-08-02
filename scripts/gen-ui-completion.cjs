// One-off generator (#4235, epic #3604) — author the EIGHT shared/ui components that records import but
// no record provides.
//
// The shared/ui-as-data batches (#3660 → #3692) landed 49 records and were recorded as complete. They were
// complete as a SET, not as a closure: a sweep of every specifier the 152 packaged records import, against
// the records that exist, turns up eight more that are actively reached — `Eyebrow` by five records,
// `InlineError` by four, `BackButton` and `CardListRow` by three each, and so on down to one.
//
// WHY IT IS NOT JUST TIDINESS. `composes` is NAME-KEYED WITHIN-KIT, so a component with no record is not an
// edge. That is exactly why regenerating `projectspage` in #4232 correctly DROPPED `Dropdown` and
// `InlineError` from its `composes`: the page really does render both, and the graph could not say so.
// Eight missing records are eight holes in the edge set the Design Studio, Glance and the doctor read.
//
// SAFE TO VENDOR: none of the eight uses `useContext`/`createContext` — checked, because that is the one
// property that makes a component unsafe as data (a fresh compile gets a different context identity).
// Hooks are fine; `Dropdown` is the largest here at 201 lines and holds five of them.
//
// THE SOURCE FILES STAY. Record and `.tsx` coexist, held identical by the record↔file parity guard.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

/** `[path under src/, id, display name, role]`. Roles are the initial value only — the metadata backfill
 *  re-derives `role` (and `composes`/`props`) from the source, as it does for every other record. */
const RECORDS = [
  ["shared/ui/typography/Eyebrow.tsx", "ui-eyebrow", "Eyebrow", "primitive"],
  ["shared/ui/feedback/InlineError.tsx", "ui-inline-error", "InlineError", "primitive"],
  ["shared/ui/controls/BackButton.tsx", "ui-back-button", "BackButton", "primitive"],
  ["shared/ui/data/CardListRow.tsx", "ui-card-list-row", "CardListRow", "primitive"],
  ["shared/ui/data/Code.tsx", "ui-code", "Code", "primitive"],
  ["shared/ui/controls/Dropdown.tsx", "ui-dropdown", "Dropdown", "primitive"],
  ["shared/ui/data/ActivityFeed.tsx", "ui-activity-feed", "ActivityFeed", "composite"],
  ["shared/ui/layouts/RailFolderRow.tsx", "ui-rail-folder-row", "RailFolderRow", "primitive"],
];

/** Resolve one relative specifier against the importing file's directory → `@/<path under src>`.
 *  `Eyebrow` imports `./Text` and `Code` imports `../typography/type`; both must land on the absolute
 *  key the registry (and any future `provides`) is stated in. Records carry absolute specifiers — a rule
 *  #4232 made enforceable by making `platformBoundary` reject relative ones. */
function absolutize(spec, fromRel) {
  const abs = path.resolve(path.dirname(path.join(SRC, fromRel)), spec);
  return "@/" + path.relative(SRC, abs).split(path.sep).join("/");
}

const HEADER = (name, provides) =>
  `// ${name}, AS GRAPH SOURCE (#4235, epic #3604) — one of the eight shared/ui components the batches\n` +
  `// #3660-#3692 left behind: reached by packaged records, provided by none. Its\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS source wherever a graph\n` +
  `// component imports that specifier (the registered module is the fallback). Transcribed verbatim; the\n` +
  `// CSS import is dropped (the host owns the stylesheet) and specifiers are absolute. Deps stay code.\n`;

for (const [relPath, id, name, role] of RECORDS) {
  const provides = "@/" + relPath.replace(/\.tsx$/, "");
  let code = fs.readFileSync(path.join(SRC, relPath), "utf8");
  // The regex tail must swallow a TRAILING COMMENT: `GraphCanvas` writes
  // `import "./graphCanvas.css"; // the shared drill transition`, and a pattern anchored at the `;`
  // leaves the statement in the record. The boundary guard cannot see it either -- a side-effect
  // import has no `from`, so its scanner skips it -- and the first thing that notices is the loader,
  // in a browser, refusing to resolve a `.css` specifier.
  code = code.replace(/^import "[^"]+\.css";[^\n]*\r?\n/gm, "");
  code = code.replace(
    /(^[ \t]*(?:import|export)[^"';]*?from\s*)"(\.[^"]*)"/gm,
    (_m, head, spec) => `${head}"${absolutize(spec, relPath)}"`,
  );
  const rec = {
    id, name,
    kitId: "base-studio-code",
    role,
    provides,
    srcText: HEADER(name, provides) + code,
    src: `src/${relPath}`,
    folder: path.posix.dirname(relPath),
  };
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${id}.json  (${rec.srcText.length} chars)  provides ${provides}`);
  const rel = rec.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) console.log(`  WARN ${id}: leftover relative import(s): ${[...new Set(rel)].join(", ")}`);
}

// ── RECONCILE the records that had DRIFTED from their files ─────────────────────────────────────────
// Found by the same sweep, and the more serious half of it. The shared/ui records were never in the
// shadow catalogue, so the record↔file parity guard (#4181) never covered them — and NINE had drifted,
// every one of them with the FILE as the newer copy:
//
//   ui-card · ui-data-table-row   the file spreads `clickable(onClick)`; the record still writes a bare
//   ui-checkbox · ui-toggle       `onClick`. That is #3775's Tier-0 accessibility work — role, tabIndex
//                                 and Enter/Space activation — reaching the file and NOT what mounts.
//   ui-graph-canvas               the file uses `<div ref={setWorld}>` "because setWorld needs a REAL
//                                 DOM ref" (#4140); the record still renders a `<Box>` and never binds
//                                 setWorld at all.
//   ui-avatar                     the file uses `var(--on-accent)`; the record hardcodes `#1a120a`.
//   ui-pane · ui-screen           the file grew a `PageBoundary`, tear-off drag handlers and reworked
//   ui-tab-bar                    prop interfaces the record never got.
//
// Re-transcribed from the file, keeping each record's own id/name/role/provides/folder and its ORIGINAL
// provenance header — the header names the batch that authored it, which stays true.
//
// `ui-charts` is NOT here: it is three CTX-free source files concatenated behind one `provides`
// (`Charts.tsx` + `primitives.tsx` + `telemetry.tsx`, #3690), so a one-file comparison can never hold. It
// is the one KNOWN_STALE entry in the extended parity guard, with that as its reason.
const RECONCILE = [
  "ui-avatar", "ui-card", "ui-checkbox", "ui-data-table-row",
  "ui-graph-canvas", "ui-toggle", "ui-pane", "ui-screen", "ui-tab-bar",
];

console.log("");
for (const id of RECONCILE) {
  const file = path.join(OUT, `${id}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const relPath = rec.src.replace(/^src\//, "");
  // Keep the record's own header — the run of comment lines it opens with, which names the batch that
  // authored it. Everything after is re-transcribed.
  const lines = rec.srcText.replace(/\r/g, "").split("\n");
  let end = 0;
  while (end < lines.length && /^\s*\/\//.test(lines[end])) end++;
  const header = lines.slice(0, end).join("\n");

  let code = fs.readFileSync(path.join(SRC, relPath), "utf8");
  // The regex tail must swallow a TRAILING COMMENT: `GraphCanvas` writes
  // `import "./graphCanvas.css"; // the shared drill transition`, and a pattern anchored at the `;`
  // leaves the statement in the record. The boundary guard cannot see it either -- a side-effect
  // import has no `from`, so its scanner skips it -- and the first thing that notices is the loader,
  // in a browser, refusing to resolve a `.css` specifier.
  code = code.replace(/^import "[^"]+\.css";[^\n]*\r?\n/gm, "");
  code = code.replace(
    /(^[ \t]*(?:import|export)[^"';]*?from\s*)"(\.[^"]*)"/gm,
    (_m, head, spec) => `${head}"${absolutize(spec, relPath)}"`,
  );
  const before = rec.srcText.length;
  rec.srcText = `${header}\n// RECONCILED #4235: re-transcribed from the file, which had moved on without it.\n${code}`;
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  console.log(`reconciled ${id}.json  (${before} → ${rec.srcText.length} chars)`);
}

console.log("\n— shadow catalogue glob entries —");
for (const [relPath] of RECORDS) console.log(`    "/src/${relPath}",`);
