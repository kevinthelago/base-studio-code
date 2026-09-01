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
//! ## THEY STILL DO NOT AGREE, and this test records exactly how
//!
//! MEASURED: 8 of 25 pairs disagreed. SIX ARE CLOSED — the `?` and `[…]` families were unambiguous
//! metacharacter leaks in the TypeScript and were fixed there (`globToRegExp` now compiles `?` to
//! `[^/]` and a bracket expression to a real class), so it agrees with both engines that ENFORCE.
//! Nothing in the packaged floors uses either character, so that closed a latent divergence rather
//! than moving a live lane.
//!
//! TWO REMAIN, and they are the dangerous ones: `*` crossing a separator. This is therefore still a
//! CHARACTERIZATION test — it pins what is TRUE TODAY so any NEW drift fails, while
//! `the-two-write-scope-glob-engines-disagree` tracks the rest of the defect.
//!
//! ## Why the `*` case did not move with the others
//!
//! The maintainer's call was that `*` must NOT cross `/`, which means narrowing the enforcing engines
//! to what the model already believed. Acting on it uncovered a THIRD engine the item did not name:
//! `scope.sh`'s `bsc-scope` matches with a shell `case`, where `*` crosses `/` by construction. That is
//! the HOST path — it runs through `BASH_ENV` in every uncaged session — while `bsc_util::scope` is
//! reached by the static `bsc-hook` binary on the SANDBOXED path.
//!
//! So narrowing the Rust matcher alone would not close the divergence; it would move it, and in the
//! worst direction: a sandboxed session would refuse writes an uncaged one allows, which is exactly
//! what `star_crosses_a_slash_because_the_shell_it_mirrors_does` exists to prevent. A shell `case`
//! cannot express "`*` stops at a separator", so honouring the decision means either making
//! `bsc-scope` delegate to `bsc-hook` (one engine, a subprocess per file write) or matching
//! segment-wise in pure shell. That is a bigger decision than the one that was taken, and it is
//! recorded on the item rather than guessed at here.
//!
//! The three families, the first of which is the one still open:
//!
//!   `*` CROSSES `/` IN RUST AND NOT IN TYPESCRIPT. `scope_verdict` allows when any glob matches, so
//!   Rust allows MORE: a lane of `src/*.ts` permits `src/a/b/c.ts` at the hook, which is what
//!   actually enforces, while the role model, the launch write-rules and the warden all believe that
//!   path is out of lane.
//!
//!   `?` WAS AN UNESCAPED REGEX QUANTIFIER IN TYPESCRIPT — CLOSED. `globToRegExp` escaped
//!   `. + ^ $ { } ( ) | [ ] \` and omitted `?`, so `src/a?.ts` compiled to `^src/a?\.ts$` — "optional
//!   a" — matching `src/.ts` and failing on `src/ab.ts`. A metacharacter leak in a security predicate,
//!   and the opposite of what both enforcing engines do. It now compiles to `[^/]`.
//!
//!   `[ab]` WAS A CLASS IN RUST AND LITERAL IN TYPESCRIPT — CLOSED. The brackets were escaped; the
//!   TypeScript now compiles a real class, with an unterminated `[` staying literal as POSIX and
//!   `bsc_util::scope::bracket` both have it.
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
    fn the_glob_engines_disagree_in_exactly_the_two_remaining_known_ways() {
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
        // WAS EIGHT. The `?` and `[…]` families are gone — six rows — because the TypeScript stopped
        // leaking those two characters into its RegExp. What is left is the `*`-crosses-a-separator
        // pair, which needs the third engine (`scope.sh`'s shell `case`) settled first.
        let known: std::collections::BTreeSet<&str> = [
            "src/*.ts|src/a/b.ts",
            "src/*.ts|src/a/b/c.ts",
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
