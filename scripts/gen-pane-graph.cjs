// One-off generator (#4227, epic #3604) — author the focused project pane AS GRAPH SOURCE, and DERIVE its
// graph-platform registration from the value imports the records actually carry.
//
// The pane is the right half of the planning page: the stepper, the stage header + gate pill, the stage
// body, the footer advance bar. #4224 moved the session SHELL into the graph; the pane it composes was
// still a registered code module. This moves the pane too.
//
// RESOLUTION IS `provides`, NOT A SIBLING REWRITE. Each record carries `provides:
// "@/features/planner/pane/<X>"`, and `resolveGraphSource` is consulted BEFORE the registry (#3660) — so
// the `planningpage` record needs no edit at all (it keeps importing the specifier it imports today), the
// records reference EACH OTHER by that same specifier, and the registered code stays as the fallback.
// It also means the file consumers that are not graph components — `bodies/*` importing
// `focusedPrimitives`, `list/BlueprintCard` importing `PlanGateRow` — keep resolving to the file.
//
// WHY THIS EMITS ITS OWN graphPlatform.ts. Same reason as gen-planning-graph.cjs (#4224): the registration
// is derived from what the records import, so it cannot disagree with them. Here it matters more than
// usual, because vendoring the pane into `planningpage` makes the loader responsible for resolving
// EVERY specifier the pane reaches — the eleven stage bodies, the preview chain, the blueprint catalogue —
// none of which the loader had to see while the pane was a code module Vite had already bundled.
//
// TYPE-ONLY IMPORTS ARE REGISTERED TOO, deliberately. esbuild elides `import type { X }` and
// `import { type X }`, so in principle the loader never asks for them and a first cut of this script
// skipped them. `platformBoundary` disagreed — its scanner counts every specifier — and the guard is the
// one to trust: a static check that is MORE permissive than the runtime it stands for is the exact defect
// #4188 and #4224 each removed from this same test. Two registrations of eager weight is a cheap price for
// a guard that never has to model TypeScript's elision rules.
//
// THE SOURCE FILES STAY. Record and `.tsx` coexist, held identical by the record↔file parity guard.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../src/features/planner/pane");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/planner/pane");
const PLATFORM = path.resolve(__dirname, "../src/features/planner/pane/graphPlatform.ts");
fs.mkdirSync(OUT, { recursive: true });

const RECORDS = [
  { id: "plan-pane", name: "ProjectPane", file: "ProjectPane.tsx", what: "Planning → the focused project pane (the plan half of the session)" },
  { id: "plan-pane-shell", name: "FocusedShell", file: "FocusedShell.tsx", what: "Project pane → the stepper, stage header, lock banner and footer advance bar" },
  { id: "plan-pane-bodies", name: "FocusedStageBody", file: "FocusedBodies.tsx", what: "Project pane → the stage-body switch" },
  // NOT `PlanPreviewPane.tsx`. It is the SUPERSEDED predecessor of `preview/PreviewPaneShell` — nothing
  // mounts it, and its only two importers are its own test and `claudeDesignBrief.test`. A record for a
  // component that renders nowhere is inventory, not migration; that is the same call #4219 made for
  // `PersonasPanel`. The file stays where it is.
  { id: "plan-pane-stage-bar", name: "PlanStageBar", file: "PlanStageBar.tsx", what: "Project pane → the stage bar and gate row" },
  { id: "plan-pane-rail", name: "ProgressionRail", file: "ProgressionRail.tsx", what: "Project pane → the progression rail" },
  { id: "plan-pane-mcp-modal", name: "McpDownloadModal", file: "McpDownloadModal.tsx", what: "Project pane → the MCP download modal" },
  { id: "plan-pane-primitives", name: "FocusedPrimitives", file: "focusedPrimitives.tsx", role: "primitive", what: "Project pane → its leaf primitives (KindDot · Tile · RoleChip · Seg)" },
];

/** `./X` → `@/features/planner/pane/X`, `../<dir>/X` → `@/features/planner/<dir>/X`. Every specifier the
 *  records carry is absolute afterwards, which is what the loader's registry is keyed by. */
function rewrite(code) {
  return code
    .replace(/(from\s*)"\.\.\/([A-Za-z][A-Za-z0-9]*)\//g, '$1"@/features/planner/$2/')
    .replace(/(from\s*)"\.\/([A-Za-z][A-Za-z0-9]*)"/g, '$1"@/features/planner/pane/$2"');
}

const HEADER = (what, provides) =>
  `// ${what}, AS GRAPH SOURCE (#4227, epic #3604). Transcribed from the live feature file. Its\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS source wherever a graph\n` +
  `// component imports that specifier — so the planning page composes the pane from the graph without\n` +
  `// knowing it, and the registered module stays as the fallback. Behaviour runs here.\n`;

function srcOf(file, what, provides) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  code = code.replace(/^import "[^"]+\.css";[ \t]*\r?\n/gm, ""); // the host owns the stylesheet
  return HEADER(what, provides) + rewrite(code);
}

const written = [];
for (const r of RECORDS) {
  const provides = `@/features/planner/pane/${r.file.replace(/\.tsx$/, "")}`;
  const srcText = srcOf(r.file, r.what, provides);
  const rec = {
    id: r.id,
    name: r.name,
    kitId: "base-studio-code",
    role: r.role ?? "composite",
    provides,
    srcText,
    src: `src/features/planner/pane/${r.file}`,
    folder: "features/planner/pane",
  };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  written.push(rec);
  console.log(`wrote ${r.id}.json  (${srcText.length} chars)  provides ${provides}`);
}

// ── The DERIVED registration ────────────────────────────────────────────────────────────────────────
// Every `@/features/…` specifier the records carry. Shared and npm specifiers are the shell's
// `appModules.ts`, not a feature's business; `platformBoundary` names any that is missing.
const specs = new Set();
for (const rec of written) {
  for (const m of rec.srcText.matchAll(/^[ \t]*(?:import|export)\s+[^"';]*?\s*from\s*["']([^"']+)["']/gm)) {
    if (m[1].startsWith("@/features/")) specs.add(m[1]);
  }
}
const sorted = [...specs].sort();
/** A readable identifier from the last path segment, so the emitted file is not `Mod1..Mod30`. */
const ident = (s) => {
  const leaf = s.split("/").pop();
  return leaf.charAt(0).toUpperCase() + leaf.slice(1).replace(/[^A-Za-z0-9]/g, "");
};
const lines = [
  "// The project pane's graph-platform surface (#4227, epic #3604) — AUTO-GENERATED by",
  "// scripts/gen-pane-graph.cjs. DO NOT EDIT BY HAND: it is derived from the VALUE imports the pane's",
  "// records actually carry, so it cannot drift from them. Re-run the generator after changing the pane.",
  "//",
  "// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545).",
  "// It grew from the one entry #3901's survey left it with (`@/features/designs`) to the pane's whole",
  "// reachable surface, because vendoring the pane into `planningpage` makes the LOADER responsible for",
  "// every specifier it touches — the eleven stage bodies, the preview chain, the blueprint catalogue.",
  "// While the pane was a registered code module, Vite had already bundled all of that.",
  "//",
  "// The pane's OWN modules are registered too: each is `provides`-resolved from the graph first, and the",
  "// module behind it is the fallback for a record that will not load.",
  'import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";',
  ...sorted.map((s) => `import * as ${ident(s)} from "${s}";`),
  "",
  "let done = false;",
  "",
  "/** Register the project pane's injected graph-platform modules. Idempotent. */",
  "export function registerPanePlatform(): void {",
  "  if (done) return;",
  "  done = true;",
  ...sorted.map((s) => `  registerAppModule("${s}", ${ident(s)});`),
  "}",
  "",
].join("\n");
fs.writeFileSync(PLATFORM, lines);
console.log(`\nwrote graphPlatform.ts  (${sorted.length} registrations)`);

let bad = 0;
for (const r of RECORDS) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${r.id}.json`), "utf8"));
  const rel = j.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) { bad++; console.log(`  WARN ${r.id}: leftover relative import(s): ${[...new Set(rel)].join(", ")}`); }
}
console.log(bad ? `${bad} record(s) still carry a relative import` : "all records resolve absolutely");
