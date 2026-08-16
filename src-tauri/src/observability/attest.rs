//! Runtime attestation ingest (#runtime-attests-what-actually-ran) — the app's write path into
//! `runtime.db`.
//!
//! The frontend decides which record served each module; this is where that decision is persisted. The
//! store itself lives in the Tauri-free `bsc-runtime` crate, so `bsc runtime` and `doctor` read through
//! exactly the same code rather than a second implementation of the same query.
//!
//! **One command, batched.** The frontend coalesces in memory and flushes a whole batch, because a page
//! mount links a closure of hundreds of modules and a per-load IPC would be tens of thousands of calls a
//! session to answer a question that needs three numbers.
//!
//! **A failed write is logged and swallowed.** Attestation is an observation: a measurement that can
//! fail the thing it measures is worse than no measurement. The frontend already treats the invoke as
//! best-effort, and returning an error here would only give it something to ignore — so this returns the
//! count it actually folded, which is a fact the caller can log.

/// One attestation row off the wire. Mirrors `AttestRow` in `@/shared/lib/runtime/attest` — snake_case
/// because serde owns this shape and the Rust side owns the schema.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AttestRow {
    pub specifier: String,
    #[serde(default)]
    pub record_id: String,
    #[serde(default)]
    pub src_hash: String,
    pub outcome: String,
    pub session: String,
    #[serde(default)]
    pub n: i64,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub ms_total: f64,
    #[serde(default)]
    pub ms_max: f64,
    #[serde(default)]
    pub at: i64,
}

impl From<&AttestRow> for bsc_runtime::NewAttestation {
    fn from(r: &AttestRow) -> Self {
        bsc_runtime::NewAttestation {
            specifier: r.specifier.clone(),
            record_id: r.record_id.clone(),
            src_hash: r.src_hash.clone(),
            outcome: r.outcome.clone(),
            session: r.session.clone(),
            n: r.n,
            reason: r.reason.clone(),
            ms_total: r.ms_total,
            ms_max: r.ms_max,
            // A row with no timestamp is stamped on ARRIVAL rather than rejected: the frontend clock is
            // the same clock, and a missing `at` should cost precision, not the whole observation.
            at: if r.at > 0 { r.at } else { now_ms() },
        }
    }
}

/// Where `runtime.db` lives — beside the other global stores, and reachable by `bsc runtime` with no
/// argument, which is what lets a session read it without knowing anything about the app.
fn runtime_db_path() -> Option<std::path::PathBuf> {
    bsc_util::bsc_base_dir().map(|d| d.join("runtime.db"))
}

/// Fold a batch of attestations into `runtime.db`; returns how many rows were folded.
///
/// Rejects nothing on content: an unrecognised `outcome` is STORED rather than dropped, so a frontend
/// that grows a new one reports it (visibly, in `bsc runtime summary`) instead of silently writing
/// nothing while looking healthy. The only rejection is a row with no specifier, which cannot be keyed.
#[tauri::command]
pub fn record_attestations(rows: Vec<AttestRow>) -> usize {
    let Some(path) = runtime_db_path() else {
        log::warn!("attest: no base dir — runtime attestations are not being recorded");
        return 0;
    };
    let batch: Vec<bsc_runtime::NewAttestation> = rows
        .iter()
        .filter(|r| !r.specifier.trim().is_empty() && !r.outcome.trim().is_empty())
        .map(Into::into)
        .collect();
    if batch.is_empty() {
        return 0;
    }
    match bsc_runtime::Store::open(&path) {
        Ok(mut store) => match store.fold_batch(&batch) {
            Ok(n) => n,
            Err(e) => {
                log::warn!("attest: folding {} attestation(s) failed: {e}", batch.len());
                0
            }
        },
        Err(e) => {
            log::warn!("attest: opening {} failed: {e}", path.display());
            0
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(specifier: &str, outcome: &str) -> AttestRow {
        AttestRow {
            specifier: specifier.into(),
            record_id: "rec".into(),
            src_hash: "h".into(),
            outcome: outcome.into(),
            session: "s1".into(),
            n: 1,
            reason: None,
            ms_total: 0.0,
            ms_max: 0.0,
            at: 10,
        }
    }

    /// The wire shape is a CONTRACT with `@/shared/lib/runtime/attest`. Deserializing the exact JSON the
    /// frontend sends is what stops a rename on one side becoming a silent no-op on the other — serde
    /// would happily default every missing field and fold rows full of blanks.
    #[test]
    fn the_wire_shape_round_trips_the_frontends_json() {
        let json = r#"{
            "specifier": "@/features/glance/GlanceWorkspace",
            "record_id": "glancepage",
            "src_hash": "8e543092bdc94add",
            "outcome": "served",
            "session": "s-abc",
            "n": 3,
            "reason": null,
            "ms_total": 2100.0,
            "ms_max": 900.0,
            "at": 1755300000000
        }"#;
        let r: AttestRow = serde_json::from_str(json).expect("the frontend's row must deserialize");
        assert_eq!(r.specifier, "@/features/glance/GlanceWorkspace");
        assert_eq!(r.record_id, "glancepage");
        assert_eq!(r.n, 3);
        assert_eq!(r.ms_max, 900.0);
        let n: bsc_runtime::NewAttestation = (&r).into();
        assert_eq!(n.src_hash, "8e543092bdc94add");
        assert_eq!(n.at, 1755300000000);
    }

    /// THE WIRE CONTRACT, against rows CAPTURED from a real `flushAttestations()` rather than typed out
    /// here. A hand-written sample only ever proves that Rust can parse what Rust's author imagined;
    /// this proves it parses what the frontend actually sends — and serde's `#[serde(default)]` on every
    /// optional field means a rename on the TS side would otherwise fold rows full of blanks, forever,
    /// while every gate stayed green.
    #[test]
    fn deserializes_the_captured_frontend_flush() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("data/runtime/attest-wire.fixtures.json");
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("wire fixture")).unwrap();
        let rows: Vec<AttestRow> = serde_json::from_value(doc["rows"].clone()).expect("the captured flush must deserialize");
        assert!(rows.len() >= 3, "the fixture must keep real coverage, got {}", rows.len());

        // The COALESCED row: two observations of one fact arrived as n=2 with summed and maxed timings.
        let served = rows.iter().find(|r| r.record_id == "glancepage").expect("the served row");
        assert_eq!(served.n, 2);
        assert_eq!(served.ms_total, 1600.0);
        assert_eq!(served.ms_max, 900.0);
        assert_eq!(served.src_hash, "8e543092bdc94add");

        // A DECLINE carries its reason and claims no version.
        let declined = rows.iter().find(|r| r.outcome == "declined-closure").expect("the declined row");
        assert!(declined.reason.as_deref().unwrap_or_default().contains("@/definitely/not/registered"));
        assert_eq!(declined.src_hash, "");

        // A FILE-served module carries no record id — and must therefore never join `seen_record_ids`.
        let file_served = rows.iter().find(|r| r.record_id.is_empty()).expect("a file-served row");
        assert_eq!(file_served.outcome, "served");

        // …and the whole batch folds, which is the only thing the command actually does with it.
        let mut store = bsc_runtime::Store::open_in_memory().unwrap();
        let batch: Vec<bsc_runtime::NewAttestation> = rows.iter().map(Into::into).collect();
        assert_eq!(store.fold_batch(&batch).unwrap(), rows.len());
        assert_eq!(store.seen_record_ids().unwrap().len(), 2, "the file-served row contributes no record");
    }

    /// A FILE-served module sends no record id, and every optional field is absent. It must still
    /// deserialize — this is the ordinary shape for anything the graph does not override.
    #[test]
    fn a_minimal_row_deserializes_with_defaults() {
        let r: AttestRow =
            serde_json::from_str(r#"{"specifier":"@/x","outcome":"served","session":"s"}"#).unwrap();
        assert_eq!(r.record_id, "");
        assert_eq!(r.n, 0);
        assert!(r.reason.is_none());
        // …and an absent `at` is stamped on arrival rather than stored as 0, which would sort before
        // every real row and break `--since` for it forever.
        let n: bsc_runtime::NewAttestation = (&r).into();
        assert!(n.at > 0, "a missing timestamp is stamped on arrival");
    }

    #[test]
    fn a_row_without_a_specifier_or_outcome_is_dropped_not_stored() {
        // Both are part of the primary key; a blank one cannot be keyed and would collapse unrelated
        // observations into one meaningless row.
        let batch: Vec<bsc_runtime::NewAttestation> = [row("", "served"), row("@/x", "")]
            .iter()
            .filter(|r| !r.specifier.trim().is_empty() && !r.outcome.trim().is_empty())
            .map(Into::into)
            .collect();
        assert!(batch.is_empty());
    }

    /// An unknown outcome is STORED. A frontend that grows a new one must show up in the summary rather
    /// than writing nothing while appearing healthy — the failure mode this whole feature exists to end.
    #[test]
    fn an_unrecognised_outcome_is_stored_rather_than_dropped() {
        let mut store = bsc_runtime::Store::open_in_memory().unwrap();
        let r = row("@/x", "some-future-outcome");
        store.fold_batch(&[(&r).into()]).unwrap();
        let rows = store.list(&bsc_runtime::Filter::default()).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].outcome, "some-future-outcome");
    }

    /// End to end through a real db: a batch folds, and a second flush of the same facts accumulates
    /// rather than duplicating — the property the whole store rests on.
    #[test]
    fn a_batch_folds_into_a_real_store_and_accumulates() {
        let dir = std::env::temp_dir().join(format!("bsc-attest-cmd-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("runtime.db");
        let _ = std::fs::remove_file(&path);

        let batch = |ms: f64| -> Vec<bsc_runtime::NewAttestation> {
            vec![
                bsc_runtime::NewAttestation { ms_total: ms, ms_max: ms, ..(&row("@/a", "served")).into() },
                (&row("@/b", "linked")).into(),
            ]
        };
        {
            let mut s = bsc_runtime::Store::open(&path).unwrap();
            s.fold_batch(&batch(700.0)).unwrap();
            s.fold_batch(&batch(300.0)).unwrap();
        }
        let s = bsc_runtime::Store::open(&path).unwrap();
        let rows = s.list(&bsc_runtime::Filter::default()).unwrap();
        assert_eq!(rows.len(), 2, "two facts, folded — not four rows");
        let a = rows.iter().find(|r| r.specifier == "@/a").unwrap();
        assert_eq!(a.n, 2);
        assert_eq!(a.ms_total, 1000.0);
        assert_eq!(a.ms_max, 700.0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
