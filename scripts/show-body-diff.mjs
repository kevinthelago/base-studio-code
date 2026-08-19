// Show WHAT differs between a record and its file — the adjudication view for `promote-records.mjs`'s
// `body differs` bucket.
//
// It must normalize EXACTLY as the promoter does (`fileAsRecordSource` → `splitPreamble` → `codeOnly`),
// or it shows differences the promoter does not care about and hides the ones it does. That is not
// hypothetical: comparing raw text reports every transcription preamble and every absolutized import as
// a difference, which is how "21 candidates" were once written off as drift.
//
//   node scripts/show-body-diff.mjs <src-relative-path> [--full]
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { norm, codeOnly, splitPreamble, fileAsRecordSource, exportedNames } from "./lib/recordSource.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BSC = process.env.BSC_BIN ?? "C:/Users/Kevin/Projects/rust/base-studio-code/target/release/bsc.exe";
const argv = process.argv.slice(2);
const FULL = argv.includes("--full");
const rel = argv.find((a) => !a.startsWith("--"));
if (!rel) { console.error("usage: node scripts/show-body-diff.mjs <src-relative-path> [--full]"); process.exit(2); }

const spec = `@/${rel.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
const all = [
  ...JSON.parse(execFileSync(BSC, ["ui", "list", "--full"], { encoding: "utf8", maxBuffer: 1 << 28 })),
  ...JSON.parse(execFileSync(BSC, ["graph", "impl", "list"], { encoding: "utf8", maxBuffer: 1 << 28 })),
];
const rec = all.find((r) => (r.provides ?? "").trim() === spec)
  ?? all.find((r) => String(r.src ?? "").split("\\").join("/") === `src/${rel}`);
if (!rec) { console.error(`no record provides ${spec} nor claims src/${rel}`); process.exit(1); }

const fileSrc = fileAsRecordSource(join(REPO, "src", rel), rel);
const body = splitPreamble(norm(rec.srcText ?? rec.code ?? ""), fileSrc)[1];

const R = codeOnly(body).split("\n");
const F = codeOnly(fileSrc).split("\n");
console.log(`${rec.id}  (${rec.provides ? `provides ${rec.provides}` : "no provides"})`);
console.log(`record ${R.length} lines / file ${F.length} lines\n`);

// A line-set diff, not an LCS: the question an adjudicator asks is "what does one copy have that the
// other does not", and for a decision about DROPPED EXPORTS a set difference answers it directly while a
// positional diff buries it under reordering noise.
const setF = new Set(F.map((l) => l.trim()).filter(Boolean));
const setR = new Set(R.map((l) => l.trim()).filter(Boolean));
const onlyRecord = [...setR].filter((l) => !setF.has(l));
const onlyFile = [...setF].filter((l) => !setR.has(l));
const cap = FULL ? Infinity : 25;

console.log(`ONLY IN THE RECORD (${onlyRecord.length}):`);
for (const l of onlyRecord.slice(0, cap)) console.log(`  + ${l}`);
if (onlyRecord.length > cap) console.log(`  … ${onlyRecord.length - cap} more (--full)`);
console.log(`\nONLY IN THE FILE (${onlyFile.length}):`);
for (const l of onlyFile.slice(0, cap)) console.log(`  - ${l}`);
if (onlyFile.length > cap) console.log(`  … ${onlyFile.length - cap} more (--full)`);

// The decisive question for a retirement: does either copy declare an export the other does not? A
// dropped export is the one difference that breaks importers rather than merely changing behaviour.
//
// USE THE SHARED `exportedNames`, never a local regex. This file HAD its own, and it disagreed with the
// shared one on `export type { A, B } from "…"` — reporting `NetworkPage`'s record as declaring four
// exports its file "lacked" when the file re-exports two of them on one line. A second implementation of
// a definition this repo has already been bitten by twice is not a shortcut; it is a third answer.
const eR = exportedNames(codeOnly(body));
const eF = exportedNames(codeOnly(fileSrc));
if (!eR || !eF) {
  // `null` means `export * from` — unknowable by regex, and reporting it as "drops nothing" is the one
  // answer that is worse than saying so.
  console.log("\nEXPORTS: one side uses `export * from`, so the comparison is UNKNOWN, not clean.");
  process.exit(0);
}
const lostByRecord = [...eF].filter((n) => !eR.has(n));
const addedByRecord = [...eR].filter((n) => !eF.has(n));
console.log(`\nEXPORTS the record would DROP: ${lostByRecord.length ? lostByRecord.join(", ") : "(none)"}`);
console.log(`EXPORTS only the record has:   ${addedByRecord.length ? addedByRecord.join(", ") : "(none)"}`);
