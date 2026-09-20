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
fn scratch(tag: &str) -> Scratch {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let d = std::env::temp_dir().join(format!("gm-{}-{tag}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("scratch dir");
    Scratch(d)
}

/// A scratch directory that REMOVES ITSELF when the test ends, pass or fail — unwinding runs `Drop`.
/// Returning a bare `PathBuf` left every one behind in /tmp, a 16 GB RAM tmpfs: 6,930 `gm-*` and 3,352
/// `gmtt-*` entries when measured (`the-test-suites-leak-temp-dirs-into-tmp`). It derefs to `PathBuf`,
/// so every call site reads exactly as it did.
#[derive(Debug)]
struct Scratch(PathBuf);

/// So an assertion reads `assert_eq!(path, root)` whether `root` is the guard or the path it holds.
impl PartialEq<Scratch> for PathBuf {
    fn eq(&self, other: &Scratch) -> bool {
        *self == other.0
    }
}

impl std::ops::Deref for Scratch {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A repo root holding a committed store with `records` — each `(id, src, code)`.
fn repo_with(root: &Path, records: &[(&str, &str, &str)]) {
    let impls: Vec<serde_json::Value> = records
        .iter()
        .map(|(id, src, code)| serde_json::json!({ "id": id, "src": src, "code": code }))
        .collect();
    std::fs::create_dir_all(root.join("graph")).expect("graph/");
    // The MARKER is what makes this a repo root, and it names the store. A JSON store is still a
    // legal one — the loader sniffs the magic bytes — so a fixture does not need a database to be a
    // faithful fixture, and keeping it as JSON is what lets these tests state their records inline.
    std::fs::write(root.join("graph").join("store.toml"), "store = \"algorithms.json\"\n").expect("marker");
    std::fs::write(
        root.join("graph").join("algorithms.json"),
        serde_json::to_string(&serde_json::json!({ "implementations": impls })).expect("json"),
    )
    .expect("store");
}

/// This checkout's COMMITTED STORE. Read the crude way, for the same reason [`repo`] is: calling
/// [`store_name`] here would make every assertion below agree with the thing under test by
/// construction, and the store's NAME is exactly what the marker exists to decide.
fn committed_store(root: &Path) -> PathBuf {
    let marker = std::fs::read_to_string(root.join("graph").join("store.toml")).expect("graph/store.toml");
    let name = marker
        .lines()
        .find_map(|l| l.split_once('=').filter(|(k, _)| k.trim() == "store").map(|(_, v)| v.trim().trim_matches('"').to_string()))
        .expect("graph/store.toml names a store");
    root.join("graph").join(name)
}

/// This checkout's root. Derived the crude way ON PURPOSE — using [`repo_root_by_walk`] here would
/// make the fixture agree with the thing under test by construction.
fn repo() -> PathBuf {
    let r = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf();
    // The MARKER, not the store: the committed store is a database now
    // (`retire-the-committed-json-record-store`) and may be renamed again. Still a literal path rather
    // than `repo_root_by_walk`, so the fixture does not agree with the thing under test by construction.
    assert!(r.join("graph").join("store.toml").is_file(), "{} is not the checkout root", r.display());
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
    // …and a directory with no MARKER above it is a named error, not a path that silently misses.
    // It names `graph/store.toml` rather than the store: root discovery stopped keying on the store
    // file (`the-repo-root-is-its-own-marker`), so the error has to send a reader to the marker.
    let orphan = scratch("orphan");
    let err = repo_root_by_walk(&orphan).expect_err("no marker above it");
    assert!(err.contains("graph/store.toml"), "names what it looked for: {err}");
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
    assert!(err.contains("bsc algorithms impl set"), "says how to fix it: {err}");
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
    let store_rel = format!("graph/{}", committed_store(&repo()).file_name().unwrap().to_string_lossy());
    assert!(names.iter().any(|n| n.ends_with(&store_rel)), "the store {store_rel} is not watched: {names:?}");
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
        assert_eq!(plan.store_path, committed_store(&root));
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
    // Through the crate's OWN merged loader, which is what `emit_into` reads the store with. A
    // `read_to_string` here saw only the store FILE, so the day `src-tauri`'s 138 records split out
    // into `graph/records/` this asserted "src-tauri owns only 0 records"
    // (`epic-retire-json-ledgers-for-db-and-git-drivers`).
    let raw = load_merged_store(&plan.store_path).expect("the committed store reads");
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
        // EITHER ROOT. A binary declares its program in `src/main.rs` and reaches the shared root
        // through `[[bin]] path`; reading only `lib.rs` reported `bsc-hook` as having no root at all
        // and quietly excused it from the rule.
        let root_src = std::fs::read_to_string(krate.join("src").join("lib.rs"))
            .or_else(|_| std::fs::read_to_string(krate.join("src").join("main.rs")))
            .ok();
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
                "crates/{name}'s crate root is only its docs and the include, but the manifest does \
                 not point its [lib]/[[bin]] path at the shared crate root"
            )),
            // A BINARY ROOT USED TO BE OUT OF SCOPE, "because nothing wires it yet". Something does
            // now (`the-crate-body-is-a-record-not-only-its-children`): `bsc-hook` reaches the same
            // shared file through `[[bin]] path`, so the carve-out is gone and the rule is one rule.
            None => {
                if manifest.lines().any(|l| l.trim() == wants) {
                    at_floor += 1;
                    // AND NOTHING ELSE EITHER. The floor is a `Cargo.toml` and nothing else, so a
                    // crate that pointed its path at the shared root and kept a `src/` of stray
                    // modules would compile perfectly while being two files again.
                    let strays = rs_files(&root.join("crates").join(&name).join("src"), "");
                    if !strays.is_empty() {
                        offenders.push(format!("crates/{name} is at the floor but src/ still holds {strays:?}"));
                    }
                } else {
                    offenders.push(format!(
                        "crates/{name} has no crate root on disk and no `{wants}` — it will not \
                         compile, and cargo will look for a root that is not there"
                    ));
                }
            }
        }
    }
    assert!(offenders.is_empty(), "{} adopter(s) off the shared root:\n  {}", offenders.len(), offenders.join("\n  "));
    // THE POPULATION, asserted rather than described. A rewritten `adopters` that stopped matching
    // would find zero crates and report a clean pass over nothing — the exact green-that-sees-less
    // this repo keeps paying for.
    // 11 BEFORE `the-crate-body-is-a-record-not-only-its-children`, 16 after — the five crates whose
    // whole implementation was their root and which `migrate-crate` could not see at all. 61 after
    // `the-crate-root-implementations-move-into-the-graph`, which applied that same unmodified verb to
    // every remaining root. The number is what makes this red against the pre-change tree rather than
    // merely unchanged: at 16 this passed over a tree with 45 unmigrated roots in it.
    //
    // THIS ONE ONLY EVER RISES, which is the opposite of the population floors in
    // `bsc-graph::migration_ratchet` and `bsc-graph::crate_root_tests` — those count what is still on
    // DISK and fall as the migration proceeds, this counts what has REACHED the floor. Raise it when
    // crates land; never lower it to quiet a red, because a crate leaving the floor means a root grew
    // back.
    assert!(at_floor >= 61, "only {at_floor} crate(s) are at the floor; 61 have been migrated");
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

/// THE SPLIT ITSELF, where a unit test can see it.
///
/// `split_root` is the whole mechanism of `the-crate-body-is-a-record-not-only-its-children` and the
/// two guards below reach it only through a real store and a real `$OUT_DIR`. The rules it has to keep
/// are cheap to state and were each a way to get this silently wrong.
#[test]
fn split_root_divides_the_prose_from_the_program_without_moving_a_line() {
    let src = "//! One.\n//!\n//! Two.\npub use x::y;\n\npub fn go() {}\n";
    let (doc, body) = split_root(src);
    assert_eq!(doc, "One.\n\nTwo.\n", "the `//!` marker is stripped and the prose is verbatim");
    // LINE COUNT IS PRESERVED, which is what keeps the offset header's subtraction exact. Removing the
    // doc block would be the obvious implementation and would make every reported line wrong by 3.
    assert_eq!(body.lines().count(), src.lines().count(), "same height:\n{body}");
    assert!(!body.contains("//!"), "an inner doc comment cannot survive include! (E0753)");
    assert!(body.starts_with("// One."), "…so it becomes a plain comment: {body}");
    assert!(body.contains("pub use x::y;") && body.contains("pub fn go()"), "the program is verbatim");

    // Only the LEADING run. `//!` inside an inline module is legal in an included file and is left
    // exactly as written — rewriting it would change that module's own documentation.
    let inline = "//! Head.\npub mod m {\n    //! Inner.\n}\n";
    let (doc, body) = split_root(inline);
    assert_eq!(doc, "Head.\n");
    assert!(body.contains("//! Inner."), "an inline module keeps its own inner docs: {body}");

    // A root with no prose contributes an EMPTY doc, never a blank line: the shared root includes
    // `crate_doc.md` unconditionally, so a lone newline would head every undocumented crate's rustdoc.
    assert_eq!(split_root("pub fn go() {}\n").0, "");
    assert_eq!(split_root("").0, "");
    // …and a root opening with a plain comment contributes none either, which is correct — that
    // comment is not documentation.
    assert_eq!(split_root("// not docs\n//! nor these\n").0, "");
}

/// TWO CRATES WHOSE BODY IS A RECORD STILL DOCUMENT THEMSELVES DIFFERENTLY — and still get their own
/// PROGRAM.
///
/// The sibling above pins the doc-only crates migrated by `a-crate-root-is-shared-so-a-crate-is-one-file`.
/// This one pins the crates whose ROOT RECORD CARRIES CODE, which is a second way for the shared file
/// to collapse two crates into one: `crate.rs` is per-`$OUT_DIR` exactly as `crate_doc.md` is, and
/// nothing about a build would say if it stopped being.
///
/// `mcp-rpc` and `bsc-appchan` are two of the five crates that owned no record at all before this
/// change. It is RED against the pre-change tree twice over: neither crate had a record, so
/// `Adoption::Required` is a hard error before any assertion is reached.
#[test]
fn two_crates_whose_body_is_a_record_get_their_own_docs_and_their_own_program() {
    let root = repo();
    let read = |krate: &str| {
        let out = scratch(krate);
        emit_into(&root.join("crates").join(krate), &out, Some(&root), Adoption::Required)
            .unwrap_or_else(|e| panic!("materializing {krate}: {e}"));
        let doc = std::fs::read_to_string(out.join("crate_doc.md")).expect("crate_doc.md");
        let body = std::fs::read_to_string(out.join("crate.rs")).expect("crate.rs");
        (doc, body)
    };
    let (rpc_doc, rpc_body) = read("mcp-rpc");
    let (chan_doc, chan_body) = read("bsc-appchan");

    // The DOCS are each crate's own — the risk the shared `#![doc = include_str!(…)]` introduces.
    assert!(!rpc_doc.trim().is_empty() && !chan_doc.trim().is_empty(), "both crates document themselves");
    assert_ne!(rpc_doc, chan_doc, "one shared crate root must NOT collapse two crates' documentation");
    assert!(rpc_doc.contains("JSON-RPC"), "mcp-rpc documents the JSON-RPC core: {rpc_doc}");
    assert!(chan_doc.contains("app"), "bsc-appchan documents the app channel: {chan_doc}");
    assert!(!rpc_doc.contains("//!"), "the doc half is markdown, not doc comments");

    // The PROGRAM is each crate's own too, and that is the half this change added. A body is not a
    // module block: it is emitted at the top level, which is where the crate root's items were.
    assert_ne!(rpc_body, chan_body, "…nor their programs");
    assert!(rpc_body.contains("pub trait ToolServer"), "mcp-rpc's own root items: {rpc_body}");
    assert!(chan_body.contains("pub struct Envelope"), "bsc-appchan's own root items");
    // The body is at the TOP LEVEL, where the crate root's items were — never wrapped in a module
    // named after the crate, which would move every path the crate's dependents use.
    assert!(!rpc_body.contains("mod mcp_rpc"), "the root body is not wrapped in a module: {rpc_body}");
    // The `//!` block SURVIVES as a plain comment, which is what keeps the offset arithmetic exact.
    assert!(!rpc_body.contains("//!"), "an inner doc comment cannot survive include! (E0753)");
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

// ---------------------------------------------------------------------------------------------
// DERIVED `use` LINES. The composes graph is authoritative; no `use` is hand-written.
// (`imports-are-derived-from-the-composes-graph`)
// ---------------------------------------------------------------------------------------------

/// `derive_uses` is the whole Rust rule set in one pure function, so it is tested as one: a named
/// single, a named group (author order preserved INSIDE the braces), a namespace glob, and the three
/// shapes that must produce NOTHING — an empty `from`, an empty symbol list that is not a glob, and a
/// spec whose only symbols are blank. The output is sorted and de-duplicated, which is what keeps the
/// block byte-deterministic regardless of the order `imports` arrives in.
#[test]
fn derive_uses_covers_every_shape_and_is_deterministic() {
    let spec = |from: &str, syms: &[&str], kind: &str| ImportSpec {
        from: from.to_string(),
        symbols: syms.iter().map(|s| s.to_string()).collect(),
        type_only: false,
        kind: kind.to_string(),
    };
    let uses = derive_uses(&[
        spec("serde", &["Serialize", "Deserialize"], "named"),
        spec("crate::plan", &["Unit"], "named"),
        spec("std::collections", &[], "namespace"),
        spec("", &["Nope"], "named"),            // no path              → nothing
        spec("dead::end", &[], "named"),         // no symbols, no glob  → nothing
        spec("blank::syms", &["", ""], "named"), // only blank symbols   → nothing
    ]);
    assert_eq!(
        uses,
        vec![
            "    use crate::plan::Unit;".to_string(),
            "    use serde::{Serialize, Deserialize};".to_string(),
            "    use std::collections::*;".to_string(),
        ],
        "sorted, deduped, blanks dropped, and a group keeps the author's order inside the braces"
    );

    // `type_only` is IGNORED on the Rust side — one `use` carries a type exactly as it carries a value,
    // because Rust has no `import type`. This is the sharpest place the TS-shaped field and Rust differ.
    let t = derive_uses(&[ImportSpec {
        from: "crate::x".into(),
        symbols: vec!["T".into()],
        type_only: true,
        kind: "named".into(),
    }]);
    assert_eq!(t, vec!["    use crate::x::T;".to_string()], "no `import type` in Rust");
}

/// The composes graph reaches the GENERATED FILE, and injecting the `use` lines does not corrupt the
/// per-record offset header — the property everything downstream (a panic's line number, a `bsc` jump
/// into a record) leans on. The header is computed from the LIVE line count, so the `use` lines pushed
/// ahead of it simply move it down and the record's own code still reports the right in-record line.
#[test]
fn imports_reach_the_generated_file_and_the_offset_header_stays_exact() {
    let root = scratch("imports-rt");
    std::fs::create_dir_all(root.join("graph")).expect("graph/");
    std::fs::write(root.join("graph").join("store.toml"), "store = \"algorithms.json\"\n").expect("marker");
    let store = serde_json::json!({
        "implementations": [{
            "id": "mine--thing.rs",
            "src": "crates/mine/src/thing.rs",
            "code": "pub fn t() -> Foo {\n    Foo::default()\n}",
            "imports": [
                { "from": "crate::foo", "symbols": ["Foo"], "kind": "named" },
                { "from": "serde", "symbols": ["Serialize", "Deserialize"], "kind": "named" }
            ]
        }]
    });
    std::fs::write(
        root.join("graph").join("algorithms.json"),
        serde_json::to_string(&store).unwrap(),
    )
    .expect("store");

    let out = scratch("imports-rt-out");
    let n = emit_into(&root.join("crates").join("mine"), &out, None, Adoption::Required).expect("emits");
    assert_eq!(n, 1, "one module, and the use lines must not be counted as records");
    let crate_rs = std::fs::read_to_string(out.join("crate.rs")).expect("crate.rs");

    // The derived `use` lines are present, inside the module.
    assert!(crate_rs.contains("    use crate::foo::Foo;"), "derived crate:: use missing:\n{crate_rs}");
    assert!(
        crate_rs.contains("    use serde::{Serialize, Deserialize};"),
        "derived external use missing:\n{crate_rs}"
    );

    // They sit BEFORE the offset header — the top of the module body — so they are the module's
    // imports, never part of the record's code.
    let lines: Vec<&str> = crate_rs.lines().collect();
    let use_at = lines.iter().position(|l| l.contains("use crate::foo::Foo;")).unwrap();
    let header_at = lines.iter().position(|l| l.contains("line N here is line N-")).unwrap();
    assert!(use_at < header_at, "the use lines must precede the offset header:\n{crate_rs}");

    // OFFSET ARITHMETIC. The header claims "line N here is line N-K". The record's code line 1
    // ("pub fn t() …") is the line right after the header, so its 1-indexed output line minus K must be
    // exactly 1 — the invariant a hand-written `use` block above the code would have broken.
    let k: usize = {
        let h = lines[header_at];
        let tail = h.split("line N-").nth(1).unwrap();
        tail.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap()
    };
    let code_line_1 = lines.iter().position(|l| l.contains("pub fn t() -> Foo {")).unwrap() + 1;
    assert_eq!(code_line_1 - k, 1, "record line 1 must still map to in-record line 1 after use-injection");
}

// ---------------------------------------------------------------------------------------------
// THE TAURI COMMAND FACET (`a-tauri-command-is-a-record-facet`).
//
// `#[tauri::command]` is not formatting. It generates `__cmd__<name>` in the module that HOLDS the
// function, and `generate_handler![m::name]` resolves it there — so as body text it pinned every
// command to its module, and the 201-entry handler list in `app/run.rs` was a SECOND hand-maintained
// statement of the same set. These assert the two properties that make one declaration serve both:
// the attribute comes back on the way to the compiler WITHOUT moving a line, and the handler list is
// built from the same declaration.
// ---------------------------------------------------------------------------------------------

fn cmd(name: &str) -> TauriCommand {
    TauriCommand { name: name.into(), args: None }
}

/// THE LINE COUNT IS INVARIANT, and that is the whole reason the attribute goes ON the declaration
/// line rather than above it.
///
/// Every module in a generated `crate.rs` carries `line N here is line N-<offset> in the record`, the
/// only thing that makes a compiler error inside a 12,609-line record navigable. An attribute emitted
/// on a line of its own would shift every line below it by one and make that subtraction wrong for the
/// rest of the module — silently, because the header would still look correct.
#[test]
fn the_attribute_is_reattached_without_moving_a_single_line() {
    let code = "/// docs\npub(crate) async fn pick_directory() -> Option<String> {\n    None\n}\n";
    let (out, sites) = apply_tauri_commands("r", code, &[cmd("pick_directory")]).expect("applies");
    assert_eq!(
        out.split('\n').count(),
        code.split('\n').count(),
        "the attribute must share the declaration's line:\n{out}"
    );
    assert!(
        out.contains("#[tauri::command] pub(crate) async fn pick_directory()"),
        "attribute not on the declaration line:\n{out}"
    );
    assert_eq!(sites, vec![CommandSite { name: "pick_directory".into(), cfgs: Vec::new() }]);
}

/// A `#[cfg]` STAYS ABOVE the inserted attribute, and is carried onto the handler arm as well.
///
/// Attribute order is semantic: an attribute BEFORE an attribute macro applies to its expansion, one
/// AFTER it is part of the item handed to the macro. `#[cfg]` must gate the whole expansion, and the
/// registration too — six of this repo's commands are gated on `feature = "source-stage"`, and a
/// handler entry that lost the gate would name a function that does not exist in that build.
#[test]
fn a_cfg_gate_stays_above_the_attribute_and_reaches_the_handler_entry() {
    let code = "#[cfg(feature = \"source-stage\")]\npub fn data_get_model() -> u8 { 0 }\n";
    let (out, sites) = apply_tauri_commands("r", code, &[cmd("data_get_model")]).expect("applies");
    assert!(
        out.starts_with("#[cfg(feature = \"source-stage\")]\n#[tauri::command] pub fn data_get_model()"),
        "the cfg must stay above the inserted attribute:\n{out}"
    );
    assert_eq!(sites[0].cfgs, vec!["#[cfg(feature = \"source-stage\")]".to_string()]);
}

/// A NON-CFG attribute keeps the attribute above it, which is where it was.
///
/// Six commands carry `#[allow(clippy::too_many_arguments)]` and it sat BELOW `#[tauri::command]`, so
/// the allow is part of the item the macro re-emits. Inserting the command attribute after it would
/// silently change which item the allow applies to.
#[test]
fn a_non_cfg_attribute_keeps_the_command_attribute_above_it() {
    let code = "#[allow(clippy::too_many_arguments)]\npub fn data_load_csv(a: u8) -> u8 { a }\n";
    let (out, _) = apply_tauri_commands("r", code, &[cmd("data_load_csv")]).expect("applies");
    assert!(
        out.starts_with("#[tauri::command] #[allow(clippy::too_many_arguments)]\npub fn data_load_csv"),
        "the command attribute must precede the non-cfg attribute:\n{out}"
    );
}

/// A FACET NAMING A FUNCTION THAT IS NOT THERE is a hard error, not a silent skip. A skipped entry is
/// a command that never registers, which is invisible at runtime.
#[test]
fn a_facet_naming_a_missing_function_is_a_hard_error() {
    let err = apply_tauri_commands("mine--x.rs", "pub fn other() {}", &[cmd("gone")]).unwrap_err();
    assert!(err.contains("mine--x.rs") && err.contains("gone"), "{err}");
}

/// TWO DECLARATIONS OF ONE NAME is a hard error rather than a first-match. A doc example or a fixture
/// string holding Rust source reads exactly like a declaration, and attaching the attribute to the
/// wrong one registers the wrong function — `crates/bsc-graph/src/methods` holds precisely such a
/// fixture, which is why this is not hypothetical.
#[test]
fn an_ambiguous_name_is_a_hard_error_naming_both_lines() {
    let code = "pub fn f() {}\n// a fixture:\npub fn f() {}";
    let err = apply_tauri_commands("mine--x.rs", code, &[cmd("f")]).unwrap_err();
    assert!(err.contains("2 lines") && err.contains("1, 3"), "{err}");
}

/// `declares_fn` matches a DECLARATION and not a mention. A call, a `use`, a type or a where-clause
/// naming the command must not be mistaken for the function itself.
#[test]
fn only_a_declaration_matches() {
    assert!(declares_fn("pub(crate) async fn foo(a: u8) {", "foo"));
    assert!(declares_fn("    fn foo<T>() {", "foo"));
    assert!(declares_fn("pub unsafe extern \"C\" fn foo() {", "foo"));
    assert!(!declares_fn("    foo();", "foo"));
    assert!(!declares_fn("use crate::x::foo;", "foo"));
    assert!(!declares_fn("let x = self.foo(1);", "foo"));
    assert!(!declares_fn("pub fn foobar() {", "foo"));
    assert!(!declares_fn("// fn foo() is documented here", "foo"));
}

/// THE HANDLER LIST IS THE SAME DECLARATION, reaching the generated file as an absolute path.
///
/// End to end: two records declaring commands produce a `graph_tauri_handler!` macro above every
/// module, with `crate::`-absolute paths derived from where each record actually is — never from a
/// re-export, which is how 53 of the 201 hand-written entries reached their command and why a record
/// move was invisible to the list.
#[test]
fn the_handler_list_is_generated_from_the_facet() {
    let root = scratch("cmd-rt");
    std::fs::create_dir_all(root.join("graph")).expect("graph/");
    std::fs::write(root.join("graph").join("store.toml"), "store = \"algorithms.json\"\n").expect("marker");
    let store = serde_json::json!({
        "implementations": [
            {
                "id": "mine--dialog.rs",
                "src": "crates/mine/src/dialog.rs",
                "code": "pub fn pick() -> u8 { 0 }",
                "tauriCommands": [{ "name": "pick" }]
            },
            {
                "id": "mine--data.rs",
                "src": "crates/mine/src/data.rs",
                "code": "#[cfg(feature = \"source-stage\")]\npub fn scan() -> u8 { 0 }",
                "tauriCommands": [{ "name": "scan" }]
            }
        ]
    });
    std::fs::write(root.join("graph").join("algorithms.json"), serde_json::to_string(&store).unwrap())
        .expect("store");
    let out = scratch("cmd-rt-out");
    emit_into(&root.join("crates").join("mine"), &out, None, Adoption::Required).expect("emits");
    let crate_rs = std::fs::read_to_string(out.join("crate.rs")).expect("crate.rs");

    assert!(crate_rs.contains("macro_rules! graph_tauri_handler"), "no handler macro:\n{crate_rs}");
    assert!(crate_rs.contains("crate::dialog::pick,"), "absolute path missing:\n{crate_rs}");
    assert!(crate_rs.contains("crate::data::scan,"), "absolute path missing:\n{crate_rs}");
    assert!(
        crate_rs.contains("#[cfg(feature = \"source-stage\")]\n            crate::data::scan,"),
        "the cfg must gate the handler ARM too:\n{crate_rs}"
    );
    // The macro is DEFINED before any module, because `macro_rules!` is textually scoped and the
    // record that invokes it is a module below.
    let macro_at = crate_rs.find("macro_rules! graph_tauri_handler").unwrap();
    let first_mod = crate_rs.find("pub mod ").unwrap();
    assert!(macro_at < first_mod, "the macro must precede every module:\n{crate_rs}");
}

/// A CRATE THAT DECLARES NO COMMAND GETS NO MACRO. That is what makes a total loss of the facet a
/// COMPILE ERROR — the record invoking `graph_tauri_handler!()` finds no macro — rather than an app
/// that starts with an empty command surface and rejects every invoke in silence.
#[test]
fn no_command_means_no_macro() {
    let root = scratch("cmd-none");
    repo_with(&root, &[("mine--thing.rs", "crates/mine/src/thing.rs", "pub fn t() {}")]);
    let out = scratch("cmd-none-out");
    emit_into(&root.join("crates").join("mine"), &out, None, Adoption::Required).expect("emits");
    let crate_rs = std::fs::read_to_string(out.join("crate.rs")).expect("crate.rs");
    assert!(!crate_rs.contains("graph_tauri_handler"), "a macro with no commands:\n{crate_rs}");
}

/// TWO RECORDS DECLARING ONE COMMAND NAME is a hard error. `#[tauri::command]` `#[macro_export]`s
/// `__cmd__<name>` for a `pub`/`pub(crate)` fn, so the name is crate-GLOBAL, and `generate_handler!`
/// matches an invoke on that string — a collision is reported by rustc as a macro redefinition far
/// from its cause, and the frontend would reach whichever arm was tried first.
#[test]
fn two_records_cannot_declare_the_same_command_name() {
    let root = scratch("cmd-dup");
    std::fs::create_dir_all(root.join("graph")).expect("graph/");
    std::fs::write(root.join("graph").join("store.toml"), "store = \"algorithms.json\"\n").expect("marker");
    let store = serde_json::json!({
        "implementations": [
            { "id": "mine--a.rs", "src": "crates/mine/src/a.rs", "code": "pub fn go() {}",
              "tauriCommands": [{ "name": "go" }] },
            { "id": "mine--b.rs", "src": "crates/mine/src/b.rs", "code": "pub fn go() {}",
              "tauriCommands": [{ "name": "go" }] }
        ]
    });
    std::fs::write(root.join("graph").join("algorithms.json"), serde_json::to_string(&store).unwrap())
        .expect("store");
    let out = scratch("cmd-dup-out");
    let err = emit_into(&root.join("crates").join("mine"), &out, None, Adoption::Required).unwrap_err();
    assert!(err.contains("crate-global") && err.contains("`go`"), "{err}");
}

/// THE REAL STORE, materialized: `src-tauri`'s whole command surface reaches the generated file, and
/// every command the facet declares is in the generated handler list exactly once.
///
/// This is the end-to-end half of the guard whose other half lives in `src-tauri/src/tests.rs`. It
/// runs HERE as well because this crate is where the generator lives: a change to `render` that
/// stopped emitting entries would be caught by its own test suite rather than by the app's, three
/// minutes of build later.
#[test]
fn the_app_command_surface_materializes_out_of_the_committed_store() {
    /// MEASURED 2026-09-08: 201 commands across 67 records, and the hand-written list it replaced held
    /// exactly the same 201. A FLOOR, not a ratchet — it detects the facet collapsing (a parser that
    /// stopped matching, a store read that lost records), which is the failure that would otherwise
    /// leave the app with a silently smaller command surface.
    const FLOOR: usize = 195;

    let raw = load_merged_store(&committed_store(&repo())).expect("store");
    let store: serde_json::Value = serde_json::from_str(&raw).expect("json");
    let impls = store.get("implementations").and_then(|v| v.as_array()).expect("implementations");
    let plan = plan_for(&repo().join("src-tauri"), None).expect("plan");
    let units = plan.select(impls);
    let declared: usize = units.iter().map(|u| u.commands.len()).sum();
    assert!(
        declared >= FLOOR,
        "`src-tauri`'s command surface collapsed to {declared} declarations (floor {FLOOR}). Every one \
         of them is a function the frontend invokes by name; a record that lost its `tauriCommands` \
         facet takes its commands out of the generated handler list, and `safeInvoke` turns the \
         rejection into a silent empty result.",
    );

    let body = plan.render_store(&raw, Adoption::Required).expect("renders").expect("a body");
    let start = body.find("tauri::generate_handler![").expect("a generated handler list");
    let end = body[start..].find("]\n    };").expect("the list is closed") + start;
    let list = &body[start..end];
    let registered = list.matches("            crate::").count();
    assert_eq!(
        registered, declared,
        "the generated handler list holds {registered} entries for {declared} declared commands — the \
         generator and the facet must agree exactly, or a command is declared and never reachable",
    );
    for u in &units {
        for c in &u.commands {
            let path = format!("crate::{}::{},", u.path.join("::"), c.name);
            assert_eq!(
                list.matches(&path).count(),
                1,
                "`{path}` appears {} times in the generated handler list, expected exactly once",
                list.matches(&path).count(),
            );
        }
    }
}

/// A CRATE SELECTS EXACTLY THE RECORDS WHOSE `src` IS ITS OWN, pinned against the real store.
///
/// # What this replaced, and why the replacement is narrower
///
/// It used to assert the WATCH set: that the record FILES a build script named for `rerun-if-changed`
/// (matched by the filename prefix `<crate>--`) were exactly the records whose `src` began with that
/// crate's `src/`. That question died with the file-per-record layout — a ledger is one path, so there
/// are no per-record filenames to match and nothing to narrow (see `emit_into`, which records the cost).
///
/// What did NOT die is the half that decides what actually COMPILES. [`Plan::select`] refuses any
/// record whose id is not exactly `expected_id` for its `src`, so "this crate's modules" is an
/// enforced statement rather than a convention — and a crate that selected a neighbour's record would
/// materialize another crate's module into its own `crate.rs`. That is asserted here, over the store.
///
/// # WHICH ASSERTION HERE ACTUALLY BITES, stated rather than implied
///
/// The FLOORS are the teeth. BITTEN by removing the path boundary from `src_prefix` — the exact
/// mutation the retired `a_crate_does_not_claim_the_records_of_a_crate_whose_name_extends_its_own`
/// existed for — this fails with "only 0 records selected by any crate".
///
/// The `stray` assertion is a belt: with `src_prefix` ending in a SLASH it is structurally
/// unreachable, because `crates/bsc-graph/src/` cannot prefix `crates/bsc-graph-store/src/...`, and
/// `select`'s id check rejects anything the prefix let through. It is kept because it is what makes
/// the failure READABLE if either of those two ever changes — a floor says "something broke", this
/// says which record went where.
#[test]
fn a_crate_selects_exactly_the_records_whose_src_is_its_own() {
    let root = repo();
    let raw = load_merged_store(&committed_store(&root)).expect("store loads");
    let store: serde_json::Value = serde_json::from_str(&raw).expect("store parses");
    let impls = store.get("implementations").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    assert!(impls.len() >= 2000, "only {} records — discovery is broken", impls.len());

    let mut checked = 0usize;
    let mut selected_total = 0usize;
    for e in std::fs::read_dir(root.join("crates")).expect("crates/ reads").flatten() {
        let dir = e.file_name().to_string_lossy().to_string();
        let Ok(plan) = plan_for(&e.path(), Some(root.as_path())) else { continue };

        // What the crate COMPILES.
        let selected: std::collections::BTreeSet<String> =
            plan.select(&impls).into_iter().map(|u| u.id).collect();

        // Every record whose `src` says it belongs to this crate — the authoritative answer, derived
        // the crude way so it cannot agree with `select` by construction.
        let by_src: std::collections::BTreeSet<String> = impls
            .iter()
            .filter(|i| i.get("src").and_then(|v| v.as_str()).is_some_and(|x| x.starts_with(&plan.src_prefix)))
            .filter_map(|i| i.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect();

        // `select` is a SUBSET of `by_src`, never a superset: it deliberately drops a function lifted
        // out of a file that another record IS (`unquote.rs` shares a `src` with `cve--install.rs`).
        // A record selected whose `src` is NOT this crate's is the failure that matters.
        let stray: Vec<&String> = selected.difference(&by_src).collect();
        assert!(
            stray.is_empty(),
            "crates/{dir} selects {stray:?}, whose `src` is not under {}. That record would be \
             materialized into this crate's `crate.rs` — another crate's module, compiled here.",
            plan.src_prefix
        );
        selected_total += selected.len();
        checked += 1;
    }
    assert!(checked >= 70, "only {checked} crates resolved a plan");
    assert!(selected_total >= 1000, "only {selected_total} records selected by any crate");
    // Non-vacuity on the other side: selection must not sweep in the whole store.
    assert!(selected_total < impls.len(), "every record is selected by some crate — nothing narrowed");
}

// `a_crate_does_not_claim_the_records_of_a_crate_whose_name_extends_its_own` was RETIRED here rather
// than rewritten, and the reason is worth keeping so it is not re-added out of caution.
//
// It asserted that `bsc-graph` does not pick up `bsc-graph-store--*.rs`. That hazard was specific to
// the filename prefix `<crate>--`, which has no path boundary in it: a bare `bsc-graph` prefix matches
// `bsc-graph-store--x.rs`, and the `--` was what stopped it. With the records in a ledger there are no
// filenames to match. Selection is by `Plan::src_prefix`, which is `crates/<name>/src/` — it ends in a
// SLASH, so `crates/bsc-graph/src/` cannot match `crates/bsc-graph-store/src/...` by construction, and
// there is no longer a case to test. `a_crate_selects_exactly_the_records_whose_src_is_its_own` above
// would catch it anyway, for every crate rather than for this one pair.

/// A FRONTEND record belongs to no Rust crate, so no Rust crate may COMPILE one. This is the
/// 682-record population whose edits used to rebuild the entire backend.
///
/// Asserted over SELECTION rather than over the watch list, for the reason above: the watch narrowing
/// is gone and a frontend record edit now does rebuild every materialized crate. What must never
/// happen is a frontend record being materialized INTO one — that is a `.ts` module rendered as Rust,
/// which fails to compile in a place with nothing to do with the edit.
///
/// # What holds this up, honestly
///
/// The NON-VACUITY floor is this test's own teeth: without `frontend.len() >= 100` it would pass over
/// an empty population and prove nothing. The property itself is enforced upstream by `select`'s id
/// check — a frontend record's id is not `expected_id` for any crate path — which
/// `expected_id_agrees_with_extract_module_id` pins separately. So this is the guard that says the
/// enforcement is REACHING the real store, not the guard that implements it.
#[test]
fn no_rust_crate_selects_a_frontend_record() {
    let root = repo();
    let raw = load_merged_store(&committed_store(&root)).expect("store loads");
    let store: serde_json::Value = serde_json::from_str(&raw).expect("store parses");
    let impls = store.get("implementations").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let frontend: std::collections::BTreeSet<String> = impls
        .iter()
        .filter(|i| {
            i.get("src").and_then(|v| v.as_str()).is_some_and(|s| s.ends_with(".ts") || s.ends_with(".tsx"))
        })
        .filter_map(|i| i.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    // NON-VACUITY: an empty population would satisfy the assertion below over any selection at all.
    assert!(frontend.len() >= 100, "only {} frontend records found", frontend.len());

    for e in std::fs::read_dir(root.join("crates")).expect("crates/ reads").flatten() {
        let Ok(plan) = plan_for(&e.path(), Some(root.as_path())) else { continue };
        for u in plan.select(&impls) {
            assert!(
                !frontend.contains(&u.id),
                "{} would materialize the frontend record `{}` into its `crate.rs` — a TypeScript \
                 module rendered as Rust",
                plan.crate_dir,
                u.id
            );
        }
    }
}
