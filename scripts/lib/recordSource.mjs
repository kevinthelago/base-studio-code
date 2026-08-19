// How a FILE's source compares to a RECORD's — the normalizations both the census
// (`retirement-candidates.mjs`) and the refresh (`refresh-drifted-seeds.mjs`) must apply identically.
//
// It is one module rather than two copies because this session has now watched a mirrored helper drift
// three separate times (the e2e harness's copied resolver, twice; the four-resolver split). A census that
// grades a candidate differently from the refresh that fixes it is worse than either being wrong alone:
// the two disagree about which files are safe and there is no way to tell which one to believe.
import { readFileSync } from "node:fs";

/** LF, no trailing whitespace — the byte form every comparison here works in. */
export const norm = (s) => s.replace(/\r\n/g, "\n").trimEnd();

// ── relative specifiers ───────────────────────────────────────────────────────────────────────────
// ONE definition of "a relative specifier a record carries", shared by the guard that rejects them
// (`platformBoundary.test.ts`), the sweep that repairs them (`check-record-imports.mjs`), the
// retirement that must not create new ones (`retire-module.mjs`) and the refresh that absolutizes a
// file into record form (`absolutizeImports`, below). Four readers, one regex — for the same reason
// this module exists at all: a guard that reads imports differently from the fix is worse than either
// being wrong alone.

/** A STATEMENT import/export. Line-ANCHORED, which is what makes it prose-immune with no lexer: a `//`
 *  line and a `*` doc-comment continuation both fail `^[ \t]*(?:import|export)`. The clause is
 *  `[^"';]*?` so it may span lines (a multi-line named-import list) but may cross neither a quote nor a
 *  statement end. */
const STATEMENT_SPEC = /^[ \t]*(?:import|export)\s+(?:type\s+)?[^"';]*?\s*from\s*["']([^"']+)["']/gm;
/** A bare side-effect import — `import "./x.css"`. No clause, still a `require` at runtime. */
const BARE_SPEC = /^[ \t]*import\s*["']([^"']+)["']/gm;
/** The INLINE forms, which cannot be line-anchored: `import("./x").Type` (the type-position form that a
 *  `from "…"` sweep leaves behind — it was the single remaining typecheck error the last time one ran),
 *  a dynamic `import("./x")`, a `require("./x")`, and `vi.mock("./x")` in a carried test. */
const INLINE_SPEC = /\b(?:import|require|vi\.(?:mock|doMock|unmock))\s*\(\s*["']([^"']+)["']/g;

/** The line `index` falls on — how the inline scan tells code from prose. */
const lineAt = (src, index) => {
  const end = src.indexOf("\n", index);
  return src.slice(src.lastIndexOf("\n", index) + 1, end === -1 ? undefined : end);
};

/** A line whose specifier is PROSE, not code: a `//` comment or a `*` / `/*` block-comment line.
 *
 *  Measured over all 2,405 record sources, this is exactly where every inline false positive lives —
 *  `classifyConfig`'s `{@link import("../stages/stageGate").PlanSignals}` and `pageBinding`'s
 *  ``` `require("./y")` ``` are both doc comments explaining the loader, and rewriting them would make
 *  the prose describe something that no longer happens. It deliberately does NOT try to be a lexer: a
 *  TRAILING `// import("./x")` on a code line is still scanned, and a comment-only miss is harmless
 *  because a comment cannot fail at runtime. Hand-rolled comment STRIPPING was tried first and is what
 *  this replaces — it desynchronized on a regex literal containing quotes
 *  (`/^[ \t]*(import|export)…["']([^"']+)["']/`), after which the real doc comment below it was read as
 *  code. Anchoring needs no such state. */
const isProseLine = (line) => /^[ \t]*(?:\*|\/\/|\/\*)/.test(line);

/**
 * `src` with every comment byte replaced by a space — SAME LENGTH, same newlines, same indices.
 *
 * That length-preservation is the whole point: the specifier scan returns `{ spec, at }` positions that a
 * rewriter splices into the ORIGINAL string, so a strip that shortened the text would corrupt every
 * offset after the first comment. Blanking keeps them exact.
 *
 * It is deliberately not a lexer, and it errs toward KEEPING text. It tracks the three constructs that
 * can legally contain `//` — a string, a template literal, an escaped char — and treats everything else
 * as code. A regex literal containing quotes (the case that defeated the earlier hand-rolled stripper)
 * can still confuse the string tracking, but the failure mode is now benign: a comment survives
 * un-blanked, which at worst leaves a false positive that `isProseLine` already filters, rather than
 * blanking real code.
 */
export function blankComments(src) {
  const out = src.split("");
  let i = 0;
  const n = src.length;
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i += 1;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const start = i;
      while (i < n && src[i] !== "\n") i += 1;
      blank(start, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      blank(start, i);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Every RELATIVE specifier in `src`, as `{ spec, at }` — `at` being the index of the specifier text
 * itself, so a rewriter can splice without re-finding it.
 *
 * A record may not import relatively AT ALL, whichever form it takes. The runtime loader routes a
 * specifier to the registry under its literal key, so `./x` needs a registration exactly like an
 * absolute one and `provides` (which matches the exact specifier) can never reach it. That is the rule
 * `platformBoundary.test.ts` states; this is what finds the violations.
 */
export function relativeSpecifiers(src) {
  const out = [];
  // SCAN A COMMENT-BLANKED COPY, splice into the original. `blankComments` replaces comment bytes with
  // spaces, so every index is still the index in `src` and a rewriter can splice without re-finding.
  //
  // WHY: `STATEMENT_SPEC`'s clause is `[^"';]*?`, which may not cross a quote — and an APOSTROPHE in a
  // prose comment inside an `export { … }` block is a quote. `shared/ui/kit/index.ts` had
  // `// … the designer-writable theme store's sync hooks …` between two exported names, so the whole
  // statement failed to match and `from "./theme"` was never absolutized. The record then shipped a
  // relative specifier, which resolves from `src/shared/ui/kit/` and NOT from `.bsc-records/shared/ui/`,
  // so the emitted module died with "Cannot find module './theme'" — after the file was already retired.
  const scan = blankComments(src);
  for (const [re, prose] of [[STATEMENT_SPEC, false], [BARE_SPEC, false], [INLINE_SPEC, true]]) {
    re.lastIndex = 0;
    for (const m of scan.matchAll(re)) {
      if (!m[1].startsWith(".")) continue;
      if (prose && isProseLine(lineAt(src, m.index))) continue;
      out.push({ spec: m[1], at: m.index + m[0].lastIndexOf(m[1]) });
    }
  }
  // De-duplicate by position: the bare and statement patterns can both claim `import "./x"`.
  const seen = new Set();
  return out.filter((s) => !seen.has(s.at) && seen.add(s.at)).sort((a, b) => a.at - b.at);
}

/** `./x` resolved against the DIRECTORY it is imported from, as an `@/…` specifier.
 *
 *  The trailing segment is allowed to be absent: `from "./"` and `from ".."` are real imports naming a
 *  directory's barrel — `@/components/security-flow` carries a test doing exactly that, and it was the
 *  one mispair that survived a first version of the emitter's regex requiring a name after the slash. */
export function aliasForDir(fromDir, spec) {
  const out = [];
  for (const seg of `${fromDir}/${spec}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `@/${out.join("/").replace(/^src\//, "")}`;
}

/** `./x` resolved against `fromRel` — a FILE path, relative to the repo root or to `src/`. */
export const aliasFor = (fromRel, spec) =>
  aliasForDir(fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "", spec);

/**
 * Rewrite every RELATIVE import to its absolute `@/…` form, resolved against `fromRel` (the file's path
 * relative to `src/`).
 *
 * A RECORD HAS NO POSITION ON DISK. The runtime loader vendors its source into whatever module is
 * compiling, so `./bodyStyles` has nothing to be relative TO — only an absolute specifier can be resolved
 * against the registry and the record store. `platformBoundary.test.ts` enforces exactly this, and a
 * refresh that copies a file's source verbatim breaks it on the spot: 24 records failed with "relative —
 * records must import absolutely" the first time the refresh ran.
 *
 * It also matters for the COMPARISON, which is less obvious and was worth 21 candidates: the migration
 * absolutized imports by hand, so a seed and its file differ in import FORM even when the code is
 * identical. Comparing the raw file called 21 records "body differs" that were the same module.
 */
export function absolutizeImports(src, fromRel) {
  let out = src;
  // Back to front, so an earlier splice cannot shift a later index.
  for (const { spec, at } of relativeSpecifiers(src).reverse()) {
    out = out.slice(0, at) + aliasFor(fromRel, spec) + out.slice(at + spec.length);
  }
  return out;
}

/**
 * Drop side-effect imports of ASSETS — `import "./sessionDock.css";` and friends.
 *
 * A file loads its stylesheet as a module because the bundler turns that into a CSS emit. A RECORD is
 * compiled at runtime by the graph loader, which resolves every `require()` against the platform registry
 * and the record store — and a stylesheet is in neither, so the import is a hard "not a registered app
 * module" at load. The app's CSS is already loaded globally through the bundled entry, so the import is
 * redundant for a record as well as fatal.
 *
 * The hand migration did exactly this (`ui-session-dock`'s record has no CSS import while its file does),
 * and re-adding them broke 10 records. The default gate stayed GREEN — it was the e2e mount sweep that
 * failed, because this is a property of the module the loader builds, not of the source it is built from.
 */
export const dropAssetImports = (src) =>
  src.replace(/^[ \t]*import\s+['"][^'"]+\.(?:css|scss|sass|less|svg|png|jpg|jpeg|gif|webp)['"];?[ \t]*\n?/gm, "");

/** A file read as a record would hold it: LF-normalized, asset imports dropped, imports absolutized. */
export const fileAsRecordSource = (absPath, relPath) =>
  absolutizeImports(dropAssetImports(norm(readFileSync(absPath, "utf8"))), relPath);

/**
 * Source reduced to its CODE — comments gone, whitespace collapsed. Two sources equal under this differ
 * only in formatting and prose, which is what a migration's transcription is allowed to change.
 *
 * This is the bar, and symbol equality is NOT. `connectorForm.tsx`'s record declared every symbol its
 * file did and was a preview-grade transcription: `SourceCard` destructured `runtime` and never used it,
 * where the file passes it to `connector(src.connectorId, runtime)`. Retiring that file would have
 * shipped a card that silently resolves the wrong connector identity.
 *
 * String literals are left alone: a changed string is changed behaviour (a label, a key, a class name),
 * not formatting.
 */
export const codeOnly = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Split a record's source into `[preamble, body]` at the first line the FILE also contains.
 *
 * Every migrated record opens with an "AS GRAPH SOURCE" block the file never had, recording why the
 * record exists and what `provides` does. Overwriting `srcText` with the raw file DELETES it — that
 * happened before, and four records shrank when the change only meant to add attributes. Bounded to the
 * head so a coincidental match deep in a long module cannot eat real code.
 *
 * THE BODY BEGINS WHERE THE FILE BEGINS, and that is checked before the heuristic runs. The scan below
 * requires a matched line to be longer than 8 characters, so a coincidental `}` or `);` cannot eat real
 * code — but a file that OPENS with a JSDoc block starts with `/**`, three characters, which fails that
 * filter. The split then landed on line 2 and classified the record's own `/**` as preamble, so the body
 * differed from the file by exactly one line and the record was reported as drift needing adjudication.
 * Six records were held back that way, `plannerCore/hash` among them — byte-identical to its file, and
 * itself blocking three more modules.
 *
 * Anchoring on the file's FIRST LINE is what fixes it without weakening the filter: a record's preamble
 * is a comment block, so the file's opening line does not appear inside it, and taking the first
 * occurrence keeps the strip working for every migrated record. When that line is absent (a transcribed
 * record whose head was reworded) it falls through to the original heuristic unchanged.
 */
export function splitPreamble(recordSrc, fileSrc) {
  const lines = recordSrc.split("\n");
  const fileFirst = fileSrc.split("\n")[0];
  if (fileFirst) {
    const at = lines.findIndex((l) => l === fileFirst);
    if (at >= 0 && at < 60) return [lines.slice(0, at).join("\n"), lines.slice(at).join("\n")];
  }
  const fileLines = new Set(fileSrc.split("\n").map((l) => l.trim()).filter((l) => l.length > 8));
  for (let i = 0; i < Math.min(lines.length, 60); i++) {
    const t = lines[i].trim();
    if (t.length > 8 && fileLines.has(t)) return [lines.slice(0, i).join("\n"), lines.slice(i).join("\n")];
  }
  return ["", recordSrc];
}

/**
 * The names a module EXPORTS, or `null` when it uses `export * from` (opaque to a regex — "unknown",
 * which a caller must treat as "do not judge", never as "exports nothing").
 *
 * Anchored at `^export` rather than by stripping imports first, which is what makes it correct:
 * `import { type Foo } from …` never starts a line with `export`, so there is no import-shaped text to
 * confuse it. Stripping imports first is the tempting version and is subtly wrong — a bare
 * `import "./x.css";` has no `from`, so a non-greedy strip runs on and swallows the `export { … } from`
 * block below it, which reported the whole charts barrel as losing nine exports.
 *
 * COMMENTS ARE STRIPPED FIRST. A `{ … }` export block may contain a comment between its names, and
 * `[\s\S]*?` happily swallows it — so a name arrives glued to two lines of prose and matches nothing on
 * the other side. `shared/ui/kit/index.ts` was reported as dropping `setActiveKitThemes` for exactly
 * that reason, and the record exports it on the same line as the rest. A FALSE "drops an export" is the
 * expensive direction here: it argues for replacing a record that was fine.
 */
export function exportedNames(rawSrc) {
  const src = stripComments(rawSrc ?? "");
  if (/^\s*export\s+\*\s+from/m.test(src)) return null;
  const out = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  // `export type { X } from "…"` is a re-export and it counts. The `type` keyword between `export` and
  // the brace used to defeat this pattern, so a module re-exporting a type read as not exporting it —
  // which made the retirement guard refuse `treeexplorerpage` for "dropping" `TreeNodeData` that its file
  // exports on the very next line. Harmless in that direction (over-refusal); the dangerous direction is
  // the same miss on the RECORD's side, where an export it really has would not be counted as lost.
  for (const m of src.matchAll(/^\s*export\s*(?:type\s+)?\{([\s\S]*?)\}/gm)) {
    for (const part of m[1].split(",")) {
      const n = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()?.trim();
      if (n) out.add(n);
    }
  }
  return out;
}

/**
 * The specifiers a record REQUIRES at runtime — the one definition, shared with the guard that enforces it.
 *
 * This has to match `platformBoundary.test.ts` EXACTLY, because that guard is what turns red when a
 * promoted record's import cannot resolve. A promotion tool that reads imports differently from the guard
 * is wrong in whichever direction it differs: more permissive and it packages a record that breaks the
 * suite; STRICTER and it silently refuses records that were always fine, which is what happened —
 * `promote-records.mjs` had its own loose regex and blocked 170 modules on two false positives:
 *
 *   `import type { AppStore } from "@/store/types"` — erases at compile time and emits NO require. A
 *   mixed `import { type A, B }` still requires, so only the whole-statement form is skipped.
 *
 *   the word `from` inside PROSE — `// …from "work shipped"` in a comment was read as an import of a
 *   module named `work shipped`. Anchoring at `^` (multiline) is what fixes it: a comment continuation
 *   does not begin a line with `import`/`export`.
 *
 * `export … from` IS included: esbuild compiles a re-export to the same require an import produces (#3874).
 *
 * COMMENTS ARE STRIPPED FIRST, and the `^` anchor is not enough without it. The gap between the keyword
 * and `from` is `[^"']*`, which crosses NEWLINES — it has to, because a real clause wraps
 * (`import {\n  a,\n  b,\n} from "x"`). So a match can START at a genuine top-level `export` and run
 * several lines into a doc comment to reach a `from "…"` written there as an EXAMPLE. `nodeUrn.ts` is
 * exactly that: `export function isNodeUrn(…)` matched forward five lines into
 * ``(`import { fibonacci } from "@bsc/algorithms/fibonacci"`)`` and reported a package the module never
 * imports, which blocked its retirement with an error naming a specifier that appears nowhere in its
 * code. Anchoring cannot see this — only removing the prose can.
 */
export function runtimeImports(src) {
  return [...new Set([...stripComments(src).matchAll(/^\s*(?:import|export)\s+(?!type\s)[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]))];
}

/**
 * Blank out `//` and block comments, PRESERVING newlines so `^`-anchored matching still lines up.
 *
 * Deliberately not a parser: it tracks the three states that can hide a `//` — a string, a template
 * literal, and a regex-looking `/`… — well enough that no comment survives and no code is lost. Getting
 * it wrong in the LOSSY direction (dropping real code) would silently under-report a record's imports
 * and package something unloadable, so anything ambiguous is kept.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // A string or template literal: copy it whole, so a `//` or `/*` inside one is never a comment.
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c; i += 1;
      while (i < n) {
        if (src[i] === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i += 1;               // to end of line; the \n is copied next pass
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") out += "\n"; i += 1; }
      i += 2;
      continue;
    }
    out += c; i += 1;
  }
  return out;
}

/**
 * Should a promotion REPLACE the seed already sitting at its path?
 *
 * `promote-records.mjs` never overwrites a seed — seven curated ones were clobbered before that guard
 * existed. This is the one narrow inversion of it, and it is a rule rather than a judgement: the guard
 * protects a curated seed from a worse record, and here the seed is the WORSE copy. A record only
 * reaches the write loop once its body has been proven to match the file, so when the seed does not,
 * the seed is simply behind.
 *
 * `"refuse"` outranks `"adopt"`: dropping an export the seed declares is the one way this can ship a
 * module short a symbol, which is the failure `provides` overrides are already known for.
 *
 * STALE IS EITHER HALF — body or `provides`. `skills-lessons-tab`'s seed body already matched the file
 * and it was still wrong to leave: its `provides` was `@/components/skills-lessons-tab` while the
 * record — and every importer of the retired file — names `@/features/skills/LessonsTab`, so retiring
 * with that seed in place leaves the specifier answered by nothing. A body-only check called it "keep".
 *
 * Pure over its inputs, so the decision is testable without running the promoter.
 *
 * @param {{ seedSrcText?: string, seedProvides?: string | null, recordSrcText?: string,
 *           recordProvides?: string | null, fileSrc?: string }} input
 * @returns {{ verdict: "adopt" | "keep" | "refuse", reason: string, lost: string[] }}
 */
export function seedAdoption({ seedSrcText = "", seedProvides = null, recordSrcText = "", recordProvides = null, fileSrc = "" }) {
  // NORMALIZE THE FILE SIDE HERE rather than trusting the caller. `fileAsRecordSource` already returns
  // a normed string, so the live path was fine — but a raw `readFileSync` differs by a trailing
  // newline, and that alone reads as "the seed is stale" and adopts. Silently overwriting a correct
  // seed over one byte is the failure this rule is a hair away from being.
  const file = norm(fileSrc);
  const [seedPre, seedBody] = splitPreamble(norm(seedSrcText), file);
  // A MATCHING BODY IS NOT ENOUGH — the seed can carry CODE before it. `splitPreamble` cuts at the first
  // line the file also contains, so a preview stub's imports and its whole `LocalPageFallback` function
  // land in the "preamble", and a body-only comparison calls that seed identical to the file while it
  // ships a duplicate import block and an unused component. Eleven seeds were in exactly that state and
  // the adoption declined every one of them as "already matches", leaving 21 typecheck errors that only
  // showed up in the EMITTED `.bsc-records/` tree.
  const preIsProse = seedPre.split("\n").every((l) => !l.trim() || /^\s*(\/\/|\*|\/\*)/.test(l));
  const stale = seedBody !== file || !preIsProse || (seedProvides ?? null) !== (recordProvides ?? null);
  if (!stale) return { verdict: "keep", reason: "the seed already matches the file, provides included", lost: [] };
  const seedExports = exportedNames(seedSrcText);
  const recExports = exportedNames(recordSrcText);
  // `null` means `export * from` — opaque, so it is "do not judge", never "exports nothing".
  const lost = seedExports && recExports ? [...seedExports].filter((n) => !recExports.has(n)) : [];
  if (lost.length) return { verdict: "refuse", reason: `adopting would drop export(s) ${lost.join(", ")}`, lost };
  return { verdict: "adopt", reason: `provides ${seedProvides ?? "(none)"} → ${recordProvides ?? "(none)"}`, lost: [] };
}

/**
 * Can this module be retired — does the packaged SEED already answer its specifier?
 *
 * The precondition for deleting anything. Importers keep writing `@/x/y`; once the file is gone the
 * only thing that can answer them is a shipped record. Two real failures came from nobody checking:
 * five modules retired while `promote-records` had SKIPPED their seed write (deleted, with the old
 * derivative still shipping), and `pageheader` whose seed said `@/shared/ui/pages/PageHeader` against a
 * `pageHeader.tsx` file.
 *
 * THE MATCH IS EXACT, deliberately. The runtime loader compares specifiers by string and
 * `.bsc-records/` emission is keyed off `provides`, so a case-insensitive check would wave through the
 * one bug that works on Windows and breaks on a case-sensitive filesystem — which is exactly how that
 * one survived tsc, `vite build` and the whole suite. A near-miss is reported so the message can say
 * "case mismatch" rather than "missing", because those need different fixes.
 *
 * @param {{ spec: string, seedProvides: Iterable<string> }} input
 * @returns {{ ok: boolean, nearMiss: string[] }}
 */
export function seedAnswersSpecifier({ spec, seedProvides }) {
  const all = [...seedProvides].map((s) => String(s).trim());
  if (all.includes(spec)) return { ok: true, nearMiss: [] };
  return { ok: false, nearMiss: all.filter((s) => s.toLowerCase() === spec.toLowerCase()) };
}

/**
 * ...and is that answer the SAME MODULE as the file about to be deleted?
 *
 * `seedAnswersSpecifier` asks whether anything will respond to `@/x/y`. That is necessary and NOT
 * sufficient: a seed record can answer the specifier while holding different code, and retiring the
 * file then ships the RECORD's behaviour under the file's name — silently, because it still compiles.
 * That is the BODY-DIFFERS hazard `promote-records` refuses to promote through, and the retire step had
 * no equivalent, so a divergent record that happened to be seeded sailed past.
 *
 * It cost ten test failures in one sweep: `Dialog`, `ModalCard`, `ModalScrim` and `a11y` are all
 * body-differs records, and retiring them replaced the app's focus management with the records' older
 * copies — eight `modalFocus` assertions, plus a banner registry and the retired-tests guard.
 *
 * Compared exactly as the promotion gate compares, through `splitPreamble` + `codeOnly`, so the two
 * cannot disagree about which files are safe.
 *
 * @param {{ seedSrcText: string, fileSrc: string }} input
 * @returns {{ ok: boolean }}
 */
/** Does this record import a sibling BY RECORD ID (`@/components/<id>`)?
 *
 *  Such a record is GRAPH-LOADER-ONLY and can never back a retired file. `@/components/<id>` is resolved
 *  by the runtime graph loader against the record store; it is not a path. Materialized into
 *  `.bsc-records/` and imported through the normal bundle resolution it is simply missing —
 *  "Cannot find package '@/components/algorithms-kit-graph'".
 *
 *  This is the real reason `promote-records.mjs` refuses `role: page` wholesale, and it is worth stating
 *  as its own predicate: the refusal is not about pages being special, it is about this import form.
 *
 *  Learned the hard way — teaching `seedMatchesFile` that `@/components/glance-canvas` and
 *  `@/features/glance/GlanceCanvas` are "the same module" is true IN THE GRAPH LOADER and false in the
 *  bundle, and that half-truth authorized four page retirements that broke the build. */
export function importsSiblingsByRecordId(srcText) {
  const hits = [...String(srcText ?? "").matchAll(/from\s*["'`](@\/components\/[A-Za-z0-9._-]+)["'`]/g)].map((m) => m[1]);
  return { any: hits.length > 0, specifiers: [...new Set(hits)] };
}

export function seedMatchesFile({ seedSrcText, fileSrc }) {
  const file = norm(fileSrc);
  const body = splitPreamble(norm(seedSrcText ?? ""), file)[1];
  return { ok: body === file || codeOnly(body) === codeOnly(file) };
}

/**
 * Is `relSpecifier` imported STATICALLY by an app entry — and by which one?
 *
 * THE RULE, and why it is its own class. The dev server's pre-transform pass resolves an `@/…` alias to
 * `/src/…` before the records plugin is installed, so a module the entry imports statically must exist as
 * a FILE however good its record is. Retire one and the app fails to boot — with `tsc`, `lint`, `vitest`
 * and `vite build` all green, because only a real boot observes it. `ConsoleGraphHost` was retired and
 * restored for exactly this, and `dev-boot-check.mjs` was the only thing that noticed.
 *
 * ONE definition, shared by the tool that DELETES (`retire-module.mjs`) and the census that GRADES
 * (`retirement-candidates.mjs`). They disagreed before this existed: the census offered four candidates
 * — `useAppBoot`, `ConsoleGraphHost`, `TerminalHost`, `features/sounds/index` — that the tool refused,
 * every one for this rule. A census that grades differently from the tool that acts is worse than either
 * being wrong alone, which is the reason this module exists at all.
 *
 * @param {string} repo absolute repo root
 * @param {string} relSpecifier the module's `src/`-relative path, extension and any trailing `/index` off
 * @param {(p: string) => string} read reads a file as UTF-8 — injectable so this is unit-testable
 * @param {(p: string) => boolean} exists file-existence probe, likewise
 * @returns {string[]} the entries that import it statically; empty when none do
 */
export function entriesImportingStatically(repo, relSpecifier, read, exists) {
  const ENTRIES = ["app/main.tsx", "app/App.tsx"];
  // Escapes are doubled because this is a template literal: `\\s` here is the `\s` the RegExp needs.
  // Written with a single backslash it silently becomes the literal letter `s`, which matches nothing —
  // the pattern still compiles, so the helper just answers "no entry imports it" for everything.
  const re = new RegExp(`^\\s*import\\s+[^;]*from\\s+["']@/${relSpecifier}["']`, "m");
  return ENTRIES.filter((e) => exists(`${repo}/src/${e}`)).filter((e) => re.test(read(`${repo}/src/${e}`)));
}
