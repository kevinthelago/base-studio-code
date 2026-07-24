// shared/ui as data — batch 5 (layout) (#3680, epic #3604). Structural primitives (role=layout); pure.
// space.ts (their shared gap/pad util) is registered in appModules this PR.
const fs = require("fs");
const path = require("path");
const UISRC = path.resolve(__dirname, "../../src/shared/ui");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

const PRIMS = [
  { id: "ui-box", name: "Box", file: "layout/Box.tsx" },
  { id: "ui-stack", name: "Stack", file: "layout/Stack.tsx" },
  { id: "ui-row", name: "Row", file: "layout/Row.tsx" },
  { id: "ui-grid", name: "Grid", file: "layout/Grid.tsx" },
  { id: "ui-spacer", name: "Spacer", file: "layout/Spacer.tsx" },
  { id: "ui-section-header", name: "SectionHeader", file: "layout/SectionHeader.tsx" },
  { id: "ui-section-label", name: "SectionLabel", file: "layout/SectionLabel.tsx" },
].map((p) => ({ ...p, provides: "@/shared/ui/" + p.file.replace(/\.tsx$/, ""), group: "shared/ui/" + path.dirname(p.file) }));

function rewrite(code, file) {
  const dir = "@/shared/ui/" + path.dirname(file).split(path.sep).join("/") + "/";
  return code
    .replace(/from "\.\/([A-Za-z][^"]*)"/g, (_, m) => `from "${dir}${m}"`) // ./space → @/shared/ui/layout/space
    .replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, "");
}
const HEADER = (name, provides) =>
  `// ${name}, AS GRAPH SOURCE (#3680, epic #3604) — a structural shared/ui layout primitive authored as DATA.\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS over the bundled module (registered code\n` +
  `// is the fallback). Transcribed verbatim; deps stay registered code.\n`;

for (const p of PRIMS) {
  const srcText = HEADER(p.name, p.provides) + rewrite(fs.readFileSync(path.join(UISRC, p.file), "utf8"), p.file);
  const rec = { id: p.id, name: p.name, kitId: "base-studio-code", role: "layout", group: p.group, provides: p.provides, srcText };
  fs.writeFileSync(path.join(OUT, `${p.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  const rel = srcText.match(/(?:from|import) "\.\.?\/[^"]+"/g);
  console.log(`wrote ${p.id}.json (${srcText.length} chars)${rel ? "  LEFTOVER RELATIVE: " + rel.join(", ") : ""}`);
}
