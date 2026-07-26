//! `bsc plan snapshot --json` (#3842) — EVERY plan.db artifact the planner's poll needs, in ONE
//! process spawn and ONE store open.
//!
//! Why this exists: `usePlanStagePoll` used to issue 17 separate `bsc plan <noun>` reads across 14
//! nouns every 2 seconds. Each was its own process spawn + SQLite open, at 150-660ms apiece — so a
//! single tick cost more than the interval, the Tauri command queue oversubscribed, and `pty_write`
//! (the user's keystrokes) queued behind it. #3666 stopped ticks from STACKING but never reduced the
//! per-tick fan-out, which had since grown from ~13 to ~20.
//!
//! Every key here mirrors EXACTLY the shape its former per-noun `--json` read emitted, so the
//! frontend's per-artifact change-guards, coercers and store setters are unchanged — the only
//! difference is where the JSON comes from. A key whose artifact is unset carries its former
//! "absent" value (`null` for the blob nouns, `[]` for the list nouns), which is precisely the
//! `fetchFallback` each descriptor row already declared.
//!
//! Read-only by construction: no arm writes. Adding an artifact to the poll means adding it here AND
//! to the frontend descriptor table — the parity test in `mod.rs` guards that the key set matches.

use serde_json::{json, Map, Value};

use super::{open_store, print_json, Args};

/// The snapshot's key set — the artifacts the planner poll reads. Exported so the parity test (and a
/// future consumer) can assert against it rather than hard-coding a list twice.
pub const SNAPSHOT_KEYS: [&str; 15] = [
    "issues", "features", "fleet", "deploy", "market", "classify", "transformations",
    "automations", "startup", "repos", "deps", "mcp", "confirm", "skip", "discovery",
];

/// `bsc plan snapshot [--json] [--pretty]` — the batched read. Non-`--json` prints a one-line
/// per-artifact count so a human can eyeball what the planner would see.
pub(crate) fn cmd_snapshot(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    let mut out = Map::new();

    // Issues — the same stream scoping the standalone `plan list --full --json` applies (#3279): a
    // scoped worker session sees only its own stream. The planner is unscoped, so it sees everything.
    let own = crate::scope::env_stream();
    let stream = crate::scope::resolve_read_stream(own.as_deref(), args.stream.as_deref())?;
    let issues = s
        .list_filtered(args.status.as_deref(), stream.as_deref(), args.limit, args.since)
        .map_err(|e| e.to_string())?;
    out.insert("issues".into(), serde_json::to_value(&issues).unwrap_or_else(|_| json!([])));

    // List-shaped artifacts — absent ⇒ `[]`, matching each former read's fallback.
    let features = s.feature_list().map_err(|e| e.to_string())?;
    out.insert("features".into(), serde_json::to_value(&features).unwrap_or_else(|_| json!([])));
    out.insert(
        "transformations".into(),
        Value::Array(s.transformation_list().map_err(|e| e.to_string())?),
    );
    let automations = s.automation_list().map_err(|e| e.to_string())?;
    out.insert("automations".into(), serde_json::to_value(&automations).unwrap_or_else(|_| json!([])));
    let startup = s.startup_list().map_err(|e| e.to_string())?;
    out.insert("startup".into(), serde_json::to_value(&startup).unwrap_or_else(|_| json!([])));
    out.insert("repos".into(), str_array(s.repo_list().map_err(|e| e.to_string())?));
    out.insert("mcp".into(), str_array(s.mcp_list().map_err(|e| e.to_string())?));
    let confirm = s.confirmed_list().map_err(|e| e.to_string())?;
    out.insert("confirm".into(), serde_json::to_value(&confirm).unwrap_or_else(|_| json!([])));
    out.insert("skip".into(), str_array(s.skipped_list().map_err(|e| e.to_string())?));
    out.insert("discovery".into(), str_array(s.discovery_list().map_err(|e| e.to_string())?));

    // Blob-shaped artifacts — absent ⇒ `null`, which is what each `requireTruthy` row expects.
    out.insert("fleet".into(), s.fleet_get().map_err(|e| e.to_string())?.unwrap_or(Value::Null));
    out.insert("deploy".into(), s.deploy_get().map_err(|e| e.to_string())?.unwrap_or(Value::Null));
    out.insert("market".into(), s.market_get().map_err(|e| e.to_string())?.unwrap_or(Value::Null));
    out.insert("classify".into(), s.classify_get().map_err(|e| e.to_string())?.unwrap_or(Value::Null));
    out.insert("deps".into(), s.deps_get().map_err(|e| e.to_string())?.unwrap_or(Value::Null));

    let value = Value::Object(out);
    if args.json {
        print_json(&value, args.pretty);
    } else {
        println!("{}", human_summary(&value));
    }
    Ok(())
}

fn str_array(v: Vec<String>) -> Value {
    Value::Array(v.into_iter().map(Value::String).collect())
}

/// One line per artifact: `issues 12 · features 5 · fleet set · deploy — · …`. A list reports its
/// length, a blob reports set/absent — enough to see at a glance what the planner would read.
fn human_summary(v: &Value) -> String {
    SNAPSHOT_KEYS
        .iter()
        .map(|k| {
            let slot = v.get(*k);
            let shown = match slot {
                Some(Value::Array(a)) => a.len().to_string(),
                Some(Value::Null) | None => "—".to_string(),
                Some(_) => "set".to_string(),
            };
            format!("{k} {shown}")
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_keys_cover_every_artifact_the_planner_poll_reads() {
        // The frontend descriptor table + its three bespoke blocks read exactly these keys. If an
        // artifact is added to the poll it must be added HERE too, or the frontend silently falls back
        // to its empty value forever — the same class of dead-read this batch was written to remove.
        for k in [
            "issues", "features", "fleet", "deploy", "market", "classify", "transformations",
            "automations", "startup", "repos", "deps", "mcp", "confirm", "skip", "discovery",
        ] {
            assert!(SNAPSHOT_KEYS.contains(&k), "snapshot emits {k}");
        }
        assert_eq!(SNAPSHOT_KEYS.len(), 15, "no key added without updating the frontend descriptors");
    }

    #[test]
    fn human_summary_reports_counts_for_lists_and_set_absent_for_blobs() {
        let v = json!({
            "issues": [1, 2, 3], "features": [], "fleet": { "streams": [] }, "deploy": Value::Null,
        });
        let line = human_summary(&v);
        assert!(line.contains("issues 3"), "{line}");
        assert!(line.contains("features 0"), "{line}");
        assert!(line.contains("fleet set"), "{line}");
        assert!(line.contains("deploy —"), "{line}");
        // A key absent from the value reads as absent rather than panicking.
        assert!(line.contains("market —"), "{line}");
    }
}
