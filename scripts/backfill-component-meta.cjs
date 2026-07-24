// One-time backfill (#3667) — categorize the components we extracted this session by deriving `composes`
// (edges) + `role` (tier) + a best-effort `src` from each record's srcText. MIRRORS the canonical analyzer
// in src/features/designs/lib/componentAnalysis.ts (kept in sync; that lib is the reusable/tested source of
// truth — this script is the batch application, in CJS because tsx isn't installed to import the .ts).
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../src-tauri/data/components/app");
const KIT = "base-studio-code";

// ── mirror of componentAnalysis.ts ────────────────────────────────────────────────────────────────────
const LAYOUT_NAMES = new Set([
  "Box", "Stack", "Row", "Grid", "Spacer", "Screen", "MasterDetail", "SectionHeader", "SectionLabel",
  "GraphRail", "GraphCanvas", "RailRow", "RailSection", "Pane", "TabBar", "Divider",
  "ModalScrim", "ModalCard", "Dialog", "GraphLegend", "RailGroupHeader", "PaneGrid", "SessionDock", "SplitView",
]);
const PRIMITIVE_NAMES = new Set([
  "Text", "Chip", "Button", "IconButton", "Badge", "StatusDot", "ColorSwatch", "Avatar", "IconBox",
  "FillBar", "StatTile", "Kbd", "Skeleton", "Spinner", "Dot", "Tag",
  "Field", "TextField", "SelectField", "TextArea", "SearchField", "SegmentedControl", "Toggle", "Checkbox",
]);
const deriveComposes = (srcText, resolveName) => {
  const names = new Set();
  const re = /\bfrom\s+"([^"]+)"/g;
  let m;
  while ((m = re.exec(srcText)) !== null) { const n = resolveName(m[1]); if (n) names.add(n); }
  return [...names].sort();
};
const renderedComponentCount = (srcText) => {
  const tags = new Set(); const re = /<([A-Z][A-Za-z0-9]*)[\s/>]/g; let m;
  while ((m = re.exec(srcText)) !== null) tags.add(m[1]);
  return tags.size;
};
const deriveRole = (name, existingRole, composes, rendered) => {
  if (existingRole === "page") return "page";
  if (LAYOUT_NAMES.has(name)) return "layout";
  if (PRIMITIVE_NAMES.has(name)) return "primitive";
  if (composes.length >= 1 || rendered >= 3) return "composite";
  return "primitive";
};
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

// collect every extracted record
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (e.isDirectory()) walk(p); else if (e.name.endsWith(".json")) files.push(p);
} })(ROOT);
const records = files.map((f) => ({ f, j: JSON.parse(fs.readFileSync(f, "utf8")) }));

// name resolver (same-kit): @/components/<id> → name; a provided @/shared/ui/* → name
const inKit = records.map((r) => r.j).filter((j) => j.kitId === KIT);
const byId = new Map(inKit.map((j) => [j.id, j.name]));
const byProvides = new Map(inKit.filter((j) => j.provides).map((j) => [j.provides, j.name]));
const resolveName = (spec) =>
  spec.startsWith("@/components/") ? (byId.get(spec.slice("@/components/".length)) ?? null)
  : (byProvides.get(spec) ?? null);

let changed = 0;
for (const { f, j } of records) {
  if (j.kitId !== KIT) continue;
  const composes = deriveComposes(j.srcText || "", resolveName);
  const role = deriveRole(j.name, j.role, composes, renderedComponentCount(j.srcText || ""));
  const src = j.src || `src/${j.group}/${j.name}.tsx`;
  const before = JSON.stringify([j.composes || [], j.role, j.src || null]);
  const after = JSON.stringify([composes, role, src]);
  if (before !== after) {
    j.composes = composes; j.role = role; j.src = src;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    changed++;
    console.log(`  ${j.id.padEnd(24)} role→${role.padEnd(9)} composes[${composes.length}] ${composes.slice(0, 4).join(",")}${composes.length > 4 ? "…" : ""}`);
  }
}
console.log(`\nbackfilled ${changed}/${inKit.length} ${KIT} records`);
