// The relative-specifier scanner — the ONE definition four readers share (the guard that rejects a
// relative import in a record, the sweep that repairs one, the retirement that must not create one,
// and the refresh that absolutizes a file into record form).
//
// Every case below is a real record source, not an invented one: the false positives are what a
// comment-STRIPPING scanner got wrong on this library's own records, and the inline-import case is
// the form a `from "…"` sweep is documented to leave behind.
import { describe, it, expect } from "vitest";
// A relative path on purpose: `scripts/` is outside the `@/` alias (which maps to `src/`).
import { relativeSpecifiers, aliasFor, absolutizeImports, dropAssetImports } from "./lib/recordSource.mjs";

const specsOf = (src: string) => relativeSpecifiers(src).map((s: { spec: string }) => s.spec);

describe("relativeSpecifiers — what a record may not carry", () => {
  it("finds a statement import, an export-from and a bare side-effect import", () => {
    expect(
      specsOf(
        [
          `import { a } from "./a";`,
          `export { b } from '../b';`,
          `import "./styles.css";`,
          `import { keep } from "@/shared/ui/controls/Button";`,
          `import react from "react";`,
        ].join("\n"),
      ),
    ).toEqual(["./a", "../b", "./styles.css"]);
  });

  it("finds a multi-line named-import list, whose `from` is not on the `import` line", () => {
    expect(specsOf(`import {\n  a,\n  b,\n} from "./wide";\n`)).toEqual(["./wide"]);
  });

  it("finds a TYPE-POSITION inline import — the form a `from` sweep leaves behind", () => {
    // `projectPaneInput` carried three of these. A `from "…"` regex sees none of them, and the last
    // sweep that ran found out when typecheck reported the one remaining error.
    const src = `export interface X {\n  uiPairing?: import("../fleet/workerScope").WorkerUiPairing;\n}\n`;
    expect(specsOf(src)).toEqual(["../fleet/workerScope"]);
  });

  it("finds a DYNAMIC import and a require", () => {
    expect(specsOf(`const run = () => import("./vizProgram").then((m) => m.run);\n`)).toEqual(["./vizProgram"]);
    expect(specsOf(`const m = require("./legacy");\n`)).toEqual(["./legacy"]);
  });

  it("finds `vi.mock` — a mock keys on the RESOLVED module, so a stale one silently stops applying", () => {
    expect(specsOf(`vi.mock("./graphBridge", () => ({}));\n`)).toEqual(["./graphBridge"]);
  });

  it("does NOT match a specifier that only appears in PROSE", () => {
    // Both are verbatim from this library's records. A comment-stripping scanner flagged both, and
    // rewriting either would make the comment describe something that does not happen.
    const jsdoc = `/**\n *  import("../stages/stageGate").PlanSignals} bag supports numbers only — and it lets a\n */\nexport const x = 1;\n`;
    const lineComment = `//  the same \`require("./y")\` an import produces, so a re-export breaks identically\nexport const y = 2;\n`;
    expect(specsOf(jsdoc)).toEqual([]);
    expect(specsOf(lineComment)).toEqual([]);
  });

  it("survives a REGEX LITERAL holding quotes — what broke the stripping scanner", () => {
    // `pageBinding` defines its import regex, and the doc comment BELOW it was then scanned as code.
    const src =
      `const FROM = /^[ \\t]*(import|export)\\s+([^"';]*?)\\s*from\\s*["']([^"']+)["']/gm;\n` +
      `/** A side-effect import (\`import "./x.css"\`) — no clause, still a require at runtime. */\n` +
      `import { real } from "./neighbour";\n`;
    expect(specsOf(src)).toEqual(["./neighbour"]);
  });

  it("reports each specifier's position, so a rewrite splices rather than re-finds", () => {
    const src = `import { a } from "./a";\n`;
    const [only] = relativeSpecifiers(src) as { spec: string; at: number }[];
    expect(src.slice(only.at, only.at + only.spec.length)).toBe("./a");
  });
});

describe("aliasFor", () => {
  it("resolves against the importer's directory", () => {
    expect(aliasFor("features/planner/list/ProjectsHeader.tsx", "./drafts")).toBe("@/features/planner/list/drafts");
    expect(aliasFor("features/planner/pane/projectPaneInput.ts", "../fleet/workerScope")).toBe(
      "@/features/planner/fleet/workerScope",
    );
  });

  it("takes a REPO-relative path too — a record's `src` carries the `src/` prefix", () => {
    expect(aliasFor("src/app/App.tsx", "./useDockBack")).toBe("@/app/useDockBack");
  });
});

describe("absolutizeImports", () => {
  it("rewrites every form and leaves the rest of the source byte-identical", () => {
    const src =
      `import { a } from "./a";\n` +
      `import keep from "@/shared/x";\n` +
      `export interface P { d?: import("../d/deep").T }\n` +
      `const s = "./not-an-import";\n`;
    expect(absolutizeImports(src, "features/f/mod.ts")).toBe(
      `import { a } from "@/features/f/a";\n` +
        `import keep from "@/shared/x";\n` +
        `export interface P { d?: import("@/features/d/deep").T }\n` +
        `const s = "./not-an-import";\n`,
    );
  });

  it("leaves prose alone", () => {
    const src = `// see ./sibling for why\nimport { a } from "./sibling";\n`;
    expect(absolutizeImports(src, "features/f/mod.ts")).toBe(`// see ./sibling for why\nimport { a } from "@/features/f/sibling";\n`);
  });

  it("is a no-op on source that already imports absolutely", () => {
    const src = `import { a } from "@/features/f/a";\nexport const x = a;\n`;
    expect(absolutizeImports(src, "features/f/mod.ts")).toBe(src);
  });
});

describe("dropAssetImports", () => {
  it("drops a stylesheet import, which a record may not carry under ANY specifier", () => {
    // Absolutizing `import "./charts.css"` yields `@/shared/ui/charts/charts.css`, which the registry
    // answers no better than the relative form did. The repair is to DROP it — the app's CSS already
    // loads globally through the bundled entry.
    expect(dropAssetImports(`import "./charts.css";\nexport const c = 1;\n`)).toBe(`export const c = 1;\n`);
  });
});
