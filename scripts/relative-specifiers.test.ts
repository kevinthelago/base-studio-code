import { describe, expect, it } from "vitest";
import { relativeSpecifiers, absolutizeImports, blankComments } from "./lib/recordSource.mjs";

// A record may not import RELATIVELY at all: the runtime loader routes a specifier to the registry under
// its literal key, and `.bsc-records/shared/ui/kit.tsx` resolving `./theme` looks beside the EMITTED file,
// not beside the source it came from. So a missed absolutization ships a module that cannot load — and
// the file it stood for has usually been retired by then.
describe("relativeSpecifiers", () => {
  it("finds one in a plain import", () => {
    expect(relativeSpecifiers(`import { a } from "./a";`).map((s) => s.spec)).toEqual(["./a"]);
  });

  it("finds one in a multi-line export block", () => {
    const src = `export {\n  A,\n  B,\n} from "./theme";`;
    expect(relativeSpecifiers(src).map((s) => s.spec)).toEqual(["./theme"]);
  });

  it("finds one when a comment inside the block contains an APOSTROPHE", () => {
    // The real regression. `STATEMENT_SPEC`'s clause is `[^"';]*?` and may not cross a quote, so the
    // apostrophe in `store's` ended the match before `from`. `shared/ui/kit/index.ts` shipped a record
    // holding `from "./theme"`, and the emitted module died with "Cannot find module './theme'" — after
    // the file had already been retired.
    const src = [
      `export {`,
      `  KIT_THEMES, themeById,`,
      `  // #2488: the designer-writable theme store's sync hooks — the components slice pushes it in.`,
      `  setActiveKitThemes,`,
      `} from "./theme";`,
    ].join("\n");
    expect(relativeSpecifiers(src).map((s) => s.spec)).toEqual(["./theme"]);
  });

  it("reports a position that indexes into the ORIGINAL string", () => {
    // Blanking must preserve length; a shortening strip would corrupt every offset after a comment and
    // splice the rewrite into the wrong place.
    const src = `/* a comment */\nimport { a } from "./a";`;
    const [hit] = relativeSpecifiers(src);
    expect(src.slice(hit.at, hit.at + hit.spec.length)).toBe("./a");
  });

  it("absolutizes it against the importing file's directory", () => {
    const src = `export { themeById } from "./theme";`;
    expect(absolutizeImports(src, "shared/ui/kit/index.ts")).toContain(`from "@/shared/ui/kit/theme"`);
  });

  it("absolutizes through the apostrophe comment end to end", () => {
    const src = [
      `export {`,
      `  // the store's hooks`,
      `  setActiveKitThemes,`,
      `} from "./theme";`,
    ].join("\n");
    const out = absolutizeImports(src, "shared/ui/kit/index.ts");
    expect(out).toContain(`from "@/shared/ui/kit/theme"`);
    expect(out).not.toContain(`"./theme"`);
    expect(out).toContain("the store's hooks");   // the comment itself must survive the rewrite
  });
});

describe("blankComments", () => {
  it("preserves length exactly", () => {
    const src = `const a = 1; // trailing\n/* block */ const b = 2;`;
    expect(blankComments(src)).toHaveLength(src.length);
  });

  it("preserves newlines so line-anchored patterns still line up", () => {
    const src = `/* one\ntwo */\nimport { a } from "./a";`;
    expect(blankComments(src).split("\n")).toHaveLength(src.split("\n").length);
  });

  it("does not blank a `//` inside a string", () => {
    const src = `const u = "https://x.dev";`;
    expect(blankComments(src)).toBe(src);
  });

  it("leaves code untouched", () => {
    const src = `import { a } from "./a";`;
    expect(blankComments(src)).toBe(src);
  });
});
