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
  relativeSpecifiers, aliasFor, aliasForDir, absolutizeImports, dropAssetImports, runtimeImports,
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

/** The import cluster. `fromRel` is the record's own path — what a relative specifier resolves against. */
const IMPORTS: Array<[string, string, string]> = [
  ["one relative import", 'import { X } from "./x";\n', "features/a/b.ts"],
  ["a parent-relative import", 'import { X } from "../ui/X";\n', "features/a/b.ts"],
  ["a deep parent walk", 'import { X } from "../../shared/X";\n', "features/a/b/c.ts"],
  ["an index specifier", 'import { X } from "./sub";\n', "features/a/b.ts"],
  ["an already-aliased import is left alone", 'import { X } from "@/shared/X";\n', "features/a/b.ts"],
  ["a package import is left alone", 'import React from "react";\n', "features/a/b.ts"],
  // MULTIPLE specifiers in one source. Each rewrite changes the string's length, so a forward splice
  // corrupts every offset after the first — this is what proves the reverse order.
  ["THREE relative imports rewritten together", 'import { A } from "./a";\nimport { B } from "../b";\nimport { C } from "./c/d";\n', "features/x/y.ts"],
  ["a bare relative side-effect import", 'import "./styles";\n', "features/a/b.ts"],
  ["a dynamic import is rewritten too", 'const m = await import("./lazy");\n', "features/a/b.ts"],
  ["a vi.mock target is rewritten", 'vi.mock("./dep");\n', "features/a/b.test.ts"],
  // The traps. `blankComments` is what makes these safe, and it is why offsets had to survive it.
  ["a relative specifier in a LINE comment is not an import", '// see "./ghost" for why\nimport { X } from "./x";\n', "features/a/b.ts"],
  ["a relative specifier in a BLOCK comment is not an import", '/* lifted from "./ghost" */\nimport { X } from "./x";\n', "features/a/b.ts"],
  // THE CASE blankComments EXISTS FOR, and the one the other comment subjects miss: a COMMENTED-OUT
  // import is line-anchored, so `^[ \t]*import` matches it in the raw source. Only blanking the comment
  // first stops it being rewritten as a real dependency. Without this subject, deleting the blanking step
  // passes the whole corpus.
  ["a COMMENTED-OUT import inside a block comment is not an import", '/*\nimport { Ghost } from "./ghost";\n*/\nimport { X } from "./x";\n', "features/a/b.ts"],
  ["a commented-out import on a `//` line is not one either", '// import { Ghost } from "./ghost";\nimport { X } from "./x";\n', "features/a/b.ts"],
  ["a require() inside a doc comment is prose, not a dependency", ' * `require("./example")` shows the shape\nimport { X } from "./x";\n', "features/a/b.ts"],
  // PROSE ONLY, with no real import to rewrite — the strongest form of the guard: the whole source must
  // come back byte-identical. The comment subjects above still CHANGE, because their real import is
  // rewritten alongside the prose that must not be.
  ["a source that is ONLY prose mentioning a specifier is untouched", '// see "./ghost" for why\nexport const a = 1;\n', "features/a/b.ts"],
  ["a specifier inside a STRING is not an import", 'const s = "./notanimport";\nexport const a = 1;\n', "features/a/b.ts"],
  // THE OFFSET-COORDINATE CASE. `blankComments` preserves UTF-16 length, not BYTE length — an em-dash
  // is one UTF-16 unit but three UTF-8 bytes, and blanking replaces it with a one-byte space. A port
  // that splices on a raw byte offset therefore writes in the wrong place. Not hypothetical: this
  // repo's comments are full of em-dashes, `src/features/sounds/index.ts` opens with one, and the census
  // caught the corruption as that record disagreeing with its own file.
  ["a NON-ASCII comment before an import — the offset-coordinate case", '// Public API barrel — cross-feature consumers import ONLY from here.\nimport { X } from "./x";\n', "features/sounds/index.ts"],
  ["several non-ascii comments before several imports", '// one — dash\nimport { A } from "./a";\n// two — dash\nimport { B } from "../b";\n', "features/x/y.ts"],
  ["nothing relative at all", "export const a = 1;\n", "features/a/b.ts"],
];

/** `dropAssetImports` — what a record cannot resolve. */
const ASSETS: Array<[string, string]> = [
  ["a css import goes", 'import "./styles.css";\nexport const a = 1;\n'],
  ["a bare svg import goes", 'import "./icon.svg";\nexport const a = 1;\n'],
  // A BOUND asset import STAYS, and that is right rather than an oversight: `icon` has a user, so
  // deleting the line would leave an undefined reference. Only side-effect imports — which bind nothing
  // — can be removed safely. The pattern requires a quote directly after `import`, which is what draws
  // that line.
  ["a BOUND asset import stays — it binds a value someone uses", 'import icon from "./icon.svg";\nexport const a = icon;\n'],
  ["several asset kinds go", 'import "./a.scss";\nimport "./b.png";\nimport "./c.webp";\nexport const a = 1;\n'],
  ["a code import STAYS", 'import { X } from "./x";\nexport const a = 1;\n'],
  ["a .ts import stays", 'import { X } from "./x.ts";\nexport const a = 1;\n'],
  ["nothing to drop", "export const a = 1;\n"],
];

/** `aliasForDir` / `aliasFor` — path collapsing, including the `src/` strip. */
const ALIASES: Array<[string, string, string]> = [
  ["a sibling", "features/a", "./b"],
  ["a parent walk", "features/a/b", "../c"],
  ["two parents up", "features/a/b/c", "../../d"],
  ["a `src/` prefix is stripped", "src/features/a", "./b"],
  ["a dot segment collapses", "features/a", "./././b"],
  ["from the root", "", "./b"],
];

/** `runtimeImports` — the corrected behaviour, pinned here too so both stores agree. */
const RUNTIME: Array<[string, string]> = [
  ["a plain import", 'import { X } from "./x";\n'],
  ["an all-inline-type clause yields nothing", 'import { type A, type B } from "./ab";\n'],
  ["a MIXED clause still counts", 'import { type A, b } from "./ab";\n'],
  ["a statement-level `import type` yields nothing", 'import type { T } from "./t";\n'],
  ["a bare side-effect import counts", 'import "./a.css";\n'],
  ["a re-export counts", 'export { A } from "./a";\n'],
  ["a default import counts", 'import React from "react";\n'],
  ["an import in a comment does not", '// import { X } from "./ghost";\nexport const a = 1;\n'],
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
      imports: IMPORTS.map(([label, source, fromRel]) => ({
        label,
        source,
        fromRel,
        // The SPEC SEQUENCE, not the raw offsets: JS counts UTF-16 units and Rust regex reports bytes,
        // so `at` is not comparable across the two. The rewritten source below is what proves the
        // offsets were used correctly.
        specifiers: relativeSpecifiers(source).map((r: { spec: string }) => r.spec),
        absolutized: absolutizeImports(source, fromRel),
      })),
      assets: ASSETS.map(([label, source]) => ({ label, source, dropped: dropAssetImports(source) })),
      aliases: ALIASES.map(([label, fromDir, spec]) => ({
        label, fromDir, spec,
        forDir: aliasForDir(fromDir, spec),
        forFile: aliasFor(`${fromDir}/mod.ts`, spec),
      })),
      runtime: RUNTIME.map(([label, source]) => ({ label, source, imports: runtimeImports(source) })),
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

    // The import cluster, both directions: sources that get rewritten and sources that must not.
    const rewritten = IMPORTS.filter(([, s, f]) => absolutizeImports(s, f) !== s).length;
    const untouched = IMPORTS.filter(([, s, f]) => absolutizeImports(s, f) === s).length;
    expect(rewritten, "nothing was rewritten").toBeGreaterThanOrEqual(7);
    expect(untouched, "everything was rewritten — the prose/alias guards prove nothing").toBeGreaterThanOrEqual(4);
    expect(ASSETS.filter(([, s]) => dropAssetImports(s) !== s).length).toBeGreaterThanOrEqual(3);
    expect(ASSETS.filter(([, s]) => dropAssetImports(s) === s).length).toBeGreaterThanOrEqual(3);
    expect(RUNTIME.filter(([, s]) => runtimeImports(s).length > 0).length).toBeGreaterThanOrEqual(4);
    expect(RUNTIME.filter(([, s]) => runtimeImports(s).length === 0).length).toBeGreaterThanOrEqual(3);
  });
});
