//! Pins the two properties that make `bsc-lan-core` safe to depend on from
//! anywhere: it performs **no I/O**, and its exhaustiveness guarantee cannot
//! be dissolved silently.
//!
//! ## Why the transitive check is written against this crate's own closure
//!
//! The inherited version of this file (from `netcon-core`, folded 2026-09-04)
//! scanned the whole workspace `Cargo.lock` for the forbidden crate names.
//! That was correct in a one-crate repo and is actively wrong here: this crate
//! now lives in a monorepo whose other members legitimately use `tokio`,
//! `reqwest` and `duckdb`, so the check failed on `tokio` the moment the fold
//! happened -- not because `bsc-lan-core` gained a dependency, but because a
//! sibling had one. A guard that cannot distinguish "I depend on tokio" from
//! "somebody in this repo depends on tokio" is not measuring the property it
//! claims to measure.
//!
//! So the lockfile is parsed into a package -> dependencies graph and walked
//! from `bsc-lan-core` only. A forbidden crate anywhere else in the workspace
//! is now correctly ignored; one reachable from THIS crate, however deep, is
//! caught. This needs no TOML parser and therefore no new dependency, which
//! matters for a crate whose whole point is having almost none.

/// Crates that would each defeat the no-I/O property, and the reason each is
/// listed -- so a future reader can judge an addition rather than guess.
const FORBIDDEN: &[(&str, &str)] = &[
    ("tokio", "an async runtime: this crate is pure types and traits"),
    ("reqwest", "an HTTP client: adapters do I/O, the domain model does not"),
    ("russh", "an SSH library: same reason as reqwest"),
    ("duckdb", "an embedded database, and 1.8 GB of build output the Pi cannot afford"),
    ("rusqlite", "persistence belongs to bsc-lan-store, not to the vocabulary"),
    ("tauri", "the app shell: this crate must stay runnable on a headless sensor"),
];

const OWN_MANIFEST: &str = include_str!("../Cargo.toml");

fn manifest_declares(manifest: &str, crate_name: &str) -> bool {
    // Require the TOML key-value shape (`name = ...` at the start of a line)
    // rather than a bare substring search, so the crate name appearing in
    // prose -- including this file's own doc comments and the manifest's
    // explanatory comments -- is not a false positive.
    manifest.lines().any(|line| {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix(crate_name) else {
            return false;
        };
        rest.trim_start().starts_with('=')
    })
}

#[test]
fn own_manifest_declares_none_of_the_forbidden_crates() {
    for (name, why) in FORBIDDEN {
        assert!(
            !manifest_declares(OWN_MANIFEST, name),
            "crates/bsc-lan-core/Cargo.toml declares forbidden dependency `{name}` -- {why}"
        );
    }
}

/// The exhaustiveness guarantee rests on a two-line clippy declaration in this
/// crate's own manifest. Deleting it is the single edit that would dissolve the
/// guarantee while leaving every other test in this crate green, so the
/// declaration is asserted here rather than trusted.
#[test]
fn the_wildcard_deny_lint_is_still_declared() {
    let declared = OWN_MANIFEST
        .lines()
        .map(str::trim)
        .any(|l| l.starts_with("wildcard_enum_match_arm") && l.contains("deny"));
    assert!(
        declared,
        "crates/bsc-lan-core/Cargo.toml no longer declares \
         `wildcard_enum_match_arm = \"deny\"`. Without it a `_ =>` arm silently \
         satisfies every exhaustive dispatch over Action, and adding a catalog \
         variant stops being a compile error -- which is the whole guarantee \
         this crate exists to provide."
    );
}

/// Parse `Cargo.lock` into `name -> [dependency names]`.
///
/// A `dependencies` entry is `"name"`, `"name version"` or
/// `"name version (source)"`, so the first whitespace-separated token is the
/// package name in every case.
fn parse_lock_graph(lock: &str) -> std::collections::HashMap<String, Vec<String>> {
    let mut graph: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut current: Option<String> = None;
    let mut in_deps = false;

    for line in lock.lines() {
        let t = line.trim();
        if t == "[[package]]" {
            current = None;
            in_deps = false;
            continue;
        }
        if let Some(rest) = t.strip_prefix("name = ") {
            if !in_deps {
                current = Some(rest.trim_matches('"').to_string());
            }
            continue;
        }
        if t.starts_with("dependencies = [") {
            in_deps = true;
            continue;
        }
        if in_deps {
            if t == "]" {
                in_deps = false;
                continue;
            }
            let dep = t.trim_end_matches(',').trim_matches('"');
            if let (Some(owner), Some(name)) = (current.as_ref(), dep.split_whitespace().next()) {
                if !name.is_empty() {
                    graph.entry(owner.clone()).or_default().push(name.to_string());
                }
            }
        }
    }
    graph
}

/// Every package reachable from `root`, following `dependencies` edges.
fn closure_of(graph: &std::collections::HashMap<String, Vec<String>>, root: &str) -> std::collections::BTreeSet<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut stack = vec![root.to_string()];
    while let Some(pkg) = stack.pop() {
        if !seen.insert(pkg.clone()) {
            continue;
        }
        if let Some(deps) = graph.get(&pkg) {
            stack.extend(deps.iter().cloned());
        }
    }
    seen
}

#[test]
fn this_crates_own_dependency_closure_pulls_in_none_of_them() {
    let lock_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock");
    let lock = std::fs::read_to_string(lock_path)
        .unwrap_or_else(|e| panic!("cannot read the workspace Cargo.lock at {lock_path}: {e}"));

    let graph = parse_lock_graph(&lock);

    // A parser that silently stopped matching would report an empty closure,
    // which reads as a pass. Assert the shape of what was parsed before
    // trusting it to tell us anything -- the same reason the graph-store
    // source scanner in bsc-graph asserts its offender population.
    assert!(
        graph.len() > 100,
        "parsed only {} packages out of Cargo.lock -- the lockfile format changed and this \
         guard is no longer reading it, so its silence means nothing",
        graph.len()
    );
    assert!(
        graph.contains_key("bsc-lan-core"),
        "Cargo.lock has no `bsc-lan-core` package with a dependencies list, so the closure \
         below would be trivially empty and this guard would pass without checking anything"
    );

    let closure = closure_of(&graph, "bsc-lan-core");

    for (name, why) in FORBIDDEN {
        assert!(
            !closure.contains(*name),
            "`{name}` is reachable from bsc-lan-core's own dependency closure -- {why}.\n\
             Reached through: {:?}",
            closure.iter().take(20).collect::<Vec<_>>()
        );
    }
}
