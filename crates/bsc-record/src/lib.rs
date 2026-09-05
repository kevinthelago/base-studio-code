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

/// The source field a component record renders from — the one field whose loss is unrecoverable.
pub const SRC_TEXT: &str = "srcText";
/// The history entry's retained PRIOR source — the record's `srcText` as it was *before* that write.
pub const PREV_SRC: &str = "prevSrc";
/// How many of the most recent history entries retain their [`PREV_SRC`] content.
///
/// The log keeps [`HISTORY_CAP`] entries of METADATA but only this many of CONTENT, and the asymmetry is
/// deliberate: `srcText` is 77.6% of a record's payload, so retaining it on all 30 would multiply the
/// store by roughly the number of times a record has been edited. Five is the undo depth that matters —
/// the 02:00 incident needed exactly one, and a session that has written a record five times since the
/// last good version has bigger problems than a missing sixth rung.
pub const PREV_SRC_CAP: usize = 5;

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

/// The fields this write REMOVES — present in the stored record, absent from the one being written
/// (#4197). Call it with the EFFECTIVE record (post-[`merge_over`]), which is what actually lands.
///
/// A merging `set` removes only what the write asked to remove (a `null`, or `--clear`), so this is
/// normally empty. It is `--replace` — the verbatim whole-record write the app bridge and the seed
/// reconcile need — that can still delete a field by omission, which is the case worth naming out loud.
/// That is the defect #4154 fixed for the algorithms graph, where `impl set` was `*existing = im` and a
/// domain-only edit deleted the code — it cost a 16-entry reorg before anyone noticed. It matters more
/// here: `fleetpage` has no source file (#3636 deleted it), so its record is the only copy of that UI,
/// and every page follows as the deletion track proceeds.
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

/// The `id` field — the store key, so a merge never lets a payload (or `--clear`) remove it.
const ID: &str = "id";

/// The record a MERGING `set` actually writes (#4197): the STORED record with the incoming record's
/// fields overlaid, so a write that restates only `srcText` KEEPS the kit, role, `composes` edges,
/// `src`/`folder` provenance and `props` it never mentioned.
///
/// This is the [`bsc_graph`-side fix of #4154](https://github.com/kevinthelago/base-studio-code/issues/4154)
/// applied to the component store — `impl set` was `*existing = im`, a whole-record overwrite, so a
/// domain-only edit deleted the code and it cost a 16-entry reorg before anyone noticed. The two stores
/// now answer a partial write the same way, which matters because the fleet's worker protocol routes
/// EVERY edit of a record-backed component file through `bsc ui set` (#4193) and some pages (`fleetpage`,
/// since #3636) have no source file left — the record is the only copy.
///
/// Removal is therefore EXPLICIT, exactly as it is for `bsc graph impl set`:
///   - a JSON `null` value in the incoming record removes that field, and
///   - `clear` (the CLI's `--clear a,b`) removes those fields regardless of the payload — it is applied
///     LAST, so `--clear` wins over a value the same write supplied.
///
/// `id` is never removable by either route: it is the store key, and a record that lost it would be
/// unreadable by every `list`/`get`/`doctor` path. The server-managed stamps need no special case —
/// [`stamp_with_history`] re-writes `rev`/`updatedAt`/`updatedBy`/`history` after the merge either way.
///
/// A non-object on either side cannot be merged field-wise, so the incoming value wins — the same honest
/// fallback `set_impl` takes, rather than silently keeping a malformed record. That also makes a CREATE
/// (`prior` is `Value::Null`) fall out for free: there is nothing to preserve, so the incoming record is
/// the record. Pure.
pub fn merge_over(prior: &Value, incoming: &Value, clear: &[String]) -> Value {
    let (Some(p), Some(n)) = (prior.as_object(), incoming.as_object()) else {
        return incoming.clone();
    };
    let mut merged = p.clone();
    for (k, v) in n {
        if k == ID {
            if !v.is_null() {
                merged.insert(k.clone(), v.clone());
            }
        } else if v.is_null() {
            merged.remove(k);
        } else {
            merged.insert(k.clone(), v.clone());
        }
    }
    for f in clear {
        if f != ID {
            merged.remove(f.as_str());
        }
    }
    Value::Object(merged)
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

/// Strip [`PREV_SRC`] from all but the most recent [`PREV_SRC_CAP`] entries that carry one.
///
/// Called on the history AFTER the new entry is pushed, so the newest write always keeps its content and
/// the sixth-oldest loses it. Entry METADATA is untouched — `bsc ui log` still shows that a write changed
/// `srcText` at rev 12, it just can no longer hand you the bytes. That is the honest shape: a rung that
/// has aged out reads as absent rather than as "this write changed nothing".
fn prune_prev_src(history: &mut [Value]) {
    let mut kept = 0usize;
    for entry in history.iter_mut().rev() {
        let Some(obj) = entry.as_object_mut() else { continue };
        if !obj.contains_key(PREV_SRC) {
            continue;
        }
        kept += 1;
        if kept > PREV_SRC_CAP {
            obj.remove(PREV_SRC);
        }
    }
}

/// Stamp a record for a write AND append a change-history entry (#3568): the provenance [`stamp`] plus one
/// `{ rev, at, by, note?, changed }` row appended to a capped `history[]`, carried forward from `prior`
/// (the CURRENT stored record). `changed` is [`changed_fields`] (the first write records `["created"]`).
/// SERVER-MANAGED — the incoming record's own `history` is discarded and replaced, so a session never
/// authors it. `note` (trimmed, non-empty) is optional. A no-op on a non-object `record` (defensive).
///
/// A write that MOVES `srcText` also retains the PRIOR source on its entry as `prevSrc` — which is what
/// makes the write revertible (`bsc ui revert`). Before this the log recorded *that* `srcText` changed and
/// never *what it was*, so recovery from a bad write meant re-seeding from the packaged seed — and a
/// record with no seed (25 of 47 pages, including `graphprimitive`/`kitrenderer`/`insights`) had no way
/// back at all. Retained on the most recent [`PREV_SRC_CAP`] entries only; see [`prune_prev_src`].
pub fn stamp_with_history(record: &mut Value, prior: &Value, writer: &str, now_iso: &str, note: Option<&str>) {
    stamp_with_history_of(record, prior, writer, now_iso, note, SRC_TEXT);
}

/// [`stamp_with_history`] over an explicit CONTENT field.
///
/// The retained rung is the one thing in this module that is store-specific: the component store's
/// content is `srcText`, the algorithms graph's is `code`. Everything else — rev, author, timestamp,
/// `changed`, `dropped`, the caps — is identical, which is exactly why this is one shared module with a
/// parameter rather than two implementations that agree until they quietly do not.
pub fn stamp_with_history_of(record: &mut Value, prior: &Value, writer: &str, now_iso: &str, note: Option<&str>, content: &str) {
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
    // The rung back. Only when the source actually MOVED — an unchanged `srcText` would otherwise store a
    // duplicate of itself on every write, and a `null` prior (a create) has nothing to go back to.
    let prior_src = prior.get(content).and_then(Value::as_str);
    let next_src = record.get(content).and_then(Value::as_str);
    if let Some(was) = prior_src.filter(|was| Some(*was) != next_src) {
        entry.insert(PREV_SRC.to_string(), Value::from(was));
    }
    history.push(Value::Object(entry));
    let overflow = history.len().saturating_sub(HISTORY_CAP);
    if overflow > 0 {
        history.drain(0..overflow); // drop the oldest, keep the most recent HISTORY_CAP
    }
    prune_prev_src(&mut history);
    if let Some(obj) = record.as_object_mut() {
        obj.insert(HISTORY.to_string(), Value::from(history));
    }
}

/// Did this history entry's write MOVE the source? True when `srcText` is named in either `changed` or
/// `dropped` — a deletion moves it as surely as an edit does.
fn entry_moved_src_of(entry: &Value, content: &str) -> bool {
    ["changed", "dropped"].iter().any(|k| {
        entry
            .get(*k)
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(content)))
    })
}

/// The record's `srcText` as it stood at revision `rev`, from the retained history — the read behind
/// `bsc ui revert`. `None` when no rung reaches back that far (aged past [`PREV_SRC_CAP`], or the record
/// has no history at all); `Some(current)` is never synthesised, so the caller can tell "already there"
/// from "cannot get there".
///
/// The rung is the FIRST write above `rev` that moved the source — that write is by definition the one
/// that replaced what `rev` held, so its `prevSrc` is the answer. Metadata-only writes in between are
/// read straight through, which is why reverting to a rev whose own write never touched `srcText` still
/// lands on the right bytes.
///
/// It must be the first MOVING write and not merely the first RETAINED one. Taking the first `prevSrc`
/// found returns the wrong revision's source once the true rung has aged out: the search runs on past it
/// and lands on a LATER version, reporting success while handing back bytes the record never held at
/// `rev`. Silently reverting to the wrong version is worse than refusing, so a moving write whose content
/// is gone terminates the search as unreachable.
pub fn src_at_rev(record: &Value, rev: i64) -> Option<String> {
    src_at_rev_of(record, rev, SRC_TEXT)
}

/// [`src_at_rev`] over an explicit content field — `code` for the algorithms graph.
pub fn src_at_rev_of(record: &Value, rev: i64, content: &str) -> Option<String> {
    let history = record.get(HISTORY).and_then(Value::as_array)?;
    let rung = history
        .iter()
        .filter(|e| e.get(REV).and_then(Value::as_i64).is_some_and(|r| r > rev))
        .find(|e| entry_moved_src_of(e, content))?;
    rung.get(PREV_SRC).and_then(Value::as_str).map(str::to_owned)
}

/// The revisions a [`src_at_rev`] revert can still reach, ascending — the retained rungs, so an error can
/// say what IS possible rather than only what is not. Entry at rev N holding a `prevSrc` means rev N-1's
/// source survives, so the reachable anchor is one below each retained entry.
///
/// These are the ANCHORS, not the whole reachable set: a rev between two anchors is reachable too (its
/// source is the anchor's — nothing moved in between), and [`src_at_rev`] accepts it. Listing the anchors
/// keeps the offer to the revisions at which the source actually differs.
/// NO `_of` variant, deliberately: this reads the RUNG key (`prevSrc`), which is the same whichever
/// content field produced it. A parameter here would be decorative, and a decorative parameter reads as
/// a promise that the function respects it.
pub fn revertible_revs(record: &Value) -> Vec<i64> {
    let mut revs: Vec<i64> = record
        .get(HISTORY)
        .and_then(Value::as_array)
        .map(|h| {
            h.iter()
                .filter(|e| e.get(PREV_SRC).is_some())
                .filter_map(|e| e.get(REV).and_then(Value::as_i64))
                .map(|r| r - 1)
                .collect()
        })
        .unwrap_or_default();
    revs.sort_unstable();
    revs.dedup();
    revs
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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/record_source.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-record--<module>.rs
//     bsc graph impl set --id bsc-record--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-record--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-record--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
