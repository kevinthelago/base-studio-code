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

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata")).join(name)
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
