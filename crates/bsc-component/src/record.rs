//! Record history / attribution / optimistic-concurrency stamping (#3164).
//!
//! The component/kit stores are **verbatim JSON** — the shared [`bsc_json_store`] backend imposes no
//! schema and every other family store (blueprints/personas/teams/…) relies on that "stored byte-for-byte
//! what you sent" contract. So the provenance metadata a `bsc ui` write carries is stamped HERE, in the
//! crate that OWNS the component/kit record shape, right before the JSON is handed to the store — never
//! in the shared backend. Three OPTIONAL, ADDITIVE fields:
//!
//!   - `rev` — a monotonically-increasing integer revision, auto-bumped on every write. A record with
//!     no `rev` reads as **rev 0** (the backward-compat contract), so its first stamped write is rev 1.
//!   - `updatedAt` — the write's ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`, UTC) timestamp.
//!   - `updatedBy` — the writer tag (`bsc ui set --by <tag>`, else `$BSC_UI_WRITER`, else `"unknown"`).
//!
//! All three are optional (absent on legacy records) and never consulted by `get`/`list`/`doctor` —
//! they're pure provenance, surfaced by `bsc ui log <id>`. Optimistic concurrency
//! (`bsc ui set --if-version <n>`) compares the CURRENT stored `rev` against `n` and refuses a stale
//! overwrite, so a background writer can't silently clobber a record it never re-read.

use serde_json::Value;

/// The revision counter field.
pub const REV: &str = "rev";
/// The last-write ISO-8601 timestamp field.
pub const UPDATED_AT: &str = "updatedAt";
/// The writer-tag attribution field.
pub const UPDATED_BY: &str = "updatedBy";
/// The change-history field (#3568) — a capped list of past write entries, appended NEWEST-LAST.
pub const HISTORY: &str = "history";
/// Max history entries kept on a record — older ones drop off so the record (and `bsc ui list --full`)
/// stays bounded; the recent log is what a session reviews before an edit.
pub const HISTORY_CAP: usize = 30;

/// The record's current `rev` as an integer — **0** when absent, null, or a non-integer, so a legacy
/// record with no `rev` reads as rev 0 (the backward-compat contract). Never errors.
pub fn read_rev(record: &Value) -> i64 {
    record.get(REV).and_then(Value::as_i64).unwrap_or(0)
}

/// Stamp a record IN PLACE for a write: bump `rev` to `prior_rev + 1`, set `updatedAt = now_iso`, and
/// set `updatedBy = writer`. A no-op on a non-object value (defensive — real records are objects).
/// `prior_rev` is the record's CURRENT stored rev (see [`read_rev`]); pass 0 for a brand-new record.
pub fn stamp(record: &mut Value, prior_rev: i64, writer: &str, now_iso: &str) {
    if let Some(obj) = record.as_object_mut() {
        obj.insert(REV.to_string(), Value::from(prior_rev + 1));
        obj.insert(UPDATED_AT.to_string(), Value::from(now_iso));
        obj.insert(UPDATED_BY.to_string(), Value::from(writer));
    }
}

/// The fields this write REMOVES — present in the stored record, absent from the incoming one (#4197).
///
/// A `set` is a whole-record REPLACE, so a partial write silently deletes everything it does not restate.
/// That is the defect #4154 fixed for the algorithms graph, where `impl set` was `*existing = im` and a
/// domain-only edit deleted the code — it cost a 16-entry reorg before anyone noticed. The component store
/// never got the same treatment, and it matters more here: `fleetpage` has no source file (#3636 deleted
/// it), so its record is the only copy of that UI, and every page follows as the deletion track proceeds.
///
/// [`changed_fields`] already counts a removal as a change, but files it alongside ordinary edits — so in
/// `bsc ui log` a destructive write and a routine one look identical. This separates them. Pure; the CLI
/// decides what to do about a non-empty result (warn), and `stamp_with_history` records it distinctly.
///
/// The server-managed fields are excluded: `rev`/`updatedAt`/`updatedBy`/`history` are re-stamped on every
/// write regardless of the payload, and `seedHash` is a derived reconcile value, not authored content —
/// reporting any of them would fire on every single write and train people to ignore the warning.
pub fn dropped_fields(prior: &Value, next: &Value) -> Vec<String> {
    const SKIP: [&str; 5] = [REV, UPDATED_AT, UPDATED_BY, HISTORY, "seedHash"];
    let (Some(p), Some(n)) = (prior.as_object(), next.as_object()) else { return vec![] };
    p.keys()
        .filter(|k| !SKIP.contains(&k.as_str()) && !n.contains_key(*k))
        .cloned()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// The top-level fields that DIFFER between the prior record and the new one — the auto-summary of a
/// change (#3568). Excludes the provenance/history fields themselves and `seedHash` (a derived reconcile
/// hash, not an authored change). A brand-new record (prior absent/empty at rev 0) → `["created"]`.
/// Returns names sorted for a stable entry. Pure. A REMOVED field counts as a change here; see
/// [`dropped_fields`] for the removals on their own, which is what makes a destructive write legible.
pub fn changed_fields(prior: &Value, next: &Value) -> Vec<String> {
    const SKIP: [&str; 5] = [REV, UPDATED_AT, UPDATED_BY, HISTORY, "seedHash"];
    let Some(n) = next.as_object() else { return vec![] };
    let p = prior.as_object();
    if p.is_none_or(serde_json::Map::is_empty) && read_rev(prior) == 0 {
        return vec!["created".to_string()];
    }
    let p = p.expect("non-new ⇒ prior is a non-empty object");
    let mut changed = std::collections::BTreeSet::new();
    for (k, v) in n {
        if !SKIP.contains(&k.as_str()) && p.get(k) != Some(v) {
            changed.insert(k.clone());
        }
    }
    for k in p.keys() {
        if !SKIP.contains(&k.as_str()) && !n.contains_key(k) {
            changed.insert(k.clone()); // a removed field is a change too
        }
    }
    changed.into_iter().collect()
}

/// Stamp a record for a write AND append a change-history entry (#3568): the provenance [`stamp`] plus one
/// `{ rev, at, by, note?, changed }` row appended to a capped `history[]`, carried forward from `prior`
/// (the CURRENT stored record). `changed` is [`changed_fields`] (the first write records `["created"]`).
/// SERVER-MANAGED — the incoming record's own `history` is discarded and replaced, so a session never
/// authors it. `note` (trimmed, non-empty) is optional. A no-op on a non-object `record` (defensive).
pub fn stamp_with_history(record: &mut Value, prior: &Value, writer: &str, now_iso: &str, note: Option<&str>) {
    let prior_rev = read_rev(prior);
    let mut history: Vec<Value> =
        prior.get(HISTORY).and_then(Value::as_array).cloned().unwrap_or_default();
    let changed = changed_fields(prior, record);
    stamp(record, prior_rev, writer, now_iso);
    let mut entry = serde_json::Map::new();
    entry.insert(REV.to_string(), Value::from(prior_rev + 1));
    entry.insert("at".to_string(), Value::from(now_iso));
    entry.insert("by".to_string(), Value::from(writer));
    if let Some(n) = note.map(str::trim).filter(|s| !s.is_empty()) {
        entry.insert("note".to_string(), Value::from(n));
    }
    entry.insert("changed".to_string(), Value::from(changed));
    // #4197: removals recorded SEPARATELY from edits. `changed` counts a dropped field, but alongside
    // ordinary edits — so in `bsc ui log` a write that deleted half a record and one that fixed a typo
    // read the same. Only present when something was actually dropped, so an ordinary entry is unchanged
    // and existing readers see no new noise.
    let dropped = dropped_fields(prior, record);
    if !dropped.is_empty() {
        entry.insert("dropped".to_string(), Value::from(dropped));
    }
    history.push(Value::Object(entry));
    let overflow = history.len().saturating_sub(HISTORY_CAP);
    if overflow > 0 {
        history.drain(0..overflow); // drop the oldest, keep the most recent HISTORY_CAP
    }
    if let Some(obj) = record.as_object_mut() {
        obj.insert(HISTORY.to_string(), Value::from(history));
    }
}

/// Resolve the writer tag for a write: an explicit `--by <tag>` wins, else `$BSC_UI_WRITER`, else
/// `"unknown"`. A blank/whitespace value at either source is treated as absent.
pub fn resolve_writer(explicit: Option<&str>) -> String {
    explicit
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("BSC_UI_WRITER").ok().filter(|s| !s.trim().is_empty()))
        .unwrap_or_else(|| "unknown".to_string())
}

/// The current write timestamp as ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`), matching the app's other
/// stamps ([`bsc_util::epoch_ms_to_iso8601`]).
pub fn now_iso() -> String {
    bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms())
}

/// What `bsc ui log <id>` prints for a record: the current stamp `{ id, rev, updatedAt, updatedBy }` plus
/// the change `history` (#3568, NEWEST-FIRST for reading), so a session can review a component's past
/// before editing. A record never stamped (or legacy) reports rev 0, empty stamps, and an empty history.
pub fn log_value(id: &str, record: &Value) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("id".to_string(), Value::from(id));
    m.insert(REV.to_string(), Value::from(read_rev(record)));
    m.insert(
        UPDATED_AT.to_string(),
        Value::from(record.get(UPDATED_AT).and_then(Value::as_str).unwrap_or("")),
    );
    m.insert(
        UPDATED_BY.to_string(),
        Value::from(record.get(UPDATED_BY).and_then(Value::as_str).unwrap_or("")),
    );
    // Stored append-order (oldest-first); reverse so the log reads newest-first.
    let mut history: Vec<Value> = record.get(HISTORY).and_then(Value::as_array).cloned().unwrap_or_default();
    history.reverse();
    m.insert(HISTORY.to_string(), Value::from(history));
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Serializes the one test that mutates the process-wide `$BSC_UI_WRITER` env (env is global to the
    /// test binary), so a parallel read never sees a half-set value.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn read_rev_treats_a_missing_or_odd_rev_as_zero_and_reads_a_real_one() {
        // Backward-compat: a legacy record with no `rev` (and null / non-integer / string values) all
        // read as rev 0, so an old record slots into the concurrency scheme as "never revised".
        assert_eq!(read_rev(&json!({ "id": "x", "name": "X" })), 0, "absent ⇒ 0");
        assert_eq!(read_rev(&json!({ "id": "x", "rev": null })), 0, "null ⇒ 0");
        assert_eq!(read_rev(&json!({ "id": "x", "rev": "7" })), 0, "string ⇒ 0");
        assert_eq!(read_rev(&json!({ "id": "x", "rev": 1.5 })), 0, "non-integer ⇒ 0");
        // A real integer rev reads through.
        assert_eq!(read_rev(&json!({ "id": "x", "rev": 4 })), 4);
    }

    #[test]
    fn stamp_bumps_rev_sets_time_and_writer_and_preserves_other_fields() {
        // A brand-new record (prior 0) → rev 1, plus the two stamps; the original fields survive.
        let mut rec = json!({ "id": "button", "name": "Button", "kitId": "react-ui" });
        stamp(&mut rec, 0, "alice", "2026-07-16T00:00:00Z");
        assert_eq!(rec["rev"], json!(1), "a fresh record's first write is rev 1");
        assert_eq!(rec["updatedAt"], "2026-07-16T00:00:00Z");
        assert_eq!(rec["updatedBy"], "alice");
        assert_eq!(rec["id"], "button", "the id is untouched");
        assert_eq!(rec["name"], "Button", "domain fields are preserved");
        assert_eq!(rec["kitId"], "react-ui");

        // The next write bumps from the (now current) rev, and a stale `rev` field on the incoming
        // value is OVERWRITTEN by prior+1 (the store's rev is authoritative, not the payload's).
        rec["rev"] = json!(99); // pretend the caller sent a stale value
        stamp(&mut rec, 1, "bob", "2026-07-16T00:01:00Z");
        assert_eq!(rec["rev"], json!(2), "bumped from the prior stored rev, not the payload's 99");
        assert_eq!(rec["updatedBy"], "bob");
    }

    #[test]
    fn stamp_is_a_no_op_on_a_non_object() {
        // Defensive: real records are objects, but a non-object never panics.
        let mut arr = json!([1, 2, 3]);
        stamp(&mut arr, 0, "x", "t");
        assert_eq!(arr, json!([1, 2, 3]));
    }

    #[test]
    fn log_value_reports_the_current_stamp_and_defaults_for_a_legacy_record() {
        // A legacy record (no stamps) logs as rev 0 with empty attribution and an empty history.
        let legacy = json!({ "id": "old", "name": "Old" });
        assert_eq!(
            log_value("old", &legacy),
            json!({ "id": "old", "rev": 0, "updatedAt": "", "updatedBy": "", "history": [] }),
        );
        // A stamped record surfaces all three (still an empty history — it was never written via
        // `stamp_with_history`, only the bare `stamp`).
        let mut rec = json!({ "id": "card", "name": "Card" });
        stamp(&mut rec, 2, "designer", "2026-07-16T09:00:00Z");
        assert_eq!(
            log_value("card", &rec),
            json!({ "id": "card", "rev": 3, "updatedAt": "2026-07-16T09:00:00Z", "updatedBy": "designer", "history": [] }),
        );
    }

    #[test]
    fn changed_fields_reports_created_then_the_diffed_top_level_fields() {
        // A brand-new record (prior absent, rev 0) is summarized as "created", not a field-by-field diff.
        let fresh = json!({ "id": "button", "name": "Button", "kitId": "react-ui" });
        assert_eq!(changed_fields(&Value::Null, &fresh), vec!["created".to_string()]);
        assert_eq!(changed_fields(&json!({}), &fresh), vec!["created".to_string()]);

        // A real edit diffs the top-level fields: a changed value, an added field, and a removed one all
        // count; unchanged fields do not; the result is sorted for a stable entry.
        let prior = json!({ "id": "button", "rev": 3, "name": "Button", "kitId": "react-ui", "old": 1 });
        let next = json!({ "id": "button", "name": "Button", "kitId": "mui", "srcText": "…" });
        assert_eq!(
            changed_fields(&prior, &next),
            vec!["kitId".to_string(), "old".to_string(), "srcText".to_string()],
            "changed kitId + added srcText + removed old; id/name unchanged",
        );

        // The provenance/history fields and the derived `seedHash` never count as an authored change.
        let p2 = json!({ "id": "x", "rev": 2, "name": "X", "seedHash": "aaa" });
        let n2 = json!({ "id": "x", "rev": 3, "updatedAt": "t", "updatedBy": "u", "history": [1], "name": "X", "seedHash": "bbb" });
        assert!(changed_fields(&p2, &n2).is_empty(), "only rev/stamps/history/seedHash moved ⇒ no authored change");
    }

    #[test]
    fn stamp_with_history_appends_a_capped_newest_last_log() {
        // First write on a fresh record: rev 1, one "created" entry carrying the note.
        let mut rec = json!({ "id": "button", "name": "Button" });
        stamp_with_history(&mut rec, &Value::Null, "designer", "2026-07-16T00:00:00Z", Some("initial"));
        assert_eq!(rec["rev"], json!(1));
        let hist = rec["history"].as_array().unwrap();
        assert_eq!(hist.len(), 1);
        assert_eq!(
            hist[0],
            json!({ "rev": 1, "at": "2026-07-16T00:00:00Z", "by": "designer", "note": "initial", "changed": ["created"] }),
        );

        // Second write carries the prior history forward and appends newest-LAST; a blank note is dropped.
        let prior = rec.clone();
        let mut next = json!({ "id": "button", "name": "Button 2" });
        stamp_with_history(&mut next, &prior, "alice", "2026-07-16T00:01:00Z", Some("   "));
        assert_eq!(next["rev"], json!(2));
        let hist = next["history"].as_array().unwrap();
        assert_eq!(hist.len(), 2, "prior entry carried forward + the new one");
        assert_eq!(hist[0]["rev"], json!(1), "oldest stays first (append order)");
        assert_eq!(hist[1], json!({ "rev": 2, "at": "2026-07-16T00:01:00Z", "by": "alice", "changed": ["name"] }), "no note key when blank");

        // The incoming record's own `history` is SERVER-MANAGED — a forged one is discarded.
        let mut forged = json!({ "id": "button", "name": "Button 3", "history": [{ "rev": 999, "by": "attacker" }] });
        stamp_with_history(&mut forged, &next, "bob", "2026-07-16T00:02:00Z", None);
        let hist = forged["history"].as_array().unwrap();
        assert_eq!(hist.len(), 3, "grew from the PRIOR's 2, not the forged 1");
        assert!(hist.iter().all(|e| e["by"] != json!("attacker")), "the forged entry is gone");
    }

    #[test]
    fn stamp_with_history_caps_at_history_cap_dropping_the_oldest() {
        let mut rec = json!({ "id": "x", "name": "n0" });
        let mut prior = Value::Null;
        // Write HISTORY_CAP + 5 times; the log must retain exactly the most recent HISTORY_CAP.
        for i in 0..(HISTORY_CAP + 5) {
            rec = json!({ "id": "x", "name": format!("n{i}") });
            stamp_with_history(&mut rec, &prior, "w", "2026-07-16T00:00:00Z", None);
            prior = rec.clone();
        }
        let hist = rec["history"].as_array().unwrap();
        assert_eq!(hist.len(), HISTORY_CAP, "capped");
        let oldest_rev = hist[0]["rev"].as_i64().unwrap();
        let newest_rev = hist[hist.len() - 1]["rev"].as_i64().unwrap();
        assert_eq!(newest_rev, (HISTORY_CAP + 5) as i64, "the last write's rev is retained");
        assert_eq!(oldest_rev, newest_rev - (HISTORY_CAP as i64) + 1, "exactly the most recent CAP, oldest dropped");
    }

    #[test]
    fn log_value_reverses_history_to_newest_first() {
        let mut rec = json!({ "id": "x", "name": "a" });
        stamp_with_history(&mut rec, &Value::Null, "w", "2026-07-16T00:00:00Z", None);
        let prior = rec.clone();
        let mut next = json!({ "id": "x", "name": "b" });
        stamp_with_history(&mut next, &prior, "w", "2026-07-16T00:01:00Z", None);
        // Stored oldest-first (rev 1 then rev 2); the LOG must read newest-first (rev 2 then rev 1).
        let logged = log_value("x", &next);
        let hist = logged["history"].as_array().unwrap();
        assert_eq!(hist[0]["rev"], json!(2), "newest first");
        assert_eq!(hist[1]["rev"], json!(1));
    }

    #[test]
    fn resolve_writer_precedence_explicit_then_env_then_unknown() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        // Explicit `--by` wins regardless of the env.
        std::env::set_var("BSC_UI_WRITER", "ci-bot");
        assert_eq!(resolve_writer(Some("alice")), "alice");
        // A blank explicit falls through to the env.
        assert_eq!(resolve_writer(Some("   ")), "ci-bot");
        assert_eq!(resolve_writer(None), "ci-bot");
        // With no env (and no/blank explicit) the default is "unknown".
        std::env::remove_var("BSC_UI_WRITER");
        assert_eq!(resolve_writer(None), "unknown");
        assert_eq!(resolve_writer(Some("")), "unknown");
        assert_eq!(resolve_writer(Some("designer")), "designer");
    }

    #[test]
    fn now_iso_is_a_well_formed_utc_stamp() {
        let ts = now_iso();
        // `YYYY-MM-DDTHH:MM:SSZ` — 20 chars, ends in Z, and round-trips back through the inverse.
        assert_eq!(ts.len(), 20, "ISO-8601 second-resolution: {ts}");
        assert!(ts.ends_with('Z'), "UTC 'Z' suffix: {ts}");
        assert!(bsc_util::iso8601_to_epoch_ms(&ts).is_some(), "parses back: {ts}");
    }
}
