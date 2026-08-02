// One-off generator (#4215, epic #3604) — author the Sounds pillar AS GRAPH SOURCE.
//
// The first surface that is NOT a rail Workspace: Sounds is mounted inside the planner Screen, so its host
// is composed by a file page rather than by `lazyWorkspaces`. Nothing else about the recipe changes — which
// is the point of doing this one first, before `personas` / `studio-sessions` / `debug` / `tunnel` /
// `algorithms` get the same treatment.
//
// THE SOURCE FILES STAY. The record and the `.tsx` coexist, held identical by the record↔file parity guard
// (`src/app/runtime/graphParity.test.ts`). Deleting them was once the plan and is not being done.
//
// SRC resolves inside THIS repo (`../src`), not `../../src` — reading the main tree from a worktree
// silently transcribes a different develop than the one you are editing (see gen-glance-graph.cjs).
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../src/features/sounds");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/sounds");
fs.mkdirSync(OUT, { recursive: true });

/** Sibling component → graph id. The page composes all three directly; none composes another. */
const SIB = {
  "./SoundsRail": "sounds-rail",
  "./SoundsInspector": "sounds-inspector",
  "./SoundsKitGraph": "sounds-kit-graph",
};

/** The pure sound domain + the kit hook stay CODE, registered by `sounds/graphPlatform.ts` — the graph
 *  carries the layout, the synth and the descriptors carry the behaviour. */
function rewrite(code) {
  let c = code;
  for (const [rel, id] of Object.entries(SIB)) c = c.split(`from "${rel}"`).join(`from "@/components/${id}"`);
  return c
    .replace(/from "\.\/lib\//g, 'from "@/features/sounds/lib/')
    .replace(/from "\.\/useSoundKits"/g, 'from "@/features/sounds/useSoundKits"')
    .replace(/from "\.\/useNotificationSounds"/g, 'from "@/features/sounds/useNotificationSounds"');
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#4215, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the sound domain via the sounds graph-platform, and the\n` +
  `// sibling views as @/components/* graph records). Behaviour runs here.\n`;

function srcOf(file, what) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  code = code.replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, ""); // the host owns the stylesheet
  return HEADER(what) + rewrite(code);
}

const RECORDS = [
  { id: "soundspage", name: "SoundsWorkspace", role: "page", file: "SoundsWorkspace.tsx", what: "Sounds → the kit workspace" },
  { id: "sounds-rail", name: "SoundsRail", role: "composite", file: "SoundsRail.tsx", what: "Sounds → the kit/sound rail" },
  { id: "sounds-inspector", name: "SoundsInspector", role: "composite", file: "SoundsInspector.tsx", what: "Sounds → the sound inspector" },
  { id: "sounds-kit-graph", name: "SoundsKitGraph", role: "composite", file: "SoundsKitGraph.tsx", what: "Sounds → the kit graph canvas" },
];

for (const r of RECORDS) {
  const rec = {
    id: r.id,
    name: r.name,
    kitId: "base-studio-code",
    role: r.role,
    srcText: srcOf(r.file, r.what),
    src: `src/features/sounds/${r.file}`,
    folder: "features/sounds",
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
