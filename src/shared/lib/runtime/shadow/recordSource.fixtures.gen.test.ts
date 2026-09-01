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
  exportedNames, seedMatchesFile, importsSiblingsByRecordId, entriesImportingStatically,
  seedAdoption, seedAnswersSpecifier,
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

/** Export-shaped subjects for `exportedNames`. Kept separate from SUBJECTS so the comment corpus above
 *  — which the already-merged Rust tests read — is not disturbed by growing this one. */
const EXPORTS: Array<[string, string]> = [
  ["a function declaration", "export function f() {}\n"],
  ["a const", "export const a = 1;\n"],
  ["default plus async", "export default async function go() {}\n"],
  ["a class, an interface, a type and an enum", "export class C {}\nexport interface I {}\nexport type T = 1;\nexport enum E { A }\n"],
  ["a brace clause", "export { a, b };\n"],
  // The `treeexplorerpage` case: the `type` keyword between `export` and the brace defeated the pattern,
  // so a module re-exporting a type read as not exporting it and the retirement guard refused it for
  // "dropping" a name its file exports on the next line.
  ["a type re-export COUNTS", 'export type { TreeNodeData } from "./tree";\n'],
  ["a renamed export takes the module-side name", "export { a as b };\n"],
  ["an inline-type member inside a clause", "export { type A, b };\n"],
  ["a multi-line clause", "export {\n  a,\n  b,\n};\n"],
  // Unknowable — a partial set is worse than no answer.
  ["a star re-export makes the set unknowable", 'export * from "./everything";\n'],
  // Must NOT count.
  ["a non-exported declaration", "function hidden() {}\nconst x = 1;\n"],
  ["`export` inside a comment is not an export", "// export function ghost() {}\nexport const real = 1;\n"],
  ["`export` inside a string is not an export", 'const s = "export const ghost = 1;";\nexport const real = 1;\n'],
  ["nothing at all", "const a = 1;\n"],
];

/** `importsSiblingsByRecordId` subjects — the `@/components/<id>` form and its near misses. */
const SIBLINGS: Array<[string, string]> = [
  ["a sibling-by-id import", 'import { X } from "@/components/glance-session-log";\n'],
  ["two of them, deduped", 'import { A } from "@/components/a";\nimport { B } from "@/components/a";\nimport { C } from "@/components/c";\n'],
  ["single quotes", "import { X } from '@/components/x';\n"],
  ["an ordinary alias is not one", 'import { Card } from "@/shared/ui/data/Card";\n'],
  ["a relative import is not one", 'import { X } from "./x";\n'],
  ["no imports at all", "export const a = 1;\n"],
];

/** `entriesImportingStatically` — a synthetic two-entry repo, so the decision is testable with no disk. */
const ENTRY_CASES: Array<[string, string, Record<string, string>]> = [
  [
    "main.tsx imports it statically",
    "app/console/ConsoleGraphHost",
    { "app/main.tsx": 'import { ConsoleGraphHost } from "@/app/console/ConsoleGraphHost"\n', "app/App.tsx": "export const App = 1;\n" },
  ],
  [
    "both entries import it",
    "shared/ui/Card",
    { "app/main.tsx": 'import { Card } from "@/shared/ui/Card"\n', "app/App.tsx": 'import { Card } from "@/shared/ui/Card"\n' },
  ],
  [
    "neither does",
    "features/sounds/index",
    { "app/main.tsx": 'import { X } from "@/x"\n', "app/App.tsx": "export const App = 1;\n" },
  ],
  [
    "a MENTION in a comment is not a static import",
    "app/console/TerminalHost",
    { "app/main.tsx": '// see "@/app/console/TerminalHost" for why\nexport const m = 1;\n', "app/App.tsx": "export const App = 1;\n" },
  ],
  [
    "a missing entry file is skipped, not an error",
    "shared/ui/Card",
    { "app/main.tsx": 'import { Card } from "@/shared/ui/Card"\n' },
  ],
];

/** `seedAdoption` — the promoter's three-way verdict. Each subject is a shape that cost something. */
const ADOPTIONS: Array<[string, { seedSrcText: string; seedProvides: string | null; recordSrcText: string; recordProvides: string | null; fileSrc: string }]> = [
  [
    "an identical seed is KEPT",
    { seedSrcText: "export function f() {\\n  return 1;\\n}\\n", seedProvides: "@/x/f", recordSrcText: "export function f() {\\n  return 1;\\n}\\n", recordProvides: "@/x/f", fileSrc: "export function f() {\\n  return 1;\\n}\\n" },
  ],
  [
    // The byte that would otherwise silently overwrite a correct seed. `norm` inside the function is
    // what makes this `keep` rather than `adopt`.
    "a seed differing ONLY by a trailing newline is still KEPT",
    { seedSrcText: `${"export function f() {\\n  return 1;\\n}\\n"}\n\n`, seedProvides: "@/x/f", recordSrcText: "export function f() {\\n  return 1;\\n}\\n", recordProvides: "@/x/f", fileSrc: "export function f() {\\n  return 1;\\n}\\n" },
  ],
  [
    "a prose preamble does not make a matching seed stale",
    { seedSrcText: `// AS GRAPH SOURCE\n// why\n${"export function f() {\\n  return 1;\\n}\\n"}`, seedProvides: "@/x/f", recordSrcText: "export function f() {\\n  return 1;\\n}\\n", recordProvides: "@/x/f", fileSrc: "export function f() {\\n  return 1;\\n}\\n" },
  ],
  [
    // The eleven-seed case: the body matches, but a preview stub's imports and its whole fallback
    // component sit in what `splitPreamble` calls the preamble. A body-only check called these identical
    // while they shipped a duplicate import block — 21 typecheck errors, visible only in `.bsc-records/`.
    "a preamble containing CODE makes it stale, not a match",
    { seedSrcText: `import { X } from "@/x";\nconst LocalPageFallback = () => null;\n${"export function f() {\\n  return 1;\\n}\\n"}`, seedProvides: "@/x/f", recordSrcText: "export function f() {\\n  return 1;\\n}\\n", recordProvides: "@/x/f", fileSrc: "export function f() {\\n  return 1;\\n}\\n" },
  ],
  [
    "a differing `provides` alone makes it stale",
    { seedSrcText: "export function f() {\\n  return 1;\\n}\\n", seedProvides: "@/x/old", recordSrcText: "export function f() {\\n  return 1;\\n}\\n", recordProvides: "@/x/f", fileSrc: "export function f() {\\n  return 1;\\n}\\n" },
  ],
  [
    "adopting that would DROP an export is REFUSED, and the export is named",
    { seedSrcText: "export function f() {}\nexport const keepMe = 1;\n", seedProvides: "@/x/f", recordSrcText: "export function f() {}\n", recordProvides: "@/x/f", fileSrc: "export function f() {\\n  return 1;\\n}\\n" },
  ],
  [
    // `exportedNames` answers null for `export *`, and null must mean DO NOT JUDGE. Treating it as the
    // empty set would make the lost-export check pass vacuously on exactly the unknowable modules.
    "an unknowable record export set declines to judge rather than reporting everything lost",
    { seedSrcText: "export function f() {}\nexport const other = 1;\n", seedProvides: "@/x/f", recordSrcText: 'export * from "./all";\n', recordProvides: "@/x/f", fileSrc: "export function f() {\\n  return 1;\\n}\\n" },
  ],
  [
    "a plain stale seed is ADOPTED",
    { seedSrcText: "export function f() { return 0; }\n", seedProvides: "@/x/f", recordSrcText: "export function f() {\\n  return 1;\\n}\\n", recordProvides: "@/x/f", fileSrc: "export function f() {\\n  return 1;\\n}\\n" },
  ],
];

/** `seedAnswersSpecifier` — exact match, with a case-only near miss reported separately. */
const SPECS: Array<[string, string, string[]]> = [
  ["an exact match", "@/shared/ui/Card", ["@/shared/ui/Card", "@/other"]],
  ["whitespace around a seed entry is trimmed", "@/shared/ui/Card", ["  @/shared/ui/Card  "]],
  // `pageheader`: the seed said `@/shared/ui/pages/PageHeader` against a `pageHeader.tsx` file. A
  // case-insensitive check would wave it through — it works on Windows and breaks on a case-sensitive fs.
  ["a CASE-only difference is a near miss, not a match", "@/shared/ui/pages/pageHeader", ["@/shared/ui/pages/PageHeader"]],
  ["absent entirely", "@/nowhere", ["@/shared/ui/Card"]],
  ["nothing seeded at all", "@/nowhere", []],
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
    const exports = EXPORTS.map(([label, source]) => {
      const set = exportedNames(source);
      // A Set does not survive JSON; null (a star re-export) must stay distinguishable from empty.
      return { label, source, names: set === null ? null : [...set].sort() };
    });
    const siblings = SIBLINGS.map(([label, source]) => ({ label, source, ...importsSiblingsByRecordId(source) }));
    const entries = ENTRY_CASES.map(([label, relSpecifier, files]) => ({
      label,
      relSpecifier,
      files,
      importedBy: entriesImportingStatically(
        "/repo",
        relSpecifier,
        (p: string) => files[p.replace("/repo/src/", "")] ?? "",
        (p: string) => p.replace("/repo/src/", "") in files,
      ),
    }));
    const seedFile = PAIRS.map(([label, seedSrcText, fileSrc]) => ({
      label,
      seedSrcText,
      fileSrc,
      ...seedMatchesFile({ seedSrcText, fileSrc }),
    }));

    const adoptions = ADOPTIONS.map(([label, input]) => ({ label, input, ...seedAdoption(input) }));
    const specs = SPECS.map(([label, spec, seedProvides]) => ({
      label, spec, seedProvides, ...seedAnswersSpecifier({ spec, seedProvides }),
    }));

    const next = {
      note: "GENERATED from scripts/lib/recordSource.mjs — do not hand-edit; see the .gen.test.ts",
      cases,
      pairs,
      exports,
      siblings,
      entries,
      seedFile,
      adoptions,
      specs,
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

    // Each decision function must answer BOTH ways somewhere in its corpus, or it proves only that it
    // runs. A guard that always says "no export" and one that always says "yes" both pass a one-sided set.
    const named = EXPORTS.map(([, s]) => exportedNames(s));
    expect(named.filter((n) => n !== null && n.size > 0).length, "never found an export").toBeGreaterThanOrEqual(6);
    expect(named.filter((n) => n !== null && n.size === 0).length, "never found an EMPTY module").toBeGreaterThanOrEqual(2);
    expect(named.filter((n) => n === null).length, "the unknowable case is missing").toBeGreaterThanOrEqual(1);

    const sib = SIBLINGS.map(([, s]) => importsSiblingsByRecordId(s));
    expect(sib.filter((r) => r.any).length).toBeGreaterThanOrEqual(3);
    expect(sib.filter((r) => !r.any).length).toBeGreaterThanOrEqual(3);

    const ent = ENTRY_CASES.map(([, spec, files]) =>
      entriesImportingStatically("/repo", spec, (p: string) => files[p.replace("/repo/src/", "")] ?? "", (p: string) => p.replace("/repo/src/", "") in files));
    expect(ent.filter((e) => e.length > 0).length, "never found a static import").toBeGreaterThanOrEqual(2);
    expect(ent.filter((e) => e.length === 0).length, "never refused one").toBeGreaterThanOrEqual(2);

    // All THREE verdicts must appear, or the corpus proves only that the function returns something.
    const verdicts = ADOPTIONS.map(([, i]) => seedAdoption(i).verdict);
    for (const v of ["keep", "adopt", "refuse"]) {
      expect(verdicts.filter((x) => x === v).length, `no ${v} case`).toBeGreaterThanOrEqual(1);
    }
    const answered = SPECS.map(([, spec, seedProvides]) => seedAnswersSpecifier({ spec, seedProvides }));
    expect(answered.filter((a) => a.ok).length, "never matched").toBeGreaterThanOrEqual(2);
    expect(answered.filter((a) => a.nearMiss.length > 0).length, "no near-miss case").toBeGreaterThanOrEqual(1);
  });
});
