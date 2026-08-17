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
  for (const [re, prose] of [[STATEMENT_SPEC, false], [BARE_SPEC, false], [INLINE_SPEC, true]]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
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
 */
export function splitPreamble(recordSrc, fileSrc) {
  const lines = recordSrc.split("\n");
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
 */
export function exportedNames(src) {
  if (/^\s*export\s+\*\s+from/m.test(src)) return null;
  const out = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s*\{([\s\S]*?)\}/gm)) {
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
 */
export function runtimeImports(src) {
  return [...new Set([...src.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]))];
}
