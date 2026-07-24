// One-off generator (#3660) — author a FIRST BATCH of pure leaf shared/ui primitives AS GRAPH SOURCE with a
// `provides` field, so the loader vendors them (DATA) over the bundled module. Only primitives that are pure
// presentational (0 hooks/context) and whose value deps are already REGISTERED are safe to freshly compile.
const fs = require("fs");
const path = require("path");

const UISRC = path.resolve(__dirname, "../../src/shared/ui");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

// per-primitive: file, provides specifier, group, and any relative-import rewrites (deps stay registered).
const PRIMS = [
  { id: "ui-color-swatch", name: "ColorSwatch", file: "controls/ColorSwatch.tsx", provides: "@/shared/ui/controls/ColorSwatch", group: "shared/ui/controls" },
  { id: "ui-status-dot", name: "StatusDot", file: "feedback/StatusDot.tsx", provides: "@/shared/ui/feedback/StatusDot", group: "shared/ui/feedback" },
  { id: "ui-stat-tile", name: "StatTile", file: "data/StatTile.tsx", provides: "@/shared/ui/data/StatTile", group: "shared/ui/data" },
  { id: "ui-chip", name: "Chip", file: "data/Chip.tsx", provides: "@/shared/ui/data/Chip", group: "shared/ui/data" },
  { id: "ui-fill-bar", name: "FillBar", file: "data/FillBar.tsx", provides: "@/shared/ui/data/FillBar", group: "shared/ui/data" },
];

// A primitive's same-dir relative imports (`./Card`) → absolute registered specifier; strip CSS side-effects.
function rewrite(code, file) {
  const dir = "@/shared/ui/" + path.dirname(file).replace(/\\/g, "/") + "/";
  return code
    .replace(/from "\.\/([A-Za-z][^"]*)"/g, (_, m) => `from "${dir}${m}"`) // ./Card → @/shared/ui/data/Card
    .replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, ""); // drop CSS side-effect imports (global CSS is already loaded)
}

const HEADER = (name, provides) =>
  `// ${name}, AS GRAPH SOURCE (#3660, epic #3604) — a pure leaf shared/ui primitive authored as DATA. Its\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS source wherever a graph component imports\n` +
  `// that specifier, so the primitive renders from the graph, not bundled code (registered code is the\n` +
  `// fallback when no component provides it). Transcribed verbatim from the live .tsx; deps (Skeleton/Card/\n` +
  `// math) stay registered code — a fresh compile is safe because the primitive holds no context or state.\n`;

for (const p of PRIMS) {
  const raw = fs.readFileSync(path.join(UISRC, p.file), "utf8");
  const srcText = HEADER(p.name, p.provides) + rewrite(raw, p.file);
  const rec = { id: p.id, name: p.name, kitId: "base-studio-code", role: "primitive", group: p.group, provides: p.provides, srcText };
  fs.writeFileSync(path.join(OUT, `${p.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  const rel = srcText.match(/(?:from|import) "\.\.?\/[^"]+"/g);
  console.log(`wrote ${p.id}.json (${srcText.length} chars)${rel ? "  LEFTOVER RELATIVE: " + rel.join(", ") : ""}`);
}
