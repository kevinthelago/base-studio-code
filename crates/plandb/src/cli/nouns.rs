//! The remaining plan.db + connector nouns of `bsc plan` (#1864): `feature`/`repo`/`deploy`/`deps`/
//! `mcp`/`blueprint`/`discovery`/`integration`/`lesson`. Split out of `cli.rs` as a pure move —
//! [`super::run`] dispatches each here; the shared plumbing (`Args`/`open_store`/`emit_*`/
//! `cmd_blob_noun`/`blob_count`/`unknown_sub`) stays in the parent module. Output is byte-for-byte
//! what `cli.rs` emitted before the split.

use super::{blob_count, cmd_blob_noun, emit_json_or_lines, emit_set_result, open_store, unknown_sub, Args};
use crate::{Lesson, PlanFeature};
use bsc_sqlite_util::print_json;
use std::io::Read;

/// `feature` — the features roster (titles-first) + the detail-fill path.
pub(crate) fn cmd_feature(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `feature add <name>...` registers titles (the roster); with no names it reads a feature
        // object/array on stdin (the detail-fill path, merged by slug).
        "add" => {
            let names: Vec<&String> = args.positional.iter().skip(2).collect();
            let slugs = if names.is_empty() {
                cmd_feature_add(&s)?
            } else {
                names
                    .iter()
                    .map(|n| s.feature_upsert(&PlanFeature { name: (*n).clone(), ..Default::default() }))
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|e| e.to_string())?
            };
            emit_set_result(args.json, &slugs, "");
            Ok(())
        }
        "list" => {
            let feats = s.feature_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &feats, "(no features)", |_, f| render_feature_line(f));
            Ok(())
        }
        "get" => {
            let slug = args.positional.get(2).ok_or("usage: bsc plan feature get <slug>")?;
            match s.feature_get(slug).map_err(|e| e.to_string())? {
                Some(f) if args.json => print_json(&serde_json::to_value(&f).unwrap_or_default(), args.pretty),
                Some(f) => print!("{}", render_feature(&f)),
                None => return Err(format!("no feature with slug '{slug}'")),
            }
            Ok(())
        }
        "remove" => {
            let slug = args.positional.get(2).ok_or("usage: bsc plan feature remove <slug>")?;
            s.feature_remove(slug).map_err(|e| e.to_string())?;
            if !args.json {
                println!("removed {slug}");
            }
            Ok(())
        }
        other => Err(unknown_sub(args, "feature", other)),
    }
}

/// `repo` — repos linked to the project (durable in plan.db).
/// `triage` — per-repo triage-run markers (#1004) + the since-marker issue delta. Backs the UI's
/// triage flow through the bridge (#2114/#2124): the same actions the app's `plan_triage_*` /
/// `plan_issues_changed_since` Tauri commands drove, now reachable from the one `bsc` surface.
pub(crate) fn cmd_triage(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `triage record <owner/repo>` — mark a triage launch at now; prints the recorded epoch-seconds.
        "record" => {
            let repo = args.positional.get(2).ok_or("usage: bsc plan triage record <owner/repo>")?;
            let t = s.triage_record_run(repo).map_err(|e| e.to_string())?;
            print_json(&serde_json::json!(t), args.pretty);
            Ok(())
        }
        // `triage last <owner/repo>` — the last triage-launch timestamp (epoch seconds), or null.
        "last" => {
            let repo = args.positional.get(2).ok_or("usage: bsc plan triage last <owner/repo>")?;
            let t = s.triage_last_run(repo).map_err(|e| e.to_string())?;
            print_json(&serde_json::json!(t), args.pretty);
            Ok(())
        }
        // `triage changed <owner/repo> --since <epoch>` — the JSON array of issues whose status
        // changed since <epoch>, scoped to <repo> (empty repo = the whole project). The triage
        // resume-delta, same shape `plan_issues_changed_since` returned.
        "changed" => {
            let repo = args.positional.get(2).ok_or("usage: bsc plan triage changed <owner/repo> --since <epoch>")?;
            let since = args.since.ok_or("triage changed needs --since <epoch-seconds>")?;
            let issues = s.issues_changed_since(repo, since).map_err(|e| e.to_string())?;
            print_json(&serde_json::to_value(&issues).unwrap_or_default(), args.pretty);
            Ok(())
        }
        other => Err(unknown_sub(args, "triage", other)),
    }
}

pub(crate) fn cmd_repo(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `repo add <owner/repo>...` links repo(s) to the project.
        "add" => {
            let names: Vec<&String> = args.positional.iter().skip(2).collect();
            if names.is_empty() {
                return Err("usage: bsc plan repo add <owner/repo>...".into());
            }
            for n in &names {
                s.repo_add(n).map_err(|e| e.to_string())?;
            }
            emit_set_result(args.json, &names, "linked");
            Ok(())
        }
        "list" => {
            let repos = s.repo_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &repos, "(no linked repos)", |_, r| r.clone());
            Ok(())
        }
        "remove" => {
            let name = args.positional.get(2).ok_or("usage: bsc plan repo remove <owner/repo>")?;
            s.repo_remove(name).map_err(|e| e.to_string())?;
            if !args.json {
                println!("unlinked {name}");
            }
            Ok(())
        }
        other => Err(unknown_sub(args, "repo", other)),
    }
}

/// `deploy` — the Deploy stage's structured config (one blob).
pub(crate) fn cmd_deploy(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "deploy", "deploy JSON", "(no deploy config)",
        |s, v| s.deploy_set(v).map_err(|e| e.to_string()),
        |s| s.deploy_get().map_err(|e| e.to_string()),
        |v| format!("deploy set ({} services)", blob_count(v, "services")),
    )
}

/// `deps` — the Deploy stage's locked dependency manifest (one blob).
pub(crate) fn cmd_deps(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "deps", "dependency manifest JSON", "(no dependency manifest)",
        |s, v| s.deps_set(v).map_err(|e| e.to_string()),
        |s| s.deps_get().map_err(|e| e.to_string()),
        |v| format!("deps set ({} dependencies)", blob_count(v, "dependencies")),
    )
}

/// `mcp` — catalog MCP servers scoped to the project (durable in plan.db).
pub(crate) fn cmd_mcp(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `mcp add <name>...` assigns catalog MCP server(s) to the project.
        "add" => {
            let names: Vec<&String> = args.positional.iter().skip(2).collect();
            if names.is_empty() {
                return Err("usage: bsc plan mcp add <name>...".into());
            }
            for n in &names {
                s.mcp_add(n).map_err(|e| e.to_string())?;
            }
            emit_set_result(args.json, &names, "assigned");
            Ok(())
        }
        "list" => {
            let mcps = s.mcp_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &mcps, "(no assigned MCP servers)", |_, m| m.clone());
            Ok(())
        }
        "remove" => {
            let name = args.positional.get(2).ok_or("usage: bsc plan mcp remove <name>")?;
            s.mcp_remove(name).map_err(|e| e.to_string())?;
            if !args.json {
                println!("unassigned {name}");
            }
            Ok(())
        }
        other => Err(unknown_sub(args, "mcp", other)),
    }
}

/// `blueprint` — the blueprint an authoring project is designing (one blob).
pub(crate) fn cmd_blueprint(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "blueprint", "blueprint JSON", "(no blueprint)",
        |s, v| s.blueprint_set(v).map_err(|e| e.to_string()),
        |s| s.blueprint_get().map_err(|e| e.to_string()),
        |v| {
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("blueprint");
            format!("blueprint set: {name} ({} sections)", blob_count(v, "sections"))
        },
    )
}

/// `discovery` — the Discovery stage's DYNAMIC required-set (prose lives in discovery/<topic>.md).
pub(crate) fn cmd_discovery(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `discovery require/unrequire <topic>...` shape the DYNAMIC required set as the project
        // clarifies. Discovery files gate on GENERATION (the gate checks each required
        // `discovery/<topic>.md` exists) — they are not confirmed (#1028).
        "require" | "unrequire" => {
            let topics: Vec<&String> = args.positional.iter().skip(2).collect();
            if topics.is_empty() {
                return Err(format!("usage: bsc plan discovery {sub} <topic>..."));
            }
            let required = sub == "require";
            for t in &topics {
                s.discovery_require(t, required).map_err(|e| e.to_string())?;
            }
            emit_set_result(args.json, &topics, if required { "required" } else { "unrequired" });
            Ok(())
        }
        "list" => {
            let required = s.discovery_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &required, "(no required discovery topics)", |_, t| t.clone());
            Ok(())
        }
        other => Err(unknown_sub(args, "discovery", other)),
    }
}

/// `confirm` — the durable stage-confirmation set (#2256). `add <stage> [<fingerprint>]` confirms a
/// stage (recording the content fingerprint the app compares for the per-stage reset), `remove
/// <stage>` unconfirms it, and `list` prints the `{stage, fingerprint}` rows (JSON with `--json`).
pub(crate) fn cmd_confirm(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        "add" => {
            let stage = args.positional.get(2).map(String::as_str).unwrap_or("");
            if stage.is_empty() {
                return Err("usage: bsc plan confirm add <stage> [<fingerprint>]".into());
            }
            let fingerprint = args.positional.get(3).map(String::as_str).unwrap_or("");
            s.confirm_stage(stage, fingerprint).map_err(|e| e.to_string())?;
            if !args.json {
                println!("confirmed {stage}");
            }
            Ok(())
        }
        "remove" => {
            let stage = args.positional.get(2).map(String::as_str).unwrap_or("");
            if stage.is_empty() {
                return Err("usage: bsc plan confirm remove <stage>".into());
            }
            s.unconfirm_stage(stage).map_err(|e| e.to_string())?;
            if !args.json {
                println!("unconfirmed {stage}");
            }
            Ok(())
        }
        "list" => {
            let confirmed = s.confirmed_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &confirmed, "(no confirmed stages)", |_, c| {
                format!("{}\t{}", c.stage, c.fingerprint)
            });
            Ok(())
        }
        other => Err(unknown_sub(args, "confirm", other)),
    }
}

/// `integration` — runtime (planner-authored) REST connector presets (#1235). These live in the
/// connectors store (~/.base-studio-code/connectors.json) — NOT plan.db — so an authored integration
/// is a native, app-wide connector like the built-ins. The spec is validated + secret-free on add
/// (credentials go to the keychain, #1194).
///
/// **Deprecated (#1721):** the connectors store is DATA-platform state; its CLI access moved to
/// `bsc data connector`. This verb still works (delegating to the same `bsc_data::*` functions) so
/// nothing breaks mid-transition, but it prints a one-line deprecation note to stderr.
pub(crate) fn cmd_integration(args: &Args) -> Result<(), String> {
    eprintln!("`bsc plan integration` is deprecated; use `bsc data connector`");
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let path = bsc_data::runtime_store_path();
    match sub {
        // `integration add` reads a RuntimePreset JSON on stdin, validates, upserts by id.
        "add" => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
            let preset: bsc_data::RuntimePreset = serde_json::from_str(buf.trim())
                .map_err(|e| format!("parsing integration JSON: {e}"))?;
            let id = preset.id.clone();
            bsc_data::upsert_runtime_preset(&path, preset)?;
            if args.json {
                println!("{}", serde_json::to_string(&id).unwrap_or_default());
            } else {
                println!("integration added: {id}");
            }
            Ok(())
        }
        "list" => {
            let presets = bsc_data::load_runtime_presets(&path).map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &presets, "(no runtime integrations)", |_, p| {
                format!("{}  {} [{}] — {} resource(s)", p.id, p.label, p.auth, p.resources.len())
            });
            Ok(())
        }
        "get" => {
            let id = args.positional.get(2).ok_or("usage: bsc plan integration get <id>")?;
            match bsc_data::find_runtime_preset(&path, id).map_err(|e| e.to_string())? {
                Some(p) => print_json(&serde_json::to_value(&p).unwrap_or_default(), args.pretty),
                None if args.json => println!("null"),
                None => println!("(no integration '{id}')"),
            }
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(2).ok_or("usage: bsc plan integration remove <id>")?;
            let removed = bsc_data::remove_runtime_preset(&path, id).map_err(|e| e.to_string())?;
            if !args.json {
                println!("{}", if removed { format!("removed {id}") } else { format!("(no integration '{id}')") });
            }
            Ok(())
        }
        other => Err(unknown_sub(args, "integration", other)),
    }
}

/// `lesson` — self-correction candidates (#1362): the `bsc-learned` capture helper + the review queue.
pub(crate) fn cmd_lesson(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `lesson add "<mistake>" --rule "<rule>" [--cause …] [--from <provenance>]` — capture a
        // candidate (idempotent on its mistake|rule dedup key); prints the lesson id.
        "add" => {
            let mistake = args.positional.get(2).cloned().unwrap_or_default();
            let lesson = Lesson {
                mistake,
                rule: args.rule.clone().unwrap_or_default(),
                cause: args.cause.clone().unwrap_or_default(),
                provenance: args.from.clone().unwrap_or_default(),
                ..Default::default()
            };
            let id = s.lesson_add(&lesson).map_err(|e| e.to_string())?;
            println!("{}", if args.json { serde_json::to_string(&id).unwrap_or_default() } else { id });
            Ok(())
        }
        // `lesson list [--status pending|confirmed|discarded]` — JSON array (the review queue).
        "list" => {
            let lessons = s.lesson_list(args.status.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
            print_json(&serde_json::to_value(&lessons).unwrap_or_default(), args.pretty);
            Ok(())
        }
        "confirm" | "discard" => {
            let id = args.positional.get(2).ok_or(format!("usage: bsc plan lesson {sub} <id>"))?;
            let status = if sub == "confirm" { "confirmed" } else { "discarded" };
            let n = s.lesson_set_status(id, status).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("no lesson with id '{id}'"));
            }
            if !args.json {
                println!("{id} {status}");
            }
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(2).ok_or("usage: bsc plan lesson remove <id>")?;
            s.lesson_remove(id).map_err(|e| e.to_string())?;
            if !args.json {
                println!("removed {id}");
            }
            Ok(())
        }
        other => Err(unknown_sub(args, "lesson", other)),
    }
}

/// Read JSON from stdin (one feature object or an array) and merge-upsert each; return the slugs.
/// Used for the detail-fill phase (`{"slug":"…","behavior":…}`) — title rows are added by name.
fn cmd_feature_add(s: &crate::Store) -> Result<Vec<String>, String> {
    let feats: Vec<PlanFeature> = bsc_sqlite_util::read_stdin_json("feature")?;
    let mut slugs = Vec::new();
    for f in &feats {
        if f.slug.trim().is_empty() && f.name.trim().is_empty() {
            return Err("feature add: each feature needs a \"slug\" or a \"name\"".into());
        }
        slugs.push(s.feature_upsert(f).map_err(|e| e.to_string())?);
    }
    Ok(slugs)
}

/// A one-line feature entry: `invite-teammates  ✓ Invite teammates   (auth)` — ✓ = fully defined.
fn render_feature_line(f: &PlanFeature) -> String {
    let defined = !f.name.is_empty() && f.behavior.as_deref().map(|b| !b.trim().is_empty()).unwrap_or(false) && !f.acceptance.is_empty();
    let mark = if defined { "✓" } else { "·" };
    let stream = f.stream.as_deref().map(|s| format!("   ({s})")).unwrap_or_default();
    format!("{:<24} {} {}{}", f.slug, mark, f.name, stream)
}

/// The full human-readable spec of one feature (for `feature get`).
fn render_feature(f: &PlanFeature) -> String {
    let mut out = format!("{}  {}\n", f.slug, f.name);
    if let Some(s) = &f.stream {
        out.push_str(&format!("  stream: {s}\n"));
    }
    if let Some(b) = &f.behavior {
        out.push_str(&format!("  behavior: {b}\n"));
    }
    if let Some(a) = &f.approach {
        out.push_str(&format!("  approach: {a}\n"));
    }
    if let Some(d) = &f.data {
        out.push_str(&format!("  data: {d}\n"));
    }
    if !f.depends_on.is_empty() {
        out.push_str(&format!("  depends on: {}\n", f.depends_on.join(", ")));
    }
    if !f.tools.is_empty() {
        out.push_str(&format!("  tools: {}\n", f.tools.join(", ")));
    }
    if !f.acceptance.is_empty() {
        out.push_str("  acceptance:\n");
        for a in &f.acceptance {
            out.push_str(&format!("    - {a}\n"));
        }
    }
    out
}
