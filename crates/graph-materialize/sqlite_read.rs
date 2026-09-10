// The JSON-SHAPED layer over the record store — the half of the old `sqlite_read.rs` that needs
// `serde_json` and therefore cannot live in `bsc-sqlite-read`, whose whole defining property is a
// dependency closure of exactly `std`.
//
// The page-level reader moved to `crates/bsc-sqlite-read/src/pages.rs` when `bsc-util` needed it too
// (`packaged::read` is the ONE funnel every Rust reader of a packaged seed goes through, and it is a
// std-only leaf that cannot `include!` its way into a build script). `build.rs` and `src/lib.rs` beside
// this file `include!` that file directly, textually, rather than taking the crate as a dependency —
// which is not a shortcut but the BOOTSTRAP: this script materializes every graph-hosted crate, so it
// cannot read the store through a crate that has not been built yet.
//
// So `Db`, `Val`, `varint`, `decode_record`, `columns_of` and `strip_sql_comments` are all in scope
// here unqualified, exactly as they were when this was one file.

/// Every record on `lane`, newest revision per id, as the `implementations` array the JSON store
/// would have carried.
///
/// The ledger keeps EVERY revision (`record_revs` is append-only, which is what makes a record's
/// history answerable), so "the store" is the max `rev` per id — reading them all and taking the
/// newest is what the JSON store's one-file-per-record layout expressed structurally.
pub fn read_lane(db_path: &std::path::Path, lane: &str) -> Result<Vec<serde_json::Value>, String> {
    read_lane_of(db_path, lane, None)
}

/// Every record on `lane` of a given TIER — `impl` for modules, `edge` for the relationship tier.
///
/// The tier is not decoration. Once the committed store is the database, edges live in it beside the
/// records, and a reader that ignored the column would hand 89 edges to the materializer as if they
/// were modules. `None` reads every tier, which is what a caller that wants the whole lane means.
///
/// A NULL tier reads as `impl`: rows predating the column are modules, and defaulting the other way
/// would drop them from the build.
pub fn read_lane_of(
    db_path: &std::path::Path,
    lane: &str,
    tier: Option<&str>,
) -> Result<Vec<serde_json::Value>, String> {
    let db = Db::open(db_path)?;
    let root = db.table_root("record_revs")?;
    let rows = db.rows(root)?;

    // Column order is read from sqlite_master's DDL rather than assumed, so a future ALTER TABLE that
    // appends a column cannot silently shift `json` into `note`.
    let cols = db.columns_of("record_revs")?;
    let idx = |name: &str| -> Result<usize, String> {
        cols.iter()
            .position(|c| c == name)
            .ok_or_else(|| format!("`record_revs` has no `{name}` column; it has {cols:?}"))
    };
    let (i_id, i_lane, i_rev, i_json) = (idx("id")?, idx("lane")?, idx("rev")?, idx("json")?);
    let i_tier = cols.iter().position(|c| c == "tier");

    // A NULL `json` is a TOMBSTONE, not a row to skip — and getting that wrong resurrects the dead.
    //
    // The ledger is append-only, so a record is not deleted by removing rows: a new revision is added
    // whose body is NULL, carrying the reason ("superseded by `bsc-util--deny--mod.rs` — both claimed
    // module `deny`"). MEASURED against the live ledger 2026-09-09: 198 ids on `main` have exactly that
    // as their newest revision. An earlier version of this loop skipped NULL rows, which meant the
    // tombstone was ignored and the PREVIOUS revision won — so all 198 came back from the dead and the
    // materializer refused with `two records claim module …`. The store had already reconciled itself;
    // the reader was the thing that was wrong.
    //
    // So the newest revision is chosen over EVERY row, tombstones included, and an id whose winner is a
    // tombstone is omitted entirely.
    let mut best: std::collections::HashMap<String, (i64, Option<String>)> = std::collections::HashMap::new();
    for row in rows {
        if row.get(i_lane).and_then(Val::as_text) != Some(lane) {
            continue;
        }
        if let Some(want) = tier {
            // A NULL tier is an `impl` — see the doc above; defaulting the other way loses records.
            let got = i_tier
                .and_then(|i| row.get(i))
                .and_then(Val::as_text)
                .unwrap_or("impl");
            if got != want {
                continue;
            }
        }
        let (id, rev) = match (row.get(i_id).and_then(Val::as_text), row.get(i_rev).and_then(Val::as_int)) {
            (Some(i), Some(r)) => (i.to_string(), r),
            _ => continue,
        };
        let json = row.get(i_json).and_then(Val::as_text).map(str::to_string);
        match best.get(&id) {
            Some((have, _)) if *have >= rev => {}
            _ => {
                best.insert(id, (rev, json));
            }
        }
    }
    best.retain(|_, (_, json)| json.is_some());

    // Sorted by id so the emitted store is DETERMINISTIC — the JSON path sorts its record files, and
    // a build whose output depends on hash-map order is a build that cannot be diffed.
    let mut ids: Vec<&String> = best.keys().collect();
    ids.sort();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let json = best[id].1.as_deref().expect("tombstones were retained out above");
        out.push(
            serde_json::from_str(json)
                .map_err(|e| format!("record `{id}` on lane `{lane}` holds invalid JSON: {e}"))?,
        );
    }
    Ok(out)
}
