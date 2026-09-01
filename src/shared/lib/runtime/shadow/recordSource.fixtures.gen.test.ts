// The record-vs-file comparison primitives, captured from the LIVE TypeScript so the Rust port can be
// proved equal — the same shape `importScan.fixtures.gen.test.ts` uses for the import scanner.
//
// WHY A FIXTURE AND NOT TWO TEST SUITES. `scripts/lib/recordSource.mjs` exists as ONE module rather than
// two copies because a census that grades a candidate differently from the refresh that fixes it is worse
// than either being wrong alone. Porting it to Rust reintroduces exactly that risk for as long as both
// live — `emit-records.mjs` and four gate guards keep importing the JS — so the two are pinned to one
// recorded answer instead of two independently-written expectations.
//
// The subjects deliberately mix inputs the function CHANGES with inputs it must leave alone. A corpus of
// only the former proves a function does something; it does not prove it does nothing else.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/runtime/shadow/recordSource.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  norm, blankComments, stripComments, codeOnly, splitPreamble,
} from "../../../../../scripts/lib/recordSource.mjs";

const FIXTURE = join(process.cwd(), "src/shared/lib/runtime/shadow/recordSource.fixtures.json");

/** Single-source subjects — every function except `splitPreamble`, which needs a pair. */
const SUBJECTS: Array<[string, string]> = [
  ["plain code, untouched", "export const a = 1;\n"],
  ["a line comment", "const a = 1; // why\nconst b = 2;\n"],
  ["a block comment on one line", "const a = /* why */ 1;\n"],
  ["a block comment spanning lines", "/*\n * why\n */\nconst a = 1;\n"],
  ["a JSDoc opener — the splitPreamble case", "/**\n * why\n */\nexport function f() {}\n"],

  // The false-positive corpus. Each is a NON-comment that a naive scan eats, and each is a real shape in
  // this tree: records carry provenance headers full of specifiers, and prose says "from".
  ["`//` inside a double-quoted string is not a comment", 'const u = "https://example.com/x";\nconst a = 1;\n'],
  ["`//` inside a single-quoted string is not a comment", "const u = 'http://x//y';\nconst a = 1;\n"],
  ["`/*` inside a string is not a comment", 'const s = "/* not a comment */";\nconst a = 1;\n'],
  ["a template literal protects both markers", "const t = `// not\\n/* not */`;\nconst a = 1;\n"],
  ["an escaped quote does not end the string", 'const s = "a\\"// still string";\nconst a = 1;\n'],
  ["a comment containing a quote does not open a string", "// it's fine\nconst a = 1;\n"],
  ["a comment containing a block opener", "// see /* this\nconst a = 1;\n"],

  // Degenerate shapes.
  ["an unterminated block comment runs to the end", "const a = 1;\n/* never closed\nconst b = 2;\n"],
  ["an unterminated string", 'const s = "never closed\nconst a = 1;\n'],
  ["a lone slash is not a comment", "const half = 6 / 2;\n"],
  ["empty input", ""],
  ["whitespace only", "   \n\t\n"],

  // Normalisation shapes.
  ["CRLF line endings", "const a = 1;\r\nconst b = 2;\r\n"],
  ["trailing whitespace and blank lines", "const a = 1;\n\n   \n"],
  ["collapsible interior whitespace", "const   a\t=\n\n1;\n"],

  // The UTF-16 vs char question, measured rather than assumed: JS indexes by code unit, Rust by char, so
  // an ASTRAL character (this emoji) is 2 units to JS and 1 char to Rust. A BMP character (the em dash)
  // is 1 to both. If `blankComments` diverges anywhere, it is here.
  ["a comment with an astral character", "// 🎉 party\nconst a = 1;\n"],
  ["a comment with a BMP non-ascii character", "// em — dash\nconst a = 1;\n"],
];

/** `splitPreamble` takes a PAIR, so it gets its own corpus. */
const PAIRS: Array<[string, string, string]> = [
  [
    "the file's first line anchors the split",
    "// AS GRAPH SOURCE\n// why this record exists\nexport function f() {}\n",
    "export function f() {}\n",
  ],
  [
    "a file OPENING with JSDoc — the case that held six records back",
    "// AS GRAPH SOURCE\n/**\n * doc\n */\nexport function f() {}\n",
    "/**\n * doc\n */\nexport function f() {}\n",
  ],
  ["no preamble at all", "export function f() {}\n", "export function f() {}\n"],
  [
    "no shared line — falls through to the whole record as body",
    "export const totallyDifferent = 1;\n",
    "export function f() {}\n",
  ],
  [
    "a short shared line cannot anchor the heuristic",
    "// preamble\n}\nexport const somethingLongEnough = 1;\n",
    "}\nexport const somethingLongEnough = 1;\n",
  ],
];

describe("recordSource fixtures", () => {
  it("captures every primitive over every subject", () => {
    const cases = SUBJECTS.map(([label, source]) => ({
      label,
      source,
      norm: norm(source),
      blankComments: blankComments(source),
      stripComments: stripComments(source),
      codeOnly: codeOnly(source),
    }));
    const pairs = PAIRS.map(([label, recordSrc, fileSrc]) => {
      const [preamble, body] = splitPreamble(recordSrc, fileSrc);
      return { label, recordSrc, fileSrc, preamble, body };
    });
    const next = {
      note: "GENERATED from scripts/lib/recordSource.mjs — do not hand-edit; see the .gen.test.ts",
      cases,
      pairs,
    };

    if (process.env.UPDATE_FIXTURES) {
      writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    }
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("is non-vacuous: it carries subjects each function CHANGES and subjects it must not", () => {
    const changed = (f: (s: string) => string) => SUBJECTS.filter(([, s]) => f(s) !== s).length;
    const unchanged = (f: (s: string) => string) => SUBJECTS.filter(([, s]) => f(s) === s).length;
    // A comment-stripper that never strips, or one that mangles plain code, both pass a one-sided corpus.
    expect(changed(blankComments), "nothing was blanked").toBeGreaterThanOrEqual(8);
    expect(unchanged(blankComments), "plain code must survive untouched").toBeGreaterThanOrEqual(4);
    expect(changed(stripComments)).toBeGreaterThanOrEqual(8);
    expect(unchanged(stripComments)).toBeGreaterThanOrEqual(4);
    // `splitPreamble` must actually split somewhere, and must decline somewhere.
    const split = PAIRS.map(([, r, f]) => splitPreamble(r, f));
    expect(split.filter(([p]) => p !== "").length, "never split").toBeGreaterThanOrEqual(2);
    expect(split.filter(([p]) => p === "").length, "always split").toBeGreaterThanOrEqual(2);
  });
});
