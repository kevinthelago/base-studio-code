// One-off generator (#3658) — author the Settings workspace + its 7 section pages AS GRAPH SOURCE, and
// AUTO-EMIT the settings graph-platform (the 37 cards + SettingsPageHeader/SettingsControls stay CODE,
// registered — they run as normal modules, not transcribed). Mirrors the prior generators. Large card set →
// the graphPlatform is generated from the specifiers the page records actually import, so it can't drift.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../src/features/settings");        // read source of truth (MAIN)
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/settings"); // records → worktree
const PLATFORM_OUT = path.resolve(__dirname, "../src/features/settings/graphPlatform.ts"); // graphPlatform → worktree
fs.mkdirSync(OUT, { recursive: true });

// the 7 section pages the workspace composes → sibling graph records.
const PAGE_SIB = {
  "./pages/GeneralPage": "settings-general",
  "./pages/PlannerPage": "settings-planner",
  "./pages/SkillsPage": "settings-skills",
  "./pages/AutomationsPage": "settings-automations",
  "./pages/McpPage": "settings-mcp",
  "./pages/GithubPage": "settings-github",
  "./pages/SecurityPage": "settings-security",
};

function rewrite(code) {
  let c = code;
  for (const [rel, id] of Object.entries(PAGE_SIB)) c = c.split(`from "${rel}"`).join(`from "@/components/${id}"`);
  // cards + the two page helpers + any settings lib → absolute registered specifiers (they stay CODE).
  c = c
    .replace(/from "\.\.\/cards\//g, 'from "@/features/settings/cards/')
    .replace(/from "\.\.\/lib\//g, 'from "@/features/settings/lib/')
    .replace(/from "\.\/SettingsPageHeader"/g, 'from "@/features/settings/pages/SettingsPageHeader"')
    .replace(/from "\.\/SettingsControls"/g, 'from "@/features/settings/pages/SettingsControls"');
  return c;
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#3658, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the setting cards + page helpers via the settings graph-\n` +
  `// platform, and the sibling section pages as @/components/* graph records). Behaviour runs here.\n`;

function src(file, what, isPage) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  if (isPage) code = code.replace(/^export \{[\s\S]*?\} from "[^"]+";[ \t]*\r?\n/gm, ""); // strip barrel re-exports (the workspace only)
  code = code.replace(/^import "\.\.?\/[^"]*\.css";[ \t]*\r?\n/gm, "");
  return HEADER(what) + rewrite(code);
}

const records = [
  { id: "settingspage", name: "SettingsWorkspace", role: "page", file: "index.tsx", isPage: true, what: "Settings workspace (nav + section detail)" },
  { id: "settings-general", name: "SettingsGeneralPage", role: "component", file: "pages/GeneralPage.tsx", what: "Settings → General section" },
  { id: "settings-planner", name: "SettingsPlannerPage", role: "component", file: "pages/PlannerPage.tsx", what: "Settings → Planner section" },
  { id: "settings-skills", name: "SettingsSkillsPage", role: "component", file: "pages/SkillsPage.tsx", what: "Settings → Skills section" },
  { id: "settings-automations", name: "SettingsAutomationsPage", role: "component", file: "pages/AutomationsPage.tsx", what: "Settings → Automations section" },
  { id: "settings-mcp", name: "SettingsMcpPage", role: "component", file: "pages/McpPage.tsx", what: "Settings → MCP section" },
  { id: "settings-github", name: "SettingsGithubPage", role: "component", file: "pages/GithubPage.tsx", what: "Settings → GitHub section" },
  { id: "settings-security", name: "SettingsSecurityPage", role: "component", file: "pages/SecurityPage.tsx", what: "Settings → Security section" },
];

for (const r of records) {
  const rec = { id: r.id, name: r.name, kitId: "base-studio-code", role: r.role, group: "features/settings", srcText: src(r.file, r.what, r.isPage) };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${r.id}.json  (${rec.srcText.length} chars)`);
}

// Collect the distinct @/features/* specifiers the records import (the settings cards/page-helpers AND any
// cross-feature barrel like @/features/tunnel) → auto-emit graphPlatform.ts. `import type` is erased, so
// skip type-only specifiers (they need no registration).
const spec = new Set();
for (const r of records) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${r.id}.json`), "utf8"));
  (j.srcText.match(/from "(@\/features\/[^"]+)"/g) || []).forEach((m) => spec.add(m.replace(/from "|"/g, "")));
  // (Over-registering a type-only feature barrel is harmless — the type import is erased, the entry unused.)
  const rel = j.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) console.log(`  WARN ${r.id}: leftover relative import(s): ${rel.join(", ")}`);
}
const specs = [...spec].sort();
const alias = (s) => s.split("/").pop().replace(/[^A-Za-z0-9]/g, "");
const imports = specs.map((s) => `import * as ${alias(s)} from "${s}";`).join("\n");
const regs = specs.map((s) => `  registerAppModule("${s}", ${alias(s)});`).join("\n");
const platform = `// The settings feature's graph-platform surface (#3658, epic #3604) — AUTO-GENERATED by
// scripts/gen-settings-graph.cjs. The setting CARDS + the two page helpers stay CODE: a graph-loaded
// Settings page composes them but does not redraw them (they run as normal registered modules). Registered
// HERE, inside the feature, because the shell must not reach a feature's internals (#1545). The settings
// host calls this synchronously before the graph page loads. Mirrors the other feature graph-platforms.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
${imports}

let done = false;

/** Register the settings page's injected graph-platform modules (cards + page helpers). Idempotent. */
export function registerSettingsPlatform(): void {
  if (done) return;
  done = true;
${regs}
}
`;
fs.writeFileSync(PLATFORM_OUT, platform);
console.log(`\nauto-emitted graphPlatform.ts with ${specs.length} registrations`);
