// THE CLAIM CENSUS — which store records claim a module they are not
// (a-derivative-record-must-not-claim-the-module-it-derives-from).
//
//   npm run census:claims            # the report
//   npm run census:claims -- --json  # the same, machine-readable; exits 1 when any record must lose its claim
//
// WHY A COMMAND RATHER THAN A NUMBER IN AN ISSUE. The population moves every tranche: the item was filed
// against 978 records with `provides` + `src`, of which 244 files still existed and 122 disagreed. Re-run
// on 2026-08-24 it was 936 / 12 / 0 — because 924 of those files have been RETIRED since, and when the
// file is gone the record IS the module and there is nothing to disagree with. A number in an issue is
// stale before it is read; this re-derives it.
//
// WHY IT READS THE STORE, not the seed. `provides` is a global override resolved at RUNTIME against the
// store, so the copy that decides what the running app loads is exactly the copy a vitest run cannot see
// (CI has no `~/.base-studio-code`). `providesMatchesItsFile.test.ts` asks the same question of the seed
// and is blind to seed-clean/store-divergent, which is the case that actually breaks a developer's app.
//
// It supersedes `audit-store-provides.mjs`, which asked a NARROWER question — only records claiming
// exactly their own file's implied specifier — and reported "store OK" while the broader class went
// unmeasured.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedMatchesFile, fileAsRecordSource, exportedNames } from "./lib/recordSource.mjs";
import { classify, summarize } from "./lib/claimCensus.mjs";

const repoArg = process.argv.indexOf("--repo");
const REPO = repoArg > -1 ? resolve(process.argv[repoArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");
// No hardcoded path: the previous script defaulted to a Windows path that stopped existing, so it could
// only run where someone happened to set the env var.
const BSC = process.env.BSC_BIN ?? join(process.env.HOME ?? "", ".base-studio-code", "bin", "bsc");

// `--dir <store>` points the census at another store. Not a convenience: a census that has only ever
// reported zero is indistinguishable from one that cannot count, so this is how it gets pointed at a
// store built to contain a known divergence and proved to FIRE.
const dirArg = process.argv.indexOf("--dir");
const dirFlags = dirArg > -1 ? ["--dir", process.argv[dirArg + 1]] : [];
const read = (args) => JSON.parse(execFileSync(BSC, [...args, ...dirFlags], { encoding: "utf8", maxBuffer: 1 << 28 }));
// The algorithms store is a different store, so `--dir` (a component-store path) must not reach it.
const records = [
  ...read(["ui", "list", "--full"]),
  ...(dirFlags.length ? [] : JSON.parse(execFileSync(BSC, ["graph", "impl", "list"], { encoding: "utf8", maxBuffer: 1 << 28 }))),
];

// How many LIVE records point at each `src` — the multi-component signal the classifier needs.
const claimants = new Map();
for (const r of records) {
  const src = String(r.src ?? "").split("\\").join("/");
  if (src && !r.suppressed) claimants.set(src, (claimants.get(src) ?? 0) + 1);
}

const population = { withProvidesAndSrc: 0, fileRetired: 0, agrees: 0, disagrees: 0 };
const verdicts = [];
for (const r of records) {
  if (r.suppressed) continue;
  const src = String(r.src ?? "").split("\\").join("/");
  const provides = typeof r.provides === "string" ? r.provides.trim() : "";
  if (!src || !provides) continue;
  population.withProvidesAndSrc++;
  const abs = join(REPO, src);
  // The file is gone ⇒ the record IS the module. Nothing to disagree with, and the great majority.
  if (!existsSync(abs)) { population.fileRetired++; continue; }
  const fileSrc = fileAsRecordSource(abs, src.replace(/^src\//, ""));
  const body = r.srcText ?? r.code ?? "";
  if (seedMatchesFile({ seedSrcText: body, fileSrc }).ok) { population.agrees++; continue; }
  population.disagrees++;
  const v = classify({
    recordSrc: body,
    fileSrc,
    fileExports: exportedNames(fileSrc),
    recordExports: exportedNames(body),
    sharesSrc: claimants.get(src) ?? 1,
  });
  verdicts.push({ id: r.id, provides, src, ...v });
}

const summary = summarize(verdicts);
if (JSON_OUT) {
  console.log(JSON.stringify({ population, summary, verdicts }, null, 2));
  process.exit(summary.shouldDropProvides ? 1 : 0);
}

console.log(`${records.length} records · ${population.withProvidesAndSrc} carry both provides and a src`);
console.log(`  ${population.fileRetired} file retired — the record IS the module, nothing to disagree with`);
console.log(`  ${population.agrees} agree with their file`);
console.log(`  ${population.disagrees} DISAGREE while still claiming its specifier\n`);
if (!verdicts.length) {
  console.log("no record claims a module it is not — nothing to do");
  process.exit(0);
}
for (const [kind, n] of Object.entries(summary.counts)) console.log(`  ${String(n).padStart(4)}  ${kind}`);
console.log();
for (const v of verdicts) {
  console.log(`  ${v.kind.padEnd(20)} ${v.id.padEnd(24)} ${v.why}`);
}
console.log(
  `\n${summary.shouldDropProvides} must lose \`provides\` (docs/records.md: a record that is not the whole` +
    ` module must not claim it). The record survives for provenance:\n` +
    `  echo '{"id":"<id>"}' | bsc ui set --clear provides`,
);
process.exit(1);
