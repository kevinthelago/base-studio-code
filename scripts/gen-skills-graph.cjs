// One-off generator (#3654) — author the Skills page + its 6 composed views AS GRAPH SOURCE. Mirrors the
// prior generators. SkillsStatus + SessionSkillsModal are barrel-only cross-feature exports (not rendered
// by the workspace) → their `export { … } from "./…"` lines are stripped so they stay CODE and pickComponent
// selects SkillsWorkspace.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../src/features/skills");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/skills");
fs.mkdirSync(OUT, { recursive: true });

const SIB = {
  "./SkillsViews": "skills-views",
  "./NewGroupDialog": "skills-new-group-dialog",
  "./SkillDrawer": "skills-drawer",
  "./SkillsDigest": "skills-digest",
  "./LessonsTab": "skills-lessons-tab",
  "./RunsTab": "skills-runs-tab",
};

function rewrite(code) {
  let c = code;
  for (const [rel, id] of Object.entries(SIB)) c = c.split(`from "${rel}"`).join(`from "@/components/${id}"`);
  // feature-internal libs + the shared style helper → absolute registered specifiers.
  c = c
    .replace(/from "\.\/lib\//g, 'from "@/features/skills/lib/')
    .replace(/from "\.\/skillStyles"/g, 'from "@/features/skills/skillStyles"');
  return c;
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#3654, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the skills lib/style surface via the skills graph-platform,\n` +
  `// and the sibling views as @/components/* graph records). Behaviour runs here.\n`;

function pageSrc() {
  let code = fs.readFileSync(path.join(SRC, "index.tsx"), "utf8");
  // Drop barrel re-export statements (SkillsStatus / SessionSkillsModal / lib re-exports) — they'd fail the
  // loader and a re-exported fn would confuse pickComponent. The page's own component export is kept.
  code = code.replace(/^export \{[\s\S]*?\} from "[^"]+";[ \t]*\r?\n/gm, "");
  code = code.replace(/^import "\.\/skills\.css";[ \t]*\r?\n/m, "");
  return HEADER("Skills → library workspace (#skills-groups)") + rewrite(code);
}

function bodySrc(file, what) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  code = code.replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, "");
  return HEADER(what) + rewrite(code);
}

const records = [
  { id: "skillspage", name: "SkillsWorkspace", role: "page", srcText: pageSrc() },
  { id: "skills-views", name: "SkillsViews", role: "component", srcText: bodySrc("SkillsViews.tsx", "Skills → list/cards/grouped row views") },
  { id: "skills-new-group-dialog", name: "SkillsNewGroupDialog", role: "component", srcText: bodySrc("NewGroupDialog.tsx", "Skills → new task-group dialog") },
  { id: "skills-drawer", name: "SkillDrawer", role: "component", srcText: bodySrc("SkillDrawer.tsx", "Skills → skill editor drawer") },
  { id: "skills-digest", name: "SkillsDigest", role: "component", srcText: bodySrc("SkillsDigest.tsx", "Skills → KPI digest bar + panel") },
  { id: "skills-lessons-tab", name: "SkillsLessonsTab", role: "component", srcText: bodySrc("LessonsTab.tsx", "Skills → Lessons tab") },
  { id: "skills-runs-tab", name: "SkillsRunsTab", role: "component", srcText: bodySrc("RunsTab.tsx", "Skills → Runs (telemetry) tab") },
];

for (const r of records) {
  const rec = { id: r.id, name: r.name, kitId: "base-studio-code", role: r.role, group: "features/skills", srcText: r.srcText };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${r.id}.json  (${rec.srcText.length} chars)`);
}
for (const r of records) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${r.id}.json`), "utf8"));
  const rel = j.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) console.log(`  WARN ${r.id}: leftover relative import(s): ${rel.join(", ")}`);
}
