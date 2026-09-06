//! THE INTEGRATION-TEST HALF — a crate's `tests/*.rs` targets, materialized from the EDGE tier.
//!
//! A separate test module rather than more of `tests.rs`, for the reason the split in `plan.rs` /
//! `emit.rs` already has: these assert a capability with its own selection rule, its own output
//! directory and its own shared root file, and the two never share a fixture.
//!
//! Every test here is written to FAIL against the tree before
//! `a-rust-record-test-runs-and-an-edge-reaches-the-seed`, where `emit_into` materialized
//! implementations only and never read `edges` at all.

use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// A scratch directory of our own — no `tempfile`, for the reason `tests.rs` states: this crate is a
/// build-dependency of ~54 others.
fn scratch(tag: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let d = std::env::temp_dir().join(format!("gmtt-{}-{tag}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).expect("scratch dir");
    d
}

/// A repo root whose committed store holds `impls` (each `(id, src, code)`) and `edges` verbatim.
fn repo_with_edges(root: &Path, impls: &[(&str, &str, &str)], edges: serde_json::Value) {
    let list: Vec<serde_json::Value> = impls
        .iter()
        .map(|(id, src, code)| serde_json::json!({ "id": id, "src": src, "code": code }))
        .collect();
    std::fs::create_dir_all(root.join("graph")).expect("graph/");
    std::fs::write(
        root.join("graph").join("algorithms.json"),
        serde_json::to_string(&serde_json::json!({ "implementations": list, "edges": edges }))
            .expect("json"),
    )
    .expect("store");
}

fn plan_at(root: &Path, crate_dir: &str) -> Plan {
    let manifest = root.join("crates").join(crate_dir);
    std::fs::create_dir_all(&manifest).expect("crate dir");
    plan_for(&manifest, Some(root)).expect("plan")
}

fn edge(id: &str, src: &str, body: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "members": ["a.rs", "b.rs"],
        "src": src,
        "tests": [{ "name": "t.rs", "src": body }],
    })
}

// ── the PURE naming rule ────────────────────────────────────────────────────────────────────────

#[test]
fn a_flat_tests_file_names_a_cargo_target_and_nothing_deeper_does() {
    assert_eq!(test_target_name("wire_contract.rs"), Some("wire_contract".to_string()));
    // Cargo auto-discovers exactly `tests/*.rs`. `tests/common/helpers.rs` is a MODULE of some
    // target, not a target — declaring it would produce an entry that never compiles.
    assert_eq!(test_target_name("common/helpers.rs"), None);
    assert_eq!(test_target_name("mod.rs"), None);
    assert_eq!(test_target_name("fixtures.json"), None);
    assert_eq!(test_target_name(".rs"), None);
}

#[test]
fn the_generated_header_makes_a_compiler_error_navigable_back_into_the_record() {
    let t = TestTarget { id: "e--x".into(), name: "x".into(), code: "#[test]\nfn t() {}\n".into() };
    let out = render_test_target(&t);
    let lines: Vec<&str> = out.lines().collect();
    let hdr = lines.iter().position(|l| l.starts_with("// edge `e--x`")).expect("a header");
    // The offset the header states must be the header's own 1-based line number, so record line 1
    // lands at `offset + 1`. Asserted by ARITHMETIC rather than by a literal, because a preamble that
    // changed height would otherwise keep this passing while every reported line moved.
    let stated: usize = out
        .lines()
        .find_map(|l| l.strip_prefix("// edge `e--x` — line N here is line N-")?.strip_suffix(" in the record.")?.parse().ok())
        .expect("the offset parses");
    assert_eq!(stated, hdr + 1);
    assert_eq!(lines[stated], "#[test]", "record line 1 is generated line offset+1");
}

/// EVERY real integration test in this repo opens with a `//!` block, and an inner doc comment does
/// not survive `include!` (E0753). `wire_contract.rs` failed to compile on exactly this the first
/// time it was wired, so this is the case, not a hypothetical. The rewrite must preserve the LINE
/// COUNT or the offset header above lies about every line below it.
#[test]
fn a_leading_inner_doc_block_is_rewritten_in_place_so_the_include_compiles() {
    let code = "//! What this test proves.\n//!\n//! At length.\n\nuse thing::Thing;\n#[test]\nfn t() {}\n";
    let out = render_test_target(&TestTarget { id: "e".into(), name: "x".into(), code: code.into() });
    assert!(!out.contains("//!"), "an inner doc comment reached the included file: {out}");
    assert!(out.contains("// What this test proves."), "the prose is kept, as a plain comment: {out}");
    // Same line count in, same line count out — what the offset arithmetic depends on.
    let body = out.split_once("in the record.\n").expect("a header").1;
    assert_eq!(body.lines().count(), code.lines().count(), "the rewrite moved a line");
    assert_eq!(body.lines().nth(4), Some("use thing::Thing;"));
}

// ── SELECTION ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_crate_selects_the_edges_under_its_own_tests_dir_and_no_others() {
    let root = scratch("select");
    let plan = plan_at(&root, "mine");
    let edges = vec![
        edge("mine--alpha", "crates/mine/tests/alpha.rs", "#[test] fn a() {}"),
        edge("theirs--beta", "crates/theirs/tests/beta.rs", "#[test] fn b() {}"),
        // A FRONTEND edge — `bsc-emit` materializes this one into `.bsc-records/`; it is not a Rust
        // test target and must not be mistaken for one.
        edge("fe--gamma", "src/features/x/lib/y.test.ts", "it('x', () => {})"),
        // A crate's own `src/` is modules, never test targets.
        edge("mine--delta", "crates/mine/src/delta.rs", "#[test] fn d() {}"),
    ];
    let got = plan.select_test_targets(&edges).expect("selects");
    assert_eq!(got.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), vec!["alpha"]);
    assert_eq!(got[0].code, "#[test] fn a() {}");
    assert_eq!(got[0].id, "mine--alpha");
}

#[test]
fn an_edge_that_carries_no_test_is_a_relationship_and_not_a_target() {
    let root = scratch("notest");
    let plan = plan_at(&root, "mine");
    let bare = serde_json::json!({ "id": "mine--bare", "members": ["a.rs", "b.rs"], "src": "crates/mine/tests/bare.rs" });
    assert!(plan.select_test_targets(&[bare]).expect("selects").is_empty());
}

/// A cargo test target is ONE file. Taking the first body silently is how a migrated test stops
/// running behind a green gate, which is the failure this whole capability exists to remove.
#[test]
fn an_edge_carrying_two_bodies_for_one_target_is_refused_by_name() {
    let root = scratch("two");
    let plan = plan_at(&root, "mine");
    let two = serde_json::json!({
        "id": "mine--two", "members": ["a.rs", "b.rs"], "src": "crates/mine/tests/two.rs",
        "tests": [{ "src": "#[test] fn a() {}" }, { "src": "#[test] fn b() {}" }],
    });
    let err = plan.select_test_targets(&[two]).expect_err("two bodies, one target");
    assert!(err.contains("mine--two") && err.contains("two.rs"), "{err}");
}

#[test]
fn two_edges_claiming_one_target_are_refused_rather_than_last_one_wins() {
    let root = scratch("dup");
    let plan = plan_at(&root, "mine");
    let edges = vec![
        edge("mine--old", "crates/mine/tests/same.rs", "#[test] fn a() {}"),
        edge("mine--new", "crates/mine/tests/same.rs", "#[test] fn b() {}"),
    ];
    let err = plan.select_test_targets(&edges).expect_err("a duplicate target");
    assert!(err.contains("mine--old") && err.contains("mine--new"), "{err}");
}

#[test]
fn the_tests_prefix_is_derived_at_whatever_depth_the_crate_sits() {
    let root = scratch("depth");
    assert_eq!(plan_at(&root, "plandb").tests_prefix(), "crates/plandb/tests/");
    // ONE deep — the shape that kept `src-tauri` out of the graph before the repo root was found by
    // walking. Derived from `src_prefix`, so it cannot disagree with it.
    let manifest = root.join("src-tauri");
    std::fs::create_dir_all(&manifest).expect("dir");
    let p = plan_for(&manifest, Some(&root)).expect("plan");
    assert_eq!(p.src_prefix, "src-tauri/src/");
    assert_eq!(p.tests_prefix(), "src-tauri/tests/");
}

// ── THE WRITE ───────────────────────────────────────────────────────────────────────────────────

#[test]
fn emit_writes_the_target_where_the_shared_test_root_looks_for_it() {
    let root = scratch("write");
    repo_with_edges(
        &root,
        &[("mine--m.rs", "crates/mine/src/m.rs", "pub fn m() {}")],
        serde_json::json!([edge("mine--alpha", "crates/mine/tests/alpha.rs", "#[test]\nfn a() { assert!(true); }\n")]),
    );
    let out = scratch("write-out");
    let manifest = root.join("crates").join("mine");
    std::fs::create_dir_all(&manifest).expect("crate dir");
    emit_into(&manifest, &out, Some(&root), Adoption::Required).expect("emit");

    // The SHARED root is `include!(concat!(env!("OUT_DIR"), "/tests/", env!("CARGO_CRATE_NAME"),
    // ".rs"))`, so this exact path is the contract between the two halves.
    let dest = out.join("tests").join("alpha.rs");
    let body = std::fs::read_to_string(&dest).unwrap_or_else(|e| panic!("{}: {e}", dest.display()));
    assert!(body.contains("fn a() { assert!(true); }"), "{body}");
    assert!(body.contains("// edge `mine--alpha`"), "the offset header is present: {body}");
    // The MODULE half is untouched by this — both are written from one emit.
    assert!(out.join("crate.rs").is_file(), "the module render still happened");
}

/// The overwhelming majority of crates. An empty `$OUT_DIR/tests/` would be pure noise, and a
/// directory appearing for every one of ~54 adopters is the kind of harmless-looking churn that makes
/// a real change unreadable.
#[test]
fn a_crate_with_no_test_edge_writes_no_tests_directory() {
    let root = scratch("none");
    repo_with_edges(
        &root,
        &[("mine--m.rs", "crates/mine/src/m.rs", "pub fn m() {}")],
        serde_json::json!([edge("theirs--beta", "crates/theirs/tests/beta.rs", "#[test] fn b() {}")]),
    );
    let out = scratch("none-out");
    let manifest = root.join("crates").join("mine");
    std::fs::create_dir_all(&manifest).expect("crate dir");
    emit_into(&manifest, &out, Some(&root), Adoption::Required).expect("emit");
    assert!(!out.join("tests").exists(), "an empty tests/ dir was created");
}

/// A store with no `edges` key at all is the normal shape of every committed store that has never
/// carried one, and asking about edges must not be able to change that.
#[test]
fn a_store_with_no_edges_key_emits_normally() {
    let root = scratch("noedges");
    std::fs::create_dir_all(root.join("graph")).expect("graph/");
    std::fs::write(
        root.join("graph").join("algorithms.json"),
        r#"{"implementations":[{"id":"mine--m.rs","src":"crates/mine/src/m.rs","code":"pub fn m() {}"}]}"#,
    )
    .expect("store");
    let out = scratch("noedges-out");
    let manifest = root.join("crates").join("mine");
    std::fs::create_dir_all(&manifest).expect("crate dir");
    emit_into(&manifest, &out, Some(&root), Adoption::Required).expect("emit");
    assert!(!out.join("tests").exists());
}

/// THE REAL STORE, not a fixture: `bsc-lan-stream` is the first crate migrated onto this, and a
/// selection that stopped matching would leave its `[[test]]` entry `include!`ing nothing — a compile
/// error, but only for whoever built that crate. Naming it here fails for everyone.
#[test]
fn the_committed_store_still_names_the_test_target_bsc_lan_stream_declares() {
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = repo_root_by_walk(&here).expect("this crate is in the repo");
    let raw = std::fs::read_to_string(root.join("graph").join("algorithms.json")).expect("the store");
    let store: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
    let empty = Vec::new();
    let edges = store.get("edges").and_then(|v| v.as_array()).unwrap_or(&empty);
    let plan = plan_for(&root.join("crates").join("bsc-lan-stream"), Some(&root)).expect("plan");
    let got = plan.select_test_targets(edges).expect("selects");
    assert!(
        got.iter().any(|t| t.name == "wire_contract"),
        "the committed store no longer carries bsc-lan-stream's `wire_contract` test target — its \
         manifest still declares one, so the crate will not compile: {:?}",
        got.iter().map(|t| &t.name).collect::<Vec<_>>()
    );
}
