//! The differential guard — fixtures WRITTEN by SQLite, READ by this crate.
//!
//! A hand-rolled parser checked only against its own output is a claim, not evidence
//! (`a-byte-identical-roundtrip-does-not-prove-the-parse`), and the failure mode is the bad one: a
//! mis-parse returns plausible data rather than an error. So every fixture under `testdata/` was
//! written by the real SQLite engine and is committed as BYTES. `testdata/*.sql` regenerates each one
//! and names its own command.
//!
//! `rusqlite` is not even a DEV-dependency here, for the reason the fixtures exist: a dev edge still
//! lands in the Cargo.lock closure of every dependent, and `bsc-util` — which this crate now sits
//! under — is in almost every crate's closure. `serde_json` IS a dev-dependency, and it is what
//! [`json_string_field`] is proved against.

use super::*;

fn fixture(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata")).join(name)
}

fn ledger() -> Db {
    Db::open(&fixture("ledger.db")).expect("open the fixture ledger")
}

/// The columns come from the table's own `CREATE TABLE`, by NAME.
///
/// Positional trust is the trap this closes: the reader is pinned to the SCHEMA, so adding a column
/// to `record_revs` cannot silently re-point `json` at another field.
#[test]
fn the_columns_are_read_from_the_schema_by_name() {
    let db = ledger();
    let cols = db.columns_of("record_revs").expect("columns");
    assert_eq!(cols, ["id", "lane", "rev", "base_rev", "json", "tier", "at", "by", "note"]);
}

/// Rows come back with the values SQLite actually wrote — the whole point of a committed fixture.
#[test]
fn reads_back_exactly_what_sqlite_wrote() {
    let db = ledger();
    let root = db.table_root("record_revs").expect("root");
    let rows = db.rows(root).expect("rows");
    let find = |id: &str, rev: i64| {
        rows.iter()
            .find(|r| r[0].as_text() == Some(id) && r[2].as_int() == Some(rev))
            .unwrap_or_else(|| panic!("{id} rev {rev} missing"))
    };
    assert_eq!(find("alpha.rs", 1)[4].as_text(), Some(r#"{"id":"alpha.rs","code":"fn a() {}"}"#));
    // Multibyte survives: record bodies are prose-heavy source.
    assert!(find("u.rs", 1)[4].as_text().expect("body").contains("日本語 🌍"));
    // A TOMBSTONE is a NULL body, not an absent row — the distinction 198 real records depend on.
    assert_eq!(find("dead.rs", 2)[4], Val::Null);
    assert_eq!(find("dead.rs", 2)[8].as_text(), Some("superseded by `dead--mod.rs`"));
}

/// The b-tree is WALKED, not assumed to be one leaf: the fixture carries 500+ rows precisely so the
/// table grows interior pages, and a reader that only read the root would return a fraction of them.
#[test]
fn every_row_is_found_across_interior_pages() {
    let db = ledger();
    let rows = db.rows(db.table_root("record_revs").expect("root")).expect("rows");
    let generated = rows.iter().filter(|r| r[0].as_text().is_some_and(|s| s.starts_with("r0"))).count();
    assert_eq!(generated, 500, "the b-tree walk must reach every leaf, not just the root page");
}

/// A body past one 4096-byte page lives in an OVERFLOW CHAIN, and the payload arithmetic that finds
/// it is the fiddliest part of the format. 40,000 characters, reassembled whole.
#[test]
fn an_overflowing_body_is_reassembled_from_its_chain() {
    let db = ledger();
    let rows = db.rows(db.table_root("record_revs").expect("root")).expect("rows");
    let big = rows.iter().find(|r| r[0].as_text() == Some("big.rs")).expect("big.rs");
    let body = big[4].as_text().expect("body");
    assert!(body.len() > 40_000, "the overflow chain was truncated at {} bytes", body.len());
    assert!(body.ends_with(r#"ab"}"#), "the TAIL of the chain is what a short read loses: {:?}", &body[body.len() - 8..]);
}

/// WAL is REFUSED, never read. Committed data can live in a `-wal` sidecar this reader does not open,
/// so reading anyway would return STALE ROWS while looking perfectly healthy.
#[test]
fn a_wal_database_is_refused_rather_than_read_stale() {
    // `.err()` rather than `expect_err`, because `Db` deliberately has no `Debug`: it holds the whole
    // file in memory, and a derived one would let a stray `{:?}` print ~98 MB of the real ledger.
    let err = Db::open(&fixture("wal.db")).err().expect("WAL must be refused, not read");
    assert!(err.to_lowercase().contains("wal"), "the refusal must name WAL: {err}");
}

/// Inline `--` comments in the live DDL are what a naive column parser chokes on — the real ledger
/// has them, and reading them as columns yielded 26 phantom fields and no `lane`.
#[test]
fn a_commented_ddl_still_yields_its_real_columns() {
    let db = Db::open(&fixture("commented.db")).expect("open");
    let cols = db.columns_of("record_revs").expect("columns");
    assert!(cols.contains(&"lane".to_string()), "the real columns must survive the comments: {cols:?}");
    assert!(cols.iter().all(|c| !c.contains("--")), "a comment leaked into a column name: {cols:?}");
}

/// A `--` inside a string literal is DATA. Eating it would corrupt a DEFAULT and, through it, the
/// column list that everything else is positioned by.
#[test]
fn a_comment_marker_inside_a_string_literal_is_left_alone() {
    let got = strip_sql_comments("CREATE TABLE t (a TEXT DEFAULT 'x -- y', b INT) -- trailing");
    assert!(got.contains("'x -- y'"), "the literal was eaten: {got}");
    assert!(!got.contains("trailing"), "the real comment survived: {got}");
}

// ── json_string_field ───────────────────────────────────────────────────────────────────────────────

/// The corpus is the awkward half of JSON, not the easy half — every case here is one this reader
/// could plausibly get wrong while looking fine on ordinary input.
const AWKWARD: &[&str] = &[
    r#"{"text":"plain"}"#,
    r#"{"text":""}"#,
    r#"{ "text" : "spaced out" }"#,
    // Escapes, including a quote that would end the string for a scanner that ignores backslashes.
    r#"{"text":"a \" b \\ c \/ d"}"#,
    r#"{"text":"line\nbreak\ttab\r\n"}"#,
    r#"{"text":"é日本語"}"#,
    // A SURROGATE PAIR — two escapes, one character. Decoding the halves separately is silent
    // corruption of any non-BMP content, and an emoji in a theme name is enough to hit it.
    r#"{"text":"emoji 🌍 done"}"#,
    // A DECOY one level down. A scanner taking the first match returns the wrong file entirely.
    r#"{"a":{"text":"inner"},"text":"outer"}"#,
    r#"{"a":["text","not a key"],"text":"after an array"}"#,
    // The key appearing as a VALUE before it appears as a key.
    r#"{"note":"text","text":"real"}"#,
    // A key whose name merely starts with the one we want.
    r#"{"textual":"no","text":"yes"}"#,
    // Raw multibyte, not escaped — how a real record body actually carries prose.
    r#"{"path":"ui/themes.json","text":"— → ✓ 日本語 🌍"}"#,
    // Absent, and present-but-not-a-string: both must be None rather than a guess.
    r#"{"other":"x"}"#,
    r#"{"text":123}"#,
    r#"{"text":null}"#,
    r#"{"text":{"nested":"object"}}"#,
];

/// THE GUARD THAT MAKES THE HAND-ROLLED READER SAFE: it must agree with `serde_json`, case for case.
///
/// `json_string_field` exists because `bsc-util` may not link a JSON library for one field access.
/// That is only defensible while its answers are checked against the real one — which a DEV-dependency
/// makes possible without putting `serde_json` in any dependent's closure.
#[test]
fn the_field_reader_agrees_with_serde_json() {
    for doc in AWKWARD {
        let want = serde_json::from_str::<serde_json::Value>(doc)
            .unwrap_or_else(|e| panic!("the fixture itself is not valid JSON: {doc}\n{e}"))
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let got = json_string_field(doc, "text");
        assert_eq!(got, want, "disagreed on {doc}");
    }
}

/// The real shape it is FOR: a seed row's envelope, with a body big enough to have come out of an
/// overflow chain.
#[test]
fn it_reads_a_seed_envelope_out_of_the_store() {
    let text = "/* a token contract */\n:root { --card-bg: #fff; }\r\n".repeat(500);
    let doc = serde_json::json!({ "path": "ui/tokens-contract.css", "text": text }).to_string();
    assert_eq!(json_string_field(&doc, "text").as_deref(), Some(text.as_str()));
    assert_eq!(json_string_field(&doc, "path").as_deref(), Some("ui/tokens-contract.css"));
}

/// Malformed input is `None`, never a truncated value. A half-decoded seed written to disk would look
/// like a real file.
#[test]
fn a_truncated_or_malformed_value_is_none_rather_than_partial() {
    for bad in [r#"{"text":"unterminated"#, r#"{"text":"bad escape \q"}"#, r#"{"text":"\u00"#, r#"{"text":"\ud83c only half"}"#] {
        assert_eq!(json_string_field(bad, "text"), None, "must refuse {bad}");
    }
}
