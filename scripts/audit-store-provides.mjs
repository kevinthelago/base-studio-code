// Which LIVE STORE records claim their file's specifier while not being that file?
//
// WHY THIS EXISTS BESIDE `providesMatchesItsFile.test.ts`. That guard asks the same question and cannot
// answer it here: it globs the packaged SEED (`@data/components/app/**`), because a vitest run has no
// store — CI has no `~/.base-studio-code`. But `provides` is a GLOBAL override resolved at RUNTIME
// against the STORE, so the copy that decides what the running app loads is exactly the copy the guard
// cannot see. Seed clean + store divergent is invisible to every gate and is what actually breaks a
// developer's app.
//
// Measured 2026-08-19: three records — `themeprovider`, `graphprimitive`, `skillsstatus` — carried a
// `provides` naming their file while being PREVIEW DERIVATIVES that drop exports the file still ships
// (`useResolvedTheme`; `primitiveFor` + `__resetPrimitiveCache`). The seed carried no `provides` for any
// of them, so nothing was red. They were latent only because no record imported those specifiers yet.
//
//   node scripts/audit-store-provides.mjs [--json]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedMatchesFile, fileAsRecordSource, exportedNames } from "./lib/recordSource.mjs";

/** `src/a/b/C.tsx` → `@/a/b/C` — the specifier a file's own path implies. */
const specOfSrc = (src) =>
  "@/" + src.replace(/^src\//, "").replace(/\.tsx?$/, "").replace(/\/index$/, "");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BSC = process.env.BSC_BIN ?? "C:/Users/Kevin/Projects/rust/base-studio-code/target/release/bsc.exe";
const JSON_OUT = process.argv.includes("--json");

const records = [
  ...JSON.parse(execFileSync(BSC, ["ui", "list", "--full"], { encoding: "utf8", maxBuffer: 1 << 28 })),
  ...JSON.parse(execFileSync(BSC, ["graph", "impl", "list"], { encoding: "utf8", maxBuffer: 1 << 28 })),
];

const bad = [];
for (const r of records) {
  const src = String(r.src ?? "").split("\\").join("/");
  const provides = typeof r.provides === "string" ? r.provides.trim() : "";
  if (!src || !provides) continue;
  // Only the narrow claim: a record pointing at a file AND claiming that file's own specifier. A record
  // that provides something unrelated to its `src` (a minted name, an `<id>-module` beside per-component
  // records) is out of scope — that is the same boundary the seed guard draws.
  if (provides !== specOfSrc(src)) continue;
  const abs = join(REPO, src);
  if (!existsSync(abs)) continue;                       // file already retired — the record IS the copy
  const fileSrc = fileAsRecordSource(abs, src.replace(/^src\//, ""));
  const body = r.srcText ?? r.code ?? "";
  if (seedMatchesFile({ seedSrcText: body, fileSrc }).ok) continue;
  // DIVERGENCE IS NOT DAMAGE, and the difference is what decides urgency. A record that differs but
  // still declares every export its file does merely serves different BEHAVIOUR — bad, but it resolves.
  // One that DROPS an export breaks its importers BY NAME, the moment anything reaches it.
  //
  // `exportedNames` returns null for a module containing `export * from` — it cannot enumerate through a
  // star. That is reported as unknown rather than as "drops nothing", because a confident "safe" derived
  // from a function that said "I cannot tell" is the worst of the three answers.
  const fileExports = exportedNames(fileSrc);
  const recExports = exportedNames(body);
  const drops = fileExports && recExports ? [...fileExports].filter((n) => !recExports.has(n)) : null;
  bad.push({ id: r.id, provides, src, drops });
}

if (JSON_OUT) { console.log(JSON.stringify(bad, null, 2)); process.exit(bad.length ? 1 : 0); }

if (!bad.length) { console.log("store OK — no record claims its file's specifier while differing from it"); process.exit(0); }
console.log(`${bad.length} STORE record(s) claim their file's specifier while NOT being that file:\n`);
const label = (b) => (b.drops === null ? "UNKNOWN (export *)" : b.drops.length ? "DROPS EXPORTS   " : "differs only    ");
for (const b of bad) {
  console.log(`  ${label(b)}  ${b.id.padEnd(22)} provides ${b.provides}`);
  if (b.drops?.length) console.log(`      the file exports, the record does not: ${b.drops.join(", ")}`);
}
const dropping = bad.filter((b) => b.drops?.length);
const unknown = bad.filter((b) => b.drops === null);
console.log(`\n${dropping.length} would DROP an export (breaks importers by name), ${unknown.length} unknown, ${bad.length - dropping.length - unknown.length} differ in behaviour only.`);
console.log(`\nClear each with:  bsc ui set --clear provides   (send {"id":"<id>"} on stdin)`);
console.log(`or make the record BE its file (\`lift-component-module.mjs\`) if it is meant to replace it.`);
process.exit(1);
