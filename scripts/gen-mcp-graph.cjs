// One-off generator (#3656) — author the MCP page + McpAnalytics AS GRAPH SOURCE. Mirrors the prior
// generators. The barrel re-exports (cross-feature lib API incl. HooksView/parseHookLog used by Automations)
// are stripped so they stay CODE and pickComponent selects McpWorkspace. `./shared` (a hook + drawer/row/
// card helpers) + the mcp libs stay code, registered by the mcp graph-platform.
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "../../src/features/mcp");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/features/mcp");
fs.mkdirSync(OUT, { recursive: true });

function rewrite(code) {
  return code
    .replace(/from "\.\/McpAnalytics"/g, 'from "@/components/mcp-analytics"') // the one sibling
    .replace(/from "\.\/shared"/g, 'from "@/features/mcp/shared"')
    .replace(/from "\.\/lib\//g, 'from "@/features/mcp/lib/')
    .replace(/from "\.\/useMcpInstallStatus"/g, 'from "@/features/mcp/useMcpInstallStatus"');
}

const HEADER = (what) =>
  `// ${what}, AS GRAPH SOURCE (#3656, epic #3604). Transcribed from the live feature file: the runtime\n` +
  `// loader compiles this and mounts it, resolving every import to the app's real modules (the shared/ui\n` +
  `// design system + the store via appModules, the mcp lib/shared surface via the mcp graph-platform, and\n` +
  `// the McpAnalytics sibling as a @/components/* graph record). Behaviour runs here.\n`;

function pageSrc() {
  let code = fs.readFileSync(path.join(SRC, "index.tsx"), "utf8");
  code = code.replace(/^export \{[\s\S]*?\} from "[^"]+";[ \t]*\r?\n/gm, ""); // strip barrel re-exports
  code = code.replace(/^import "\.\/mcp\.css";[ \t]*\r?\n/m, "");
  return HEADER("MCP → servers workspace (#865)") + rewrite(code);
}

function bodySrc(file, what) {
  let code = fs.readFileSync(path.join(SRC, file), "utf8");
  code = code.replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, "");
  return HEADER(what) + rewrite(code);
}

const records = [
  { id: "mcppage", name: "McpWorkspace", role: "page", srcText: pageSrc() },
  { id: "mcp-analytics", name: "McpAnalytics", role: "component", srcText: bodySrc("McpAnalytics.tsx", "MCP → Analytics tab") },
];

for (const r of records) {
  const rec = { id: r.id, name: r.name, kitId: "base-studio-code", role: r.role, group: "features/mcp", srcText: r.srcText };
  fs.writeFileSync(path.join(OUT, `${r.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  console.log(`wrote ${r.id}.json  (${rec.srcText.length} chars)`);
}
for (const r of records) {
  const j = JSON.parse(fs.readFileSync(path.join(OUT, `${r.id}.json`), "utf8"));
  const rel = j.srcText.match(/(?:from|import|export [^;]*from) "\.\.?\/[^"]+"/g);
  if (rel) console.log(`  WARN ${r.id}: leftover relative import(s): ${rel.join(", ")}`);
}
