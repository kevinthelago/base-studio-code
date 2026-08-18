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
  const fromDir = fromRel.includes("/") ? fromRel.slice(0, fromRel.lastIndexOf("/")) : "";
  return src.replace(
    /((?:from|import|require)\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (whole, head, q, relSpec) => {
      const out = [];
      for (const seg of `${fromDir}/${relSpec}`.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
      }
      return `${head}${q}@/${out.join("/")}${q}`;
    },
  );
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
const dropAssetImports = (src) =>
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
  const seedBody = splitPreamble(norm(seedSrcText), file)[1];
  const stale = seedBody !== file || (seedProvides ?? null) !== (recordProvides ?? null);
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
