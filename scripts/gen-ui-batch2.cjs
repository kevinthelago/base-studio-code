// shared/ui as data — batch 2 (#3670, epic #3604). Same pattern as gen-ui-primitives-graph.cjs: pure leaf
// primitives authored as graph records with `provides`; deps stay registered code (safe fresh compile).
const fs = require("fs");
const path = require("path");
const UISRC = path.resolve(__dirname, "../../src/shared/ui");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

const PRIMS = [
  { id: "ui-empty-state", name: "EmptyState", file: "feedback/EmptyState.tsx", provides: "@/shared/ui/feedback/EmptyState", group: "shared/ui/feedback" },
  { id: "ui-banner", name: "Banner", file: "feedback/Banner.tsx", provides: "@/shared/ui/feedback/Banner", group: "shared/ui/feedback" },
  { id: "ui-card-states", name: "CardStates", file: "feedback/CardStates.tsx", provides: "@/shared/ui/feedback/CardStates", group: "shared/ui/feedback" },
  { id: "ui-icon-box", name: "IconBox", file: "data/IconBox.tsx", provides: "@/shared/ui/data/IconBox", group: "shared/ui/data" },
  { id: "ui-data-table-row", name: "DataTableRow", file: "data/DataTableRow.tsx", provides: "@/shared/ui/data/DataTableRow", group: "shared/ui/data" },
];

function rewrite(code, file) {
  const dir = "@/shared/ui/" + path.dirname(file).replace(/\\/g, "/") + "/";
  return code
    .replace(/from "\.\/([A-Za-z][^"]*)"/g, (_, m) => `from "${dir}${m}"`)
    .replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, "");
}
const HEADER = (name, provides) =>
  `// ${name}, AS GRAPH SOURCE (#3670, epic #3604) — a pure leaf shared/ui primitive authored as DATA. Its\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS source wherever a graph component imports\n` +
  `// that specifier (registered code is the fallback). Transcribed verbatim; deps stay registered code.\n`;

for (const p of PRIMS) {
  const raw = fs.readFileSync(path.join(UISRC, p.file), "utf8");
  const srcText = HEADER(p.name, p.provides) + rewrite(raw, p.file);
  const rec = { id: p.id, name: p.name, kitId: "base-studio-code", role: "primitive", group: p.group, provides: p.provides, srcText };
  fs.writeFileSync(path.join(OUT, `${p.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  const rel = srcText.match(/(?:from|import) "\.\.?\/[^"]+"/g);
  console.log(`wrote ${p.id}.json (${srcText.length} chars)${rel ? "  LEFTOVER RELATIVE: " + rel.join(", ") : ""}`);
}
