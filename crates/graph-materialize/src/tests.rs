//! THE TESTS THIS CRATE COULD NOT HAVE UNTIL IT WAS A PACKAGE.
//!
//! `crates/graph-materialize` was a bare `build.rs` (plus `plan.rs`) that 54 crates pointed their
//! `build =` key at. A build script has no test target, so every rule in it — where the repo root is,
//! which records are a crate's, what the generated file looks like — was assertable only by compiling
//! a crate and reading the output. `plan.rs` worked around that by being `include!`d into
//! `bsc-graph`'s test module; the derivations in `emit.rs` had no such route and were simply untested.
//!
//! The depth rules below are the ones that kept `src-tauri` out of the graph, and they are written to
//! FAIL against the derivation this change replaces:
//! `manifest.parent().and_then(Path::parent).expect("crates/<name> is two deep")` plus a literal
//! `format!("crates/{crate_dir}/src/")`.

use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// A scratch directory of our own. No `tempfile` dependency: this crate is a build-dependency of ~54
/// others and every dev-dependency it grows is compiled before any of them can start.
fn scratch(tag: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let d = std::env::temp_dir().join(format!("gm-{}-{tag}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("scratch dir");
    d
}

/// A repo root holding a committed store with `records` — each `(id, src, code)`.
fn repo_with(root: &Path, records: &[(&str, &str, &str)]) {
    let impls: Vec<serde_json::Value> = records
        .iter()
        .map(|(id, src, code)| serde_json::json!({ "id": id, "src": src, "code": code }))
        .collect();
    std::fs::create_dir_all(root.join("graph")).expect("graph/");
    std::fs::write(
        root.join("graph").join("algorithms.json"),
        serde_json::to_string(&serde_json::json!({ "implementations": impls })).expect("json"),
    )
    .expect("store");
}

/// This checkout's root. Derived the crude way ON PURPOSE — using [`repo_root_by_walk`] here would
/// make the fixture agree with the thing under test by construction.
fn repo() -> PathBuf {
    let r = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf();
    assert!(r.join("graph").join("algorithms.json").is_file(), "{} is not the checkout root", r.display());
    r
}

// ---------------------------------------------------------------------------------------------
// DEPTH. The rules that kept `src-tauri` out of the graph.
// ---------------------------------------------------------------------------------------------

/// THE REPO ROOT IS FOUND BY WALKING UP, NOT BY COUNTING DIRECTORIES.
///
/// The replaced derivation was `manifest.parent().parent()`, which is correct for `crates/<name>` and
/// silently wrong everywhere else: from a crate ONE level deep — which is exactly `src-tauri` — it
/// resolves to the repo's PARENT, so the store path points at a file that does not exist and, if one
/// happened to, at another checkout's records.
#[test]
fn the_repo_root_is_found_by_walking_up_never_by_counting_directories() {
    let root = scratch("walk");
    repo_with(&root, &[]);
    for rel in ["one-deep", "crates/two-deep", "a/b/c/four-deep"] {
        let manifest = root.join(rel);
        std::fs::create_dir_all(&manifest).expect("crate dir");
        assert_eq!(
            repo_root_by_walk(&manifest).expect("the walk finds the store"),
            root,
            "a crate at `{rel}` must resolve to the SAME root — depth is not a signal"
        );
    }
    // …and a directory with no store above it is a named error, not a path that silently misses.
    let orphan = scratch("orphan");
    let err = repo_root_by_walk(&orphan).expect_err("no store above it");
    assert!(err.contains("graph/algorithms.json"), "names what it looked for: {err}");
    assert!(err.contains(&orphan.display().to_string()), "names where it started: {err}");
}

/// THE SOURCE PREFIX IS REPO-RELATIVE, not the literal `crates/<name>/src/` it was hard-coded as.
///
/// This is the second half of the same blocker: even given the right root, the old code searched the
/// store for records under `crates/src-tauri/src/`, a path no record in this repo has ever had.
#[test]
fn the_src_prefix_is_derived_from_the_manifest_not_hardcoded_to_crates() {
    let root = Path::new("/r");
    assert_eq!(src_prefix(root, &root.join("crates").join("plandb")).unwrap(), "crates/plandb/src/");
    assert_eq!(src_prefix(root, &root.join("src-tauri")).unwrap(), "src-tauri/src/");
    assert_eq!(src_prefix(root, &root.join("a").join("b").join("c")).unwrap(), "a/b/c/src/");

    // A manifest outside the root cannot be named relative to it, and the root itself is not a crate.
    assert!(src_prefix(root, Path::new("/elsewhere/thing")).is_err());
    let err = src_prefix(root, root).expect_err("the root is not a crate directory");
    assert!(err.contains("IS the repo root"), "{err}");
}

/// THE NEAREST STORE WINS. Every nested worktree (`wt-<short>/`) is itself a checkout with its own
/// committed store, and an outermost-match walk would compile every worktree against the root
/// checkout's records — which is the bug the old two-levels-up rule accidentally did not have.
#[test]
fn the_nearest_store_wins_so_a_nested_worktree_compiles_its_own_records() {
    let outer = scratch("outer");
    repo_with(&outer, &[]);
    let inner = outer.join("wt-thing");
    repo_with(&inner, &[]);
    let manifest = inner.join("crates").join("k");
    std::fs::create_dir_all(&manifest).expect("crate dir");
    assert_eq!(repo_root_by_walk(&manifest).unwrap(), inner, "the worktree's own store, not its parent's");
}

// ---------------------------------------------------------------------------------------------
// END TO END, at a depth the old script could not express.
// ---------------------------------------------------------------------------------------------

/// A CRATE AT ANY DEPTH MATERIALIZES, driven through the real `emit_into` — resolution, selection,
/// nesting, offsets and the write, with no environment and no build.
///
/// `app-shell` is one level deep, the shape `src-tauri` has.
#[test]
fn a_crate_one_level_deep_materializes_end_to_end() {
    let root = scratch("depth1");
    repo_with(
        &root,
        &[
            ("app-shell--console.rs", "app-shell/src/console.rs", "pub fn open() {}"),
            ("app-shell--console--pty.rs", "app-shell/src/console/pty.rs", "pub fn spawn() {}"),
            // …and a record belonging to somebody else, which must NOT be selected.
            ("plandb--cli.rs", "crates/plandb/src/cli.rs", "pub fn run() {}"),
        ],
    );
    let manifest = root.join("app-shell");
    let out = scratch("depth1-out");
    let n = emit_into(&manifest, &out, None, Adoption::Required).expect("a one-deep crate materializes");
    assert_eq!(n, 2, "its own two modules, and neither of plandb's");

    let got = std::fs::read_to_string(out.join("crate.rs")).expect("crate.rs was written");
    assert!(got.starts_with(PREAMBLE), "the preamble comes first — the offsets are measured past it");
    assert!(got.contains("pub mod console {"), "{got}");
    assert!(got.contains("pub mod pty {"), "the child is nested inside its parent: {got}");
    assert!(!got.contains("pub fn run()"), "another crate's record must not be selected: {got}");
    // The offset header is arithmetic, not decoration — PERFORM it rather than assert a number.
    let lines: Vec<&str> = got.lines().collect();
    let mut checked = 0;
    for (i, l) in lines.iter().enumerate() {
        let Some(rest) = l.trim().strip_prefix("// record `") else { continue };
        let offset: usize = rest
            .rsplit_once("line N-")
            .and_then(|(_, t)| t.split(' ').next())
            .and_then(|n| n.parse().ok())
            .unwrap_or_else(|| panic!("unparseable header: {l}"));
        assert_eq!(offset, i + 1, "the offset IS the header's own line number");
        checked += 1;
    }
    assert_eq!(checked, 2, "every module carries a header — otherwise this loop proves nothing");
}

/// THE DRY RUN FOR `src-tauri`, in its exact shape and under its exact name — a one-deep crate whose
/// modules nest two levels and whose directory modules are `mod.rs` files.
///
/// NO MODULE IS MIGRATED BY THIS ITEM. What this shows is that the mechanism is complete: given a
/// record, a crate named `src-tauri` sitting one level under the root emits the nested tree, with the
/// `mod.rs` mapped onto its directory and the offsets exact. The only thing standing between this and
/// the real thing is authoring the records, which is the next item's job.
#[test]
fn a_src_tauri_shaped_crate_materializes_when_a_record_exists() {
    let root = scratch("srctauri-dry");
    repo_with(
        &root,
        &[
            ("src-tauri--console.rs", "src-tauri/src/console.rs", "pub fn open() {}"),
            ("src-tauri--console--pty--mod.rs", "src-tauri/src/console/pty/mod.rs", "pub fn spawn() {}"),
            ("src-tauri--console--pty--job.rs", "src-tauri/src/console/pty/job.rs", "pub fn reap() {}"),
        ],
    );
    let out = scratch("srctauri-dry-out");
    let n = emit_into(&root.join("src-tauri"), &out, None, Adoption::Required).expect("src-tauri's shape emits");
    assert_eq!(n, 3);
    let got = std::fs::read_to_string(out.join("crate.rs")).expect("crate.rs");
    // `console::pty::job` is INSIDE `console::pty` is INSIDE `console`, and `pty/mod.rs` is `pty`.
    let (console, rest) = got.split_once("pub mod console {").expect("console: {got}");
    assert!(console.ends_with(PREAMBLE), "nothing before the first module but the preamble");
    let (pty, job) = rest.split_once("pub mod pty {").expect("pty is nested in console: {got}");
    assert!(pty.contains("pub fn open()"), "the parent's own body comes first: {got}");
    assert!(job.contains("pub mod job {"), "the grandchild is nested in pty: {got}");
    assert!(!got.contains("mod mod"), "never a module literally called `mod`: {got}");
}

/// The same, four levels deep, so nothing anywhere is counting directories.
#[test]
fn a_crate_four_levels_deep_materializes_end_to_end() {
    let root = scratch("depth4");
    repo_with(&root, &[("deep--thing.rs", "a/b/c/deep/src/thing.rs", "pub fn t() {}")]);
    let out = scratch("depth4-out");
    let n = emit_into(&root.join("a/b/c/deep"), &out, None, Adoption::Required).expect("four deep materializes");
    assert_eq!(n, 1);
    assert!(std::fs::read_to_string(out.join("crate.rs")).unwrap().contains("pub mod thing {"));
}

/// An explicit root overrides the walk, for a crate that lives outside the checkout — and it is a
/// PARAMETER, never an environment read, because a `set_var` here would race every sibling test under
/// `cargo test` while passing under `cargo nextest`'s one-process-per-test isolation.
#[test]
fn an_explicit_root_overrides_the_walk() {
    let root = scratch("explicit");
    repo_with(&root, &[("k--m.rs", "far/k/src/m.rs", "pub fn m() {}")]);
    let manifest = root.join("far").join("k");
    std::fs::create_dir_all(&manifest).expect("crate dir");
    let out = scratch("explicit-out");
    assert_eq!(emit_into(&manifest, &out, Some(&root), Adoption::Required).unwrap(), 1);
}

// ---------------------------------------------------------------------------------------------
// FAILURE IS LOUD — and the one place it deliberately is not.
// ---------------------------------------------------------------------------------------------

/// A REQUIRED adopter that owns no record is a hard error naming the prefix it searched, because its
/// `lib.rs` `include!`s the result and an empty module would surface as a wall of unresolved paths
/// several steps downstream.
#[test]
fn a_required_adopter_with_no_record_is_a_hard_error_that_names_the_prefix() {
    let root = scratch("required");
    repo_with(&root, &[("other--m.rs", "crates/other/src/m.rs", "pub fn m() {}")]);
    let out = scratch("required-out");
    let err = emit_into(&root.join("crates").join("mine"), &out, None, Adoption::Required)
        .expect_err("opted in, owns nothing");
    assert!(err.contains("crates/mine/src/"), "names the prefix it searched: {err}");
    assert!(err.contains("bsc graph impl set"), "says how to fix it: {err}");
    assert!(!out.join("crate.rs").exists(), "and writes nothing");
}

/// AN OPTIONAL ADOPTER IS WIRED AHEAD OF ITS FIRST RECORD — the `src-tauri` case — so an empty
/// selection writes nothing and is not an error…
#[test]
fn an_optional_adopter_with_no_record_writes_nothing_and_still_watches_the_store() {
    let root = scratch("optional");
    repo_with(&root, &[("other--m.rs", "crates/other/src/m.rs", "pub fn m() {}")]);
    let manifest = root.join("app-shell");
    let out = scratch("optional-out");
    assert_eq!(emit_into(&manifest, &out, None, Adoption::Optional).unwrap(), 0);
    assert!(!out.join("crate.rs").exists(), "nothing to include! yet, so nothing is written");

    // …AND THE STORE IS STILL WATCHED. Cargo's default "re-run when anything in the package changes"
    // is replaced the moment a build script prints ANY rerun directive, and `src-tauri`'s own script
    // already prints several for `data/`. Without this the FIRST record ever authored for the crate
    // would not re-run the script and nothing would say so.
    let plan = plan_for(&manifest, None).expect("resolves");
    assert!(plan.rerun.contains(&plan.store_path), "the store is watched even with nothing selected");
}

/// The rerun list names the store AND this materializer's own sources — resolved from the REPO ROOT,
/// not as `<manifest>/../graph-materialize/…`, which only pointed here from a crate two levels deep.
#[test]
fn the_rerun_list_names_the_store_and_this_materializers_own_sources() {
    let plan = plan_for(&repo().join("src-tauri"), None).expect("resolves");
    let names: Vec<String> =
        plan.rerun.iter().map(|p| p.display().to_string().replace('\\', "/")).collect();
    assert!(names.iter().any(|n| n.ends_with("graph/algorithms.json")), "{names:?}");
    for f in ["crates/graph-materialize/build.rs", "crates/graph-materialize/plan.rs", "crates/graph-materialize/emit.rs"] {
        assert!(names.iter().any(|n| n.ends_with(f)), "{f} is not watched: {names:?}");
    }
    for p in &plan.rerun {
        assert!(p.is_file(), "{} is watched but does not exist", p.display());
    }
}

// ---------------------------------------------------------------------------------------------
// THE REAL TREE. Nothing already migrated moves; `src-tauri` becomes reachable.
// ---------------------------------------------------------------------------------------------

/// EVERY EXISTING ADOPTER STILL RESOLVES TO THE PREFIX THE OLD CODE HARD-CODED.
///
/// This is the resolution half of the byte-identity claim: the selection is `src.strip_prefix(prefix)`
/// plus an id match, so a prefix that is unchanged for all 54 crates cannot change which records they
/// select, and therefore cannot change what they emit.
#[test]
fn every_opted_in_crate_resolves_to_exactly_the_prefix_the_old_derivation_hardcoded() {
    let root = repo();
    let marker = r#"build = "../graph-materialize/build.rs""#;
    let mut checked = 0usize;
    for entry in std::fs::read_dir(root.join("crates")).expect("crates/") {
        let dir = entry.expect("entry").path();
        let Some(krate) = dir.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        if !std::fs::read_to_string(dir.join("Cargo.toml")).unwrap_or_default().contains(marker) {
            continue;
        }
        let plan = plan_for(&dir, None).unwrap_or_else(|e| panic!("crates/{krate}: {e}"));
        assert_eq!(plan.repo_root, root, "crates/{krate}");
        assert_eq!(plan.crate_dir, krate);
        assert_eq!(plan.src_prefix, format!("crates/{krate}/src/"), "the old literal, now derived");
        assert_eq!(plan.store_path, root.join("graph").join("algorithms.json"));
        checked += 1;
    }
    // POPULATION, so a walk that silently stopped matching fails loudly rather than passing over
    // nothing. Measured 2026-09-04: 54 opted-in crates.
    assert!(checked >= 40, "only {checked} crates carry the marker — the walk is wrong");
}

/// THE `src-tauri` PROOF, and the whole point of this change: the largest un-migrated body in the repo
/// (141 files, 54,683 lines, zero records) now resolves correctly, from its own one-level depth, with
/// its own `build.rs` still owning the four jobs it already had.
///
/// NO MODULE IS MIGRATED HERE. What is asserted is that everything downstream of the resolution is
/// already correct: the root is this checkout, the store is the committed one, the prefix is the one
/// the 137 nested files actually live under, and the selection is EMPTY today — which is exactly why
/// `src-tauri/build.rs` calls [`emit_when_adopted`] and not [`emit`].
#[test]
fn src_tauri_resolves_correctly_today_and_selects_nothing_yet() {
    let root = repo();
    let plan = plan_for(&root.join("src-tauri"), None).expect("src-tauri resolves");
    assert_eq!(plan.repo_root, root, "one level deep, and still this checkout");
    assert_eq!(plan.crate_dir, "src-tauri");
    assert_eq!(plan.src_prefix, "src-tauri/src/", "the prefix its 141 files actually live under");
    assert!(plan.store_path.is_file(), "{} is the committed store", plan.store_path.display());

    // The old derivation, reproduced, so the failure it caused is recorded rather than described.
    let old_root = root.join("src-tauri").parent().and_then(Path::parent).unwrap().to_path_buf();
    assert_ne!(old_root, root, "`parent().parent()` from a one-deep crate leaves the repo entirely");

    // Selection over the REAL store. Zero today — `src-tauri` owns no record — and the emit is
    // therefore a no-op rather than the hard error a `Required` adopter would get.
    let raw = std::fs::read_to_string(&plan.store_path).expect("the committed store reads");
    let store: serde_json::Value = serde_json::from_str(&raw).expect("it parses");
    let impls = store.get("implementations").and_then(|v| v.as_array()).expect("implementations");
    let selected = plan.select(impls);
    assert!(
        selected.is_empty(),
        "src-tauri owns {} records — this item does NOT migrate any module, so if this fires the \
         migration has started and this test should become the byte-identity check instead",
        selected.len()
    );
    assert_eq!(plan.render_store(&raw, Adoption::Optional).expect("no error"), None, "nothing to write yet");
    assert!(
        plan.render_store(&raw, Adoption::Required).is_err(),
        "…while a Required adopter owning nothing stays a hard error"
    );

    // And every one of its real modules maps to a module path under that prefix, which is what a
    // future migration will select on. POPULATION-asserted so a walk that found nothing reads as a
    // failure rather than as a pass.
    let mut mapped = 0usize;
    let mut nested = 0usize;
    for f in rs_files(&root.join("src-tauri").join("src"), "") {
        if f == "lib.rs" || f == "main.rs" {
            continue;
        }
        assert!(module_path(&f).is_some(), "src-tauri/src/{f} maps to no module");
        assert_eq!(expected_id("src-tauri", &f), format!("src-tauri--{}", f.replace('/', "--").replace('_', "-")));
        if f.contains('/') {
            nested += 1;
        }
        mapped += 1;
    }
    assert!(mapped > 100, "only {mapped} modules found under src-tauri/src");
    assert!(nested > 100, "only {nested} nested — the depth this crate needed");
}

/// Every `.rs` under `dir`, as a path relative to it, skipping dot-directories.
fn rs_files(dir: &Path, prefix: &str) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            out.extend(rs_files(&p, &format!("{prefix}{name}/")));
        } else if name.ends_with(".rs") {
            out.push(format!("{prefix}{name}"));
        }
    }
    out.sort();
    out
}
