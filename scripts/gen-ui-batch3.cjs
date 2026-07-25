// shared/ui as data — batch 3 (#3674, epic #3604). The foundational primitives: Text/Skeleton/Card/Avatar.
// Pure (0 hooks/context); their small leaf deps (typography/type, feedback/shimmer, github/colors) are
// registered in appModules this PR. Same pattern as gen-ui-batch2.cjs.
const fs = require("fs");
const path = require("path");
const UISRC = path.resolve(__dirname, "../../src/shared/ui");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

const PRIMS = [
  { id: "ui-text", name: "Text", file: "typography/Text.tsx", provides: "@/shared/ui/typography/Text", group: "shared/ui/typography" },
  { id: "ui-skeleton", name: "Skeleton", file: "feedback/Skeleton.tsx", provides: "@/shared/ui/feedback/Skeleton", group: "shared/ui/feedback" },
  { id: "ui-card", name: "Card", file: "data/Card.tsx", provides: "@/shared/ui/data/Card", group: "shared/ui/data" },
  { id: "ui-avatar", name: "Avatar", file: "data/Avatar.tsx", provides: "@/shared/ui/data/Avatar", group: "shared/ui/data" },
];

function rewrite(code, file) {
  const dir = "@/shared/ui/" + path.dirname(file).replace(/\\/g, "/") + "/";
  return code
    .replace(/from "\.\/([A-Za-z][^"]*)"/g, (_, m) => `from "${dir}${m}"`) // ./type → @/shared/ui/typography/type
    .replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, "");
}
const HEADER = (name, provides) =>
  `// ${name}, AS GRAPH SOURCE (#3674, epic #3604) — a foundational shared/ui primitive authored as DATA. Its\n` +
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
