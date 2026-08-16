/**
 * Which gate does THIS change need? (#the-gate-runs-everything-on-every-item-regardless-of-what-changed)
 *
 * The gate runs everything on every item regardless of what changed — `cargo clippy --workspace`,
 * `cargo nextest run --workspace`, `tsc`, `eslint .`, and the full 725-file vitest suite, roughly 4-5
 * minutes warm — while a typical item touches 1-5 files. This module decides what a given change can
 * actually have affected. `scripts/gate.mjs` runs it.
 *
 * PURE ON PURPOSE. Everything here takes the changed-file list and the workspace graph as arguments and
 * returns a plan; nothing reads git, the filesystem, or spawns a process. That is what makes the scope
 * decision unit-testable — and a scope decision nobody can test is exactly the thing that would quietly
 * start covering less than the reader assumes.
 *
 * THE SCOPE IS PRINTED BY THE RUNNER, ALWAYS. This repo's recurring failure is not a gate that fails
 * wrongly, it is a gate that PASSES while seeing less than expected: tsc+lint+vitest green with a live
 * Worker deleted; ten stylesheets orphaned with every gate green; a vitest config change that silently
 * dropped 8 test files and reported all-passing. Narrowing the gate is only safe if the narrowing is
 * visible, and if the unscoped gate still runs before anything lands (CLAUDE.md step 7).
 */

/**
 * The commands a plan runs, in order — `{ label, cmd, args }`.
 *
 * Built here rather than inline in the runner so the ARGUMENTS are testable, which matters for exactly
 * one of them: `cargo nextest run` defaults to FAIL-FAST. Without `--no-fail-fast` the first failing
 * test ends the run, and the gate reports a partial picture — observed on the first full dogfood as
 * "532/2393 tests run", i.e. 1,861 tests never executed while the summary looked like a complete
 * verdict. Same species as everything else this feature guards against: not a wrong answer, a
 * narrower one presented as the whole.
 */
export function gateCommands(plan, base) {
  const c = [];
  if (plan.full) {
    c.push({ label: "typecheck", cmd: "npm", args: ["run", "typecheck"] });
    c.push({ label: "lint", cmd: "npm", args: ["run", "lint"] });
    c.push({ label: "vitest", cmd: "npx", args: ["vitest", "run"] });
    c.push({ label: "clippy", cmd: "cargo", args: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"] });
    c.push({ label: "nextest", cmd: "cargo", args: ["nextest", "run", "--workspace", "--no-fail-fast"] });
    return c;
  }
  if (plan.runTsc) c.push({ label: "typecheck (whole-program — never scoped)", cmd: "npm", args: ["run", "typecheck"] });
  if (plan.frontendFiles.length) {
    c.push({ label: "lint (changed files)", cmd: "npx", args: ["eslint", ...plan.frontendFiles] });
  }
  if (plan.runVitest) {
    c.push({ label: "vitest (--changed: module-graph affected)", cmd: "npx", args: ["vitest", "run", "--changed", base] });
  }
  if (plan.rustCrates.length) {
    const p = plan.rustCrates.flatMap((x) => ["-p", x]);
    c.push({ label: "clippy (scoped)", cmd: "cargo", args: ["clippy", ...p, "--all-targets", "--", "-D", "warnings"] });
    c.push({ label: "nextest (scoped)", cmd: "cargo", args: ["nextest", "run", ...p, "--no-fail-fast"] });
  }
  return c;
}

/**
 * Paths that invalidate the scope computation itself, so any change touching one forces the FULL gate.
 *
 * Not a conservatism reflex — each of these can change the result for files it does not contain. A
 * workspace `Cargo.toml` edits the profile every crate compiles under (measured: a profile change makes
 * even a recycled worktree rebuild from scratch, 2m21s). `vitest.config.ts` decides which files are
 * even DISCOVERED — the 8 dropped test files came from exactly that. `tsconfig.json` moves what the
 * whole-program check includes.
 */
export const FORCE_FULL = [
  "Cargo.toml", // the WORKSPACE manifest — profiles + members; a crate's own Cargo.toml is scoped normally
  ".cargo/config.toml",
  "vitest.config.ts",
  "vitest.excludes.ts",
  "eslint.config.js",
  "tsconfig.json",
  "package.json",
  "rust-toolchain.toml",
];

/**
 * Paths out of `git status --porcelain`.
 *
 * Lives here, tested, because getting it subtly wrong is SILENT AND UNDERCOVERS. The first version
 * called `.trim()` on the whole multi-line output and then `slice(3)` per line — which works for every
 * line except the first, whose leading status space `.trim()` had already eaten: ` M package.json`
 * became `M package.json`, and `slice(3)` returned `ackage.json`. That name matched nothing in
 * [`FORCE_FULL`], so a change to `package.json` — which MUST force the full gate — quietly ran as a
 * scoped one. Caught by running this script on its own diff; it would never have announced itself.
 *
 * So: never trim the block, take the path from column 3 onward, and handle rename arrows (`R  a -> b`)
 * by keeping the destination.
 */
export function parsePorcelain(output) {
  const files = [];
  for (const line of output.split("\n")) {
    const l = line.replace(/[\r\n]+$/, "");
    if (l.length < 4) continue;
    let path = l.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4); // a rename: the destination is what changed
    path = path.trim();
    if (!path || path.startsWith('"')) continue; // quoted == a path needing unescaping; skip rather than mangle
    files.push(path);
  }
  return files;
}

/** Is `file` a frontend source the gate's TS/lint/vitest half cares about? */
export function isFrontendPath(file) {
  return file.startsWith("src/") || file.startsWith("scripts/") || file.startsWith("vite/");
}

/**
 * The workspace crate owning `file`, or null.
 *
 * Directory name is NOT the package name in this workspace — `crates/data` is `bsc-data`, `crates/llm`
 * is `bsc-llm` — so the caller passes `dirToCrate`, built from `cargo metadata`'s manifest paths rather
 * than guessed from the path.
 */
export function crateForPath(file, dirToCrate) {
  if (file.startsWith("src-tauri/")) return "base-studio-code";
  const m = /^crates\/([^/]+)\//.exec(file);
  if (!m) return null;
  return dirToCrate.get(m[1]) ?? null;
}

/**
 * Every crate that must be checked given `changed` — the changed crates plus everything that depends on
 * them, transitively.
 *
 * `graph` is `Map<crate, string[] deps>`, workspace members only. Measured spread, which is the honest
 * shape of this feature: `bsc-util` reaches 35 of 40 crates, `bsc-graph` 6, `bsc-ui` 1,
 * `base-studio-code` 0. Touching a shared util legitimately means running nearly everything — that is
 * the scope being RIGHT, not the tool underperforming.
 */
export function withDependents(changed, graph) {
  const out = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, deps] of graph) {
      if (out.has(name)) continue;
      if (deps.some((d) => out.has(d))) {
        out.add(name);
        grew = true;
      }
    }
  }
  return [...out].sort();
}

/**
 * The gate plan for one change.
 *
 * Returns `{ full, reason, rustCrates, frontendFiles, runVitest, runTsc }`. `full` means run the
 * documented unscoped gate — either because something in FORCE_FULL moved, or because the caller asked.
 *
 * `runTsc` is true whenever ANY frontend file changed and is never scoped: `tsc --noEmit` is a
 * whole-program check, so "only the changed files" is not a thing it can do, and at 18.7s measured it is
 * cheap enough to always pay.
 */
export function planGate({ files, graph, dirToCrate, force = false }) {
  if (force) {
    return { full: true, reason: "--full requested", rustCrates: [], frontendFiles: [], runVitest: true, runTsc: true };
  }
  const trigger = files.find((f) => FORCE_FULL.includes(f));
  if (trigger) {
    return {
      full: true,
      reason: `${trigger} changed — it can change the result for files it does not contain`,
      rustCrates: [],
      frontendFiles: [],
      runVitest: true,
      runTsc: true,
    };
  }
  if (files.length === 0) {
    return { full: false, reason: "no changes against the base", rustCrates: [], frontendFiles: [], runVitest: false, runTsc: false };
  }

  const touched = new Set();
  for (const f of files) {
    const c = crateForPath(f, dirToCrate);
    if (c) touched.add(c);
  }
  const frontendFiles = files.filter(isFrontendPath);

  return {
    full: false,
    reason: "scoped to what this change can affect",
    rustCrates: touched.size ? withDependents(touched, graph) : [],
    frontendFiles,
    runVitest: frontendFiles.length > 0,
    runTsc: frontendFiles.length > 0,
  };
}
