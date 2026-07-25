// shared/ui as data — batch 4 (controls) (#3678, epic #3604). Pure controls (0 hooks); deps already
// registered. Same pattern as the earlier gen-ui-batch scripts.
const fs = require("fs");
const path = require("path");
const UISRC = path.resolve(__dirname, "../../src/shared/ui");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

const PRIMS = [
  { id: "ui-button", name: "Button", file: "controls/Button.tsx" },
  { id: "ui-field", name: "Field", file: "controls/Field.tsx" },
  { id: "ui-search-field", name: "SearchField", file: "controls/SearchField.tsx" },
  { id: "ui-segmented-control", name: "SegmentedControl", file: "controls/SegmentedControl.tsx" },
  { id: "ui-toggle", name: "Toggle", file: "controls/Toggle.tsx" },
  { id: "ui-checkbox", name: "Checkbox", file: "controls/Checkbox.tsx" },
  { id: "ui-icon-button", name: "IconButton", file: "controls/IconButton.tsx" },
].map((p) => ({ ...p, provides: "@/shared/ui/" + p.file.replace(/\.tsx$/, ""), group: "shared/ui/" + path.dirname(p.file) }));

function rewrite(code, file) {
  const dir = "@/shared/ui/" + path.dirname(file).split(path.sep).join("/") + "/";
  return code
    .replace(/from "\.\/([A-Za-z][^"]*)"/g, (_, m) => `from "${dir}${m}"`)
    .replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, "");
}
const HEADER = (name, provides) =>
  `// ${name}, AS GRAPH SOURCE (#3678, epic #3604) — a pure shared/ui control authored as DATA. Its\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS over the bundled module (registered code\n` +
  `// is the fallback). Transcribed verbatim; deps stay registered code.\n`;

for (const p of PRIMS) {
  const srcText = HEADER(p.name, p.provides) + rewrite(fs.readFileSync(path.join(UISRC, p.file), "utf8"), p.file);
  const rec = { id: p.id, name: p.name, kitId: "base-studio-code", role: "primitive", group: p.group, provides: p.provides, srcText };
  fs.writeFileSync(path.join(OUT, `${p.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  const rel = srcText.match(/(?:from|import) "\.\.?\/[^"]+"/g);
  console.log(`wrote ${p.id}.json (${srcText.length} chars)${rel ? "  LEFTOVER RELATIVE: " + rel.join(", ") : ""}`);
}
