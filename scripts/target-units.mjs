// Pure grouping of `target/<profile>/deps` files into compilation UNITS (#target-dirs-have-no-gc).
//
// Side-effect-free and import-free, like `incremental-prune-plan.mjs` beside it, so the decision of
// WHAT a unit is stays unit-testable without a filesystem (`scripts/target-units.test.ts`).
//
// ## Why grouping is needed at all
//
// `incremental/` holds one DIRECTORY per unit, so pruning is per-entry. `deps/` holds a FAMILY of
// files per unit, all sharing one metadata hash:
//
//     libbsc_graph-1a2b3c4d5e6f7890.rlib     <- note the extra `lib` prefix
//     bsc_graph-1a2b3c4d5e6f7890.rmeta
//     bsc_graph-1a2b3c4d5e6f7890.d
//     bsc_graph-1a2b3c4d5e6f7890.pdb
//
// Deleting some of a family and not the rest is pointless (cargo rebuilds the unit either way) and
// makes the reclaimed-bytes number a lie, so the family is the atom.
//
// ## The crate name is the SHORTEST name-part, not a stripped prefix
//
// The obvious rule — "strip a leading `lib`" — is wrong on the single largest artifact in this
// workspace. `libduckdb-sys` is a crate whose name genuinely begins with `lib`:
//
//     liblibduckdb_sys-<hash>.rlib   strip -> libduckdb_sys   (right)
//     libduckdb_sys-<hash>.d         strip -> duckdb_sys      (WRONG — same unit, different name)
//
// Two names for one unit would split it across `planPrune` groups and let half of it be deleted.
// Taking the shortest name-part within a hash group needs no knowledge of which extensions carry
// the prefix, and lands on `libduckdb_sys` for that family and `bsc_graph` for the one above.

/** Hash length cargo uses for the `-C metadata` suffix in `deps/` filenames. */
const HASH_RE = /^(.+)-([0-9a-f]{16})$/;

/**
 * Split one `deps/` filename into its name-part and metadata hash.
 *
 * @param {string} fileName e.g. `libbsc_graph-1a2b3c4d5e6f7890.rlib`
 * @returns {{namePart: string, hash: string} | null} null when the name has no hash suffix — e.g.
 *   the un-hashed convenience copies cargo also writes (`bsc.exe`, `base_studio_code.pdb`). A null
 *   means "not ours to touch": those are the files a human or another tool reaches for by name.
 */
export function parseUnitFile(fileName) {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const m = HASH_RE.exec(stem);
  if (m === null) return null;
  return { namePart: m[1], hash: m[2] };
}

/**
 * Group `deps/` entries into units keyed `<crate>-<hash>` — the exact shape `planPrune` parses, so
 * the sweep reuses that tested policy rather than restating it.
 *
 * A unit's mtime is its NEWEST file. Using the oldest would let one stale `.d` drag a live unit
 * under the age floor and get it swept.
 *
 * @param {Array<{name: string, mtimeMs: number}>} entries
 * @returns {Array<{key: string, crate: string, hash: string, mtimeMs: number, files: string[]}>}
 *   Unrecognized files are simply absent, which means the caller never deletes them.
 */
export function groupUnits(entries) {
  const byHash = new Map();
  for (const entry of entries) {
    const parsed = parseUnitFile(entry.name);
    if (parsed === null) continue;
    let unit = byHash.get(parsed.hash);
    if (unit === undefined) {
      unit = { crate: parsed.namePart, hash: parsed.hash, mtimeMs: entry.mtimeMs, files: [] };
      byHash.set(parsed.hash, unit);
    }
    // Shortest name-part wins — see the module note on `libduckdb-sys`.
    if (parsed.namePart.length < unit.crate.length) unit.crate = parsed.namePart;
    if (entry.mtimeMs > unit.mtimeMs) unit.mtimeMs = entry.mtimeMs;
    unit.files.push(entry.name);
  }
  return [...byHash.values()].map((u) => ({ ...u, key: `${u.crate}-${u.hash}`, files: u.files.sort() }));
}
