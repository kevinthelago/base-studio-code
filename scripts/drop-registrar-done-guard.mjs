// Drop the `done` guard from every `graphPlatform.ts` registrar, so the module holds no state and its
// record may claim the specifier.
//
// WHY THE GUARD BLOCKS THE MIGRATION. `bsc graph impl set` refuses a `provides` when the record holds
// module state AND the specifier is a registered platform module: a record wins over the registry, so it
// would vendor a SECOND copy of that state to every graph consumer. That refusal is right, and it is
// exactly why sixteen registrars are still files while eight are already records — the eight are the ones
// nothing registers, so their record is the only copy.
//
// WHY DROPPING IT IS SAFE. `registerAppModule` is `registry.set(specifier, mod)` — a plain Map set, so it
// is idempotent by construction. `done` never guarded correctness; it saved N repeated Map writes on a
// function called at module load and from `ensurePlatform`. Removing it is behaviourally identical and
// costs a handful of Map sets. It also cannot clobber a record override, because `resolveGraphSource`
// runs BEFORE the registry (#3660) — re-registering the file module can never win over a `provides`.
//
// The bodies were checked first: every one is imports + `registerAppModule` calls and nothing else, with
// a single nested `registerPlannerGithubPlatform()` in the github registrar, itself idempotent.
//
// ONE PASS, ANCHORED ON THE ORIGINAL TEXT. An earlier version applied three successive regexes and then a
// fourth to tidy what the third had mangled; each ran against the output of the last and the comment came
// out duplicated. This matches the whole `let done` → `done = true;` span once and replaces it wholesale,
// so re-running it on a patched file is a no-op rather than a second edit.
//
//   node scripts/drop-registrar-done-guard.mjs [--apply]
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");

/** The whole span, from the declaration to the last guard line, captured so the doc line between them is
 *  rewritten in the same replacement rather than by a follow-up pass. */
const SPAN = /let done = false;\r?\n\r?\n(\/\*\*[\s\S]*?)Idempotent\.\s*\*\/\r?\n(export function \w+\(\): void \{)\r?\n[ \t]*if \(done\) return;\r?\n[ \t]*done = true;\r?\n/;

const TAIL = [
  "",
  " *",
  " *  Idempotent, and holding NO MODULE STATE on purpose. `registerAppModule` is a Map set, so calling",
  " *  this twice writes the same entries twice and changes nothing — the `done` flag this used to carry",
  " *  saved Map writes, it never guarded correctness. It had to go: `bsc graph impl set` refuses a",
  " *  `provides` from a stateful record onto a REGISTERED specifier, because the record wins over the",
  " *  registry and would vendor a second copy of that state to every graph consumer.",
  " */",
].join("\n");

const files = execSync("git ls-files src", { cwd: REPO, encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith("graphPlatform.ts"));

let changed = 0;
for (const rel of files) {
  const abs = join(REPO, rel);
  const before = readFileSync(abs, "utf8");
  if (!SPAN.test(before)) { console.log(`SKIP ${rel} — shape did not match; inspect it`); continue; }
  const after = before.replace(SPAN, (_m, head, fn) => `${head.replace(/\s*$/, "")}${TAIL}\n${fn}\n`);
  // Check for the three GUARD CONSTRUCTS, not for the word. A `\bdone\b` test over the whole file matches
  // ordinary prose — every registrar's header says something "is done" — and rejected all sixteen.
  if (/let done = false;|if \(done\) return;|done = true;/.test(after)) {
    console.log(`SKIP ${rel} — a guard construct survives`);
    continue;
  }
  console.log(`${APPLY ? "PATCH" : "would patch"} ${rel}`);
  if (APPLY) writeFileSync(abs, after);
  changed += 1;
}
console.log(`\n${changed} registrar(s)${APPLY ? " patched" : " would be patched (dry run — pass --apply)"}`);
