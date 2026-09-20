import { describe, expect, it } from "vitest";
import { runtimeImports, stripComments } from "./lib/recordSource.mjs";

// `runtimeImports` is the ONE definition of "what specifiers does this record need at runtime", shared
// by `bsc components promote-seed` and by `platformBoundary.test.ts`. A false positive here does not fail
// loudly — it silently refuses a promotion, with an error naming a specifier the module never imports.
describe("runtimeImports", () => {
  it("reads a plain import and a re-export", () => {
    const src = [
      `import { a } from "@/x/a";`,
      `export { b } from "@/x/b";`,
    ].join("\n");
    expect(runtimeImports(src)).toEqual(["@/x/a", "@/x/b"]);
  });

  it("skips a whole-statement type import but keeps a mixed one", () => {
    const src = [
      `import type { T } from "@/types";`,
      `import { type U, V } from "@/mixed";`,
    ].join("\n");
    expect(runtimeImports(src)).toEqual(["@/mixed"]);
  });

  it("reads an import whose clause WRAPS across lines", () => {
    // The reason the keyword→`from` gap has to cross newlines, and therefore the reason the comment
    // false positive below is possible at all. If a fix ever breaks this, it is the wrong fix.
    const src = `import {\n  a,\n  b,\n} from "@/wrapped";`;
    expect(runtimeImports(src)).toEqual(["@/wrapped"]);
  });

  it("does NOT read a `from \"…\"` written inside a doc comment", () => {
    // #nodeUrn: `export function isNodeUrn(…)` matched forward five lines into a JSDoc example and
    // reported `@bsc/algorithms/fibonacci`, a package the module never imports — which blocked its
    // retirement with an error naming a specifier that appears nowhere in its code. The `^` anchor
    // cannot see this, because the match STARTS on a real code line.
    const src = [
      `export function isNodeUrn(s: string): boolean {`,
      `  return parseNodeUrn(s) !== null;`,
      `}`,
      ``,
      `/** A library import specifier — the reference a component author writes`,
      ` *  (\`import { fibonacci } from "@bsc/algorithms/fibonacci"\`). */`,
      `export interface LibrarySpec { graph: string }`,
    ].join("\n");
    expect(runtimeImports(src)).toEqual([]);
  });

  it("does NOT read one written inside a line comment", () => {
    expect(runtimeImports(`// see: import { x } from "@/nope";\nimport { y } from "@/yes";`)).toEqual(["@/yes"]);
  });

  it("still reads a real import that FOLLOWS a comment mentioning another", () => {
    // The lossy direction is the dangerous one: dropping a real import under-reports what a record
    // needs and packages something unloadable.
    const src = [`/* import { x } from "@/nope"; */`, `import { y } from "@/yes";`].join("\n");
    expect(runtimeImports(src)).toEqual(["@/yes"]);
  });
});

describe("stripComments", () => {
  it("keeps a `//` that lives inside a string", () => {
    expect(stripComments(`const u = "https://x.dev";`)).toBe(`const u = "https://x.dev";`);
  });

  it("keeps comment markers inside a template literal", () => {
    expect(stripComments("const t = `a /* not a comment */ b`;")).toBe("const t = `a /* not a comment */ b`;");
  });

  it("preserves newlines so `^`-anchored matching still lines up", () => {
    const src = `/* one\ntwo\nthree */\nimport { a } from "@/a";`;
    expect(stripComments(src).split("\n").length).toBe(src.split("\n").length);
  });

  it("does not treat an escaped quote as the end of a string", () => {
    expect(stripComments(`const s = "a\\"// b";`)).toBe(`const s = "a\\"// b";`);
  });
});
