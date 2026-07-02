//! The `fleet` noun of `bsc plan` (#1864): streams + per-stream permissions/flows + director/topology.
//! Split out of `cli.rs` as a pure move — [`super::run`] dispatches `fleet` here; the shared plumbing
//! (`Args`/`open_store`/`blob_count`/`unknown_sub`) stays in the parent module. `fleet get` keeps its
//! own match for `get <stream-id>`/`--full`/lean rather than the shared blob-noun read shape.

use super::{blob_count, open_store, unknown_sub, Args};
use bsc_sqlite_util::{print_json, read_stdin_json_one};

/// `fleet` — streams + per-stream permissions/flows + director/topology.
pub(crate) fn cmd_fleet(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `fleet set` reads the whole FleetPlan JSON on stdin (streams + meta) and replaces it.
        "set" => {
            let plan: serde_json::Value = read_stdin_json_one("fleet JSON")?;
            s.fleet_set(&plan).map_err(|e| e.to_string())?;
            if !args.json {
                println!("fleet set ({} streams)", blob_count(&plan, "streams"));
            }
            Ok(())
        }
        "get" | "list" => match s.fleet_get().map_err(|e| e.to_string())? {
            None => {
                println!("{}", if args.json { "null" } else { "(no fleet)" });
                Ok(())
            }
            Some(f) => {
                if let Some(id) = args.positional.get(2) {
                    // `fleet get <stream-id>` → one stream in full (the rest of the fleet stays unread).
                    let stream = f
                        .get("streams")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.iter().find(|st| st.get("id").and_then(|i| i.as_str()) == Some(id.as_str())));
                    match stream {
                        Some(st) => print_json(st, args.pretty),
                        None => return Err(format!("no stream with id '{id}' in the fleet")),
                    }
                } else if args.full {
                    print_json(&f, args.pretty);
                } else {
                    // Lean default: id/name/dependsOn per stream; `--full` for the permissions/flows.
                    print_json(&fleet_lean(&f), args.pretty);
                }
                Ok(())
            }
        },
        "remove" => {
            let id = args.positional.get(2).ok_or("usage: bsc plan fleet remove <stream-id>")?;
            s.fleet_stream_remove(id).map_err(|e| e.to_string())?;
            if !args.json {
                println!("removed {id}");
            }
            Ok(())
        }
        // `fleet stream set <id>` upserts ONE stream's JSON (stdin) — granular per-stream edit, no
        // whole-blob replace. `fleet meta set` upserts just the meta (director/topology/…), leaving
        // every stream row intact.
        "stream" => match args.positional.get(2).map(String::as_str).unwrap_or("") {
            "set" => {
                let id = args.positional.get(3).ok_or("usage: bsc plan fleet stream set <stream-id>")?;
                let v: serde_json::Value = read_stdin_json_one("stream JSON")?;
                s.fleet_stream_set(id, &v).map_err(|e| e.to_string())?;
                if !args.json {
                    println!("stream set {id}");
                }
                Ok(())
            }
            other => Err(unknown_sub(args, "fleet stream", other)),
        },
        "meta" => match args.positional.get(2).map(String::as_str).unwrap_or("") {
            "set" => {
                let v: serde_json::Value = read_stdin_json_one("fleet meta JSON")?;
                s.fleet_meta_set(&v).map_err(|e| e.to_string())?;
                if !args.json {
                    println!("fleet meta set");
                }
                Ok(())
            }
            other => Err(unknown_sub(args, "fleet meta", other)),
        },
        other => Err(unknown_sub(args, "fleet", other)),
    }
}

/// Reduce a full FleetPlan JSON to the lean per-stream view (`id` / `name` / `dependsOn`). The
/// permission/flow/kickoff detail is reached with `fleet get <stream-id>` (one stream) or `--full`.
fn fleet_lean(f: &serde_json::Value) -> serde_json::Value {
    let streams: Vec<serde_json::Value> = f
        .get("streams")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|st| {
                    serde_json::json!({
                        "id": st.get("id").cloned().unwrap_or(serde_json::Value::Null),
                        "name": st.get("name").cloned().unwrap_or(serde_json::Value::Null),
                        "dependsOn": st.get("dependsOn").cloned().unwrap_or_else(|| serde_json::json!([])),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    serde_json::json!({ "streams": streams })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fleet_lean_keeps_only_id_name_depends_on() {
        let full = serde_json::json!({
            "streams": [
                { "id": "auth", "name": "Auth", "dependsOn": ["core"], "permissions": { "git": "write" }, "kickoff": "long..." },
                { "id": "ui", "name": "UI" }
            ],
            "director": { "enabled": true }
        });
        let lean = fleet_lean(&full);
        let streams = lean["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0]["id"], serde_json::json!("auth"));
        assert_eq!(streams[0]["dependsOn"], serde_json::json!(["core"]));
        assert!(streams[0].get("permissions").is_none(), "lean fleet drops the heavy detail");
        assert_eq!(streams[1]["dependsOn"], serde_json::json!([])); // missing → empty
    }
}
