// Materialize every `Cargo.toml` from its record in `graph/manifests/`.
//
// # Why this is pure Node and not an adapter to a Rust binary
//
// `emit-records.mjs` beside this file is a ~60-line adapter that shells to `bsc-emit`, because the
// decision logic belongs in Rust and one implementation is better than two. This one CANNOT do that,
// and the reason is a bootstrap cycle rather than a preference: building any Rust binary needs cargo,
// cargo needs `Cargo.toml`, and these files ARE the `Cargo.toml`s. An emitter that needed cargo could
// never produce the manifests cargo requires to build it.
//
// So this is deliberately a SECOND implementation of `Manifest::render`
// (`crates/graph-materialize/src/manifest.rs`), which is exactly the shape this repo warns about — a
// census that grades differently from the tool that acts is worse than either being wrong alone. The
// mitigation is the same one `emit-records` used for its own port: PARITY IS PROVED, not asserted.
// `emit-manifests.test.ts` emits all 81 with this renderer and diffs against both the committed files
// and the Rust renderer's output, byte for byte.
//
// The render rule is trivial by construction, which is what makes two implementations tolerable: a
// record is a list of sections, each a list of `lead` lines (the comment/blank run that carries the
// prose) followed by a header, then entries that are `lead` lines followed by `key = value`. There is
// no formatting decision anywhere — every byte comes from the record. A value spread over several
// lines carries its continuation lines in `cont`, verbatim and with their own indentation.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/** Render one manifest record back to TOML. Mirrors `Manifest::render`. */
export function render(rec) {
  const out = [];
  for (const sec of rec.sections) {
    out.push(...sec.lead, sec.name);
    for (const e of sec.entries) out.push(...e.lead, `${e.key} = ${e.value}`, ...(e.cont ?? []));
  }
  out.push(...rec.tail);
  const text = out.join("\n");
  return rec.endsNewline ? text + "\n" : text;
}

/** Every stored record, as `{ src, rec }`, sorted for a deterministic report. */
export function loadRecords(repoRoot) {
  const dir = join(repoRoot, "graph", "manifests");
  if (!existsSync(dir)) throw new Error(`no manifest records at ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!rec.src) throw new Error(`${f} has no \`src\``);
      // Every field is required. A tolerant reader that defaulted `endsNewline` would write a file one
      // byte different from its source and pass everything that is not byte-exact.
      if (typeof rec.endsNewline !== "boolean") throw new Error(`${f} has no \`endsNewline\``);
      return { src: rec.src, rec };
    });
}

/** Write each record to its manifest path. Only rewrites a file whose bytes actually change. */
export function emitManifests(repoRoot, { dryRun = false } = {}) {
  const written = [];
  const unchanged = [];
  for (const { src, rec } of loadRecords(repoRoot)) {
    const dest = resolve(repoRoot, src);
    const body = render(rec);
    if (existsSync(dest) && readFileSync(dest, "utf8") === body) {
      unchanged.push(src);
      continue;
    }
    if (!dryRun) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body);
    }
    written.push(src);
  }
  return { written, unchanged };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith("emit-manifests.mjs");
if (invokedDirectly) {
  const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
  const root = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? process.cwd();
  try {
    const { written, unchanged } = emitManifests(root, { dryRun });
    console.log(`${dryRun ? "DRY RUN: " : ""}${written.length} written · ${unchanged.length} unchanged`);
    for (const w of written) console.log(`  + ${w}`);
  } catch (e) {
    console.error(`emit-manifests failed: ${e.message}`);
    process.exit(1);
  }
}
