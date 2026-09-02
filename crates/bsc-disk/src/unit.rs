//! Pure grouping of `target/<profile>/deps` files into compilation UNITS.
//!
//! Ported from `scripts/target-units.mjs`. Side-effect-free like [`crate::prune`] beside it, so the
//! decision of WHAT a unit is stays testable without a filesystem.
//!
//! ## Why grouping is needed at all
//!
//! `incremental/` holds one DIRECTORY per unit, so pruning is per-entry. `deps/` holds a FAMILY of
//! files per unit, all sharing one metadata hash:
//!
//! ```text
//! libbsc_graph-1a2b3c4d5e6f7890.rlib     <- note the extra `lib` prefix
//! bsc_graph-1a2b3c4d5e6f7890.rmeta
//! bsc_graph-1a2b3c4d5e6f7890.d
//! bsc_graph-1a2b3c4d5e6f7890.pdb
//! ```
//!
//! Deleting some of a family and not the rest is pointless (cargo rebuilds the unit either way) and
//! makes the reclaimed-bytes number a lie, so the family is the atom.
//!
//! ## The crate name is the SHORTEST name-part, not a stripped prefix
//!
//! The obvious rule — "strip a leading `lib`" — is wrong on the single largest artifact in this
//! workspace. `libduckdb-sys` is a crate whose name genuinely begins with `lib`:
//!
//! ```text
//! liblibduckdb_sys-<hash>.rlib   strip -> libduckdb_sys   (right)
//! libduckdb_sys-<hash>.d         strip -> duckdb_sys      (WRONG — same unit, different name)
//! ```
//!
//! Two names for one unit would split it across [`crate::prune::plan_prune`] groups and let half of
//! it be deleted. Taking the shortest name-part within a hash group needs no knowledge of which
//! extensions carry the prefix, and lands on `libduckdb_sys` for that family and `bsc_graph` for
//! the one above.

/// Hash length cargo uses for the `-C metadata` suffix in `deps/` filenames.
const HASH_LEN: usize = 16;

/// One `deps/` file's name split into its parts.
#[derive(Clone, Debug, PartialEq)]
pub struct UnitFile {
    pub name_part: String,
    pub hash: String,
}

/// One compilation's whole file family — the atom a sweep deletes.
#[derive(Clone, Debug, PartialEq)]
pub struct Unit {
    /// `<crate>-<hash>`, exactly the shape [`crate::prune::crate_name_of`] parses, so the sweep
    /// reuses that tested policy rather than restating it.
    pub key: String,
    pub crate_name: String,
    pub hash: String,
    pub mtime_ms: f64,
    pub files: Vec<String>,
}

/// Split one `deps/` filename into its name-part and metadata hash.
///
/// `None` when the name has no hash suffix — e.g. the un-hashed convenience copies cargo also
/// writes (`bsc`, `base_studio_code.pdb`). A `None` means "not ours to touch": those are the files a
/// human or `$BSC_BIN` reaches for BY NAME.
pub fn parse_unit_file(file_name: &str) -> Option<UnitFile> {
    // `lastIndexOf(".")`, and `> 0` so a dotfile keeps its whole name as the stem.
    let stem = match file_name.rfind('.') {
        Some(dot) if dot > 0 => &file_name[..dot],
        _ => file_name,
    };
    // The JavaScript regex is `^(.+)-([0-9a-f]{16})$`, and `.+` is greedy — so the hash is the LAST
    // 16 chars and the name-part is everything before the hyphen that precedes them.
    if stem.len() < HASH_LEN + 2 {
        return None;
    }
    let cut = stem.len() - HASH_LEN;
    // A non-ASCII filename can put `cut` mid-codepoint, and slicing there panics. A name that is not
    // a clean `<name>-<16 hex>` cannot be one of ours anyway, so bail rather than slice.
    if !stem.is_char_boundary(cut - 1) {
        return None;
    }
    let hash = &stem[cut..];
    if !hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    if stem.as_bytes()[cut - 1] != b'-' {
        return None;
    }
    let name_part = &stem[..cut - 1];
    if name_part.is_empty() {
        return None;
    }
    Some(UnitFile { name_part: name_part.to_string(), hash: hash.to_string() })
}

/// Group `deps/` entries into units keyed `<crate>-<hash>`.
///
/// A unit's mtime is its NEWEST file. Using the oldest would let one stale `.d` drag a live unit
/// under the age floor and get it swept.
///
/// Unrecognized files are simply absent, which means the caller never deletes them.
pub fn group_units(entries: &[crate::prune::Entry]) -> Vec<Unit> {
    let mut order: Vec<String> = Vec::new();
    let mut by_hash: std::collections::HashMap<String, Unit> = std::collections::HashMap::new();

    for entry in entries {
        let Some(parsed) = parse_unit_file(&entry.name) else { continue };
        let unit = by_hash.entry(parsed.hash.clone()).or_insert_with(|| {
            order.push(parsed.hash.clone());
            Unit {
                key: String::new(),
                crate_name: parsed.name_part.clone(),
                hash: parsed.hash.clone(),
                mtime_ms: entry.mtime_ms,
                files: Vec::new(),
            }
        });
        // Shortest name-part wins — see the module note on `libduckdb-sys`.
        if parsed.name_part.len() < unit.crate_name.len() {
            unit.crate_name = parsed.name_part.clone();
        }
        if entry.mtime_ms > unit.mtime_ms {
            unit.mtime_ms = entry.mtime_ms;
        }
        unit.files.push(entry.name.clone());
    }

    order
        .into_iter()
        .map(|hash| {
            let mut unit = by_hash.remove(&hash).expect("every ordered key was inserted");
            unit.files.sort();
            unit.key = format!("{}-{}", unit.crate_name, unit.hash);
            unit
        })
        .collect()
}

#[cfg(test)]
mod tests {
    //! Carried over from `scripts/target-units.test.ts`, assertion for assertion.
    use super::*;
    use crate::prune::{crate_name_of, Entry};

    fn mt(name: &str, mtime_ms: f64) -> Entry {
        Entry::new(name, mtime_ms)
    }

    #[test]
    fn splits_a_hashed_artifact_into_its_name_part_and_metadata_hash() {
        assert_eq!(
            parse_unit_file("libbsc_graph-1a2b3c4d5e6f7890.rlib"),
            Some(UnitFile { name_part: "libbsc_graph".into(), hash: "1a2b3c4d5e6f7890".into() })
        );
        assert_eq!(
            parse_unit_file("bsc_graph-1a2b3c4d5e6f7890.d"),
            Some(UnitFile { name_part: "bsc_graph".into(), hash: "1a2b3c4d5e6f7890".into() })
        );
    }

    #[test]
    fn returns_none_for_the_un_hashed_copies_cargo_also_writes() {
        // `target/debug/bsc` and `base_studio_code.pdb` are the names a human or another tool
        // reaches for. Sweeping them would break `$BSC_BIN` resolution, so they must not parse.
        for name in ["bsc.exe", "base_studio_code.pdb", "libbsc_graph.rlib", "CACHEDIR.TAG", "bsc"] {
            assert_eq!(parse_unit_file(name), None, "{name}");
        }
    }

    #[test]
    fn rejects_a_suffix_that_is_not_exactly_16_hex_chars() {
        assert_eq!(parse_unit_file("bsc_graph-1a2b3c4d5e6f789.rlib"), None); // 15
        assert_eq!(parse_unit_file("bsc_graph-zzzzzzzzzzzzzzzz.rlib"), None); // not hex
    }

    #[test]
    fn requires_the_separating_hyphen_and_not_merely_a_hex_tail() {
        // ADDED AFTER A BITE PROBE FOUND NO BITE. Removing the `-` check broke nothing, and the
        // reason was a CORPUS GAP rather than redundant code: every un-hashed name in the tests
        // above is shorter than `<name>-<16 hex>`, so the LENGTH check was catching all of them and
        // the separator check was never reached. A long name whose last 16 characters happen to be
        // hex is the input that separates them — without the check it parses as a unit, which makes
        // a file cargo never hashed eligible for deletion.
        assert_eq!(parse_unit_file("deadbeefdeadbeefdeadbeef.rlib"), None, "hex tail, no separator");
        assert_eq!(parse_unit_file("libduckdb_sys0123456789abcdef.rlib"), None, "hex tail, no separator");
        // ...and the same name WITH the separator is a unit, so the check is discriminating rather
        // than simply refusing everything long.
        assert_eq!(
            parse_unit_file("libduckdb_sys-0123456789abcdef.rlib"),
            Some(UnitFile { name_part: "libduckdb_sys".into(), hash: "0123456789abcdef".into() })
        );
    }

    #[test]
    fn groups_one_compilations_file_family_under_a_single_key() {
        let units = group_units(&[
            mt("libbsc_graph-1a2b3c4d5e6f7890.rlib", 100.0),
            mt("bsc_graph-1a2b3c4d5e6f7890.rmeta", 90.0),
            mt("bsc_graph-1a2b3c4d5e6f7890.d", 80.0),
        ]);
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].key, "bsc_graph-1a2b3c4d5e6f7890");
        assert_eq!(units[0].files.len(), 3);
    }

    #[test]
    fn takes_the_shortest_name_part_so_libduckdb_sys_stays_one_unit() {
        // The case that makes "strip a leading lib" wrong: a crate whose name really starts with
        // `lib`. Stripping yields `libduckdb_sys` from the .rlib but `duckdb_sys` from the .d — two
        // names for one unit, which would split it across plan_prune groups and let half of it be
        // deleted.
        let units = group_units(&[
            mt("liblibduckdb_sys-aaaaaaaaaaaaaaaa.rlib", 100.0),
            mt("libduckdb_sys-aaaaaaaaaaaaaaaa.d", 100.0),
        ]);
        assert_eq!(units.len(), 1);
        assert_eq!(units[0].crate_name, "libduckdb_sys");
        assert_eq!(units[0].files.len(), 2);
    }

    #[test]
    fn keeps_distinct_hashes_as_distinct_units_whose_keys_parse_back_for_plan_prune() {
        let units = group_units(&[
            mt("libbsc_graph-1111111111111111.rlib", 100.0),
            mt("bsc_graph-1111111111111111.d", 100.0),
            mt("libbsc_graph-2222222222222222.rlib", 200.0),
            mt("bsc_graph-2222222222222222.d", 200.0),
        ]);
        assert_eq!(units.len(), 2);
        for u in &units {
            assert_eq!(crate_name_of(&u.key), Some("bsc_graph"));
        }
    }

    #[test]
    fn falls_back_to_the_prefixed_name_when_a_unit_has_no_un_prefixed_file() {
        // The crate name is derived from the files a unit ACTUALLY has, so a family with no
        // un-prefixed member keeps the `lib` prefix. Real units always emit a `.d` alongside the
        // rlib, so this is a degenerate input rather than a live case — pinned because the
        // consequence is worth knowing: it only changes which plan_prune GROUP the unit lands in,
        // i.e. how much gets reclaimed. A split group keeps `keep` survivors on each side, which
        // errs toward keeping more. Never toward deleting a unit's files inconsistently, because
        // the family is keyed on the hash, not the name.
        let units = group_units(&[mt("libbsc_graph-1111111111111111.rlib", 100.0)]);
        assert_eq!(units[0].crate_name, "libbsc_graph");
        assert_eq!(units[0].files, vec!["libbsc_graph-1111111111111111.rlib"]);
    }

    #[test]
    fn uses_the_newest_file_as_the_units_mtime() {
        // The oldest would let one stale `.d` drag a live unit under the age floor and get it swept.
        let units = group_units(&[
            mt("libbsc_graph-1a2b3c4d5e6f7890.rlib", 500.0),
            mt("bsc_graph-1a2b3c4d5e6f7890.d", 100.0),
        ]);
        assert_eq!(units[0].mtime_ms, 500.0);
    }

    #[test]
    fn omits_unrecognized_files_entirely_so_the_caller_can_never_delete_them() {
        assert!(group_units(&[mt("bsc.exe", 100.0), mt("CACHEDIR.TAG", 100.0)]).is_empty());
    }
}
