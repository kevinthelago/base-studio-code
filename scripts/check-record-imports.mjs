// The LIVE STORE's half of "a record may not import relatively"
// (records-carry-relative-imports-that-break-when-a-neighbour-retires).
//
//   node scripts/check-record-imports.mjs            # report; exit 1 when anything is relative
//   node scripts/check-record-imports.mjs --fix      # rewrite to `@/…` (and DROP asset imports)
//   node scripts/check-record-imports.mjs --json     # the findings, for another tool
//
// WHY THIS IS A SCRIPT AND NOT A TEST. `src/app/runtime/recordImports.test.ts` guards the packaged SEED,
// which is in git and identical for everyone, so it holds on a fresh clone with no local store. The
// store is per-machine: a test that read it would be vacuous on a clean checkout and flaky everywhere
// else. But the store is what the RUNNING APP renders from — a migrated page loads its record from the
// store, not from the seed — so the surface that actually breaks the app is precisely the one a test
// cannot cover. Hence: same rule, same scanner, two runners.
//
// WHAT IT FOUND THE FIRST TIME. 57 relative specifiers across 25 store records while the seed was
// clean and every gate was green. All 25 records' `src` files still existed on disk — these are stale
// harvest snapshots that claim `provides`, so each one is a GLOBAL OVERRIDE of a live module by an
// older copy whose neighbours have since been retired into records. 34 of the 35 already-broken
// specifiers name a module another record now provides under its `@/…` alias, which is what makes the
// rewrite a real repair rather than a rename of the failure.
//
// THE RUNTIME DOES NOT FAIL LOUDLY FOR MOST OF THEM, which is why this went unnoticed:
// `pruneUnsatisfiableOverrides` DECLINES an override whose closure cannot resolve — but only where the
// platform has a fallback to answer with. So a stale record over `@/app/App` silently reverts to the
// bundled module (the app looks fine, minus whatever the record was for), while one over a
// `@/components/<id>` specifier with no fallback throws by name. Both are the same defect; only the
// second is visible.
//
// ⚠️ WHICH IS WHY `--fix` DROPS `provides` AS WELL, and doing only the rewrite is the regression.
// Making a record's imports resolve is exactly what PROMOTES it from "declined, falls back" to "active
// global override". Graded against the files they shadow (`codeOnly`, so comments and formatting do not
// count), 11 of the 24 disagree with theirs and 7 of those carry `provides` — and every one of the 7 is
// a PREVIEW-SHAPED DERIVATIVE, the class `docs/records.md` warns about. `issuerow` and `issuedrawer`
// each inject a `SAMPLE_ISSUE` and guard the real prop with it; `projectssummary` vendors a fake
// `useProjectsSummaryData` returning four hardcoded projects in place of the sibling imports it could
// not resolve; `kitrenderer` swaps the real `primitiveFor` (the graph-override resolver) for
// `componentFor`. Repairing their imports and stopping there would put SAMPLE DATA on live screens.
//
// Dropping `provides` is not a judgement call about those records — it is the rule `docs/records.md`
// already states: "If a record is not the whole module, drop its `provides`." The record survives for
// provenance; the specifier goes back to resolving against the registry, which is where it resolves
// today anyway. Reconciling a divergent record with its file is a DIFFERENT job
// (`nothing-keeps-a-graph-hosted-page-in-sync-with-its-file`) and is not attempted here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { relativeSpecifiers, aliasFor, dropAssetImports, absolutizeImports, codeOnly, norm } from "./lib/recordSource.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flags = process.argv.slice(2);
const FIX = flags.includes("--fix");
const JSON_OUT = flags.includes("--json");

/** The bundled `bsc`. `$BSC_BIN` is how a live session is handed it; a dev shell has neither that nor a
 *  `bsc` on PATH, so the built binaries are probed too — release first, since that is what the app ships
 *  and what a stale debug build would silently disagree with. */
function bscBin() {
  const candidates = [
    process.env.BSC_BIN,
    join(REPO, "target/release/bsc.exe"),
    join(REPO, "target/release/bsc"),
    join(REPO, "target/debug/bsc.exe"),
    join(REPO, "target/debug/bsc"),
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  return "bsc"; // PATH, and a loud ENOENT if it is not there either
}
const BSC = bscBin();

const bsc = (args, input) =>
  execFileSync(BSC, args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Every store record that holds MODULE source, as `{kind, id, src, provides, text}`.
 *
 *  Carried tests are deliberately excluded, the same exemption the seed guard documents: a test is
 *  harvested beside its module saying `./LabelChip`, `emit-records.mjs` rewrites that on emit AND uses
 *  it to verify the test is paired with the right module. Rewriting it at rest would disarm that check. */
function storeRecords() {
  const components = JSON.parse(bsc(["ui", "list", "--full"]));
  const impls = JSON.parse(bsc(["graph", "impl", "list"]));
  return [
    ...components
      .filter((c) => c.srcText)
      .map((c) => ({ kind: "component", id: c.id, src: c.src ?? null, provides: c.provides ?? null, text: c.srcText, rec: c })),
    ...impls
      .filter((i) => i.tech === "typescript" && i.code)
      .map((i) => ({ kind: "impl", id: i.id, src: i.src ?? null, provides: i.provides ?? null, text: i.code, rec: i })),
  ];
}

/** The repaired source for one record: asset imports DROPPED, everything else absolutized.
 *
 *  A stylesheet is dropped rather than rewritten because absolutizing it changes nothing that matters —
 *  `@/shared/ui/charts/charts.css` is no more registered than `./charts.css` was, and the loader's
 *  `require` throws on either. The app's CSS already loads globally through the bundled entry, so the
 *  import is redundant for a record as well as fatal. Same call `fileAsRecordSource` makes, same order. */
function repaired(text, src) {
  const dropped = dropAssetImports(text);
  let out = dropped;
  for (const { spec, at } of relativeSpecifiers(dropped).reverse()) {
    out = out.slice(0, at) + aliasFor(src, spec) + out.slice(at + spec.length);
  }
  return out;
}

/**
 * Does this record still say what the file it shadows says?
 *
 * `null` when there is no file to compare against (a genuinely retired module — the record IS the
 * module, so there is nothing to diverge from). Both sides go through the same normalization the
 * retirement census uses, so a difference in import FORM or in comments is not a difference: the
 * question is whether the CODE is the same module.
 */
function agreesWithItsFile(r) {
  if (!r.src) return null;
  const abs = join(REPO, r.src);
  if (!existsSync(abs)) return null;
  const file = absolutizeImports(dropAssetImports(norm(readFileSync(abs, "utf8"))), r.src);
  return codeOnly(file) === codeOnly(repaired(norm(r.text), r.src));
}

const records = storeRecords();
const findings = [];
/** Records whose `provides` must go: divergent from a live file, so not the whole module. */
const overreaching = [];
for (const r of records) {
  const specs = relativeSpecifiers(r.text);
  if (!specs.length) continue;
  if (!r.src) {
    // Nothing to resolve against: the alias is a function of the record's own position. Reported, never
    // rewritten — guessing a directory is how a wrong specifier gets written confidently.
    findings.push(...specs.map(({ spec }) => ({ kind: r.kind, id: r.id, spec, alias: null, note: "no `src` — cannot resolve" })));
    continue;
  }
  const agrees = agreesWithItsFile(r);
  if (r.provides && agrees === false) overreaching.push(r);
  findings.push(
    ...specs.map(({ spec }) => ({
      kind: r.kind, id: r.id, src: r.src, provides: r.provides, spec,
      alias: aliasFor(r.src, spec),
      divergent: agrees === false,
    })),
  );
}

if (JSON_OUT) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  const byId = new Map();
  for (const f of findings) {
    if (!byId.has(f.id)) byId.set(f.id, []);
    byId.get(f.id).push(f);
  }
  console.log(`store: ${records.length} module sources · ${findings.length} relative specifier(s) across ${byId.size} record(s)`);
  for (const [id, fs_] of byId) {
    const f0 = fs_[0];
    const flag = f0.divergent ? (f0.provides ? "  ⚠ DIVERGENT OVERRIDE — `provides` will be dropped" : "  (divergent, but claims nothing)") : "";
    console.log(`\n  ${f0.kind} ${id}   (${f0.src ?? "no src"}${f0.provides ? ` · provides ${f0.provides}` : ""})${flag}`);
    for (const f of fs_) console.log(`      ${f.spec}  →  ${f.alias ?? f.note}`);
  }
  if (overreaching.length)
    console.log(
      `\n${overreaching.length} record(s) disagree with the file they shadow AND claim its specifier. ` +
        `Repairing their imports alone would ACTIVATE them:\n  ${overreaching.map((r) => `${r.id} → ${r.provides}`).join("\n  ")}`,
    );
}

if (!FIX) {
  if (findings.length && !JSON_OUT) console.log(`\nre-run with --fix to rewrite them. Nothing was written.`);
  process.exit(findings.length ? 1 : 0);
}

// ── --fix ────────────────────────────────────────────────────────────────────────────────────────
const NOTE = "records-carry-relative-imports: absolutize relative specifiers";
const tmp = mkdtempSync(join(tmpdir(), "bsc-record-imports-"));
let written = 0;
let dropped = 0;
const failed = [];
try {
  // FIRST, disarm — drop `provides` before making anything resolvable. The other order leaves a window
  // in which a preview-shaped derivative is a LIVE override of the module it derives from, and the app
  // is running while this script writes.
  for (const r of overreaching) {
    try {
      bsc(
        ["ui", "set", "--clear", "provides", "--by", "claude", "--note", `not the whole module (differs from ${r.src}) — provides dropped`],
        JSON.stringify({ id: r.id }),
      );
      dropped++;
      console.log(`  dropped provides  ${r.id}  (was ${r.provides})`);
    } catch (e) {
      failed.push(`${r.id} (provides): ${e.stderr?.toString().trim() || e.message}`);
    }
  }

  for (const r of records) {
    if (!r.src) continue;
    if (!relativeSpecifiers(r.text).length) continue;
    const next = repaired(r.text, r.src);
    if (next === r.text) continue;
    try {
      if (r.kind === "component") {
        // `set-src` rather than a `{id, srcText}` merge: the whole-record stdin path has a ~10KB
        // ceiling and several of these records are larger than that.
        bsc(["ui", "set-src", r.id], next);
      } else {
        // `--code-file`, never `--code`: the CLI's own help warns that source on the command line is
        // corrupted SILENTLY by the shell (a backtick or a `${…}` is substituted away, a literal
        // backslash-n never becomes a newline) and that a large module exceeds the argv limit outright.
        const f = join(tmp, `${r.id.replace(/[^\w.-]/g, "_")}.ts`);
        writeFileSync(f, next);
        bsc(["graph", "impl", "set", "--id", r.id, "--tech", r.rec.tech, "--role", r.rec.role, "--name", r.rec.name, "--code-file", f, "--by", "claude", "--note", NOTE]);
      }
      written++;
      console.log(`  rewrote ${r.kind} ${r.id}`);
    } catch (e) {
      failed.push(`${r.id}: ${e.stderr?.toString().trim() || e.message}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${written} record(s) rewritten · ${dropped} \`provides\` dropped.`);
if (failed.length) {
  console.error(`\n${failed.length} FAILED:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
// Re-read rather than trust the writes — `bsc ui set-src` runs its own JSX gate and can refuse, and a
// refusal that nobody re-checked is exactly how a repair gets reported as done while nothing changed.
const remaining = storeRecords().flatMap((r) => relativeSpecifiers(r.text).map(({ spec }) => `${r.id} → ${spec}`));
console.log(remaining.length ? `still relative after the fix:\n  ${remaining.join("\n  ")}` : "store is clean — 0 relative specifiers.");
process.exit(remaining.length ? 1 : 0);
