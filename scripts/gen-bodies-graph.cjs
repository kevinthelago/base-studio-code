// One-off generator (#4230, epic #3604) — author the planner's stage bodies AS GRAPH SOURCE.
//
// #4227 migrated the focused project pane. Its stage-body switch (`plan-pane-bodies`) reaches ELEVEN
// stage bodies as registered code modules, and those reach twelve more. This takes the whole directory.
//
// EVERY FILE HERE IS REACHED. Checked before scoping, because #4227 and #4219 each turned up a component
// that renders nowhere and left it out. This directory is clean: 11 bodies hang directly off the graph
// record, the other 12 hang off those. The four `.ts` files stay code — `bodyStyles`, `dataCollection`,
// `focusedHandlers`, `sourceConnection` are style constants, pure derivations and handler types.
//
// SAME RECIPE AS #4227: `provides`, not a `@/components/<id>` sibling rewrite. `resolveGraphSource` runs
// before the registry (#3660), so no existing record is edited — `plan-pane-bodies` keeps importing the
// specifiers it imports today — the bodies reference each other the same way, and the registered module
// stays as the fallback. This INVERTS part of #4227's platform surface: the eleven registrations
// `pane/graphPlatform.ts` makes become graph-first, demoted to fallback. That is the intended direction
// and needs no edit; `provides` wins over the registry by design.
//
// TYPE-ONLY IMPORTS ARE REGISTERED TOO, deliberately — see gen-pane-graph.cjs (#4227) for why: the
// `platformBoundary` guard counts every specifier, and a static check more permissive than the runtime it
// stands for is the exact defect #4188 and #4224 each removed from that test.
//
// THE SOURCE FILES STAY. Record and `.tsx` coexist, held identical by the record↔file parity guard.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../src/features/planner/bodies");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/planner/bodies");
const PLATFORM = path.resolve(__dirname, "../src/features/planner/bodies/graphPlatform.ts");
fs.mkdirSync(OUT, { recursive: true });

/** `[file, id, display name, role]`. The name is the file's PRIMARY export, which is often not the file
 *  name — `ReposDeployView` exports `DeploymentBody`, `FocusedPermissionsBody` exports
 *  `CoordinationControls` — so the studio lists what the record actually is. */
const RECORDS = [
  ["DiscoveryBody", "plan-body-discovery", "DiscoveryBody", "composite", "the Discovery stage body"],
  ["MarketBody", "plan-body-market", "MarketBody", "composite", "the Market stage body"],
  ["TransformationsBody", "plan-body-transformations", "TransformationsBody", "composite", "the Transformations stage body"],
  ["FocusedAutomationsBody", "plan-body-automations", "AutomationsBody", "composite", "the Automations stage body"],
  ["FocusedSkillsBody", "plan-body-skills", "SkillsBody", "composite", "the Skills stage body"],
  ["McpsBody", "plan-body-mcps", "McpsBody", "composite", "the MCP servers stage body"],
  ["FocusedFeaturesBody", "plan-body-features", "FeaturesBody", "composite", "the Features stage body"],
  ["FileIntakePane", "plan-body-file-intake", "FileIntakePane", "composite", "the design-file intake pane"],
  ["ReposDeployView", "plan-body-deployment", "DeploymentBody", "composite", "the Deployment stage body"],
  ["DeployView", "plan-body-deploy-card", "RepoDeployCard", "composite", "a repo's deploy card"],
  ["deployShipSections", "plan-body-deploy-ship", "ServiceDeploySections", "composite", "a service's ship sections"],
  ["deployTargetSection", "plan-body-deploy-target", "ServiceTargetEditor", "composite", "a service's target editor"],
  ["deployPrimitives", "plan-body-deploy-primitives", "DeployPrimitives", "primitive", "the deploy card's leaf controls"],
  ["FocusedSourceBody", "plan-body-source", "SourceBody", "composite", "the Source stage body"],
  ["ScanViews", "plan-body-scan-views", "ScanViews", "composite", "the source scan views"],
  ["connectorForm", "plan-body-connector-form", "SourceCard", "composite", "the connector form"],
  ["StreamsBody", "plan-body-streams", "StreamsBody", "composite", "the Streams stage body"],
  ["FocusedPermissionsBody", "plan-body-permissions", "CoordinationControls", "composite", "the Streams stage's coordination controls"],
  ["FocusedPlanBody", "plan-body-plan", "PlanBody", "composite", "the plan body"],
  ["StreamFocusCards", "plan-body-stream-cards", "StreamFocusCards", "composite", "the per-stream focus cards"],
  ["SharedDependencies", "plan-body-shared-deps", "StreamSharedDeps", "composite", "a stream's shared dependencies"],
  ["collapsibleCard", "plan-body-collapsible-card", "CollapsibleCard", "primitive", "the collapsible card"],
  ["bodyPrimitives", "plan-body-primitives", "BodyPrimitives", "primitive", "the stage bodies' leaf primitives"],
];

/** `./X` → `@/features/planner/bodies/X`, `../<dir>/X` → `@/features/planner/<dir>/X`. Every specifier is
 *  absolute afterwards, which is what the loader's registry is keyed by. */
function rewrite(code) {
  return code
    .replace(/(from\s*)"\.\.\/([A-Za-z][A-Za-z0-9]*)\//g, '$1"@/features/planner/$2/')
    .replace(/(from\s*)"\.\/([A-Za-z][A-Za-z0-9]*)"/g, '$1"@/features/planner/bodies/$2"');
}

const HEADER = (what, provides) =>
  `// Planner → ${what}, AS GRAPH SOURCE (#4230, epic #3604). Transcribed from the live feature file. Its\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS source wherever a graph\n` +
  `// component imports that specifier — so the stage-body switch reaches it from the graph without\n` +
  `// knowing it, and the registered module stays as the fallback. Behaviour runs here.\n`;

const written = [];
for (const [file, id, name, role, what] of RECORDS) {
  const provides = `@/features/planner/bodies/${file}`;
  let code = fs.readFileSync(path.join(SRC, `${file}.tsx`), "utf8");
  code = code.replace(/^import "[^"]+\.css";[ \t]*\r?\n/gm, ""); // the host owns the stylesheet
  const srcText = HEADER(what, provides) + rewrite(code);
  const rec = {
    id, name,
    kitId: "base-studio-code",
    role,
    provides,
    srcText,
    src: `src/features/planner/bodies/${file}.tsx`,
    folder: "features/planner/bodies",
  };
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(rec, null, 2) + "\n");
  written.push(rec);
  console.log(`wrote ${id}.json  (${srcText.length} chars)  provides ${provides}`);
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
/** A readable identifier from the last path segment, so the emitted file is not `Mod1..Mod40`. */
const ident = (s) => {
  const leaf = s.split("/").pop();
  return leaf.charAt(0).toUpperCase() + leaf.slice(1).replace(/[^A-Za-z0-9]/g, "");
};
const lines = [
  "// The stage bodies' graph-platform surface (#4230, epic #3604) — AUTO-GENERATED by",
  "// scripts/gen-bodies-graph.cjs. DO NOT EDIT BY HAND: it is derived from the specifiers the bodies'",
  "// records actually carry, so it cannot drift from them. Re-run the generator after changing a body.",
  "//",
  "// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545).",
  "//",
  "// The bodies' OWN modules are registered too: each is `provides`-resolved from the graph first, and the",
  "// module behind it is the fallback for a record that will not load. That is also why the eleven",
  "// registrations `pane/graphPlatform.ts` (#4227) makes for these same specifiers are not a conflict —",
  "// `provides` wins over the registry by design, so those become the fallback rather than the route.",
  'import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";',
  ...sorted.map((s) => `import * as ${ident(s)} from "${s}";`),
  "",
  "let done = false;",
  "",
  "/** Register the stage bodies' injected graph-platform modules. Idempotent. */",
  "export function registerBodiesPlatform(): void {",
  "  if (done) return;",
  "  done = true;",
  ...sorted.map((s) => `  registerAppModule("${s}", ${ident(s)});`),
  "}",
  "",
].join("\n");
fs.writeFileSync(PLATFORM, lines);
console.log(`\nwrote graphPlatform.ts  (${sorted.length} registrations)`);

let bad = 0;
for (const [, id] of RECORDS) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${id}.json`), "utf8"));
  const rel = j.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) { bad++; console.log(`  WARN ${id}: leftover relative import(s): ${[...new Set(rel)].join(", ")}`); }
}
console.log(bad ? `${bad} record(s) still carry a relative import` : "all records resolve absolutely");

// The shadow-catalogue lines, so the 23 entries are not hand-typed (and cannot fall out of sync with the ids).
console.log("\n— shadow catalogue entries —");
for (const [file, id] of RECORDS) {
  console.log(`      { recordId: "${id}", file: "/src/features/planner/bodies/${file}.tsx" },`);
}
