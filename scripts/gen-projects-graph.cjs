// One-off generator (#4232, epic #3604) — REGENERATE the projects page with absolute specifiers, and
// author the planner list's components as graph source.
//
// TWO JOBS, ONE CAUSE.
//
// 1. `projectspage` was the only record in the whole library carrying RELATIVE imports (`./ProjectCard`,
//    `./published/DeleteProjectModal`, …) — it is the one page authored by hand rather than by a
//    generator (#3874). `list/graphPlatform.ts` compensated by registering BOTH spellings of every
//    sibling, and `platformBoundary` skipped `.`-prefixed specifiers, so those ten were the only
//    first-party imports in the library no guard checked. Regenerating the record absolute retires the
//    dual registration and lets the guard reject relative specifiers outright.
//
// 2. `provides` matches on the EXACT specifier a record imports. While the page said `./ProjectCard`, a
//    record carrying `provides: "@/features/planner/list/ProjectCard"` could never be reached — so job 1
//    is what makes the directory migratable by the #4227/#4230 recipe at all.
//
// SPECIFIER REWRITING IS PER-FILE, not a pattern. `list/ProjectCard.tsx` and
// `list/published/DeleteProjectModal.tsx` are at different depths, so the same `./publishedModel` means
// two different modules. Each relative specifier is resolved against ITS OWN file's directory and emitted
// as `@/<path from src>`, which is what the loader's registry is keyed by.
//
// THE TWO STRIPS ON THE PAGE ARE LOAD-BEARING (#3874). The CSS import (the loader cannot resolve CSS) and
// the VALUE re-export `export { ProjectRow } from "./published/ProjectRow"` — esbuild compiles a re-export
// to the same `require` an import produces, and `pickComponent` mounts `default ?? the first exported
// function`, which is the re-export rather than the page. `export type { GhProject }` stays: it erases.
//
// THE SOURCE FILES STAY. Record and `.tsx` coexist, held identical by the record↔file parity guard.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "src-tauri/data/components/app/features/planner");
const PLATFORM = path.join(SRC, "features/planner/list/graphPlatform.ts");
fs.mkdirSync(path.join(OUT, "list"), { recursive: true });

/** `[relative path under src/, id, display name, role, what]`. `provides` is omitted for the page: it is
 *  mounted by id through `GraphComponent`, not vendored into another record. */
const RECORDS = [
  // The page keeps the `name`/`folder` it has carried since #3874 — `ProjectsPage`, filed under
  // `features/planner`. This regeneration is about SPECIFIERS; silently renaming the page or moving it in
  // the studio's folder tree would be a user-visible change smuggled in under a resolution fix.
  ["features/planner/list/ProjectsList.tsx", "projectspage", "ProjectsPage", "page", null, "Planner → the projects page", "features/planner"],
  ["features/planner/list/ProjectCard.tsx", "projects-card", "ProjectCard", "composite", true, "Projects → a project card"],
  ["features/planner/list/ProjectsRail.tsx", "projects-rail", "ProjectsRail", "composite", true, "Projects → the library rail"],
  ["features/planner/list/ProjectSetupPage.tsx", "projects-setup", "ProjectSetupPage", "composite", true, "Projects → the new-project setup page"],
  ["features/planner/list/BlueprintCard.tsx", "projects-blueprint-card", "BlueprintCard", "composite", true, "Projects → a blueprint card"],
  ["features/planner/list/CloudBlueprints.tsx", "projects-cloud-blueprints", "CloudBlueprints", "composite", true, "Projects → the cloud blueprint browser"],
  ["features/planner/list/ReopenProjectModal.tsx", "projects-reopen-modal", "ReopenProjectModal", "composite", true, "Projects → the reopen-mismatch modal"],
  ["features/planner/list/published/DeleteProjectModal.tsx", "projects-delete-modal", "DeleteProjectModal", "composite", true, "Projects → the delete-project modal"],
  // NOT `published/ProjectRow.tsx` and NOT `published/GroupHeader.tsx`. Neither is rendered anywhere:
  // `ProjectRow`'s only reference in the tree is the re-export this generator strips (plus its own test),
  // and `GroupHeader` has no importer at all. A record for a component nothing mounts is inventory, not
  // migration — the same call #4227 made for `PlanPreviewPane` and #4219 for `PersonasPanel`.
];

/** Resolve one relative specifier against the importing file's directory → `@/<path under src>`. */
function absolutize(spec, fromRel) {
  const abs = path.resolve(path.dirname(path.join(SRC, fromRel)), spec);
  return "@/" + path.relative(SRC, abs).split(path.sep).join("/");
}

function transcribe(relPath, isPage) {
  let code = fs.readFileSync(path.join(SRC, relPath), "utf8");
  code = code.replace(/^import "[^"]+\.css";[ \t]*\r?\n/gm, ""); // the host owns the stylesheet
  if (isPage) {
    // The VALUE re-export only (#3874). `export type { … } from` erases and is left alone.
    code = code.replace(/^export \{[^}]*\} from "[^"]+";[ \t]*\r?\n/gm, "");
  }
  return code.replace(
    /(^[ \t]*(?:import|export)[^"';]*?from\s*)"(\.[^"]*)"/gm,
    (_m, head, spec) => `${head}"${absolutize(spec, relPath)}"`,
  );
}

const HEADER = (what, provides) =>
  `// ${what}, AS GRAPH SOURCE (#4232, epic #3604). Transcribed from the live feature file; the CSS import\n` +
  (provides
    ? `// is dropped (the host owns it) and specifiers are absolute. Its \`provides: "${provides}"\`\n` +
      `// makes the runtime loader vendor THIS source wherever a graph component imports that specifier,\n` +
      `// with the registered module as the fallback. Behaviour runs here.\n`
    : `// is dropped (the host owns it), the VALUE re-export is stripped (it would out-rank the page in\n` +
      `// \`pickComponent\`, #3874) and every specifier is absolute — this record was the last one in the\n` +
      `// library carrying relative imports, which no guard checked. Behaviour runs here.\n`);

const written = [];
for (const [relPath, id, name, role, wantsProvides, what, folderOverride] of RECORDS) {
  const provides = wantsProvides ? "@/" + relPath.replace(/\.tsx$/, "") : undefined;
  const srcText = HEADER(what, provides) + transcribe(relPath, role === "page");
  const rec = {
    id, name,
    kitId: "base-studio-code",
    role,
    ...(provides ? { provides } : {}),
    srcText,
    src: `src/${relPath}`,
    folder: folderOverride ?? path.posix.dirname(relPath),
  };
  const file = role === "page" ? path.join(OUT, `${id}.json`) : path.join(OUT, "list", `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  written.push(rec);
  console.log(`wrote ${path.relative(ROOT, file)}  (${srcText.length} chars)${provides ? `  provides ${provides}` : "  [page]"}`);
}

// ── The DERIVED registration ────────────────────────────────────────────────────────────────────────
// Every `@/features/…` specifier the records carry. Shared and npm specifiers are the shell's
// `appModules.ts`; `platformBoundary` names any that is missing. ONE spelling now — the absolute one.
const specs = new Set();
for (const rec of written) {
  for (const m of rec.srcText.matchAll(/^[ \t]*(?:import|export)\s+[^"';]*?\s*from\s*["']([^"']+)["']/gm)) {
    if (m[1].startsWith("@/features/")) specs.add(m[1]);
  }
}
const sorted = [...specs].sort();
const ident = (s) => {
  const leaf = s.split("/").pop();
  return leaf.charAt(0).toUpperCase() + leaf.slice(1).replace(/[^A-Za-z0-9]/g, "");
};
const lines = [
  "// The projects page's graph-platform surface (#3874, regenerated #4232, epic #3604) — AUTO-GENERATED",
  "// by scripts/gen-projects-graph.cjs. DO NOT EDIT BY HAND: it is derived from the specifiers the",
  "// `projectspage` records actually carry, so it cannot drift from them.",
  "//",
  "// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545).",
  "//",
  "// ONE SPELLING PER MODULE NOW. This file used to register each sibling twice — the relative `./X` the",
  "// hand-authored page was transcribed with, and the absolute `@/features/planner/list/X` — because the",
  "// record could carry either. #4232 regenerated the page absolute, so the relative half is gone and",
  "// `platformBoundary` rejects a relative specifier in a record outright.",
  "//",
  "// The list's OWN components are registered too: each is `provides`-resolved from the graph first, and",
  "// the module behind it is the fallback for a record that will not load.",
  'import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";',
  ...sorted.map((s) => `import * as ${ident(s)} from "${s}";`),
  "",
  "let done = false;",
  "",
  "/** Register the projects page's injected graph-platform modules. Idempotent. */",
  "export function registerProjectsPlatform(): void {",
  "  if (done) return;",
  "  done = true;",
  ...sorted.map((s) => `  registerAppModule("${s}", ${ident(s)});`),
  "}",
  "",
].join("\n");
fs.writeFileSync(PLATFORM, lines);
console.log(`\nwrote graphPlatform.ts  (${sorted.length} registrations)`);

let bad = 0;
for (const rec of written) {
  const rel = rec.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) { bad++; console.log(`  WARN ${rec.id}: leftover relative import(s): ${[...new Set(rel)].join(", ")}`); }
}
console.log(bad ? `${bad} record(s) still carry a relative import` : "all records resolve absolutely");

console.log("\n— shadow catalogue entries —");
for (const [relPath, id] of RECORDS) console.log(`      { recordId: "${id}", file: "/src/${relPath}" },`);
