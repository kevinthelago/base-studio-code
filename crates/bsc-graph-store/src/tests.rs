use super::*;
use serde_json::json;

fn store() -> Connection {
    let conn = bsc_sqlite_util::open_in_memory_db().expect("in-memory store");
    conn.execute_batch(SCHEMA).expect("schema");
    conn
}

fn rec(code: &str) -> Value {
    json!({ "id": "a.rs", "name": "a", "role": "algorithm", "tech": "rust", "code": code,
            "folder": "crates/x", "provides": "@/x/a" })
}

/// THE PROPERTY THE WHOLE DESIGN EXISTS FOR: a write cannot lose a version, because a write is an
/// INSERT and there is no current-record row to overwrite.
#[test]
fn every_write_keeps_the_version_before_it() {
    let c = store();
    assert_eq!(put(&c, "a.rs", &rec("v1"), "me", None, None).unwrap(), 1);
    assert_eq!(put(&c, "a.rs", &rec("v2"), "me", None, None).unwrap(), 2);
    assert_eq!(put(&c, "a.rs", &rec("v3"), "me", None, None).unwrap(), 3);
    assert_eq!(revs(&c, "a.rs").unwrap(), vec![3, 2, 1]);
    assert_eq!(get(&c, "a.rs").unwrap().unwrap()["code"], "v3", "current is the newest");
}

/// A version cannot be REWRITTEN either — replaying a rev is a constraint violation, not a clobber.
/// This is what the primary key buys on top of append-only.
#[test]
fn an_existing_rev_cannot_be_overwritten() {
    let c = store();
    put(&c, "a.rs", &rec("v1"), "me", None, None).unwrap();
    let forged = c.execute(
        "INSERT INTO record_revs (id, rev, json, at) VALUES ('a.rs', 1, '\"FORGED\"', 0)",
        [],
    );
    assert!(forged.is_err(), "rewriting rev 1 must be refused");
    assert_eq!(get(&c, "a.rs").unwrap().unwrap()["code"], "v1");
}

/// THE TRIGGER COMPARISON, pinned as a test rather than left in a comment.
///
/// A trigger-based history is real enforcement until someone runs `DROP TRIGGER` — measured on SQLite
/// 3.46, writes then continued with history silently frozen. Here there is nothing to drop: the schema
/// carries NO triggers, and history survives because a write has no way to touch an older row.
#[test]
fn the_guarantee_does_not_depend_on_a_trigger_that_could_be_dropped() {
    let c = store();
    let triggers: i64 = c
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(triggers, 0, "history must not rest on a trigger — this schema has none to drop");

    put(&c, "a.rs", &rec("v1"), "me", None, None).unwrap();
    put(&c, "a.rs", &rec("v2"), "me", None, None).unwrap();
    assert_eq!(revs(&c, "a.rs").unwrap().len(), 2);
}

/// Reverting goes FORWARD. The old content comes back as a new rev, so the revert is itself a version
/// and the thing being recovered from is still on record.
#[test]
fn a_revert_appends_rather_than_rewrites() {
    let c = store();
    put(&c, "a.rs", &rec("good"), "me", None, None).unwrap();
    put(&c, "a.rs", &rec("BROKEN"), "me", None, None).unwrap();

    let back = revert(&c, "a.rs", 1, "me").unwrap();
    assert_eq!(back, 3, "the revert is a NEW rev, not a rewind");
    assert_eq!(get(&c, "a.rs").unwrap().unwrap()["code"], "good");
    assert_eq!(revs(&c, "a.rs").unwrap(), vec![3, 2, 1], "the broken rev is still there");

    // …and the revert can itself be reverted, which is the half that makes it safe to use in a panic.
    revert(&c, "a.rs", 2, "me").unwrap();
    assert_eq!(get(&c, "a.rs").unwrap().unwrap()["code"], "BROKEN");
}

/// A removal is a TOMBSTONE: no longer current, still recoverable. `impl remove` losing a record
/// permanently is the behaviour this replaces.
#[test]
fn a_removed_record_is_gone_from_current_and_still_recoverable() {
    let c = store();
    put(&c, "a.rs", &rec("v1"), "me", None, None).unwrap();
    remove(&c, "a.rs", "me", None).unwrap();
    assert!(get(&c, "a.rs").unwrap().is_none(), "a tombstoned record is not current");
    assert_eq!(revs(&c, "a.rs").unwrap(), vec![2, 1], "…and every version is still on disk");

    revert(&c, "a.rs", 1, "me").unwrap();
    assert_eq!(get(&c, "a.rs").unwrap().unwrap()["code"], "v1", "brought back from the dead");
}

/// Reverting TO a tombstone removes the record again — the symmetry matters, or "go back one version"
/// would mean something different depending on which version you landed on.
#[test]
fn reverting_to_a_tombstone_removes_the_record_again() {
    let c = store();
    put(&c, "a.rs", &rec("v1"), "me", None, None).unwrap();
    remove(&c, "a.rs", "me", None).unwrap();
    revert(&c, "a.rs", 1, "me").unwrap();
    revert(&c, "a.rs", 2, "me").unwrap(); // rev 2 was the tombstone
    assert!(get(&c, "a.rs").unwrap().is_none());
}

/// Optimistic concurrency, the same guard `impl set --if-version` already offers — and the reason it
/// matters more here: several sessions author this store at once.
#[test]
fn a_stale_write_is_refused_and_changes_nothing() {
    let c = store();
    put(&c, "a.rs", &rec("v1"), "me", None, None).unwrap();
    put(&c, "a.rs", &rec("v2"), "someone else", None, None).unwrap();

    let err = put(&c, "a.rs", &rec("stale"), "me", None, Some(1)).unwrap_err();
    assert!(err.contains("is at rev 2, not 1"), "{err}");
    assert_eq!(get(&c, "a.rs").unwrap().unwrap()["code"], "v2", "the refused write changed nothing");
    assert_eq!(revs(&c, "a.rs").unwrap(), vec![2, 1], "…and left no version behind");
}

/// The projected columns are computed BY SQLITE from the body, so they cannot drift from it — which is
/// what lets a listing skip parsing bodies it is not going to show.
#[test]
fn the_projected_columns_follow_the_body_and_cannot_drift() {
    let c = store();
    put(&c, "a.rs", &rec("v1"), "me", None, None).unwrap();
    let (folder, provides): (String, String) = c
        .query_row("SELECT folder, provides FROM records WHERE id = 'a.rs'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(folder, "crates/x");
    assert_eq!(provides, "@/x/a");

    // Move the record's folder; the column follows without anyone maintaining it.
    let mut moved = rec("v2");
    moved["folder"] = json!("crates/y");
    put(&c, "a.rs", &moved, "me", None, None).unwrap();
    let folder: String = c.query_row("SELECT folder FROM records WHERE id = 'a.rs'", [], |r| r.get(0)).unwrap();
    assert_eq!(folder, "crates/y");
}

/// `records` must show exactly one row per live id — the head — and nothing for a tombstoned one.
#[test]
fn the_current_view_is_one_row_per_live_record() {
    let c = store();
    for id in ["a.rs", "b.rs", "c.rs"] {
        let mut r = rec("v1");
        r["id"] = json!(id);
        put(&c, id, &r, "me", None, None).unwrap();
        put(&c, id, &r, "me", None, None).unwrap(); // a second rev each
    }
    remove(&c, "c.rs", "me", None).unwrap();
    let live: i64 = c.query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0)).unwrap();
    let total: i64 = c.query_row("SELECT COUNT(*) FROM record_revs", [], |r| r.get(0)).unwrap();
    assert_eq!(live, 2, "two live records");
    assert_eq!(total, 7, "…across seven versions, all retained");
}
