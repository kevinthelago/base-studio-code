// One-off generator (#4185, epic #3604) — author the Glance workspace + the 8 components it composes AS
// GRAPH SOURCE, with the import rewrites the runtime loader needs. Mirrors the prior generators.
//
// Glance was assessed as a POOR FIT for migration ("bespoke 732-line orchestrator") and that call was
// reversed: the objection was size, not shape. The page composes components and keeps its behaviour in
// hooks + `lib/`, which is the same shape as the seven pages already migrated.
//
// ONE DELIBERATE DIFFERENCE from its siblings: `SRC` resolves inside THIS repo (`../src`), not `../../src`.
// The others read the MAIN tree so a worktree agent transcribes the canonical copy — but that means running
// one from a worktree silently reads a DIFFERENT develop than the one you are editing, which is exactly how
// a record drifts from its file. Read the tree you are in.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../src/features/glance");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/glance");
fs.mkdirSync(OUT, { recursive: true });

/** Sibling component → its graph id. The page reaches 3 directly; the rest arrive through those, and the
 *  loader vendors transitively, so every one of them must be a record. */
const SIB = {
  "./GlanceCanvas": "glance-canvas",
  "./GlanceChatDock": "glance-chat-dock",
  "./GlanceInspector": "glance-inspector",
  "./GlanceNode": "glance-node",
  "./GlancePreviewMorph": "glance-preview-morph",
  "./GlanceStreamMorph": "glance-stream-morph",
  "./GlancePlanScreen": "glance-plan-screen",
  "./GlanceSessionLog": "glance-session-log",
};

/** Feature-internal NON-component modules stay CODE, registered by `glance/graphPlatform.ts`, so their
 *  relative specifiers become the absolute ones the registry is keyed by. */
function rewrite(code) {
  let c = code;
  for (const [rel, id] of Object.entries(SIB)) c = c.split(`from "${rel}"`).join(`from "@/components/${id}"`);
  return c
    .replace(/from "\.\/lib\//g, 'from "@/features/glance/lib/')
    .replace(/from "\.\/usePreviewReview"/g, 'from "@/features/glance/usePreviewReview"')
    .replace(/from "\.\/glanceNodeMotion"/g, 'from "@/features/glance/glanceNodeMotion"');
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#4185, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the glance lib/hook surface via the glance graph-platform,\n` +
  `// and the sibling components as @/components/* graph records). Behaviour runs here.\n`;

function srcOf(file, what) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  // The CSS side-effect import the loader cannot resolve — the host imports the stylesheet instead.
  code = code.replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, "");
  return HEADER(what) + rewrite(code);
}

const RECORDS = [
  { id: "glancepage", name: "GlanceWorkspace", role: "page", file: "GlanceWorkspace.tsx", what: "Glance → the cockpit workspace (#2206)" },
  { id: "glance-canvas", name: "GlanceCanvas", role: "composite", file: "GlanceCanvas.tsx", what: "Glance → the project-network canvas" },
  { id: "glance-inspector", name: "GlanceInspector", role: "composite", file: "GlanceInspector.tsx", what: "Glance → the node inspector panel" },
  { id: "glance-stream-morph", name: "GlanceStreamMorph", role: "composite", file: "GlanceStreamMorph.tsx", what: "Glance → the stream morph view" },
  { id: "glance-preview-morph", name: "GlancePreviewMorph", role: "composite", file: "GlancePreviewMorph.tsx", what: "Glance → the preview morph view" },
  { id: "glance-node", name: "GlanceNode", role: "composite", file: "GlanceNode.tsx", what: "Glance → a project/library graph node" },
  { id: "glance-plan-screen", name: "GlancePlanScreen", role: "composite", file: "GlancePlanScreen.tsx", what: "Glance → the dock's plan tab" },
  { id: "glance-chat-dock", name: "GlanceChatDock", role: "composite", file: "GlanceChatDock.tsx", what: "Glance → the chat/session dock" },
  { id: "glance-session-log", name: "GlanceSessionLog", role: "composite", file: "GlanceSessionLog.tsx", what: "Glance → the session log tail" },
];

for (const r of RECORDS) {
  const rec = {
    id: r.id,
    name: r.name,
    kitId: "base-studio-code",
    role: r.role,
    srcText: srcOf(r.file, r.what),
    src: `src/features/glance/${r.file}`,
    folder: "features/glance",
  };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${r.id}.json  (${rec.srcText.length} chars)`);
}

// Sanity: no leftover relative specifier the loader cannot resolve (incl. the `export … from` form, which
// esbuild compiles to the same require — the gap that shipped projectspage broken, #3874).
let bad = 0;
for (const r of RECORDS) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${r.id}.json`), "utf8"));
  const rel = j.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) {
    bad++;
    console.log(`  WARN ${r.id}: leftover relative import(s): ${[...new Set(rel)].join(", ")}`);
  }
}
console.log(bad ? `${bad} record(s) still carry a relative import` : "all records resolve absolutely");
