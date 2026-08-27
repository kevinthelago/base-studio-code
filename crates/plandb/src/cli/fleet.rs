//! The `fleet` noun of `bsc plan` (#1864): streams + per-stream permissions/flows + director/topology.
//! Split out of `cli.rs` as a pure move — [`super::run`] dispatches `fleet` here; the shared plumbing
//! (`Args`/`open_store`/`blob_count`/`unknown_sub`) stays in the parent module. `fleet get` keeps its
//! own match for `get <stream-id>`/`--full`/lean rather than the shared blob-noun read shape.

use super::{blob_count, open_store, unknown_sub, Args};
use crate::FleetSession;
use bsc_sqlite_util::{print_json, read_stdin_json_one};

/// `fleet` — streams + per-stream permissions/flows + director/topology.
pub(crate) fn cmd_fleet(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `fleet set` reads the whole FleetPlan JSON on stdin (streams + meta) and replaces it.
        // Validated at set-time (#2395): a blob without a "streams" array (or with id-less /
        // repo-less / duplicate-id streams) is rejected BEFORE the replace, so it can't silently
        // wipe or shrink the fleet. `--force` stores a work-in-progress blob unvalidated.
        "set" => {
            let plan: serde_json::Value = read_stdin_json_one("fleet JSON")?;
            if !args.force {
                crate::validate::validate_fleet_plan(&plan)?;
            }
            s.fleet_set(&plan).map_err(|e| e.to_string())?;
            if !args.json {
                println!("fleet set ({} streams){}", blob_count(&plan, "streams"), crate::validate::fleet_readiness(&plan));
            }
            Ok(())
        }
        // `fleet get --kind cleanup` (#152) filters the streams array to one lifecycle kind — the
        // way a director finds every temporary/cleanup stream across a project without reading each
        // one's free-text name. Validated against `STREAM_KINDS` up front so a typo fails loudly
        // instead of silently matching nothing. Not applied to `fleet get <stream-id>`, which already
        // names exactly one stream.
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
                } else {
                    let f = match &args.kind {
                        Some(k) => filter_fleet_by_kind(&f, k)?,
                        None => f,
                    };
                    if args.full {
                        print_json(&f, args.pretty);
                    } else {
                        // Lean default: id/name/kind/dependsOn per stream; `--full` for the rest.
                        print_json(&fleet_lean(&f), args.pretty);
                    }
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
        // `fleet model <stream-id> <model>` — set (or `--clear`) the model ONE stream launches on.
        //
        // The director's level of a precedence chain that already exists and is documented on
        // `bsc teams model` / `bsc persona model`: a fleet stream's own model > a team placement's >
        // the persona's default > the harness's own default. Both of the other levels got a
        // one-liner; this one did not, so setting it meant reading the whole stream blob, splicing
        // one field, and writing it back — through `fleet stream set`, which VALIDATES, so a
        // director that got the round-trip slightly wrong could reject or reshape its own stream.
        "model" => {
            let id = args
                .positional
                .get(2)
                .ok_or("usage: bsc plan fleet model <stream-id> <model> | --clear")?;
            let mut stream = s
                .fleet_stream_get(id)
                .map_err(|e| e.to_string())?
                // REFUSE an unknown stream rather than upserting one. `fleet_stream_set` would
                // happily create a row holding only `{id, model}` — no repo, no owns — and that is a
                // stream the fleet would try to launch. A typo'd id must fail here, not at launch.
                .ok_or_else(|| format!("no stream with id '{id}' in the fleet"))?;
            let obj = stream
                .as_object_mut()
                .ok_or_else(|| format!("stream '{id}' is not a JSON object"))?;
            if args.clear {
                obj.remove("model");
                s.fleet_stream_set(id, &stream).map_err(|e| e.to_string())?;
                if !args.json {
                    println!("{id}: model cleared — falls back to the persona's default, then the harness's");
                }
                return Ok(());
            }
            let model = args
                .positional
                .get(3)
                .map(String::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .ok_or("usage: bsc plan fleet model <stream-id> <model> | --clear")?;
            obj.insert("model".into(), serde_json::Value::String(model.to_string()));
            s.fleet_stream_set(id, &stream).map_err(|e| e.to_string())?;
            if !args.json {
                println!("{id}: model → {model}");
                // A value that is not a Claude tier is NOT rejected — choosing a local model is the
                // point of this verb. But it is not silently accepted either: on Claude Code an
                // unrecognized model produces no `--model` flag at all, so a typo like `sonet-4.5`
                // degrades to Claude's own default and looks like it worked. Say which it is.
                if !is_claude_tier(model) {
                    println!(
                        "  note: not a Claude tier ({}). A local harness uses it verbatim; \
                         Claude Code does not recognize it and falls back to its own default.",
                        CLAUDE_TIERS.join(" | "),
                    );
                }
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
                if !args.force {
                    crate::validate::validate_fleet_stream(id, &v)?;
                }
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
                if !args.force {
                    crate::validate::validate_fleet_meta(&v)?;
                }
                s.fleet_meta_set(&v).map_err(|e| e.to_string())?;
                if !args.json {
                    println!("fleet meta set");
                }
                Ok(())
            }
            other => Err(unknown_sub(args, "fleet meta", other)),
        },
        // `fleet session …` — the durable launched-agent ledger (#2405). The runtime records each
        // agent it spawns here (a fact), so recovery reads it instead of inferring from disk.
        "session" => match args.positional.get(2).map(String::as_str).unwrap_or("") {
            // `fleet session set` upserts one launched agent (FleetSession JSON on stdin).
            "set" => {
                let sess: FleetSession = read_stdin_json_one("fleet session JSON")?;
                if !args.force {
                    crate::validate::validate_fleet_session(&sess.pane_id)?;
                }
                s.fleet_session_upsert(&sess).map_err(|e| e.to_string())?;
                if !args.json {
                    println!("session set {}", sess.pane_id.trim());
                }
                Ok(())
            }
            "list" => {
                let rows = s.fleet_session_list().map_err(|e| e.to_string())?;
                print_json(&rows, args.pretty);
                Ok(())
            }
            "heartbeat" => {
                let pane = args.positional.get(3).ok_or("usage: bsc plan fleet session heartbeat <pane-id>")?;
                s.fleet_session_heartbeat(pane).map_err(|e| e.to_string())?;
                Ok(())
            }
            "status" => {
                let pane = args.positional.get(3).ok_or("usage: bsc plan fleet session status <pane-id> <status>")?;
                let status = args.positional.get(4).ok_or("usage: bsc plan fleet session status <pane-id> <status>")?;
                s.fleet_session_set_status(pane, status).map_err(|e| e.to_string())?;
                if !args.json {
                    println!("session {} → {status}", pane.trim());
                }
                Ok(())
            }
            "remove" => {
                let pane = args.positional.get(3).ok_or("usage: bsc plan fleet session remove <pane-id>")?;
                s.fleet_session_remove(pane).map_err(|e| e.to_string())?;
                if !args.json {
                    println!("removed session {}", pane.trim());
                }
                Ok(())
            }
            other => Err(unknown_sub(args, "fleet session", other)),
        },
        other => Err(unknown_sub(args, "fleet", other)),
    }
}

/// The model tiers Claude Code recognizes as a `--model` alias. Used ONLY to decide whether to warn
/// (see `fleet model`) — never to reject, because choosing a model Claude does not know is exactly
/// what this verb exists to allow.
///
/// Deliberately a local constant rather than a read of `@data/console/models.json`: plandb is a
/// Tauri-free crate with no access to the app's data dir, and the cost of the two drifting is a
/// slightly wrong hint on one line — not a wrong write. The catalog is the authority for what the UI
/// OFFERS; this is only the authority for what earns a warning.
const CLAUDE_TIERS: [&str; 3] = ["haiku-4.5", "sonnet-4.5", "opus-4.5"];

/// Whether `model` is a tier Claude Code will map to a `--model` alias. Bare tier names
/// (`opus`/`sonnet`/`haiku`) count too — that is what the alias actually is, and a director that
/// types the short form has not made a mistake.
fn is_claude_tier(model: &str) -> bool {
    let m = model.trim();
    CLAUDE_TIERS.contains(&m) || CLAUDE_TIERS.iter().any(|t| t.split('-').next() == Some(m))
}

/// Reduce a full FleetPlan JSON to the lean per-stream view (`id` / `name` / `kind` / `dependsOn`).
/// The permission/flow/kickoff detail is reached with `fleet get <stream-id>` (one stream) or
/// `--full`. `kind` is carried through the DEFAULTED value (#152, [`crate::validate::stream_kind`])
/// rather than the raw field, so a stream with no `kind` set reads as `"feature"` here too — the lean
/// view is where a director scans for lifecycle, and an absent value there would look unset rather
/// than defaulted.
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
                        "kind": crate::validate::stream_kind(st),
                        "dependsOn": st.get("dependsOn").cloned().unwrap_or_else(|| serde_json::json!([])),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    serde_json::json!({ "streams": streams })
}

/// Filter a FleetPlan's `streams` array to those whose (defaulted) [`crate::validate::stream_kind`]
/// matches `kind` (case-insensitive) — the meta fields (director/topology/recommended/…) pass through
/// unchanged. `kind` must be one of [`crate::validate::STREAM_KINDS`]; an unrecognized value is
/// rejected rather than silently matching zero streams, since that would look identical to "no
/// streams of that kind exist yet".
fn filter_fleet_by_kind(f: &serde_json::Value, kind: &str) -> Result<serde_json::Value, String> {
    let kind = kind.trim().to_lowercase();
    if !crate::validate::STREAM_KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "--kind must be one of: {} (got '{kind}')",
            crate::validate::STREAM_KINDS.join(", ")
        ));
    }
    let mut out = f.clone();
    if let Some(obj) = out.as_object_mut() {
        let filtered: Vec<serde_json::Value> = obj
            .get("streams")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter(|st| crate::validate::stream_kind(st) == kind).cloned().collect())
            .unwrap_or_default();
        obj.insert("streams".into(), serde_json::Value::Array(filtered));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp store with one real stream in it, for the `fleet model` round trips below.
    fn store_with_stream(tag: &str) -> (crate::Store, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!("plandb-fleetmodel-{tag}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let s = crate::Store::open(&path).unwrap();
        s.fleet_set(&serde_json::json!({
            "streams": [{ "id": "auth", "name": "Auth", "repo": "own/web", "owns": ["src/auth/**"] }],
            "director": { "enabled": true },
        }))
        .unwrap();
        (s, path)
    }

    #[test]
    fn fleet_model_sets_one_field_and_leaves_the_rest_of_the_stream_alone() {
        // The reason this verb exists: the director's level of the precedence chain was the only one
        // reachable exclusively by rewriting the WHOLE stream blob, which is both awkward and a way
        // to lose a field by omission. Setting the model must touch the model and nothing else.
        let (s, path) = store_with_stream("set");
        let before = s.fleet_stream_get("auth").unwrap().unwrap();

        let mut patched = before.clone();
        patched.as_object_mut().unwrap().insert("model".into(), serde_json::json!("qwen3.5:9b"));
        s.fleet_stream_set("auth", &patched).unwrap();

        let after = s.fleet_stream_get("auth").unwrap().unwrap();
        assert_eq!(after["model"], serde_json::json!("qwen3.5:9b"));
        // Everything the stream already carried survives — repo, owns, name.
        assert_eq!(after["repo"], before["repo"]);
        assert_eq!(after["owns"], before["owns"]);
        assert_eq!(after["name"], before["name"]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn fleet_stream_get_is_none_for_an_unknown_id() {
        // What makes the verb refusable. `fleet_stream_set` UPSERTS, so without this check a typo'd
        // stream id would silently create a row holding only `{id, model}` — no repo, no owns — and
        // that is a stream the fleet would then try to launch. The failure has to land on the typo.
        let (s, path) = store_with_stream("unknown");
        assert!(s.fleet_stream_get("auth").unwrap().is_some(), "the real stream resolves");
        assert!(s.fleet_stream_get("auth-ui").unwrap().is_none(), "a near-miss must not resolve");
        assert!(s.fleet_stream_get("Auth").unwrap().is_none(), "ids are exact, not case-folded");
        assert!(s.fleet_stream_get("").unwrap().is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn clearing_the_model_falls_back_rather_than_pinning_an_empty_string() {
        // `--clear` must REMOVE the key, not set it to "". An empty-string model would read as a
        // deliberate choice all the way down the chain and suppress the persona's default, which is
        // the opposite of what clearing means.
        let (s, path) = store_with_stream("clear");
        let mut v = s.fleet_stream_get("auth").unwrap().unwrap();
        v.as_object_mut().unwrap().insert("model".into(), serde_json::json!("opus-4.5"));
        s.fleet_stream_set("auth", &v).unwrap();
        assert!(s.fleet_stream_get("auth").unwrap().unwrap().get("model").is_some());

        let mut v = s.fleet_stream_get("auth").unwrap().unwrap();
        v.as_object_mut().unwrap().remove("model");
        s.fleet_stream_set("auth", &v).unwrap();
        assert!(
            s.fleet_stream_get("auth").unwrap().unwrap().get("model").is_none(),
            "cleared means ABSENT, so the next level of the chain applies",
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn is_claude_tier_recognizes_the_catalog_and_its_bare_aliases() {
        // Drives only whether the verb WARNS. A false negative prints a note on a valid tier
        // (harmless); a false positive stays silent on a typo, which is the one that costs — an
        // unrecognized model produces no `--model` flag at all, so `sonet-4.5` looks like it worked.
        for t in ["haiku-4.5", "sonnet-4.5", "opus-4.5"] {
            assert!(is_claude_tier(t), "{t} is a catalog tier");
        }
        for t in ["haiku", "sonnet", "opus"] {
            assert!(is_claude_tier(t), "{t} is the bare alias claude itself takes");
        }
        assert!(!is_claude_tier("qwen3.5:9b"), "a local model earns the note");
        assert!(!is_claude_tier("sonet-4.5"), "a TYPO earns the note — this is the case that matters");
        assert!(!is_claude_tier(""), "empty is not a tier");
    }

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

    #[test]
    fn fleet_lean_carries_the_defaulted_kind_per_stream() {
        // #152: the lean view is where a director scans for lifecycle, so an absent "kind" must show
        // up as its default ("feature"), not go missing — a missing field there would look unset
        // rather than defaulted.
        let full = serde_json::json!({
            "streams": [
                { "id": "auth", "repo": "o/r" },
                { "id": "cleanup-orphans", "repo": "o/r", "kind": "cleanup" },
            ]
        });
        let lean = fleet_lean(&full);
        let streams = lean["streams"].as_array().unwrap();
        assert_eq!(streams[0]["kind"], serde_json::json!("feature"));
        assert_eq!(streams[1]["kind"], serde_json::json!("cleanup"));
    }

    #[test]
    fn filter_fleet_by_kind_keeps_meta_and_only_matching_streams() {
        // #152: the concrete case on the request — finding every "cleanup"/"temporary" stream across
        // a fleet without reading each one's free-text name.
        let full = serde_json::json!({
            "recommended": 3,
            "director": { "enabled": true },
            "streams": [
                { "id": "kernel", "repo": "o/r" },                              // defaults to "feature"
                { "id": "mobile-orphan-clearance", "repo": "o/r", "kind": "cleanup" },
                { "id": "ui", "repo": "o/r", "kind": "feature" },
            ]
        });
        let filtered = filter_fleet_by_kind(&full, "cleanup").unwrap();
        let streams = filtered["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0]["id"], serde_json::json!("mobile-orphan-clearance"));
        // meta survives untouched
        assert_eq!(filtered["recommended"], serde_json::json!(3));
        assert_eq!(filtered["director"]["enabled"], serde_json::json!(true));

        // case-insensitive
        let filtered = filter_fleet_by_kind(&full, "CLEANUP").unwrap();
        assert_eq!(filtered["streams"].as_array().unwrap().len(), 1);

        // an unfiltered kind with zero matches returns an empty streams array, not an error
        let filtered = filter_fleet_by_kind(&full, "temporary").unwrap();
        assert!(filtered["streams"].as_array().unwrap().is_empty());

        // an unrecognized kind is rejected — it would otherwise silently match nothing, which is
        // indistinguishable from "no streams of that kind exist"
        let err = filter_fleet_by_kind(&full, "urgent").unwrap_err();
        assert!(err.contains("--kind must be one of"), "{err}");
    }
}
