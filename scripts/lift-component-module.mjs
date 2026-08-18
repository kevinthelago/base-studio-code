// Lift a COMPONENT file into a module-shaped record — the reshape `bsc graph harvest --module` stops
// one step short of (#lift-a-component-file-into-a-module-shaped-record).
//
//   node scripts/lift-component-module.mjs <src-relative-path>… [--apply]
//
// WHY THIS EXISTS. `docs/records.md` names the blocker: roughly 100 `.tsx` have records that are
// PREVIEW-SHAPED DERIVATIVES — `bsc ui harvest` lifts a COMPONENT, inlining what it cannot reach so the
// thing mounts standalone in the Design Studio. That is right for previewing and wrong for retirement,
// and such a record carries no `provides`, so nothing can import the module it stands for.
//
// THE LIFT IS NOT REIMPLEMENTED HERE. `bsc graph harvest --module` already does it correctly for a
// `.tsx` — and it carries at least three separately-learned rules that a second copy would get wrong:
// strip the FILE's extension (not one guessed from `tech`, which gave `.tsx` modules a specifier no
// import writes), strip a trailing `/index` (a directory import resolves to it, and keeping the segment
// gave 13 barrels an unreachable specifier), and absolutize relative imports (a record is resolved
// against the registry, never a directory). This drives that command and reshapes what it returns.
//
// WHAT IT WILL NOT DO:
//   * invent a record — it UPDATES an existing component by id. Creating a second record for a module
//     that already has one is how a duplicate id gets into the seed, and `SEED_COMPONENTS` globs flat.
//   * touch a module carrying MODULE STATE. `provides` beats the platform registry, so such a record
//     vendors a second copy of that state to every consumer — the failure that made the a11y announcer
//     go silent. The harvester reports it; this refuses on it.
//   * guess when the harvest returns nothing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const targets = argv.filter((a) => !a.startsWith("--"));
if (!targets.length) {
  console.error("usage: node scripts/lift-component-module.mjs <src-relative-path>… [--apply]");
  process.exit(2);
}

/** The bundled `bsc`.
 *
 *  EXISTENCE IS NOT THE TEST — each candidate is RUN. A worktree carries its own `target/`, and this
 *  found a `target/debug/bsc.exe` that was present but not a working executable (`EFTYPE`), which fails
 *  deep inside the first call with a spawn error rather than saying "that binary is no good". A stale
 *  or half-written sidecar has bitten this repo before, silently.
 *
 *  Release before debug (it is what the app ships), and the MAIN REPO before a worktree's own build —
 *  a worktree rarely builds `bsc` at all, so its copy is the likeliest to be stale. */
const BSC = (() => {
  const roots = [REPO, resolve(REPO, "..")];
  const cands = [
    process.env.BSC_BIN,
    ...roots.flatMap((r) => ["target/release/bsc.exe", "target/release/bsc", "target/debug/bsc.exe"].map((p) => join(r, p))),
    "bsc",
  ].filter(Boolean);
  for (const c of cands) {
    try {
      execFileSync(c, ["ui", "env"], { stdio: "ignore" });
      return c;
    } catch { /* missing, stale, or not executable — try the next */ }
  }
  console.error("lift: no working `bsc` found. Build one (`cargo build -p bsc --bin bsc`) or set BSC_BIN.");
  process.exit(2);
})();

const bsc = (args, input) => execFileSync(BSC, args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Every component record, by the `src` it was lifted from. */
const components = JSON.parse(bsc(["ui", "list", "--full"]));
const bySrc = new Map();
for (const c of components) if (c.src) bySrc.set(String(c.src).split("\\").join("/"), c);

const tmp = mkdtempSync(join(tmpdir(), "bsc-lift-"));
let lifted = 0;
const skipped = [];
try {
  for (const rel of targets) {
    const srcRel = rel.startsWith("src/") ? rel : `src/${rel}`;
    if (!existsSync(join(REPO, srcRel))) { skipped.push(`${rel} — no such file`); continue; }

    const rec = bySrc.get(srcRel);
    if (!rec) { skipped.push(`${rel} — no component record points at it (\`src\`); author one first`); continue; }

    let out;
    try {
      out = JSON.parse(bsc(["graph", "harvest", srcRel, "--module"]));
    } catch (e) {
      skipped.push(`${rel} — harvest failed: ${(e.stderr?.toString() || e.message).trim().split("\n")[0]}`);
      continue;
    }
    const cand = out.candidates?.[0];
    if (!cand?.code) { skipped.push(`${rel} — the harvest returned no candidate`); continue; }
    if (cand.moduleState?.length) {
      // Not a judgement call: a record of a stateful module vendors a SECOND copy of that state.
      skipped.push(`${rel} — holds MODULE STATE (${cand.moduleState.join(", ")}); it must stay a file`);
      continue;
    }
    if (!cand.provides) { skipped.push(`${rel} — the harvest derived no \`provides\``); continue; }

    console.log(`  ${APPLY ? "lift" : "would lift"} ${rec.id.padEnd(28)} ${cand.provides}`);
    if (!APPLY) { lifted++; continue; }

    // `set-src` for the source (the whole-record stdin path has a ~10KB ceiling), then a tiny merge for
    // `provides`. Two small writes rather than one large one, and each is independently revertible.
    const f = join(tmp, `${rec.id.replace(/[^\w.-]/g, "_")}.tsx`);
    writeFileSync(f, cand.code);
    bsc(["ui", "set-src", rec.id], readFileSync(f, "utf8"));
    bsc(["ui", "set", "--by", "claude", "--note", "module lift: the faithful module, not the preview derivative"],
      JSON.stringify({ id: rec.id, provides: cand.provides, src: srcRel }));
    lifted++;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (skipped.length) {
  console.log(`\nskipped ${skipped.length}:`);
  for (const s of skipped) console.log(`   ${s}`);
}
console.log(`\n${lifted} component record(s) ${APPLY ? "lifted" : "would be lifted"}.`);
if (!APPLY && lifted) console.log("(dry run — pass --apply to write)");
