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

/// THE `src-tauri` PROOF, and the whole point of this change: the largest body in the repo resolves
/// correctly from its own one-level depth, with its own `build.rs` still owning the four jobs it had.
///
/// # This test INVERTED, and its own failure message is what asked for it
///
/// It used to assert that the selection is EMPTY — `src-tauri` owned no record, so
/// `emit_when_adopted` wrote nothing and the crate was wired AHEAD of its first record. The message
/// under that assertion said what to do when it fired: "if this fires the migration has started and
/// this test should become the byte-identity check instead". `src-tauri-compiles-from-the-graph`
/// fired it, and this is that check.
///
/// The resolution half is unchanged and still the thing that mattered, because it is what the old
/// derivation could not express at all. What replaces the emptiness assertion is the rendering: every
/// selected record must reach the generated file, under a module path derived from its `src`, with
/// the parent chain intact — which is the property a 138-record, 24-directory-module crate needs and
/// a zero-record one could not exercise.
#[test]
fn src_tauri_resolves_and_now_renders_every_record_it_owns() {
    let root = repo();
    let plan = plan_for(&root.join("src-tauri"), None).expect("src-tauri resolves");
    assert_eq!(plan.repo_root, root, "one level deep, and still this checkout");
    assert_eq!(plan.crate_dir, "src-tauri");
    assert_eq!(plan.src_prefix, "src-tauri/src/", "the prefix its modules live under");
    assert!(plan.store_path.is_file(), "{} is the committed store", plan.store_path.display());

    // The old derivation, reproduced, so the failure it caused is recorded rather than described.
    let old_root = root.join("src-tauri").parent().and_then(Path::parent).unwrap().to_path_buf();
    assert_ne!(old_root, root, "`parent().parent()` from a one-deep crate leaves the repo entirely");

    // Selection over the REAL store.
    let raw = std::fs::read_to_string(&plan.store_path).expect("the committed store reads");
    let store: serde_json::Value = serde_json::from_str(&raw).expect("it parses");
    let impls = store.get("implementations").and_then(|v| v.as_array()).expect("implementations");
    let selected = plan.select(impls);
    // POPULATION, because a selection that silently stopped matching would satisfy every assertion
    // below over nothing — which is exactly what the emptiness assertion used to look like.
    // Measured 2026-09-05: 138 records, 24 of them directory modules.
    assert!(selected.len() >= 136, "src-tauri owns only {} records", selected.len());
    let mod_rs = selected.iter().filter(|u| u.id.ends_with("--mod.rs")).count();
    assert!(mod_rs >= 24, "only {mod_rs} directory modules selected");

    // AND IT RENDERS. `Optional` no longer means "writes nothing" for this crate — it means the same
    // thing `Required` does now that a record exists, which is the state change this test records.
    let rendered = plan
        .render_store(&raw, Adoption::Optional)
        .expect("no error")
        .expect("a crate that owns records renders them");
    assert_eq!(
        plan.render_store(&raw, Adoption::Required).expect("no error"),
        Some(rendered.clone()),
        "Optional and Required agree once the crate owns a record — adoption only decides what EMPTY means"
    );
    // Every selected record must actually reach the file, at its own depth. A `mod <name> {` for the
    // last segment is the weakest claim that cannot be satisfied by dropping a nested unit on the floor.
    for u in &selected {
        let name = u.path.last().expect("a module has a name");
        assert!(
            rendered.contains(&format!("mod {name} {{")),
            "`{}` (module `{}`) is selected but never rendered",
            u.id,
            u.path.join("::")
        );
        assert!(rendered.contains(&format!("record `{}`", u.id)), "…and its offset header is missing");
    }

    // The FILES that are left map to nothing this crate would select, which is the other half: a
    // crate root is never a module, and `mod tests` stays a file beside `lib.rs`.
    let left = rs_files(&root.join("src-tauri").join("src"), "");
    for f in &left {
        if f == "lib.rs" || f == "main.rs" {
            assert!(module_path(f).is_none(), "a crate root is not a module: {f}");
        }
    }
    assert!(left.len() <= 8, "src-tauri/src still holds {} files — the migration did not land", left.len());
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

// ---------------------------------------------------------------------------------------------
// THE CRATE ROOT IS SHARED. The guards for `a-crate-root-is-shared-so-a-crate-is-one-file`.
// ---------------------------------------------------------------------------------------------

/// Every adopter's `[lib]` `path`, and whether its `src/` still holds a root — read off THIS checkout.
///
/// Returned as data rather than asserted inline so both guards below read the same tree the same way,
/// and so a failure can name every offender instead of the first.
fn adopters(root: &Path) -> Vec<(String, String, Option<String>)> {
    let mut out = Vec::new();
    let dir = root.join("crates");
    let Ok(entries) = std::fs::read_dir(&dir) else { return out };
    let mut names: Vec<String> =
        entries.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    names.sort();
    for name in names {
        let krate = dir.join(&name);
        let Ok(manifest) = std::fs::read_to_string(krate.join("Cargo.toml")) else { continue };
        // The SHARED-SCRIPT route only. A crate reaching the materializer through the build-DEPENDENCY
        // route (`crates/data`, `crates/bsc-config`, `src-tauri`) owns a build script doing other jobs
        // and is not at the floor by a long way; sweeping it in would assert a rule about crates this
        // change never touched.
        if !manifest.contains(r#"build = "../graph-materialize/build.rs""#) {
            continue;
        }
        let root_src = std::fs::read_to_string(krate.join("src").join("lib.rs")).ok();
        out.push((name, manifest, root_src));
    }
    out
}

/// NO ADOPTER HAS RE-GROWN A PRIVATE CRATE ROOT.
///
/// The shared root is one file (`crates/graph-materialize/crate_root.rs`) and its whole value is that
/// it is ONE — a crate that quietly grows a `src/lib.rs` of its own again is back at two files and
/// nothing else would say so, because it still compiles perfectly. `migrate-crate` can put a crate at
/// the floor; only a guard keeps it there.
///
/// The rule is conditional on purpose: 48 crates still hold real code in their roots, and that is the
/// LARGER migration this is not. What is asserted is the implication — a root that is only its docs
/// and the one `include!` must not be a file.
///
/// It FAILS against the tree this change replaced: on `develop` all 11 crates below had exactly that
/// root and no `[lib] path`, so this named all 11.
#[test]
fn no_adopter_has_regrown_a_private_crate_root() {
    let root = repo();
    let mut offenders: Vec<String> = Vec::new();
    let mut at_floor = 0usize;
    for (name, manifest, root_src) in adopters(&root) {
        let wants = r#"path = "../graph-materialize/crate_root.rs""#;
        match root_src {
            // A root that still holds a program keeps its file — that is the other migration.
            Some(src) if !root_is_bare_for_test(&src) => {}
            // A root that is only docs + the include has no reason to exist.
            Some(_) => offenders.push(format!(
                "crates/{name}/src/lib.rs is only its docs and the include, but the manifest does not \
                 point [lib] path at the shared crate root"
            )),
            // A BINARY ROOT IS OUT OF SCOPE, and saying so is not a loophole. `bsc` and `bsc-agent`
            // declare their modules in `src/main.rs` and have no lib at all; the same trick applies to
            // them through `[[bin]] path`, but nothing wires it yet, so asserting the lib rule over
            // them would report two healthy crates as broken.
            None if root.join("crates").join(&name).join("src").join("main.rs").is_file() => {}
            None => {
                if manifest.lines().any(|l| l.trim() == wants) {
                    at_floor += 1;
                } else {
                    offenders.push(format!(
                        "crates/{name} has no src/lib.rs and no `{wants}` — it will not compile, and \
                         cargo will look for a root that is not there"
                    ));
                }
            }
        }
    }
    assert!(offenders.is_empty(), "{} adopter(s) off the shared root:\n  {}", offenders.len(), offenders.join("\n  "));
    // THE POPULATION, asserted rather than described. A rewritten `adopters` that stopped matching
    // would find zero crates and report a clean pass over nothing — the exact green-that-sees-less
    // this repo keeps paying for.
    assert!(at_floor >= 11, "only {at_floor} crate(s) are at the floor; 11 were migrated");
}

/// The floor test, restated where this crate can see it.
///
/// `bsc-graph::migrate::root_is_bare` is the authority and the two must agree, but this package is a
/// build-dependency of ~54 crates and taking `bsc-graph` for a test would compile it before any of
/// them could start. The rule is four lines; the dependency would not be.
fn root_is_bare_for_test(src: &str) -> bool {
    let mut include = false;
    for line in src.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("//") {
            continue;
        }
        if t.starts_with("include!(concat!(env!(\"OUT_DIR\")") {
            include = true;
            continue;
        }
        return false;
    }
    include
}

/// TWO ADOPTERS SHARING ONE ROOT FILE STILL DOCUMENT THEMSELVES DIFFERENTLY.
///
/// This is the whole risk the shared root introduces, and it is invisible from a build: every crate
/// compiles, every test passes, and `cargo doc` quietly renders the same page for all 61. So the
/// difference is asserted at the mechanism — `emit_into` writing the real `$OUT_DIR/crate_doc.md` that
/// `#![doc = include_str!(…)]` reads — over the REAL committed store, rather than observed by hand.
#[test]
fn two_adopters_produce_different_crate_docs() {
    let root = repo();
    let read = |krate: &str| {
        let out = scratch(krate);
        emit_into(&root.join("crates").join(krate), &out, Some(&root), Adoption::Required)
            .unwrap_or_else(|e| panic!("materializing {krate}: {e}"));
        std::fs::read_to_string(out.join("crate_doc.md")).expect("crate_doc.md is always written")
    };
    let fin = read("bsc-fin");
    let tunnel = read("bsc-tunnel");
    assert!(!fin.trim().is_empty(), "bsc-fin's crate docs reached OUT_DIR");
    assert!(!tunnel.trim().is_empty(), "bsc-tunnel's crate docs reached OUT_DIR");
    assert_ne!(fin, tunnel, "one shared crate root must NOT collapse every crate's documentation into one");
    // …and each is its OWN prose, not merely a different length.
    assert!(fin.contains("finance"), "bsc-fin documents the finance store: {fin}");
    assert!(tunnel.contains("tunnel"), "bsc-tunnel documents the tunnel: {tunnel}");
    // The markdown carries no `//!` markers — it is included as markdown, not as Rust.
    assert!(!fin.contains("//!"), "the doc record holds markdown, not doc comments");
}

/// THE SHARED ROOT IS ONE FILE, and the only thing that guarantees byte-identity for 61 crates.
///
/// Asserted against every adopter's manifest rather than by comparing copies, because there is nothing
/// to compare: a second copy is exactly the failure. It also pins the two lines the root must have —
/// a root that lost the `#![doc = …]` would compile and silently document nothing.
#[test]
fn the_shared_crate_root_is_one_file_that_carries_both_halves() {
    let root = repo();
    let path = root.join("crates").join("graph-materialize").join("crate_root.rs");
    let src = std::fs::read_to_string(&path).expect("crates/graph-materialize/crate_root.rs");
    assert!(
        src.contains(r#"#![doc = include_str!(concat!(env!("OUT_DIR"), "/crate_doc.md"))]"#),
        "the shared root must pick up each crate's OWN docs from OUT_DIR"
    );
    assert!(src.contains(r#"include!(concat!(env!("OUT_DIR"), "/crate.rs"));"#), "…and its modules");
    let code = src.lines().filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with("//")).count();
    assert_eq!(code, 2, "the shared root is two lines of code; anything more is per-crate logic in a shared file");
    // Nobody has copied it. `[lib] path` is the only way to reach it, and a copy under any crate's own
    // directory would be a second root that can drift.
    let stray: Vec<String> = adopters(&root)
        .into_iter()
        .filter(|(name, ..)| root.join("crates").join(name).join("crate_root.rs").is_file())
        .map(|(name, ..)| name)
        .collect();
    assert!(stray.is_empty(), "crate_root.rs is copied into: {stray:?}");
}
