// shared/ui as data — batch 8 (charts) (#3690, epic #3604). The @/shared/ui/charts barrel as ONE record by
// CONCATENATING Charts.tsx + primitives.tsx + telemetry.tsx. They're CTX-free with NO value cross-imports
// (only a type-only `ChartTip` from ./Charts, erased), so concat is clean: strip each file's import lines,
// prepend one merged/deduped import block, join the bodies. Deps already registered/graph.
const fs = require("fs");
const path = require("path");
const CH = path.resolve(__dirname, "../../src/shared/ui/charts");
const OUT = path.resolve(__dirname, "../src-tauri/data/components/app/shared/ui");
fs.mkdirSync(OUT, { recursive: true });

const stripImports = (code) => code.replace(/^import [^\n]*;[ \t]*\r?\n/gm, ""); // every single-line import
const bodies = ["Charts.tsx", "primitives.tsx", "telemetry.tsx"].map((f) => stripImports(fs.readFileSync(path.join(CH, f), "utf8")));

// One merged import block covering every VALUE dep across the 3 files (the type-only ./Charts import is
// dropped — ChartTip is a local type once concatenated). All specifiers are registered or already-graph.
const merged =
  `import { useState, useCallback, type ReactNode, type CSSProperties } from "react";\n` +
  `import { loginColor } from "@/shared/lib/core/format";\n` +
  `import { Skeleton } from "@/shared/ui/feedback/Skeleton";\n` +
  `import { FillBar } from "@/shared/ui/data/FillBar";\n`;

const header =
  `// Charts, AS GRAPH SOURCE (#3690, epic #3604) — the @/shared/ui/charts barrel (LineArea/Bars/Donut/\n` +
  `// StatCard/TelemetryPanel/… 17 exports) as DATA, its 3 CTX-free source files concatenated. provides\n` +
  `// @/shared/ui/charts; deps (format.loginColor, Skeleton, FillBar) stay registered/graph.\n`;

const srcText = header + merged + bodies.join("\n");
const rec = { id: "ui-charts", name: "Charts", kitId: "base-studio-code", role: "composite", group: "shared/ui/charts", provides: "@/shared/ui/charts", srcText };
fs.writeFileSync(path.join(OUT, "ui-charts.json"), JSON.stringify(rec, null, 2) + "\n");

// sanity: no leftover relative import, and no duplicate top-level export name
const rel = srcText.match(/(?:from|import) "\.\.?\/[^"]+"/g);
const exportNames = [...srcText.matchAll(/^export (?:function|const) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
const dupes = exportNames.filter((n, i) => exportNames.indexOf(n) !== i);
console.log(`wrote ui-charts.json (${srcText.length} chars) — ${exportNames.length} exports${rel ? "  LEFTOVER: " + rel.join(",") : ""}${dupes.length ? "  DUP EXPORTS: " + dupes.join(",") : "  no dup exports"}`);
console.log("  exports:", exportNames.join(", "));
