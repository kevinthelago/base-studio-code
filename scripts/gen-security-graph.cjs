// One-off generator (#3646) — author the Security (Agents) page + its 4 tab bodies AS GRAPH SOURCE by
// transcribing the live .tsx into graph component records, with the import rewrites the runtime loader
// needs (siblings → @/components/<id>; feature-internal libs → absolute @/features/security/* the graph-
// platform registers). Mirrors scripts/gen-automations-graph.cjs (#3642). Deterministic → the #2514
// round-trip holds and re-running is a no-op.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../src/features/security");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/security");
fs.mkdirSync(OUT, { recursive: true });

// specifier rewrites applied to EVERY record: relative feature paths → loader-resolvable specifiers.
function rewrite(code) {
  return code
    .replace(/from "\.\/ProfilesTab"/g, 'from "@/components/security-profiles"')
    .replace(/from "\.\/AssignmentsTab"/g, 'from "@/components/security-assignments"')
    .replace(/from "\.\/ActivityTab"/g, 'from "@/components/security-activity"')
    .replace(/from "\.\/FlowTab"/g, 'from "@/components/security-flow"')
    .replace(/from "\.\/lib\//g, 'from "@/features/security/lib/');
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#3646, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the security lib surface via the security graph-platform,\n` +
  `// and the sibling tab bodies as @/components/* graph records). Behaviour runs here — no forked render path.\n`;

function pageSrc() {
  let code = fs.readFileSync(path.join(SRC, "index.tsx"), "utf8");
  // Drop the barrel re-export statements (`export { … } from "./…"`) — they sit BETWEEN the imports and the
  // component here, and a re-exported function would confuse pickComponent (default ?? first exported fn).
  // The page's own `export function SecurityWorkspace` is kept (it is not an `export … from`).
  code = code.replace(/^export \{[^}]*\} from "[^"]+";[ \t]*\r?\n/gm, "");
  // …and the CSS side-effect import (the loader can't resolve CSS; the host imports it instead).
  code = code.replace(/^import "\.\/security\.css";[ \t]*\r?\n/m, "");
  return HEADER("Security → Agents workspace (#236)") + rewrite(code);
}

function bodySrc(file, what) {
  return HEADER(what) + rewrite(fs.readFileSync(path.join(SRC, file), "utf8"));
}

const records = [
  { id: "securitypage", name: "SecurityWorkspace", role: "page", srcText: pageSrc() },
  { id: "security-profiles", name: "SecurityProfiles", role: "component", srcText: bodySrc("ProfilesTab.tsx", "Security → Profiles tab (permission-profile editor)") },
  { id: "security-assignments", name: "SecurityAssignments", role: "component", srcText: bodySrc("AssignmentsTab.tsx", "Security → Assignments tab (console/pane ↔ profile)") },
  { id: "security-activity", name: "SecurityActivity", role: "component", srcText: bodySrc("ActivityTab.tsx", "Security → Activity tab (audit feed)") },
  { id: "security-flow", name: "SecurityFlow", role: "component", srcText: bodySrc("FlowTab.tsx", "Security → Flow tab (coordination × profile)") },
];

for (const r of records) {
  const rec = { id: r.id, name: r.name, kitId: "base-studio-code", role: r.role, group: "features/security", srcText: r.srcText };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${r.id}.json  (${r.srcText.length} chars)`);
}

// Sanity: no leftover relative import (incl. side-effect `import "./x"`) the loader can't resolve.
for (const r of records) {
  const rel = r.srcText.match(/(?:from|import|export [^;]*from) "\.\/[^"]+"/g);
  if (rel) console.log(`  WARN ${r.id}: leftover relative import(s): ${rel.join(", ")}`);
}
