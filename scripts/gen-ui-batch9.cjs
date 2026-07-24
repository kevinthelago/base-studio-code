// shared/ui as data — batch 9 (GraphCanvas + Tree) (#3692, epic #3604). Completes shared/ui. CTX-free.
// Deps (useGraphViewport/renderProfiler/treeLayout/edgePath) registered this PR; MasterDetail already graph.
const fs = require("fs");
const path = require("path");
const UISRC = path.resolve(__dirname, "../../src/shared/ui");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

const PRIMS = [
  { id: "ui-graph-canvas", name: "GraphCanvas", file: "layouts/GraphCanvas.tsx" },
  { id: "ui-tree", name: "Tree", file: "layouts/Tree.tsx" },
].map((p) => ({ ...p, provides: "@/shared/ui/" + p.file.replace(/\.tsx$/, ""), group: "shared/ui/" + path.dirname(p.file) }));

function rewrite(code, file) {
  const dir = "@/shared/ui/" + path.dirname(file).split(path.sep).join("/") + "/";
  return code
    .replace(/from "\.\/([A-Za-z][^"]*)"/g, (_, m) => `from "${dir}${m}"`) // ./GraphCanvas/./treeLayout → absolute
    .replace(/^import "\.\/[^"]+\.css";[^\n]*\r?\n/gm, ""); // tolerate a trailing comment after the ;
}
const HEADER = (name, provides) =>
  `// ${name}, AS GRAPH SOURCE (#3692, epic #3604) — the design-studio graph renderer authored as DATA. Its\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS over the bundled module (registered code\n` +
  `// is the fallback). CTX-free. Transcribed verbatim; deps stay registered code.\n`;

for (const p of PRIMS) {
  const srcText = HEADER(p.name, p.provides) + rewrite(fs.readFileSync(path.join(UISRC, p.file), "utf8"), p.file);
  const rec = { id: p.id, name: p.name, kitId: "base-studio-code", role: "layout", group: p.group, provides: p.provides, srcText };
  fs.writeFileSync(path.join(OUT, `${p.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  const rel = srcText.match(/(?:from|import) "\.\.?\/[^"]+"/g);
  console.log(`wrote ${p.id}.json (${srcText.length} chars)${rel ? "  LEFTOVER RELATIVE: " + rel.join(", ") : ""}`);
}
