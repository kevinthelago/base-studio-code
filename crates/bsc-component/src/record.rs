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

/// The history stamp `bsc ui log <id>` prints for a record: `{ id, rev, updatedAt, updatedBy }`. A
/// record never stamped (or a legacy one) reports rev 0 and empty `updatedAt`/`updatedBy`. Pure read —
/// the store keeps only the current row, so this is the current stamp, not a history table.
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
        // A legacy record (no stamps) logs as rev 0 with empty attribution.
        let legacy = json!({ "id": "old", "name": "Old" });
        assert_eq!(
            log_value("old", &legacy),
            json!({ "id": "old", "rev": 0, "updatedAt": "", "updatedBy": "" }),
        );
        // A stamped record surfaces all three.
        let mut rec = json!({ "id": "card", "name": "Card" });
        stamp(&mut rec, 2, "designer", "2026-07-16T09:00:00Z");
        assert_eq!(
            log_value("card", &rec),
            json!({ "id": "card", "rev": 3, "updatedAt": "2026-07-16T09:00:00Z", "updatedBy": "designer" }),
        );
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
