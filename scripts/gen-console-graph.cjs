// One-off generator (#4186, epic #3604) — author the Console workspace + the pane chrome it composes AS
// GRAPH SOURCE. The LAST surface, and the only one that is `app/` rather than a feature.
//
// WHAT MOVES IS THE LAYOUT. The console page is a tab strip over a CSS grid of pane cells; that is what
// becomes data. The pane VIEWS (files, branches, changes, log, telemetry, tools), the terminal slot, the
// coordinator/director/fault pumps and every `lib/` helper stay CODE, registered by `graphPlatform.ts` —
// they are the behaviour, and the split is the same one every other page made.
//
// WHY THIS IS SAFE FOR LIVE TERMINALS. `GraphComponent` re-loads whenever a record's `srcText` changes, so
// a naive migration would kill every running session on a designer edit. It cannot: #2378 put the terminals
// OUTSIDE the page. `TerminalHost` is mounted in `App.tsx` and owns exactly one `<TerminalView>` per
// `paneId`, portaling it into whichever slot claims it; the page renders only `<TerminalSlot>`. A recompiled
// Console re-creates SLOTS, not terminals.
//
// SRC resolves inside THIS repo (`../src`), not `../../src` — see gen-glance-graph.cjs for why.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../src/app/console");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/app/console");
fs.mkdirSync(OUT, { recursive: true });

/** Sibling component → graph id. Both spellings appear in the source (relative within a dir, absolute
 *  across dirs), so both are rewritten. */
const SIB = [
  ['from "./PaneAt"', "console-pane-at"],
  ['from "./consoleStates"', "console-states"],
  ['from "@/app/console/panes/PaneShell"', "console-pane-shell"],
  ['from "./PaneShell"', "console-pane-shell"],
  ['from "./PaneMenu"', "console-pane-menu"],
];

/** Feature-internal NON-component modules stay CODE — their relative specifiers become the absolute ones
 *  the registry is keyed by. `app/console` is the shell, so these are app-owned paths. */
function rewrite(code, dir) {
  let c = code;
  for (const [from, id] of SIB) c = c.split(from).join(`from "@/components/${id}"`);
  // `./x` inside app/console/ → @/app/console/x ; inside app/console/panes/ → @/app/console/panes/x
  const base = dir === "panes" ? "@/app/console/panes" : "@/app/console";
  c = c.replace(/from "\.\/([A-Za-z][A-Za-z0-9]*)"/g, `from "${base}/$1"`);
  c = c.replace(/from "\.\/lib\//g, 'from "@/app/console/lib/');
  return c;
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#4186, epic #3604). Transcribed from the live shell file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the console pane/lib/terminal surface via the console\n` +
  `// graph-platform, and the sibling pane chrome as @/components/* graph records). Behaviour runs here.\n`;

function srcOf(file, what) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  code = code.replace(/^import "[^"]+\.css";[ \t]*\r?\n/gm, ""); // the host owns the stylesheet
  return HEADER(what) + rewrite(code, file.includes("/") ? "panes" : "");
}

const RECORDS = [
  { id: "consolepage", name: "ConsoleWorkspace", role: "page", file: "index.tsx", what: "Console → the execution surface (tabs + the pane grid)" },
  { id: "console-pane-at", name: "PaneAt", role: "composite", file: "PaneAt.tsx", what: "Console → one grid cell: the pane and its view" },
  { id: "console-pane-shell", name: "PaneShell", role: "composite", file: "panes/PaneShell.tsx", what: "Console → a pane's chrome (header, view tabs, menu)" },
  { id: "console-pane-menu", name: "PaneMenu", role: "composite", file: "panes/PaneMenu.tsx", what: "Console → the pane hamburger menu" },
  { id: "console-states", name: "ConsoleStates", role: "composite", file: "consoleStates.tsx", what: "Console → the disabled/ended/dormant/completed pane states" },
];

for (const r of RECORDS) {
  const rec = {
    id: r.id,
    name: r.name,
    kitId: "base-studio-code",
    role: r.role,
    srcText: srcOf(r.file, r.what),
    src: `src/app/console/${r.file}`,
    folder: "app/console",
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
