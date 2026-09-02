//! PARITY AGAINST THE REAL TREES, not against inputs somebody thought of.
//!
//! A fixture written by hand proves two implementations agree on the cases its author imagined.
//! This corpus was captured from the repository's ACTUAL build trees — 18 worktrees, ~450 GB of
//! `target/`, 3,396 real artifact filenames, 297 real incremental directories, and 19 real
//! worktrees covering parked, merged, detached-HEAD and main — and every expected value was produced
//! by CALLING the live JavaScript this crate replaces, never by writing down what it ought to say.
//!
//! ## Why the input is FROZEN
//!
//! Other trees on this box compile continuously. Running the JavaScript and then the Rust against
//! the live filesystem would disagree for reasons that have nothing to do with the port, and the
//! disagreement would be unfalsifiable. So the state was snapshotted once and both implementations
//! answered the SAME bytes.
//!
//! ## Why the capture is trustworthy
//!
//! The generator had to re-walk the trees itself, which is a second chance to be wrong. It is
//! checked against the drivers' own output: the JavaScript CLIs printed `would prune 231 of 297`,
//! `would sweep 135 dep unit(s)` and `nothing to remove`, and the frozen snapshot reproduces 231 of
//! 297, 135 and 0 exactly. A capture that gathered something else could not have matched all four.
//!
//! ## What this file is FOR, now that the JavaScript is gone
//!
//! It has changed role, the same way every fixture in this migration does. While both
//! implementations existed it was a parity proof. Now it is a REGRESSION BASELINE — and it is the
//! only place these policies are pinned against inputs nobody invented, which is exactly the
//! evidence the unit tests beside each module cannot supply.

use bsc_disk::pool::{plan_cap, Tree, DEFAULT_MIN_IDLE_MS};
use bsc_disk::prune::{plan_prune, Entry};
use bsc_disk::unit::group_units;

fn corpus() -> serde_json::Value {
    let raw = include_str!("real-trees.parity.json");
    serde_json::from_str(raw).expect("the parity corpus is valid JSON")
}

fn entries(v: &serde_json::Value) -> Vec<Entry> {
    v.as_array()
        .expect("entries is an array")
        .iter()
        .map(|e| Entry::new(e["n"].as_str().expect("n"), e["m"].as_f64().expect("m")))
        .collect()
}

fn strings(v: &serde_json::Value) -> Vec<String> {
    v.as_array().expect("array").iter().map(|s| s.as_str().expect("string").to_string()).collect()
}

#[test]
fn the_corpus_is_the_real_thing_and_stays_that_way() {
    // A shrunken corpus would let every assertion below pass while measuring almost nothing — the
    // "green gate that sees less" this repo keeps getting caught by. These floors are the sizes
    // actually captured; a future edit that guts the corpus fails here rather than silently.
    let c = corpus();
    assert!(c["prune"]["entries"].as_array().unwrap().len() >= 297, "the incremental corpus shrank");
    assert!(c["sweep"]["entries"].as_array().unwrap().len() >= 3396, "the deps corpus shrank");
    assert_eq!(c["cap"]["trees"].as_array().unwrap().len(), 19, "the worktree corpus changed size");

    // The three shapes that make this corpus worth having, rather than a bag of plausible names.
    let names: Vec<&str> =
        c["sweep"]["entries"].as_array().unwrap().iter().map(|e| e["n"].as_str().unwrap()).collect();
    assert!(
        names.iter().any(|n| n.starts_with("liblibduckdb_sys-")),
        "the libduckdb-sys family is the case that makes `strip a leading lib` wrong"
    );
    assert!(
        names.iter().any(|n| bsc_disk::unit::parse_unit_file(n).is_none()),
        "the corpus must contain un-hashed copies, the names $BSC_BIN resolves BY"
    );
    let trees = c["cap"]["trees"].as_array().unwrap();
    assert!(trees.iter().any(|t| t["branch"].is_null()), "a detached HEAD must be represented");
    assert!(trees.iter().any(|t| t["merged"] == true), "a merged tree must be represented");
    assert!(trees.iter().any(|t| t["isMain"] == true), "the main tree must be represented");
}

#[test]
fn plan_prune_agrees_with_the_javascript_on_297_real_incremental_dirs() {
    let c = corpus();
    let got = plan_prune(
        &entries(&c["prune"]["entries"]),
        c["prune"]["days"].as_f64().unwrap(),
        c["prune"]["keep"].as_u64().unwrap() as usize,
        c["nowMs"].as_f64().unwrap(),
    );
    // WHOLE VALUES IN ORDER, not a set and not a count. `prune` is ordered oldest-first so a
    // truncated log shows the stalest first, and two implementations can agree on "231" while
    // disagreeing about WHICH 231.
    assert_eq!(got.prune, strings(&c["prune"]["expectedPrune"]));
    assert_eq!(got.keep, strings(&c["prune"]["expectedKeep"]));
    assert_eq!(got.prune.len(), 231, "the count the JavaScript CLI printed");
}

#[test]
fn group_units_agrees_with_the_javascript_on_3396_real_deps_files() {
    let c = corpus();
    let units = group_units(&entries(&c["sweep"]["entries"]));
    let keys: Vec<String> = units.iter().map(|u| u.key.clone()).collect();
    assert_eq!(keys, strings(&c["sweep"]["expectedUnitKeys"]), "unit grouping, in order");
}

#[test]
fn the_deps_sweep_agrees_with_the_javascript_on_the_real_units() {
    let c = corpus();
    let units = group_units(&entries(&c["sweep"]["entries"]));
    let keys: Vec<Entry> = units.iter().map(|u| Entry::new(u.key.clone(), u.mtime_ms)).collect();
    let got = plan_prune(
        &keys,
        c["sweep"]["days"].as_f64().unwrap(),
        c["sweep"]["keep"].as_u64().unwrap() as usize,
        c["nowMs"].as_f64().unwrap(),
    );
    assert_eq!(got.prune, strings(&c["sweep"]["expectedPrune"]));
    assert_eq!(got.prune.len(), 135, "the count the JavaScript CLI printed");
}

fn cap_trees(c: &serde_json::Value) -> Vec<Tree> {
    c["cap"]["trees"]
        .as_array()
        .expect("trees")
        .iter()
        .map(|t| Tree {
            name: t["name"].as_str().expect("name").to_string(),
            branch: t["branch"].as_str().map(String::from),
            blocked: t["blocked"].as_str().map(String::from),
            last_built_ms: t["lastBuiltMs"].as_f64().unwrap_or(0.0),
            last_active_ms: t["lastActiveMs"].as_f64().unwrap_or(0.0),
            merged: t["merged"].as_bool().unwrap_or(false),
            is_main: t["isMain"].as_bool().unwrap_or(false),
        })
        .collect()
}

#[test]
fn plan_cap_agrees_with_the_javascript_on_19_real_worktrees() {
    let c = corpus();
    let trees = cap_trees(&c);
    let now = c["nowMs"].as_f64().unwrap();

    // The DEFAULT policy: on this pool it removes nothing, because every tree had been touched
    // inside the six-hour idle window. That is a real answer and worth pinning — "nothing to
    // remove" is the output a broken implementation produces too, so the aggressive arm below is
    // what makes this one meaningful.
    let default = plan_cap(&trees, 2, DEFAULT_MIN_IDLE_MS, now);
    assert_eq!(default.remove, strings(&c["cap"]["expectedDefaultRemove"]));

    // THE ARM THAT ACTUALLY DISCRIMINATES: guards off, so the full collectable set and its ORDER
    // are exercised — 7 trees, oldest-built first, spanning parked and merged branches, while the
    // main tree, `develop`, the detached HEAD and every unlanded ref are excluded.
    let aggressive = plan_cap(&trees, 0, 0.0, now);
    let expected = strings(&c["cap"]["expectedAggressiveRemove"]);
    assert_eq!(aggressive.remove, expected, "the collectable set and its order");
    assert_eq!(aggressive.remove.len(), 7);

    // Never, under the most permissive settings the CLI can express.
    for tree in &trees {
        if tree.is_main || tree.branch.is_none() || tree.branch.as_deref() == Some("develop") {
            assert!(
                !aggressive.remove.contains(&tree.name),
                "{} must never be collectable ({:?})",
                tree.name,
                tree.branch
            );
        }
    }
}

// ── the dedupe arm ───────────────────────────────────────────────────────────────────────────────
//
// Kept separate because it is the one verb a LIVE comparison could not settle. Run side by side
// against the real pool, the two JavaScript runs differed from EACH OTHER by 182 files while 495
// files vanished mid-scan under concurrent builds in other trees — more drift than the gap being
// measured, which makes the comparison unfalsifiable rather than merely noisy. Freezing the input is
// what turns it back into evidence.

use bsc_disk::dedupe::{plan_dedupe, reclaimable_bytes, ArtifactFile};
use std::collections::HashSet;

fn dedupe_files(c: &serde_json::Value) -> Vec<ArtifactFile> {
    let trees: Vec<&str> =
        c["dedupe"]["trees"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
    c["dedupe"]["files"]
        .as_array()
        .expect("files")
        .iter()
        .map(|f| {
            let a = f.as_array().expect("[treeIdx, name, size, mtimeMs, ino]");
            let tree = trees[a[0].as_u64().unwrap() as usize];
            let name = a[1].as_str().unwrap().to_string();
            ArtifactFile {
                tree: tree.to_string(),
                path: std::path::PathBuf::from(format!("{tree}/target/debug/deps/{name}")),
                name,
                size: a[2].as_u64().unwrap(),
                mtime_ms: a[3].as_f64().unwrap(),
                // Carried as a STRING: an inode can exceed what a JSON number holds exactly, and a
                // silently-rounded inode would make two distinct files look already-linked.
                ino: a[4].as_str().unwrap().parse().expect("inode"),
            }
        })
        .collect()
}

#[test]
fn plan_dedupe_agrees_with_the_javascript_on_a_real_cross_tree_cross_section() {
    let c = corpus();
    let workspace: HashSet<String> = c["dedupe"]["workspaceCrates"]
        .as_array()
        .expect("workspaceCrates")
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    assert!(workspace.contains("bsc_util"), "the workspace set must be the real one");

    let files = dedupe_files(&c);
    assert!(files.len() >= 1538, "the dedupe corpus shrank");

    let got = plan_dedupe(
        &files,
        &workspace,
        c["dedupe"]["minAgeMs"].as_f64().unwrap(),
        c["dedupe"]["nowMs"].as_f64().unwrap(),
    );

    let expected = c["dedupe"]["expectedGroups"].as_array().expect("expectedGroups");
    assert_eq!(got.len(), expected.len(), "group count");

    let trees: Vec<&str> =
        c["dedupe"]["trees"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
    // WHOLE VALUES IN ORDER — the group order is load-bearing (largest reclaimable first, so an
    // interrupted run has saved the most it could) and so is the order WITHIN a group, because
    // `files[0]` is the canonical copy every other one is linked TO.
    for (i, (g, want)) in got.iter().zip(expected).enumerate() {
        let w = want.as_array().expect("[name, size, treeIdxs]");
        assert_eq!(g.name, w[0].as_str().unwrap(), "group {i} name");
        assert_eq!(g.size, w[1].as_u64().unwrap(), "group {i} size");
        let want_trees: Vec<&str> =
            w[2].as_array().unwrap().iter().map(|t| trees[t.as_u64().unwrap() as usize]).collect();
        let got_trees: Vec<&str> = g.files.iter().map(|f| f.tree.as_str()).collect();
        assert_eq!(got_trees, want_trees, "group {i} ({}) membership and order", g.name);
    }

    // And the number the CLI actually reports.
    assert!(reclaimable_bytes(&got) > 0, "a real cross-section must have something to reclaim");
}

#[test]
fn the_workspace_exclusion_is_load_bearing_on_the_real_cross_section() {
    // Not a tautology: with the real workspace set, our OWN crates must be absent from every group.
    // Cargo folds the absolute manifest path into their `-C metadata`, so they differ per tree and
    // could never match anyway — but they also rebuild constantly, which is when linking is least
    // welcome, so this is correctness rather than caution.
    let c = corpus();
    let workspace: HashSet<String> = c["dedupe"]["workspaceCrates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    let got = plan_dedupe(
        &dedupe_files(&c),
        &workspace,
        c["dedupe"]["minAgeMs"].as_f64().unwrap(),
        c["dedupe"]["nowMs"].as_f64().unwrap(),
    );
    for g in &got {
        let parsed = bsc_disk::unit::parse_unit_file(&g.name).expect("every group name is hashed");
        assert!(
            !bsc_disk::dedupe::is_workspace_crate(&parsed.name_part, &workspace),
            "{} is a workspace crate and must never be a dedupe candidate",
            g.name
        );
    }
}
