// The import scan, captured from the LIVE TypeScript so the Rust scanner can be proved equal.
//
// WHY THIS FIXTURE EXISTS. This repo runs THREE import scanners and they disagree on 7 of the 11 cases
// first measured. `parseImports` here is a per-line anchored regex; `emit::import_specifiers` is a raw
// keyword-substring scan that reads comments and string literals as imports; `harvest::internal_imports`
// is tree-sitter but walks only `import_statement`, so every `export … from` is invisible to it. No one
// of the three is right on all of them, and two are on live paths — emit's closure vendoring and
// harvest's buildability verdict.
//
// So the Rust side is not a port of this file. It is a tree-sitter scanner meant to be RIGHT, and this
// fixture is how "right" gets an independent second opinion: wherever the TypeScript is correct, Rust
// must agree with it case for case, and the ONE place Rust deliberately goes further — a dynamic
// `import()`, which the anchored regex cannot see — is recorded here with the TypeScript's own answer so
// the divergence is stated in the artifact rather than hidden in a Rust-only expectation.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/runtime/shadow/importScan.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseImports } from "@/shared/lib/runtime/shadow/pageBinding";

const FIXTURE = join(process.cwd(), "src/shared/lib/runtime/shadow/importScan.fixtures.json");

/** Sources put through the scanner. Each is labelled with the thing it pins, and the set deliberately
 *  mixes forms that MUST be seen with forms that must NOT be — a scanner is defined as much by its
 *  false positives as by its coverage, which is precisely how the substring scan fails. */
const SUBJECTS: Array<[string, string]> = [
  ["a plain named import", 'import { X } from "./x";\n'],
  ["a default import", 'import React from "react";\n'],
  ["a namespace import", 'import * as ns from "./ns";\n'],
  ["default plus named", 'import React, { useState } from "react";\n'],
  ["a renamed binding takes the MODULE side name", 'import { a as b } from "./ab";\n'],
  ["a first-party alias", 'import { Card } from "@/shared/ui/data/Card";\n'],
  ["a parent-relative specifier", 'import { X } from "../ui/X";\n'],
  ["a scoped npm package", 'import { z } from "@scope/pkg/sub";\n'],
  ["single quotes", "import { X } from './x';\n"],
  ["an indented import", '  import { X } from "./x";\n'],
  ["a multi-line named list", 'import {\n  A,\n  B,\n} from "./ab";\n'],

  // The re-export forms. esbuild compiles these to the same require() an import produces, so a scanner
  // blind to them certifies a broken closure — the gap that shipped `projectspage` (#3874).
  ["a re-export is an import at runtime", 'export { ProjectRow } from "./published/ProjectRow";\n'],
  ["export-star is too", 'export * from "./a";\n'],
  ["export-star-as is too", 'export * as ns from "./a";\n'],
  ["a renamed re-export", 'export { a as b } from "./ab";\n'],

  // Type-only forms. Erased before anything resolves, so reporting them pads a worklist with non-work.
  ["a statement-level type import is erased", 'import type { T } from "./t";\n'],
  ["an all-inline-type clause is erased too", 'import { type A, type B } from "./ab";\n'],
  ["ONE value binding keeps the whole import", 'import { type A, b } from "./ab";\n'],
  ["a type re-export is erased", 'export type { T } from "./t";\n'],

  // Side-effect and dynamic.
  ["a bare side-effect import", 'import "./a.css";\n'],
  ["a dynamic import — the regex cannot see it", 'const m = await import("./lazy");\n'],

  // The false-positive corpus. Every one of these is a NON-import that a naive scan reads as one, and
  // each is a real shape in this tree: records carry provenance headers, and prose says "from".
  ["`from \"…\"` inside a line comment is not an import", '// see the note from "./ghost" for why\nimport { X } from "./x";\n'],
  ["`from \"…\"` inside a block comment is not an import", '/* lifted from "./ghost" */\nimport { X } from "./x";\n'],
  ["`from \"…\"` inside a string literal is not an import", "const s = 'from \"./strghost\"';\nimport { X } from \"./x\";\n"],
  ["a require() call is not an ESM import", 'function f() {\n  const m = require("./r");\n}\nimport { X } from "./x";\n'],
  ["the word `transform` does not contain an import", 'const transform = 1; // from nothing\nimport { X } from "./x";\n'],
  ["a provenance header naming a specifier is not an import", '// `@/shared/ui/data/Card` after the original module was retired\nexport function Card() {}\n'],

  // Multiples and shape.
  ["several imports keep source order", 'import { A } from "./a";\nimport { B } from "./b";\nimport "./c.css";\n'],
  // The TypeScript runs its two regexes in SEQUENCE — every `from` import, then every bare one — so a
  // bare import that comes FIRST in the source is reported LAST. Recorded rather than avoided: it is the
  // second place the Rust scanner deliberately differs, and a fixture that only used sources where the
  // two orderings coincide would have hidden it.
  ["a bare import BEFORE a named one", 'import "./a.css";\nimport { B } from "./b";\n'],
  ["the same module twice", 'import { A } from "./ab";\nimport { B } from "./ab";\n'],
  ["a file with no imports at all", 'export function f() { return 1; }\n'],
];

describe("importScan fixtures", () => {
  it("captures parseImports over every subject", () => {
    const cases = SUBJECTS.map(([label, source]) => ({
      label,
      source,
      // The live TypeScript's answer. Where it is WRONG (the dynamic import) this records the wrong
      // answer on purpose — the Rust test names that case as an intended divergence rather than
      // quietly expecting something the fixture does not say.
      imports: parseImports(source),
    }));
    const next = { note: "GENERATED from src/shared/lib/runtime/shadow/pageBinding.ts — do not hand-edit; see the .gen.test.ts", cases };

    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("is non-vacuous: it carries real coverage in both directions", () => {
    const cases = SUBJECTS.map(([, source]) => parseImports(source));
    const seen = cases.filter((c) => c.length > 0).length;
    const refused = cases.filter((c) => c.length === 0).length;
    expect(seen, "a scanner fixture that sees nothing proves nothing").toBeGreaterThanOrEqual(20);
    expect(refused, "the false-positive corpus is the half that catches a substring scan").toBeGreaterThanOrEqual(5);
  });
});
