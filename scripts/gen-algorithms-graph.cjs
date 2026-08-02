// One-off generator (#4219, epic #3604) — author the Algorithms knowledge-graph workspace AS GRAPH SOURCE.
//
// The same shape as Sounds (#4215): a workspace the planner Screen mounts as a tab, composed of a rail, an
// inspector, a kit canvas and the librarian terminal. The graph carries the LAYOUT; the knowledge model,
// the graph hook and the visualiser stay code, registered by `algorithms/graphPlatform.ts`.
//
// THE SOURCE FILES STAY. Record and `.tsx` coexist, held identical by the record↔file parity guard
// (`src/app/runtime/graphParity.test.ts`).
//
// SRC resolves inside THIS repo (`../src`), not `../../src` — reading the main tree from a worktree
// silently transcribes a different develop than the one you are editing (see gen-glance-graph.cjs).
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../src/features/algorithms");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/algorithms");
fs.mkdirSync(OUT, { recursive: true });

/** Sibling component → graph id. The page composes all four directly; none composes another. */
const SIB = {
  "./AlgorithmsRail": "algorithms-rail",
  "./AlgorithmsInspector": "algorithms-inspector",
  "./AlgorithmsKitGraph": "algorithms-kit-graph",
  "./LibrarianTerminal": "algorithms-librarian-terminal",
};

/** The knowledge domain + the viz panel stay CODE — they read stores, drive `bsc graph`, and run the
 *  instrumented visualiser (#3215). What moves is the arrangement of them. */
function rewrite(code) {
  let c = code;
  for (const [rel, id] of Object.entries(SIB)) c = c.split(`from "${rel}"`).join(`from "@/components/${id}"`);
  return c
    .replace(/from "\.\/lib\//g, 'from "@/features/algorithms/lib/')
    .replace(/from "\.\/viz\//g, 'from "@/features/algorithms/viz/')
    .replace(/from "\.\/useKnowledgeGraph"/g, 'from "@/features/algorithms/useKnowledgeGraph"');
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#4219, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the knowledge/viz surface via the algorithms graph-platform,\n` +
  `// and the sibling views as @/components/* graph records). Behaviour runs here.\n`;

function srcOf(file, what) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  code = code.replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, ""); // the host owns the stylesheet
  return HEADER(what) + rewrite(code);
}

const RECORDS = [
  { id: "algorithmspage", name: "AlgorithmsWorkspace", role: "page", file: "AlgorithmsWorkspace.tsx", what: "Algorithms → the knowledge-graph workspace" },
  { id: "algorithms-rail", name: "AlgorithmsRail", role: "composite", file: "AlgorithmsRail.tsx", what: "Algorithms → the kit/impl rail" },
  { id: "algorithms-inspector", name: "AlgorithmsInspector", role: "composite", file: "AlgorithmsInspector.tsx", what: "Algorithms → the impl inspector" },
  { id: "algorithms-kit-graph", name: "AlgorithmsKitGraph", role: "composite", file: "AlgorithmsKitGraph.tsx", what: "Algorithms → the kit graph canvas" },
  { id: "algorithms-librarian-terminal", name: "LibrarianTerminal", role: "composite", file: "LibrarianTerminal.tsx", what: "Algorithms → the librarian session terminal" },
];

for (const r of RECORDS) {
  const rec = {
    id: r.id,
    name: r.name,
    kitId: "base-studio-code",
    role: r.role,
    srcText: srcOf(r.file, r.what),
    src: `src/features/algorithms/${r.file}`,
    folder: "features/algorithms",
  };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${r.id}.json  (${rec.srcText.length} chars)`);
}

let bad = 0;
for (const r of RECORDS) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${r.id}.json`), "utf8"));
  const rel = j.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) { bad++; console.log(`  WARN ${r.id}: leftover relative import(s): ${[...new Set(rel)].join(", ")}`); }
}
console.log(bad ? `${bad} record(s) still carry a relative import` : "all records resolve absolutely");
