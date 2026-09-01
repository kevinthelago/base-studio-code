//! Do the two glob engines that decide ONE write scope actually agree?
//!
//! `write-scope.ts`'s `matchGlob` compiles a glob to a RegExp; `bsc_util::scope`'s `fnmatch` is a
//! hand-written POSIX-style matcher. The `bsc-scope` hook ENFORCES writes with the Rust one, while
//! the role model, the launch write-rules and the warden's conformance check all reason with the
//! TypeScript one. Nothing bound them until this test.
//!
//! A disagreement here is not a style difference. It is the hook permitting or refusing something
//! the rest of the system believes the opposite about.
//!
//! ## THEY DO NOT AGREE, and this test records exactly how
//!
//! MEASURED: 8 of 25 pairs disagree. This is therefore a CHARACTERIZATION test — it pins what is
//! TRUE TODAY so any NEW drift fails, while `the-two-write-scope-glob-engines-disagree` tracks the
//! defect itself. Reconciling them silently was not an option: choosing which semantics is correct
//! changes what a security boundary MEANS, and that is the maintainer's call.
//!
//! The three families, and the first is the dangerous one:
//!
//!   `*` CROSSES `/` IN RUST AND NOT IN TYPESCRIPT. `scope_verdict` allows when any glob matches, so
//!   Rust allows MORE: a lane of `src/*.ts` permits `src/a/b/c.ts` at the hook, which is what
//!   actually enforces, while the role model, the launch write-rules and the warden all believe that
//!   path is out of lane.
//!
//!   `?` IS AN UNESCAPED REGEX QUANTIFIER IN TYPESCRIPT. `globToRegExp` escapes
//!   `. + ^ $ { } ( ) | [ ] \` and omits `?`, so `src/a?.ts` compiles to `^src/a?\.ts$` — "optional
//!   a" — and matches `src/.ts`. Rust reads `?` as a single-character wildcard. Neither is the
//!   other, and the TypeScript one is a metacharacter leak in a security predicate.
//!
//!   `[ab]` IS A CLASS IN RUST AND LITERAL IN TYPESCRIPT (the brackets are escaped).
//!
//! ## Why the test lives in this crate
//!
//! `bsc-util` is deliberately dependency-free — "std only, no dependencies, so any CLI can pull it
//! in for free" — and reading the fixture needs `serde_json`. `bsc-fleet` already depends on both,
//! so the measurement lives here rather than putting a dependency on the leaf crate to test it.

#[cfg(test)]
mod tests {
    use bsc_util::scope::{scope_verdict, Scope};

    /// Reports EVERY disagreement at once rather than dying on the first: the SHAPE of the
    /// divergence is the finding, and one failing assertion would hide the rest.
    #[test]
    fn the_glob_engines_disagree_in_exactly_the_known_ways() {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str())
                    == Some("globSemantics.fixtures.json")
                {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one globSemantics.fixtures.json, got {found:?}");
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap();

        let pairs = doc["pairs"].as_array().expect("pairs");
        let mut disagreements = Vec::new();
        let mut disagreement_keys: Vec<String> = Vec::new();
        for p in pairs {
            let glob = p["glob"].as_str().unwrap();
            let path = p["path"].as_str().unwrap();
            let why = p["why"].as_str().unwrap_or("");
            let ts = p["matches"].as_bool().unwrap();
            // One glob, no root: Allow <=> the matcher matched.
            let rs = matches!(scope_verdict(path, glob, ""), Scope::Allow);
            if ts != rs {
                disagreement_keys.push(format!("{glob}|{path}"));
                disagreements.push(format!(
                    "  glob {glob:<22} path {path:<22} ts={ts:<5} rust={rs:<5}  ({why})"
                ));
            }
        }
        // The disagreements that exist TODAY, keyed by glob+path. Any pair leaving or joining this
        // set is drift and fails — including a FIX, which is correct: changing these semantics is a
        // deliberate act that should have to update this list and say so.
        let known: std::collections::BTreeSet<&str> = [
            "src/*.ts|src/a/b.ts",
            "src/*.ts|src/a/b/c.ts",
            "src/a?.ts|src/ab.ts",
            "src/a?.ts|src/a?.ts",
            "src/a?.ts|src/.ts",
            "src/a?.ts|src/a.ts",
            "src/[ab].ts|src/a.ts",
            "src/[ab].ts|src/[ab].ts",
        ]
        .into_iter()
        .collect();
        let got: std::collections::BTreeSet<&str> =
            disagreement_keys.iter().map(String::as_str).collect();
        assert_eq!(
            got,
            known,
            "the set of glob-engine disagreements MOVED.\n\nnow disagreeing:\n{}\n\nIf you fixed \
             one, update this list and `the-two-write-scope-glob-engines-disagree`. If a NEW one \
             appeared, a security boundary just moved.",
            disagreements.join("\n")
        );
    }
}
