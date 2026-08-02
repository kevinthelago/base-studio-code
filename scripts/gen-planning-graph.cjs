// One-off generator (#4224, epic #3604) — author the Planning session AS GRAPH SOURCE, and DERIVE its
// graph-platform registration from what it actually imports.
//
// The Planning session is the product's flagship: a live terminal beside the focused plan pane. Its page is
// 896 lines over ~34 hooks — `usePlanningSession`, `usePlannerTerminal`, `usePlanPublish`, `usePlanGates`,
// `plannerConductor`, `planAutopilotRunner` and the rest. Those RUN the session; the graph carries how it
// is arranged. That is the same split as every page before it, just with more behaviour underneath.
//
// WHY THIS ONE EMITS ITS OWN graphPlatform.ts. Every earlier feature's registration was hand-written, which
// is fine for five specifiers and a liability at forty: the day someone adds a hook, the registration is
// where the omission hides, and the loader's error arrives at runtime. Here the registration is DERIVED
// from the records this script just wrote, so it cannot disagree with them. Same approach as
// gen-settings-graph.cjs (#3658).
//
// THE SOURCE FILES STAY. Record and `.tsx` coexist, held identical by the record↔file parity guard.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../src/features/planner/session");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/planner/session");
const PLATFORM = path.resolve(__dirname, "../src/features/planner/session/graphPlatform.ts");
fs.mkdirSync(OUT, { recursive: true });

/** Sibling component → graph id. `PublishProgressView` composes `GitHubStructureCard`; the rest are leaves. */
const SIB = {
  "./PlanningHeader": "planning-header",
  "./PlanningNotices": "planning-notices",
  "./PlanningDialogs": "planning-dialogs",
  "./PublishProgressView": "planning-publish-progress",
  "./InjectionGateBanner": "planning-injection-gate",
  "./GitHubStructureCard": "planning-github-structure",
};

/** Everything else the session reaches stays CODE at an absolute specifier the registry is keyed by:
 *  `./<hook>` → `@/features/planner/session/<hook>`, and `../<dir>/<x>` → `@/features/planner/<dir>/<x>`. */
function rewrite(code) {
  let c = code;
  for (const [rel, id] of Object.entries(SIB)) c = c.split(`from "${rel}"`).join(`from "@/components/${id}"`);
  return c
    .replace(/from "\.\.\/([A-Za-z]+)\//g, 'from "@/features/planner/$1/')
    .replace(/from "\.\/([A-Za-z][A-Za-z0-9]*)"/g, 'from "@/features/planner/session/$1"');
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#4224, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the planner session's hooks via the planning graph-platform,\n` +
  `// and the sibling views as @/components/* graph records). Behaviour runs here.\n`;

function srcOf(file, what) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  code = code.replace(/^import "[^"]+\.css";[ \t]*\r?\n/gm, ""); // the host owns the stylesheet
  return HEADER(what) + rewrite(code);
}

const RECORDS = [
  { id: "planningpage", name: "Planning", role: "page", file: "Planning.tsx", what: "Planner → the planning session (terminal + focused plan pane)" },
  { id: "planning-header", name: "PlanningHeader", role: "composite", file: "PlanningHeader.tsx", what: "Planning → the session header" },
  { id: "planning-notices", name: "PlanningNotices", role: "composite", file: "PlanningNotices.tsx", what: "Planning → the notice stack" },
  { id: "planning-dialogs", name: "PlanningDialogs", role: "composite", file: "PlanningDialogs.tsx", what: "Planning → the session's modals" },
  { id: "planning-publish-progress", name: "PublishProgressView", role: "composite", file: "PublishProgressView.tsx", what: "Planning → the publish progress view" },
  { id: "planning-injection-gate", name: "InjectionGateBanner", role: "composite", file: "InjectionGateBanner.tsx", what: "Planning → the injection-gate banner" },
  { id: "planning-github-structure", name: "GitHubStructureCard", role: "composite", file: "GitHubStructureCard.tsx", what: "Planning → the GitHub structure card" },
];

const written = [];
for (const r of RECORDS) {
  const srcText = srcOf(r.file, r.what);
  const rec = {
    id: r.id,
    name: r.name,
    kitId: "base-studio-code",
    role: r.role,
    srcText,
    src: `src/features/planner/session/${r.file}`,
    folder: "features/planner/session",
  };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  written.push(rec);
  console.log(`wrote ${r.id}.json  (${srcText.length} chars)`);
}

// ── The DERIVED registration ────────────────────────────────────────────────────────────────────────
// Every `@/features/planner/...` specifier the records import, minus the graph siblings. An identifier is
// derived from the last path segment so the emitted file is readable rather than `Mod1..Mod40`.
const specs = new Set();
for (const rec of written) {
  for (const m of rec.srcText.matchAll(/^[ \t]*(?:import|export)\s+[^"';]*?\s*from\s*["']([^"']+)["']/gm)) {
    if (m[1].startsWith("@/features/planner/")) specs.add(m[1]);
  }
}
const sorted = [...specs].sort();
const ident = (s) => {
  const leaf = s.split("/").pop();
  return leaf.charAt(0).toUpperCase() + leaf.slice(1).replace(/[^A-Za-z0-9]/g, "");
};
const lines = [
  "// The planning session's graph-platform surface (#4224, epic #3604) — AUTO-GENERATED by",
  "// scripts/gen-planning-graph.cjs. DO NOT EDIT BY HAND: it is derived from what the `planningpage`",
  "// records actually import, so it cannot drift from them. Re-run the generator after changing the page.",
  "//",
  "// These are the modules that RUN the session — the terminal, the tag stream, the gates, the publish",
  "// pipeline, the autopilot, the conductor. The graph carries the arrangement; every one of these stays",
  "// code, registered here so the loaded page's `require()` reaches the live module.",
  'import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";',
  ...sorted.map((s) => `import * as ${ident(s)} from "${s}";`),
  "",
  "let done = false;",
  "",
  "/** Register the Planning session's injected graph-platform modules. Idempotent. */",
  "export function registerPlanningPlatform(): void {",
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
