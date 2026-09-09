//! Root discovery is SEPARATE from the store, and these prove it.
//!
//! `repo_root_by_walk` used to key on `graph/algorithms.json`, giving the store file a second,
//! unnamed job: marking the repo root. That is why retiring the store was measured as breaking all 75
//! materialized crates independently of the records — two failures wearing one filename.
//!
//! The first test is the one that matters: a root with the MARKER and NO STORE resolves. Against the
//! old code it cannot, because there is nothing named `algorithms.json` to find.

use super::*;

/// A throwaway tree. Not `tempfile` — this crate is a build-dependency of 75 crates and takes no
/// dependency it does not need, dev included (`the-rust-build-reads-records-from-the-database`).
struct Tmp(std::path::PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("gm-root-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&p).ok();
        std::fs::create_dir_all(&p).expect("mkdir");
        Tmp(p)
    }
    fn write(&self, rel: &str, body: &str) -> std::path::PathBuf {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().expect("has a parent")).expect("mkdir -p");
        std::fs::write(&p, body).expect("write");
        p
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

/// THE POINT OF THE WHOLE CHANGE: a root with a marker and no store at all still resolves.
#[test]
fn a_root_is_found_by_the_marker_alone_with_no_store_present() {
    let t = Tmp::new("marker-only");
    t.write("graph/store.toml", "store = \"records.db\"\n");
    let manifest = t.write("crates/thing/Cargo.toml", "[package]\nname = \"thing\"\n");
    assert!(!t.0.join("graph/algorithms.json").exists(), "the fixture has NO json store");

    let root = repo_root_by_walk(&manifest).expect("the marker is enough");
    assert_eq!(root, t.0, "root resolved from the marker, not from a store file");
}

/// TRANSITIONAL, and it has to keep working: a parked worktree sitting on a commit older than the
/// marker has no `store.toml`, and refusing there would break every tree in the pool on the day this
/// lands. Delete this test with the fallback, not before.
#[test]
fn the_legacy_anchor_still_resolves_a_root() {
    let t = Tmp::new("legacy");
    t.write("graph/algorithms.json", "{\"implementations\":[]}");
    let manifest = t.write("crates/thing/Cargo.toml", "[package]\nname = \"thing\"\n");
    assert_eq!(repo_root_by_walk(&manifest).expect("legacy anchor"), t.0);
}

/// NEAREST wins. A nested worktree is its own checkout, and the outermost match would compile every
/// worktree against the root checkout's records.
#[test]
fn the_nearest_marker_wins_so_a_nested_worktree_uses_its_own() {
    let t = Tmp::new("nested");
    t.write("graph/store.toml", "store = \"algorithms.json\"\n");
    t.write("wt-inner/graph/store.toml", "store = \"algorithms.json\"\n");
    let manifest = t.write("wt-inner/crates/thing/Cargo.toml", "[package]\nname = \"thing\"\n");
    assert_eq!(
        repo_root_by_walk(&manifest).expect("nested"),
        t.0.join("wt-inner"),
        "the inner checkout is the root for a crate inside it"
    );
}

#[test]
fn no_marker_anywhere_is_an_error_that_names_what_is_missing() {
    let t = Tmp::new("absent");
    let manifest = t.write("crates/thing/Cargo.toml", "[package]\nname = \"thing\"\n");
    let err = repo_root_by_walk(&manifest).expect_err("nothing to find");
    assert!(err.contains("graph/store.toml"), "the error names the marker: {err}");
}

/// The store is NAMED by the marker, so phase 3 of the retirement is a one-line change to a committed
/// file rather than a code change inside a build-dependency of 75 crates.
#[test]
fn the_marker_names_the_store_the_build_reads() {
    let t = Tmp::new("names");
    t.write("graph/store.toml", "# a comment\nstore = \"records.db\"\n");
    assert_eq!(store_name(&t.0), "records.db");
}

#[test]
fn a_commented_out_store_line_is_not_the_store() {
    let t = Tmp::new("commented");
    t.write("graph/store.toml", "# store = \"wrong.db\"\nstore = \"right.db\"\n");
    assert_eq!(store_name(&t.0), "right.db", "a commented line must not win");
}

#[test]
fn an_absent_or_silent_marker_falls_back_to_the_historical_name() {
    let t = Tmp::new("fallback");
    assert_eq!(store_name(&t.0), "algorithms.json", "no marker at all");
    t.write("graph/store.toml", "# nothing declared here\n");
    assert_eq!(store_name(&t.0), "algorithms.json", "a marker that names no store");
}

/// The REAL repo agrees with the marker — a fixture proves the parse, this proves the wiring.
#[test]
fn this_checkout_resolves_its_own_root_and_store() {
    let manifest = std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"));
    let root = repo_root_by_walk(&manifest).expect("this crate is in the repo");
    assert!(root.join("graph").join("store.toml").is_file(), "the marker is committed");
    let store = store_name(&root);
    assert!(
        root.join("graph").join(&store).exists(),
        "the marker names a store that exists: {store}"
    );
}
