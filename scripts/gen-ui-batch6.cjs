// shared/ui as data — batch 6 (overlays + structural layouts) (#3684, epic #3604). All CTX-free → safe to
// vendor. useModalDismiss/useClickOutside registered this PR; useDragResize already registered. Sibling
// chains (Screen→TabBar, ModalCard/Dialog→ModalScrim, promptDialog→Dialog, RailSection→RailGroupHeader)
// resolve within the batch.
const fs = require("fs");
const path = require("path");
const UISRC = path.resolve(__dirname, "../../src/shared/ui");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

const PRIMS = [
  { id: "ui-pane", name: "Pane", file: "overlay/Pane.tsx" },
  { id: "ui-modal-scrim", name: "ModalScrim", file: "overlay/ModalScrim.tsx" },
  { id: "ui-modal-card", name: "ModalCard", file: "overlay/ModalCard.tsx" },
  { id: "ui-dialog", name: "Dialog", file: "overlay/Dialog.tsx" },
  { id: "ui-prompt-dialog", name: "promptDialog", file: "overlay/promptDialog.tsx", role: "composite" },
  { id: "ui-screen", name: "Screen", file: "layouts/Screen.tsx" },
  { id: "ui-tab-bar", name: "TabBar", file: "layouts/TabBar.tsx" },
  { id: "ui-graph-rail", name: "GraphRail", file: "layouts/GraphRail.tsx" },
  { id: "ui-graph-legend", name: "GraphLegend", file: "layouts/GraphLegend.tsx" },
  { id: "ui-rail-row", name: "RailRow", file: "layouts/RailRow.tsx" },
  { id: "ui-rail-group-header", name: "RailGroupHeader", file: "layouts/RailGroupHeader.tsx" },
  { id: "ui-rail-section", name: "RailSection", file: "layouts/RailSection.tsx" },
  { id: "ui-pane-grid", name: "PaneGrid", file: "layouts/PaneGrid.tsx" },
  { id: "ui-session-dock", name: "SessionDock", file: "layouts/SessionDock.tsx" },
  { id: "ui-sequence", name: "Sequence", file: "layouts/Sequence.tsx" },
  { id: "ui-master-detail", name: "MasterDetail", file: "layouts/MasterDetail.tsx" },
  { id: "ui-split-view", name: "SplitView", file: "layouts/SplitView.tsx" },
].map((p) => ({ role: "layout", ...p, provides: "@/shared/ui/" + p.file.replace(/\.tsx$/, ""), group: "shared/ui/" + path.dirname(p.file) }));

function rewrite(code, file) {
  const dir = "@/shared/ui/" + path.dirname(file).split(path.sep).join("/") + "/";
  return code
    .replace(/from "\.\/([A-Za-z][^"]*)"/g, (_, m) => `from "${dir}${m}"`) // ./TabBar → @/shared/ui/layouts/TabBar
    .replace(/^import "\.\/[^"]+\.css";[ \t]*\r?\n/gm, "");
}
const HEADER = (name, provides) =>
  `// ${name}, AS GRAPH SOURCE (#3684, epic #3604) — a shared/ui overlay/layout container authored as DATA.\n` +
  `// \`provides: "${provides}"\` makes the runtime loader vendor THIS over the bundled module (registered code\n` +
  `// is the fallback). CTX-free, so a fresh compile has no identity split. Transcribed verbatim.\n`;

for (const p of PRIMS) {
  const srcText = HEADER(p.name, p.provides) + rewrite(fs.readFileSync(path.join(UISRC, p.file), "utf8"), p.file);
  const rec = { id: p.id, name: p.name, kitId: "base-studio-code", role: p.role, group: p.group, provides: p.provides, srcText };
  fs.writeFileSync(path.join(OUT, `${p.id}.json`), JSON.stringify(rec, null, 2) + "\n");
  const rel = srcText.match(/(?:from|import) "\.\.?\/[^"]+"/g);
  console.log(`wrote ${p.id}.json (${srcText.length} chars)${rel ? "  LEFTOVER RELATIVE: " + rel.join(", ") : ""}`);
}
