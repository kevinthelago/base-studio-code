// Verify the binaries a build just claimed to produce, and heal a corrupt one ONCE
// (#a-corrupt-build-artifact-has-no-recovery-path).
//
//   node scripts/verify-build-artifacts.mjs [--profile debug|release] [--no-heal] [--quiet]
//
// Runs after `cargo build` in `build:plan`. On the healthy path it is three `stat` calls and prints
// nothing, so it costs nothing to leave wired in.
//
// ## What it is for
//
// The existing artifact guards all protect the CONSUMER — `source_is_plausible`,
// `staging_would_downgrade` and `stale_sidecars` in `console/pty/env.rs` stop a bad binary reaching
// `~/.base-studio-code/bin`. Nothing protected the PRODUCER, so a truncated artifact sat in
// `target/` until something noticed, and the thing that usually noticed was an agent session failing
// to exec `$BSC_BIN` with `Permission denied`.
//
// ## Why healing is `rm` + rebuild, not just rebuild
//
// Cargo will not restore a truncated artifact: its fingerprint says the unit is current, so a plain
// rebuild reports `Finished` in 0.4s and leaves the 0-byte file exactly where it was (measured
// twice on 2026-08-24). Removing the file is what makes cargo disagree with its own fingerprint.
//
// ## Why exactly ONE heal
//
// A second silent retry would turn a real, reproducible build failure into a slow loop that still
// ends in a wrong state. One heal fixes the transient case (a concurrent build caught the artifact
// mid-write); anything that survives it is a genuine failure and is reported as one.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planVerification } from "./build-artifact-plan.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The sidecar binaries a build is expected to emit, from `tauri.conf.json`'s `bundle.externalBin`
 *  — the same canonical list `stage-sidecar.mjs` reads. Derived rather than restated so adding a
 *  sidecar cannot silently escape this check (that is how `bsc-hook` would otherwise have been
 *  missed: it is newer than `build:plan`'s original two). */
function expectedBins() {
  const conf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  const ext = conf?.bundle?.externalBin;
  if (!Array.isArray(ext) || ext.length === 0) {
    throw new Error("no bundle.externalBin array in tauri.conf.json — cannot know what to verify");
  }
  return ext.map((p) => p.replace(/^binaries\//, ""));
}

function parseArgs(argv) {
  const o = { profile: "debug", heal: true, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--profile") { o.profile = argv[i + 1] ?? "debug"; i += 1; }
    else if (argv[i] === "--no-heal") o.heal = false;
    else if (argv[i] === "--quiet") o.quiet = true;
  }
  return o;
}

/** `stat`, mapped to the shape the pure planner reads. `null` for anything unreadable — a path we
 *  cannot stat is indistinguishable from one that is not there, and both mean "not verified". */
function statOf(a) {
  try {
    const s = statSync(a.path);
    return { size: s.size, mode: s.mode, isFile: s.isFile() };
  } catch {
    return null;
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const exe = process.platform === "win32" ? ".exe" : "";
  const artifacts = expectedBins().map((name) => ({
    name,
    path: join(REPO_ROOT, "target", opts.profile, `${name}${exe}`),
  }));

  let { bad, healable } = planVerification(artifacts, statOf);
  if (bad.length === 0) {
    if (!opts.quiet) console.log(`[verify-artifacts] ${artifacts.length} binaries ok`);
    return 0;
  }

  for (const v of bad) {
    console.error(`[verify-artifacts] ${v.name}: ${v.reason}`);
  }

  if (!opts.heal || healable.length === 0) {
    console.error(
      "[verify-artifacts] not healing" +
        (healable.length === 0 ? " — nothing here is a truncation" : " (--no-heal)") +
        ". Rebuild with `npm run build:plan`."
    );
    return 1;
  }

  // Remove ONLY the corrupt ones, then rebuild exactly those bins. Scoped so a single bad sidecar
  // never costs a whole-workspace rebuild.
  const names = healable.map((v) => v.name);
  console.error(`[verify-artifacts] healing ${names.join(", ")} — removing and rebuilding once`);
  for (const v of healable) {
    try { rmSync(v.path, { force: true }); } catch { /* a path we cannot remove will re-report below */ }
  }
  const args = ["build"];
  if (opts.profile === "release") args.push("--release");
  for (const n of names) args.push("--bin", n);
  const built = spawnSync("cargo", args, { cwd: REPO_ROOT, stdio: "inherit", encoding: "utf8" });
  if (built.status !== 0) {
    console.error("[verify-artifacts] the rebuild FAILED — this is not a transient truncation.");
    return 1;
  }

  ({ bad } = planVerification(artifacts, statOf));
  if (bad.length > 0) {
    for (const v of bad) console.error(`[verify-artifacts] STILL BAD after healing — ${v.name}: ${v.reason}`);
    console.error(
      "[verify-artifacts] something is rewriting these artifacts, or the build is not emitting them. " +
        "Check for another build running against this same target/ directory."
    );
    return 1;
  }
  console.error("[verify-artifacts] healed — all binaries verified");
  return 0;
}

process.exit(main());
