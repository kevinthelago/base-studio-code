//! The differential guard for `sqlite_read.rs` — fixtures WRITTEN by SQLite, READ by us.
//!
//! A hand-rolled parser checked only against its own output is a claim, not evidence
//! (`a-byte-identical-roundtrip-does-not-prove-the-parse`) — and the failure mode is the bad one: a
//! mis-parse returns plausible data rather than an error. So every fixture under `testdata/` was
//! written by the real SQLite engine and is committed as BYTES, and these tests read them with ours.
//! Two implementations, and only one of them is mine.
//!
//! `testdata/*.sql` regenerates each one, and each file names its own command. They are checked in
//! rather than built at test time because `graph-materialize` is a build-dependency of 75 crates held
//! to "serde_json and nothing else": taking `rusqlite` even as a DEV-dependency puts it in the
//! Cargo.lock closure of every dependent, which the sensor binaries' `the_sensor_binary_pulls_in_
//! nothing_heavy` guard reads as a real edge. 106 KB of fixture buys the differential property with
//! no dependency at all.

use super::*;

/// The fixtures live with the READER, in `bsc-sqlite-read`, because that is what they are evidence
/// about — these tests exercise the JSON layer on top of it and share the same corpus rather than
/// keeping a second copy that could drift.
fn fixture(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../bsc-sqlite-read/testdata")).join(name)
}

#[test]
fn reads_back_exactly_what_sqlite_wrote() {
    let got = read_lane(&fixture("ledger.db"), "main").expect("read");
    let by = |id: &str| got.iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("{id} missing"));
    assert_eq!(by("alpha.rs")["code"], "fn a() {}");
    assert_eq!(by("beta.rs")["code"], "fn b() {}");
    // Sorted by id, so the store the build sees is DETERMINISTIC — the JSON path sorts its record
    // files, and a build whose output depends on hash-map order cannot be diffed.
    let ids: Vec<&str> = got.iter().map(|r| r["id"].as_str().expect("id")).collect();
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    assert_eq!(ids, sorted, "records come back in id order");
}

#[test]
fn the_newest_revision_of_an_id_wins() {
    let got = read_lane(&fixture("ledger.db"), "main").expect("read");
    let x: Vec<_> = got.iter().filter(|r| r["id"] == "x.rs").collect();
    assert_eq!(x.len(), 1, "one id, one record, however many revisions it has");
    assert_eq!(x[0]["v"], 3, "the ledger is append-only, so the store is max(rev) per id");
}

#[test]
fn a_lane_is_isolated_from_main() {
    let main = read_lane(&fixture("ledger.db"), "main").expect("main");
    let x = main.iter().find(|r| r["id"] == "x.rs").expect("x.rs on main");
    assert!(x.get("where").is_none(), "rev 9 on ANOTHER lane must not win on main: {x:?}");
    assert!(!main.iter().any(|r| r["id"] == "y.rs"), "a lane-only record is not on main");

    let lane = read_lane(&fixture("ledger.db"), "some-slice").expect("lane");
    let ids: Vec<&str> = lane.iter().map(|r| r["id"].as_str().expect("id")).collect();
    assert_eq!(ids, vec!["x.rs", "y.rs"], "and the lane sees its own");
    assert_eq!(lane[0]["where"], "lane");
}

/// THE OVERFLOW CASE, and the reason this file exists at all.
///
/// Record bodies are source code — the committed store holds 20 MB across 2,944 records — so almost
/// every real row spills past the 4096-byte page onto an overflow chain. A reader that handled only
/// the local-payload case would pass a naive test and then truncate every module in the repo.
#[test]
fn a_body_far_larger_than_a_page_survives_its_overflow_chain() {
    let got = read_lane(&fixture("ledger.db"), "main").expect("read");
    let big = got.iter().find(|r| r["id"] == "big.rs").expect("big.rs");
    let code = big["code"].as_str().expect("code is a string");
    assert_eq!(code.len(), 40_000, "the whole body, not the first page of it");
    assert!(code.starts_with("abab"), "the chain starts where it should");
    assert!(code.ends_with("abab"), "and ends where it should — a truncation shows up here");
    assert!(!code.contains('\0'), "no page padding leaked into the value");
}

/// 500 rows force the table b-tree to grow INTERIOR pages. A reader that only ever handled leaf pages
/// (type 0x0d) would pass every test above and silently return a fraction of the store.
#[test]
fn an_interior_btree_is_walked_not_just_one_leaf() {
    let got = read_lane(&fixture("ledger.db"), "main").expect("read");
    let numbered: Vec<i64> = got.iter().filter_map(|r| r.get("n").and_then(|v| v.as_i64())).collect();
    assert_eq!(numbered.len(), 500, "every row, across every leaf the interior pages point at");
    assert_eq!(numbered.first(), Some(&0));
    assert_eq!(numbered.last(), Some(&499));
}

/// UTF-8 is decoded as text, not sliced as bytes. Record bodies are full of em dashes and arrows, so a
/// reader that mishandled multibyte would corrupt real source rather than fail.
#[test]
fn multibyte_text_round_trips() {
    let got = read_lane(&fixture("ledger.db"), "main").expect("read");
    let u = got.iter().find(|r| r["id"] == "u.rs").expect("u.rs");
    assert_eq!(u["code"], "// — → ✓ 日本語 🌍");
}

/// A DDL WITH COMMENTS IN IT — the bug the real ledger found and no library-written fixture had.
///
/// The live `record_revs` documents its columns inline, and the first parser split those `-- …` lines
/// on their own commas: 26 phantom columns (`--`, `so`, `which`, `rather`) and no `lane` among them.
/// PROVEN to bite: reverting `strip_sql_comments` puts this straight back to "has no `lane` column".
#[test]
fn a_commented_ddl_still_yields_its_real_columns() {
    let db = Db::open(&fixture("commented.db")).expect("open");
    let cols = db.columns_of("record_revs").expect("columns");
    assert_eq!(cols, vec!["id", "lane", "rev", "json", "note"], "comments are not columns");

    let got = read_lane(&fixture("commented.db"), "main").expect("read");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["ok"], 1);
}

/// Column indices are resolved from the DDL, never assumed — so a schema that gains or reorders a
/// column cannot silently shift `json` onto another field and compile a `note` as a module body.
#[test]
fn columns_are_found_by_name_so_a_new_column_cannot_shift_json() {
    let db = Db::open(&fixture("reordered.db")).expect("open");
    let cols = db.columns_of("record_revs").expect("columns");
    assert_eq!(cols, vec!["lane", "extra", "json", "id", "rev"], "PRIMARY KEY is not a column");

    let got = read_lane(&fixture("reordered.db"), "main").expect("read");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["ok"], true, "json was located by NAME, not by position");
}

/// THE REFUSAL THAT MATTERS MOST. Under WAL, committed rows can live in the `-wal` sidecar this reader
/// does not read — so it would return STALE records while looking perfectly healthy. Silence there is
/// the worst outcome this code could have, so it fails loudly and says how to fix it.
#[test]
fn wal_mode_is_refused_rather_than_read_stale() {
    let err = read_lane(&fixture("wal.db"), "main").expect_err("WAL must be refused, not read");
    assert!(err.contains("WAL"), "the error names the mode: {err}");
    assert!(err.contains("STALE"), "and says what the danger is: {err}");
    assert!(err.contains("wal_checkpoint"), "and hands over the fix: {err}");
}

#[test]
fn a_file_that_is_not_a_database_is_named_as_such() {
    let dir = std::env::temp_dir().join(format!("gm-sqlite-read-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");

    // Over 100 bytes, so it passes the length check and is refused on the MAGIC instead — the two
    // refusals are different sentences and a test that conflates them proves neither.
    let long = dir.join("long.db");
    std::fs::write(&long, "not a database, ".repeat(20).as_bytes()).expect("write");
    let err = read_lane(&long, "main").expect_err("must refuse");
    assert!(err.contains("not a SQLite database"), "{err}");

    let short = dir.join("short.db");
    std::fs::write(&short, b"tiny").expect("write");
    let err = read_lane(&short, "main").expect_err("must refuse");
    assert!(err.contains("too short"), "{err}");

    std::fs::remove_dir_all(&dir).ok();
}

/// `load_store_from_db` keeps the envelope — `edges` is not a record and lives beside them.
#[test]
fn the_store_envelope_survives_being_read_from_the_database() {
    let dir = std::env::temp_dir().join(format!("gm-envelope-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir");
    let store = dir.join("algorithms.json");
    std::fs::write(&store, r#"{"implementations":[],"edges":[{"from":"a","to":"b"}],"version":7}"#).expect("write");

    let text = load_store_from_db(&fixture("commented.db"), &store).expect("load");
    let v: serde_json::Value = serde_json::from_str(&text).expect("parse");
    assert_eq!(v["implementations"].as_array().expect("array").len(), 1, "records come from the DB");
    assert_eq!(v["edges"][0]["from"], "a", "and the edge table is NOT lost");
    assert_eq!(v["version"], 7, "nor anything else the envelope carried");

    std::fs::remove_dir_all(&dir).ok();
}

/// The opt-in is a path, and an EMPTY variable reads as unset — an exported-but-empty var is the shape
/// a shell leaves behind, and it must not silently disable the build's only source of source.
#[test]
fn an_empty_opt_in_is_not_an_opt_in() {
    assert_eq!(db_override_from(None), None, "unset is unset");
    assert_eq!(db_override_from(Some("")), None, "empty is unset");
    assert_eq!(db_override_from(Some("   ")), None, "whitespace is unset");
    assert_eq!(db_override_from(Some("\t")), None, "a tab is unset");
    assert_eq!(
        db_override_from(Some(" /tmp/x.db ")),
        Some(std::path::PathBuf::from("/tmp/x.db")),
        "a real path is taken, trimmed",
    );
}

/// THE REAL LEDGER, when this machine has one. `#[ignore]` because it reads a USER path that CI and a
/// fresh clone do not have — a test that silently passed on an absent file would be worse than none.
///
/// `cargo test -p graph-materialize --lib -- --ignored real_ledger`. The count it prints is checkable
/// against a third implementation (`sqlite3 "select count(distinct id) …"`), and three implementations
/// agreeing is evidence no fixture can give. It is what caught the commented-DDL bug.
#[test]
#[ignore = "reads ~/.base-studio-code/knowledge/graph.db, which only a real install has"]
fn real_ledger_reads_end_to_end() {
    let home = std::env::var("HOME").expect("HOME");
    let p = std::path::PathBuf::from(home).join(".base-studio-code/knowledge/graph.db");
    if !p.exists() {
        eprintln!("no ledger at {} — nothing to check", p.display());
        return;
    }
    let got = read_lane(&p, "main").expect("the real ledger reads");
    eprintln!("lane=main records: {}", got.len());
    assert!(got.len() > 1000, "a real ledger holds thousands of records, got {}", got.len());
    for r in &got {
        assert!(r.is_object(), "every record decodes to an object");
        assert!(r.get("id").is_some(), "and carries an id: {r:?}");
    }
}

/// A TOMBSTONE DELETES, and does not merely get skipped.
///
/// The ledger is append-only: a record is removed by adding a newer revision whose body is NULL,
/// carrying the reason. An earlier reader skipped NULL rows, so the tombstone was ignored and the
/// PREVIOUS revision won — MEASURED on the live ledger, that resurrected all 198 records the store had
/// already retired, and the materializer refused with `two records claim module …`. The store was
/// right and the reader was wrong, which is exactly the failure a fixture-only suite cannot see.
#[test]
fn a_tombstone_removes_the_id_rather_than_falling_back_to_the_previous_revision() {
    let got = read_lane(&fixture("ledger.db"), "main").expect("read");
    assert!(
        !got.iter().any(|r| r["id"] == "dead.rs"),
        "dead.rs has a NULL-bodied rev 2; rev 1 must NOT win: {:?}",
        got.iter().filter(|r| r["id"] == "dead.rs").collect::<Vec<_>>()
    );
    // And the tombstone must not take its neighbours with it.
    assert!(got.iter().any(|r| r["id"] == "alpha.rs"), "live records are unaffected");
}

/// A LANE READS THROUGH ITS ANCESTORS (`a-session-lane-is-derived-from-its-branch`).
///
/// The build now reads the checkout's branch lane, and a lane only holds what it changed — so a branch
/// that has written nothing must compile exactly main, and one that has must see its own rows over main's.
#[test]
fn a_lane_reads_its_own_rows_over_main_and_an_empty_lane_is_main() {
    let db = fixture("ledger.db");
    let main = read_lane(&db, "main").expect("main");
    let untouched = read_lanes_over(&db, &["main", "never-wrote-a-record"], None).expect("empty lane");
    assert_eq!(untouched, main, "a lane with no rows compiles main, not an empty store");

    let nested = read_lanes_over(&db, &["main", "some-slice", "some-slice/child"], None).expect("nested");
    let by = |id: &str| nested.iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("{id} missing"));
    assert_eq!(by("x.rs")["where"], "lane", "the lane's revision wins over main's");
    assert!(nested.iter().any(|r| r["id"] == "y.rs"), "a lane-only record is seen");
    assert!(nested.iter().any(|r| r["id"] == "alpha.rs"), "main's untouched records are seen");
    assert!(!nested.iter().any(|r| r["id"] == "dead.rs"), "main's tombstone still holds");
    assert_eq!(read_lane_of(&db, "some-slice", None).expect("one"), read_lanes_over(&db, &["some-slice"], None).expect("chain of one"));
}

/// The build's copy of the branch→lane rule, pinned to `bsc_util::Lane`'s own table
/// (`BRANCH_TO_LANE` in `bsc-util--lane--mod.rs`), which it cannot import.
#[test]
fn graph_materialize_derives_the_same_lane_as_bsc_util() {
    let table: &[(Option<&str>, &str)] = &[
        (None, "main"),
        (Some("develop"), "main"),
        (Some("main"), "main"),
        (Some("master"), "main"),
        (Some("voice/lexicographer"), "voice/lexicographer"),
        (Some("voice/develop"), "voice"),
        (Some("a-session-lane-is-derived-from-its-branch"), "a-session-lane-is-derived-from-its-branch"),
        (Some("bad//name"), "main"),
    ];
    for (branch, want) in table {
        assert_eq!(branch_lane(*branch), *want, "branch {branch:?}");
    }
    assert_eq!(lane_chain("voice/lexicographer"), vec!["main", "voice", "voice/lexicographer"]);
    assert_eq!(lane_chain("main"), vec!["main"]);
    let env = |k: &str| (k == "BSC_LANE").then(|| "forced".to_string());
    assert_eq!(build_lane(std::path::Path::new("/"), env), "forced", "an explicit lane wins");
}

/// THE RULE IS ONE TABLE (`the-committed-record-stores-write-into-lanes`): `scripts/lib/laneCases.json`
/// is read by the JS store reader's test and by `bsc_util::Lane`'s, and by this one — so the three places
/// that derive a lane from a branch cannot come to disagree about which lane a checkout reads.
#[test]
fn the_build_derives_lanes_exactly_as_the_shared_table_says() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../scripts/lib/laneCases.json");
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    let cases: serde_json::Value = serde_json::from_str(&raw).expect("laneCases.json parses");
    let rows = cases["branchToLane"].as_array().expect("branchToLane");
    assert!(rows.len() > 5, "a near-empty table would pass every assertion below");
    for row in rows {
        let (branch, want) = (row["branch"].as_str(), row["lane"].as_str().expect("lane"));
        assert_eq!(branch_lane(branch), want, "branch {branch:?}");
    }
    for row in cases["chains"].as_array().expect("chains") {
        let want: Vec<String> =
            row["chain"].as_array().expect("chain").iter().map(|v| v.as_str().expect("lane").to_string()).collect();
        assert_eq!(lane_chain(row["lane"].as_str().expect("lane")), want);
    }
    let root = std::env::temp_dir().join(format!("gm-lane-cases-{}", std::process::id()));
    for (i, row) in cases["env"].as_array().expect("env").iter().enumerate() {
        let dir = root.join(i.to_string());
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("HEAD"), format!("ref: refs/heads/{}\n", row["branch"].as_str().expect("branch")))
            .unwrap();
        let env = row["env"].clone();
        let lookup = move |k: &str| env.get(k).and_then(|v| v.as_str()).map(str::to_string);
        assert_eq!(build_lane(&dir, lookup), row["lane"].as_str().expect("lane"), "env case {i}: {row}");
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// A LINKED WORKTREE's lane comes from its OWN `HEAD`, reached through its `.git` file.
#[test]
fn a_linked_worktree_builds_from_its_own_branch_lane() {
    let root = std::env::temp_dir().join(format!("gm-lane-{}", std::process::id()));
    let admin = root.join("repo").join(".git").join("worktrees").join("wt");
    std::fs::create_dir_all(&admin).unwrap();
    std::fs::write(root.join("repo").join(".git").join("HEAD"), "ref: refs/heads/develop\n").unwrap();
    std::fs::write(admin.join("HEAD"), "ref: refs/heads/radio/ui-lan\n").unwrap();
    let wt = root.join("wt");
    std::fs::create_dir_all(wt.join("graph")).unwrap();
    std::fs::write(wt.join(".git"), format!("gitdir: {}\n", admin.display())).unwrap();
    let no_env = |_: &str| None;
    assert_eq!(build_lane(&wt.join("graph"), no_env), "radio/ui-lan");
    assert_eq!(build_lane(&root.join("repo"), no_env), "main", "the main checkout is on develop");
    let _ = std::fs::remove_dir_all(&root);
}

/// A STORE THAT KEEPS HISTORY (`the-committed-record-store-does-not-grow-a-full-copy-per-edit`) reads exactly its
/// heads. Superseded revisions live in `record_history`, which has no `json` column; a reader that picked a table
/// by prefix, or took the newest rev from both tables, would surface a history row as a record — or fail on one.
#[test]
fn a_store_that_keeps_history_reads_its_heads_and_never_a_history_row() {
    let main = read_lane(&fixture("history.db"), "main").expect("read");
    let ids: Vec<&str> = main.iter().map(|r| r["id"].as_str().expect("id")).collect();
    assert_eq!(ids, vec!["x.rs"], "the tombstoned head hides gone.rs, and no history-only id appears");
    assert_eq!(main[0]["v"], 3, "the head body, exactly as written");

    let lane = read_lane(&fixture("history.db"), "some-slice").expect("lane");
    let by = |id: &str| lane.iter().find(|r| r["id"] == id).unwrap_or_else(|| panic!("{id} missing"));
    assert_eq!(by("x.rs")["where"], "lane", "the lane's head over main's");
    assert!(lane.iter().all(|r| r["id"] != "orphan.rs"));
}
