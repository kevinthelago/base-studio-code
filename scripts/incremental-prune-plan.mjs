// Pure selection logic for pruning orphaned incremental-compilation directories (#3821).
//
// Extracted into its own SIDE-EFFECT-FREE module — mirroring `toolchain-layout.mjs` beside
// `stage-sidecar.mjs` — so the fs-touching sweep in `prune-incremental.mjs` stays thin and the
// decision of WHAT to delete is unit-testable without a filesystem
// (`scripts/incremental-prune-plan.test.ts`). No imports; every function is pure.
//
// ## What these directories are
//
// `target/<profile>/incremental/` holds one directory per `<crate_name>-<stable-crate-id>`. The
// suffix is a hash of the crate name plus the `-C metadata` cargo passes, which folds in the
// package id, the enabled FEATURE SET, the PROFILE settings, target triple, rustc version, and
// whether it's a lib or a test harness. Change any of those and cargo emits a NEW directory; the
// old one is orphaned permanently.
//
// Nothing reclaims them. rustc's own GC runs inside the directory for the crate being compiled,
// pruning superseded sessions there (which is why each holds only 1-2), but a sibling directory
// for another crate-id is, to rustc, a different crate. Cargo's garbage collection (`-Zgc`)
// covers the global caches under `~/.cargo`, not build output.
//
// ## Why deleting is safe
//
// Incremental state is a PURE CACHE. Removing any of it can only cost rebuild time, never
// correctness — which is what lets this run unattended before a dev launch.

/** How many trailing `[0-9a-z]` characters a stable-crate-id must have for a directory name to be
 *  recognized as `<crate_name>-<id>`. Real ids observed are 13 chars; the floor is deliberately
 *  loose but long enough that a hyphenated word can't be mistaken for one. */
const MIN_CRATE_ID_LEN = 10;

/** Split an incremental directory name into its crate name, or return null when the name doesn't
 *  have the `<crate_name>-<stable-crate-id>` shape.
 *
 *  Cargo renders crate names with underscores here (`base-studio-code` → `base_studio_code`), so
 *  the crate-name half never contains a hyphen and the LAST hyphen is unambiguously the split.
 *  A null return means "unrecognized" and the caller must keep the directory — being wrong about
 *  the shape should cost disk, never someone else's cache.
 *
 *  @param {string} dirName e.g. `base_studio_code_lib-0n9p2yhrm5isb`
 *  @returns {string | null} e.g. `base_studio_code_lib`
 */
export function crateNameOf(dirName) {
  const cut = dirName.lastIndexOf("-");
  if (cut <= 0) return null;
  const id = dirName.slice(cut + 1);
  if (id.length < MIN_CRATE_ID_LEN) return null;
  if (!/^[0-9a-z]+$/.test(id)) return null;
  return dirName.slice(0, cut);
}

/**
 * Decide which incremental directories to delete.
 *
 * Two independent guards, both of which must pass before a directory is pruned:
 *   1. **Keep the newest `keep` per crate name.** The live cache for each crate survives even if
 *      the whole tree is older than the cutoff (e.g. a crate nobody has rebuilt in months) — so a
 *      sweep never forces a from-scratch rebuild of something that was working.
 *   2. **Age cutoff.** Only directories untouched for `days` are eligible. An in-flight build
 *      stamps its directory's mtime to now, so a concurrent `cargo build` can never have its
 *      cache pulled out from under it.
 *
 * Unrecognized names (per `crateNameOf`) are always kept.
 *
 * @param {Array<{name: string, mtimeMs: number}>} entries directory names + mtimes
 * @param {{days?: number, keep?: number, now?: number}} [opts]
 *   `days` age cutoff (default 14) · `keep` newest-per-crate to spare (default 1) · `now` epoch ms
 * @returns {{prune: string[], keep: string[]}} names, `prune` oldest-first
 */
export function planPrune(entries, opts = {}) {
  const days = opts.days ?? 14;
  const keep = opts.keep ?? 1;
  const now = opts.now ?? Date.now();
  const cutoff = now - days * 86_400_000;

  const byCrate = new Map();
  const kept = [];
  for (const entry of entries) {
    const crate = crateNameOf(entry.name);
    if (crate === null) {
      kept.push(entry.name); // unrecognized shape — not ours to delete
      continue;
    }
    if (!byCrate.has(crate)) byCrate.set(crate, []);
    byCrate.get(crate).push(entry);
  }

  const pruned = [];
  for (const group of byCrate.values()) {
    // Newest first, so the `keep` survivors are the freshest caches for that crate.
    group.sort((a, b) => b.mtimeMs - a.mtimeMs);
    group.forEach((entry, i) => {
      if (i < keep || entry.mtimeMs >= cutoff) kept.push(entry.name);
      else pruned.push(entry);
    });
  }

  pruned.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { prune: pruned.map((e) => e.name), keep: kept };
}
