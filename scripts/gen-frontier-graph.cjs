// One-off generator (#4238, epic #3604) — the last reachable components that were not records.
//
// A sweep of every specifier the 160 packaged records import, against the records that exist (by `src`
// AND by `provides`), left 21 reachable-but-uncovered components. Ten of those are deliberate — the six
// console pane views and `TerminalSlot` (#4186 kept everything that DOES something as modules), the
// algorithms `VizPanel` (#4219, it runs the instrumented executor), `renderProfiler` (an instrument), and
// `FleetGraphHost` (a host authored as graph source would be a record that mounts a record).
//
// Of the eleven left, NINE are here. Two more are excluded on inspection, and the reasons are the point:
//
//   blueprintIcons.tsx   FOUR LINES, and all of them are `export { Ic, ICONS } from "@/shared/ui/icons"`
//                        — a compatibility shim from #1752. A record whose entire body is a re-export
//                        adds an indirection to the graph with no layout in it.
//   stageScreens.tsx     a REGISTRY with load-bearing module-init side effects (`import
//                        "./renderers/htmlRenderer"` and two more, then `registerStageScreen` calls at
//                        load). Vendoring it would run those registrations a SECOND time from a compiled
//                        copy, against a `PreviewPaneShell` of different identity than the code copy's.
//                        Plumbing, not arrangement — and the one shape where a second copy actively hurts.
//
// SAME `provides` RECIPE as #4227/#4230/#4232/#4235: no existing record is edited, the records reference
// each other by the specifier the live source already uses, and the registered module stays the fallback.
// No `graphPlatform.ts` is emitted here — each of these was already registered by whichever platform its
// CONSUMER needed, so the specifiers resolve today; `platformBoundary` names anything that does not.
//
// `PageBoundary` is a CLASS (an error boundary has to be). That is fine for a `provides` record: it is
// vendored as a module and `require` hands back its namespace, so `pickComponent`'s
// default-else-first-exported-function rule never runs on it.
//
// THE SOURCE FILES STAY. Record and `.tsx` coexist, held identical by the record↔file parity guard —
// which since #4235 covers every record with a resolvable `src`, so these are guarded the moment they
// exist, with no catalogue entry needed.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "src-tauri/data/components/app");

/** `[path under src/, id, display name, role, what]`. */
const RECORDS = [
  ["features/planner/blueprints/BlueprintModals.tsx", "plan-blueprint-modals", "StageSummary", "composite", "Projects → the blueprint stage summary"],
  ["features/planner/blueprints/BlueprintUpdateModal.tsx", "plan-blueprint-update-modal", "BlueprintUpdateModal", "composite", "Planning → the blueprint update modal"],
  ["features/planner/preview/PreviewPaneShell.tsx", "plan-preview-shell", "PreviewPaneShell", "composite", "Planning → the streaming preview pane"],
  ["features/planner/preview/StageScreenFrame.tsx", "plan-stage-screen-frame", "StageScreenFrame", "composite", "Planning → a stage second-screen frame"],
  ["features/planner/relationship/RelationshipGraphView.tsx", "plan-relationship-graph", "RelationshipGraphView", "composite", "Planning → the relationship graph"],
  ["features/planner/relationship/RelationshipInspector.tsx", "plan-relationship-inspector", "RelationshipInspector", "composite", "Planning → the relationship inspector"],
  ["features/planner/fleet/WorkerDetail.tsx", "fleet-worker-detail", "WorkerDetail", "composite", "Fleet → the worker detail panel"],
  ["features/mcp/shared.tsx", "mcp-shared", "McpShared", "composite", "MCP → its shared rows, cards and editors"],
  ["shared/ui/layouts/PageBoundary.tsx", "ui-page-boundary", "PageBoundary", "layout", "the per-page error boundary"],
];

/** Resolve one relative specifier against the importing file's directory → `@/<path under src>`. Records
 *  carry absolute specifiers; `platformBoundary` rejects relative ones since #4232. */
function absolutize(spec, fromRel) {
  const abs = path.resolve(path.dirname(path.join(SRC, fromRel)), spec);
  return "@/" + path.relative(SRC, abs).split(path.sep).join("/");
}

const HEADER = (what, provides) =>
  `// ${what}, AS GRAPH SOURCE (#4238, epic #3604) — one of the last reachable components that was not a\n` +
  `// record. Its \`provides: "${provides}"\` makes the runtime loader vendor THIS\n` +
  `// source wherever a graph component imports that specifier, with the registered module as the\n` +
  `// fallback. Transcribed from the live feature file; the CSS import is dropped (the host owns the\n` +
  `// stylesheet) and specifiers are absolute. Behaviour runs here.\n`;

for (const [relPath, id, name, role, what] of RECORDS) {
  const provides = "@/" + relPath.replace(/\.tsx$/, "");
  let code = fs.readFileSync(path.join(SRC, relPath), "utf8");
  // The tail must swallow a TRAILING COMMENT — `import "./x.css"; // …` survives a pattern anchored at
  // the `;`, and nothing static catches the leftover: a side-effect import has no `from`, so
  // `platformBoundary`'s scanner skips it. #4235 found that the hard way, in a browser.
  code = code.replace(/^import ["'][^"']+\.css["'];[^\n]*\r?\n/gm, "");
  // Matched on `from <quote>…<quote>` ANYWHERE, and on EITHER quote style. Two things this file was
  // caught by, both reported by #4232's reject-relative-specifiers guard rather than shipping quietly:
  //   · a braced import spanning lines puts its `from` on a line beginning with `}`, so a pattern
  //     anchored to a line starting with `import` misses it;
  //   · `PreviewPaneShell` is the one file in this set written with SINGLE quotes, so a double-quote-only
  //     pattern left all five of its relative specifiers in place.
  // Normalised to double quotes on the way out, which is what every other record carries.
  code = code.replace(
    /(\bfrom\s*)["'](\.[^"']*)["']/g,
    (_m, head, spec) => `${head}"${absolutize(spec, relPath)}"`,
  );
  const dir = path.join(OUT, path.posix.dirname(relPath));
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    id, name,
    kitId: "base-studio-code",
    role,
    provides,
    srcText: HEADER(what, provides) + code,
    src: `src/${relPath}`,
    folder: path.posix.dirname(relPath),
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${id}.json  (${rec.srcText.length} chars)  provides ${provides}`);
  const rel = rec.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) console.log(`  WARN ${id}: leftover relative import(s): ${[...new Set(rel)].join(", ")}`);
  const css = rec.srcText.match(/^import "[^"]+\.css";/gm);
  if (css) console.log(`  WARN ${id}: leftover CSS import: ${css.join(", ")}`);
}
