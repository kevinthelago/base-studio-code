// One-off generator (#3642) — author the Automations page + its 3 tab bodies AS GRAPH SOURCE by
// transcribing the live .tsx into graph component records, with the import rewrites the runtime loader
// needs (siblings → @/components/<id>; feature-internal libs → absolute @/features/automations/* the
// graph-platform registers). Deterministic so the round-trip (#2514) holds and re-running is a no-op.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../src/features/automations");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/automations");
fs.mkdirSync(OUT, { recursive: true });

// specifier rewrites applied to EVERY record: relative feature paths → loader-resolvable specifiers.
function rewrite(code) {
  return code
    .replace(/from "\.\/Schedules"/g, 'from "@/components/automations-schedules"')
    .replace(/from "\.\/History"/g, 'from "@/components/automations-history"')
    .replace(/from "\.\/HookAnalytics"/g, 'from "@/components/automations-hook-analytics"')
    .replace(/from "\.\/lib\/scheduler"/g, 'from "@/features/automations/lib/scheduler"')
    .replace(/from "\.\/lib\/cron"/g, 'from "@/features/automations/lib/cron"')
    .replace(/from "\.\/format"/g, 'from "@/features/automations/format"');
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#3642, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the mcp/scheduler surface via the automations graph-platform,\n` +
  `// and the sibling tab bodies as @/components/* graph records). Behaviour runs here — no forked render path.\n`;

function pageSrc() {
  let code = fs.readFileSync(path.join(SRC, "index.tsx"), "utf8");
  // Keep ONLY the AutomationsWorkspace component — drop the barrel re-export tail (not part of the page)…
  const cut = code.indexOf("// Re-exported feature surface");
  if (cut === -1) throw new Error("page: barrel-export marker not found");
  code = code.slice(0, cut).replace(/\s+$/, "\n");
  // …and the CSS side-effect import (the loader can't resolve CSS; the host imports it instead).
  // Tolerate CRLF endings (the source is CRLF): strip the whole line incl. its terminator.
  code = code.replace(/^import "\.\/automations\.css";[ \t]*\r?\n/m, "");
  return HEADER("Automations → workspace (#142)") + rewrite(code);
}

function bodySrc(file, what) {
  const code = fs.readFileSync(path.join(SRC, file), "utf8");
  return HEADER(what) + rewrite(code);
}

const records = [
  { id: "automationspage", name: "AutomationsWorkspace", role: "page", srcText: pageSrc() },
  { id: "automations-schedules", name: "AutomationsSchedules", role: "component", srcText: bodySrc("Schedules.tsx", "Automations → Schedules tab + editor drawer") },
  { id: "automations-history", name: "AutomationsHistory", role: "component", srcText: bodySrc("History.tsx", "Automations → run History tab") },
  { id: "automations-hook-analytics", name: "AutomationsHookAnalytics", role: "component", srcText: bodySrc("HookAnalytics.tsx", "Automations → Hook Analytics tab") },
];

for (const r of records) {
  const rec = { id: r.id, name: r.name, kitId: "base-studio-code", role: r.role, group: "features/automations", srcText: r.srcText };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${r.id}.json  (${r.srcText.length} chars)`);
}

// Sanity: no leftover relative import (incl. side-effect `import "./x"`) that the loader can't resolve.
for (const r of records) {
  const rel = r.srcText.match(/(?:from|import) "\.\/[^"]+"/g);
  if (rel) console.log(`  WARN ${r.id}: leftover relative import(s): ${rel.join(", ")}`);
}
