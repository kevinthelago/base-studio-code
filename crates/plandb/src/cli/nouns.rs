//! The remaining plan.db + connector nouns of `bsc plan` (#1864): `feature`/`repo`/`deploy`/`deps`/
//! `mcp`/`blueprint`/`ui`/`discovery`/`integration`/`lesson`. Split out of `cli.rs` as a pure move —
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
            // Readiness echo (#2395): the Features gate needs EVERY feature fully defined (name +
            // behavior + ≥1 acceptance) — mirror that count so the author sees the gap now.
            if !args.json {
                let all = s.feature_list().map_err(|e| e.to_string())?;
                println!("{}", crate::validate::feature_readiness(&all));
            }
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

/// `deploy` — the Deploy stage's structured config (one blob). Validated at set-time (#2395,
/// motivated by #2392's silently-stored `mode:"local"` service with no `localKind`); the echo
/// carries the pane's "N of M deploy-ready" readiness so a partial-but-valid config is visible.
pub(crate) fn cmd_deploy(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "deploy", "deploy JSON", "(no deploy config)",
        crate::validate::validate_deploy_config,
        |s, v| s.deploy_set(v).map_err(|e| e.to_string()),
        |s| s.deploy_get().map_err(|e| e.to_string()),
        |v| format!("deploy set ({} services){}", blob_count(v, "services"), crate::validate::deploy_readiness(v)),
    )
}

/// `deps` — the Deploy stage's locked dependency manifest (one blob). Validated at set-time (#2395)
/// against what the manifest readers keep (name + npm/cargo ecosystem; registries need a url).
pub(crate) fn cmd_deps(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "deps", "dependency manifest JSON", "(no dependency manifest)",
        crate::validate::validate_deps_manifest,
        |s, v| s.deps_set(v).map_err(|e| e.to_string()),
        |s| s.deps_get().map_err(|e| e.to_string()),
        |v| {
            let (deps, regs) = crate::validate::deps_counts(v);
            let gate = if deps == 0 { " — gate blocked: 0 dependencies (the Dependencies gate needs ≥1)" } else { "" };
            format!("deps set ({deps} dependencies, {regs} registries){gate}")
        },
    )
}

/// `market` — the Market stage's scored assessment (one blob, #2430): the structured artifact
/// behind the `marketDefined` gate. Validated at set-time (#2395): all six rubric dimensions scored
/// 1-5 with a rationale + ≥1 fetched source each (citation discipline), plus a go|caution|no-go
/// verdict; the echo mirrors the pane's "N of 6 dimensions scored, cited" readiness.
pub(crate) fn cmd_market(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "market", "market assessment JSON", "(no market assessment)",
        crate::validate::validate_market_config,
        |s, v| s.market_set(v).map_err(|e| e.to_string()),
        |s| s.market_get().map_err(|e| e.to_string()),
        |v| format!("market set{}", crate::validate::market_readiness(v)),
    )
}

/// `classify` — the project classification (one blob, #3783/#3784): the planner's discovery output
/// that shapes the plan (the UI mode + which optional stages the project needs). Validated at
/// set-time; the echo mirrors the chosen uiMode + which optional stages are on.
pub(crate) fn cmd_classify(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "classify", "classification JSON", "(no classification)",
        crate::validate::validate_classify_config,
        |s, v| s.classify_set(v).map_err(|e| e.to_string()),
        |s| s.classify_get().map_err(|e| e.to_string()),
        |v| format!("classify set{}", crate::validate::classify_readiness(v)),
    )
}

/// `transformation` — the Transformations stage's list (#2509): the modification counterpart to
/// features, one JSON-per-row (the `fleet_streams` shape) backing the bottom-up confirm queue.
/// Writes validate at set-time (#2395: verb taxonomy, discovered target, delta, invariants, owns,
/// tier — field-level rejects, batch rejected whole); every write echoes the queue's readiness
/// (`N transformations · M confirmed · tiers 0-K`) so the gate distance is always visible. The
/// `confirm` verb is the PANE's (the user's one action per queue item) — the planner never runs it.
pub(crate) fn cmd_transformation(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `transformation add` — upsert row(s) from stdin JSON (one object or an array). The whole
        // batch validates before ANY row persists, so a bad item can't leave a half-written queue.
        "add" => {
            let v: serde_json::Value = bsc_sqlite_util::read_stdin_json_one("transformation JSON")?;
            let rows: Vec<serde_json::Value> = match &v {
                serde_json::Value::Array(a) => a.clone(),
                other => vec![other.clone()],
            };
            if !args.force {
                crate::validate::validate_transformations(&rows)?;
            }
            let ids = s.transformation_add(&v).map_err(|e| e.to_string())?;
            emit_set_result(args.json, &ids, "");
            transformation_echo(args, &s)
        }
        "list" => {
            let rows = s.transformation_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &rows, "(no transformations)", |_, t| render_transformation_line(t));
            Ok(())
        }
        "get" => {
            let id = args.positional.get(2).ok_or("usage: bsc plan transformation get <id>")?;
            match s.transformation_get(id).map_err(|e| e.to_string())? {
                Some(t) => {
                    print_json(&t, args.pretty);
                    Ok(())
                }
                None => Err(format!("no transformation with id '{id}'")),
            }
        }
        // `transformation update <id>` — replace one row (position kept, so the item re-presents in
        // place in the queue). Never an implicit add: an unknown id is an error.
        "update" => {
            let id = args.positional.get(2).ok_or("usage: bsc plan transformation update <id>  (JSON on stdin)")?;
            let v: serde_json::Value = bsc_sqlite_util::read_stdin_json_one("transformation JSON")?;
            if !args.force {
                crate::validate::validate_transformation_update(id, &v)?;
            }
            if !s.transformation_update(id, &v).map_err(|e| e.to_string())? {
                return Err(format!(
                    "no transformation with id '{id}' — use `bsc plan transformation add` for a new row"
                ));
            }
            if !args.json {
                println!("updated {id} — the item re-presents in the confirm queue");
            }
            transformation_echo(args, &s)
        }
        // `transformation confirm <id>` — the USER's one action per queue item (the pane drives it).
        "confirm" => {
            let id = args.positional.get(2).ok_or("usage: bsc plan transformation confirm <id>")?;
            if !s.transformation_confirm(id).map_err(|e| e.to_string())? {
                return Err(format!("no transformation with id '{id}'"));
            }
            if !args.json {
                println!("confirmed {id}");
            }
            transformation_echo(args, &s)
        }
        "remove" => {
            let id = args.positional.get(2).ok_or("usage: bsc plan transformation remove <id>")?;
            s.transformation_remove(id).map_err(|e| e.to_string())?;
            if !args.json {
                println!("removed {id}");
            }
            Ok(())
        }
        other => Err(unknown_sub(args, "transformation", other)),
    }
}

/// The human-mode readiness echo after any transformation write — the #2395 echo pattern, over the
/// whole stored queue (`N transformations · M confirmed · tiers 0-K`).
fn transformation_echo(args: &Args, s: &crate::Store) -> Result<(), String> {
    if !args.json {
        let all = s.transformation_list().map_err(|e| e.to_string())?;
        println!("{}", crate::validate::transformations_readiness(&all));
    }
    Ok(())
}

/// One queue line: `replace-bespoke-buttons      · replace  tier 0  Replace the bespoke buttons`
/// (· = pending, ✓ = confirmed), emitted in queue (position) order.
fn render_transformation_line(t: &serde_json::Value) -> String {
    let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("?");
    let mark = if t.get("confirmed").and_then(|v| v.as_bool()).unwrap_or(false) { "✓" } else { "·" };
    let verb = t.get("verb").and_then(|v| v.as_str()).unwrap_or("?");
    let tier = t.get("tier").and_then(|v| v.as_i64()).unwrap_or(0);
    let title = t.get("title").and_then(|v| v.as_str()).unwrap_or("");
    format!("{id:<28} {mark} {verb:<8} tier {tier}  {title}")
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

/// `blueprint` — the blueprint an authoring project is designing (one blob). Validated at set-time
/// (#2395): without an id + name the reader silently ignores the WHOLE blob, and a stage entry
/// missing key/name is silently dropped. The echo counts `stages` OR `sections` (both accepted).
pub(crate) fn cmd_blueprint(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "blueprint", "blueprint JSON", "(no blueprint)",
        crate::validate::validate_blueprint,
        |s, v| s.blueprint_set(v).map_err(|e| e.to_string()),
        |s| s.blueprint_get().map_err(|e| e.to_string()),
        |v| {
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("blueprint");
            format!("blueprint set: {name} ({} stages)", crate::validate::blueprint_stage_count(v))
        },
    )
}

/// `ui` — the app's UI pairing: the {kit, theme} the planned application ships on (#2489, one
/// blob). Recorded in the Test UI stage after the theme is chosen with the user; the generated
/// app's palette is EMITTED from it (`bsc ui emit-css --theme <themeId>` → tokens.css + theme.css),
/// resolved by id at emission time — never snapshotted. Validated at set-time (#2395).
pub(crate) fn cmd_ui(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "ui", "ui pairing JSON", "(no ui pairing)",
        crate::validate::validate_ui_pairing,
        |s, v| s.ui_set(v).map_err(|e| e.to_string()),
        |s| s.ui_get().map_err(|e| e.to_string()),
        |v| {
            let (kit, theme) = crate::validate::ui_pairing_echo(v);
            format!("ui pairing set: kit {kit}, theme {theme}")
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
        // `discovery integration set|list|remove` (#4024) — the integrations the user declared during
        // Discovery, as DATA. Nested under `discovery` deliberately: this IS discovery output, and the
        // top-level `bsc plan integration` noun is already taken by the DEPRECATED connector alias
        // (#1721 → `bsc data connector`). Two different things — a connector MANIFEST is how you talk to
        // a system; this is which systems the project needs and why — so they must not share a name.
        "integration" => cmd_discovery_integration(args, &s),
        other => Err(unknown_sub(args, "discovery", other)),
    }
}

/// The `discovery integration` sub-noun. Writes take JSON on stdin (one object or an array), matching
/// every other structured write in this CLI, so declaring an integration completely is ONE call.
fn cmd_discovery_integration(args: &Args, s: &crate::Store) -> Result<(), String> {
    match args.positional.get(2).map(String::as_str).unwrap_or("") {
        "set" => {
            let v: serde_json::Value = bsc_sqlite_util::read_stdin_json_one("integration JSON")?;
            let rows: Vec<serde_json::Value> = match &v {
                serde_json::Value::Array(a) => a.clone(),
                other => vec![other.clone()],
            };
            // Validate the WHOLE batch before anything persists, so a typo in item 3 cannot leave a
            // half-declared set that reads as complete.
            let parsed: Vec<crate::PlanIntegration> = rows
                .iter()
                .map(parse_integration)
                .collect::<Result<_, _>>()?;
            for i in &parsed {
                s.integration_set(i).map_err(|e| e.to_string())?;
            }
            let ids: Vec<String> = parsed.iter().map(|i| i.id.clone()).collect();
            emit_set_result(args.json, &ids, "declared");
            Ok(())
        }
        "list" => {
            let direction = args.direction.as_deref();
            if let Some(d) = direction {
                check_direction(d)?;
            }
            let rows = s.integration_list(direction).map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &rows, "(no integrations declared)", |_, i| {
                let name = if i.name.is_empty() { i.id.clone() } else { format!("{} ({})", i.name, i.id) };
                let purpose = i.purpose.as_deref().unwrap_or("");
                format!("{:<8} {name}{}{purpose}", i.direction, if purpose.is_empty() { "" } else { " — " })
            });
            Ok(())
        }
        "remove" => {
            let id = args
                .positional
                .get(3)
                .ok_or("usage: bsc plan discovery integration remove <id>")?;
            s.integration_remove(id).map_err(|e| e.to_string())?;
            emit_set_result(args.json, &[id], "removed");
            Ok(())
        }
        other => Err(unknown_sub(args, "discovery integration", other)),
    }
}

/// Parse one declared-integration JSON object. `id` is required (it is what both downstream surfaces
/// key off); `direction` must be one of [`crate::DIRECTIONS`] — a typo would file the integration in a
/// bucket nothing reads, which is worse than a loud reject.
fn parse_integration(v: &serde_json::Value) -> Result<crate::PlanIntegration, String> {
    let str_of = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty());
    let id = str_of("id").ok_or("integration JSON needs a non-empty \"id\"")?;
    let direction = str_of("direction").unwrap_or(crate::DEFAULT_DIRECTION);
    check_direction(direction)?;
    Ok(crate::PlanIntegration {
        id: id.to_string(),
        name: str_of("name").unwrap_or_default().to_string(),
        direction: direction.to_string(),
        docs: str_of("docs").map(str::to_string),
        base_url: str_of("baseUrl").or_else(|| str_of("base_url")).map(str::to_string),
        auth: str_of("auth").map(str::to_string),
        purpose: str_of("purpose").map(str::to_string),
    })
}

/// Reject an unknown `direction` by name, listing the two that exist.
fn check_direction(d: &str) -> Result<(), String> {
    if crate::DIRECTIONS.contains(&d) {
        return Ok(());
    }
    Err(format!("unknown direction '{d}' — use one of: {}", crate::DIRECTIONS.join(" | ")))
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

/// `skip` — the durable skipped-stage set (#2267). `add <stage>...` skips optional stage(s),
/// `remove <stage>...` unskips them, and `list` prints the set. A skip is a plain decision (no
/// fingerprint), so this mirrors `discovery` rather than `confirm`.
pub(crate) fn cmd_skip(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        "add" | "remove" => {
            let stages: Vec<&String> = args.positional.iter().skip(2).collect();
            if stages.is_empty() {
                return Err(format!("usage: bsc plan skip {sub} <stage>..."));
            }
            let skipping = sub == "add";
            for st in &stages {
                if skipping {
                    s.skip_stage(st).map_err(|e| e.to_string())?;
                } else {
                    s.unskip_stage(st).map_err(|e| e.to_string())?;
                }
            }
            emit_set_result(args.json, &stages, if skipping { "skipped" } else { "unskipped" });
            Ok(())
        }
        "list" => {
            let skipped = s.skipped_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &skipped, "(no skipped stages)", |_, t| t.clone());
            Ok(())
        }
        other => Err(unknown_sub(args, "skip", other)),
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
/// Validates the WHOLE batch before writing anything (#2395), so a bad item can't leave a
/// half-written roster behind.
fn cmd_feature_add(s: &crate::Store) -> Result<Vec<String>, String> {
    let feats: Vec<PlanFeature> = bsc_sqlite_util::read_stdin_json("feature")?;
    for (i, f) in feats.iter().enumerate() {
        if f.slug.trim().is_empty() && f.name.trim().is_empty() {
            return Err(format!(
                "feature add: features[{i}] needs a \"slug\" or a \"name\" — rejected; nothing was written"
            ));
        }
    }
    let mut slugs = Vec::new();
    for f in &feats {
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

/// `bsc plan request …` (#4000) — the worker→director change-request lane.
///
/// Note which verbs exist and which do not. There is no `remove`: a request is a contract between two
/// agents, and letting the requester delete it would let a worker withdraw an ask the director is
/// already acting on. Closure is `resolve`, which keeps the row and the answer.
pub(crate) fn cmd_request(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        // `request new "<text>" [--command <cmd>] [--from <stream>]` — file an ask; prints the id.
        // `--command` is the grounding: the exact command that failed.
        "new" | "add" => {
            let text = args.positional.get(2).cloned().unwrap_or_default();
            // Attribution defaults to the filing session's own stream (`$BSC_STREAM`, #3279) so the
            // director knows WHO asked without the agent having to remember to say. Same env-trust
            // model as the rest of the runtime CLI: it prevents the ask arriving anonymous, and is not
            // a defense against an agent that passes a different `--from`.
            let env_stream = crate::scope::env_stream();
            let from = args.from.as_deref().or(env_stream.as_deref()).unwrap_or("");
            let id = s
                .request_new(&text, args.command.as_deref().unwrap_or(""), from)
                .map_err(|e| e.to_string())?;
            // Announce it (#4001). The pump re-derives its pending set from the LOG, so a request
            // that is stored but not announced is invisible to the director forever.
            crate::coord::emit(crate::coord::KIND_REQUEST, &id.to_string(), &text);
            println!("{}", if args.json { serde_json::to_string(&id).unwrap_or_default() } else { id.to_string() });
            Ok(())
        }
        // `request list [--status open|claimed|resolved]` — the queue, oldest first (JSON).
        "list" => {
            let items = s.request_list(args.status.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
            print_json(&serde_json::to_value(&items).unwrap_or_default(), args.pretty);
            Ok(())
        }
        "show" | "get" => {
            let id = request_id(args, "show")?;
            let got = s.request_get(id).map_err(|e| e.to_string())?;
            match got {
                Some(r) => {
                    print_json(&serde_json::to_value(&r).unwrap_or_default(), args.pretty);
                    Ok(())
                }
                None => Err(format!("no request with id '{id}'")),
            }
        }
        // Claiming is exclusive, so a non-move is reported as an error rather than a silent success —
        // otherwise two directors would both believe they hold the same ask.
        "claim" => {
            let id = request_id(args, "claim")?;
            if !s.request_claim(id).map_err(|e| e.to_string())? {
                return Err(format!("request {id} is not open (already claimed or resolved)"));
            }
            if !args.json {
                println!("{id} claimed");
            }
            Ok(())
        }
        // `request resolve <id> --note "<what was done>"` — the note is the answer the requester reads.
        "resolve" => {
            let id = request_id(args, "resolve")?;
            let note = args.note.clone().or_else(|| args.positional.get(3).cloned()).unwrap_or_default();
            if !s.request_resolve(id, &note).map_err(|e| e.to_string())? {
                return Err(format!("request {id} is already resolved"));
            }
            // Both ENDS must be announced: the pump decides "still pending" from the log, so without
            // this a resolved request would be re-surfaced to the director on every tick.
            crate::coord::emit(crate::coord::KIND_REQUEST_RESOLVED, &id.to_string(), &note);
            if !args.json {
                println!("{id} resolved");
            }
            Ok(())
        }
        other => Err(unknown_sub(args, "request", other)),
    }
}

/// The `<id>` positional shared by the by-id request verbs, parsed with a usage-shaped error.
fn request_id(args: &Args, verb: &str) -> Result<i64, String> {
    args.positional
        .get(2)
        .ok_or_else(|| format!("usage: bsc plan request {verb} <id>"))?
        .parse::<i64>()
        .map_err(|_| format!("request id must be a number (usage: bsc plan request {verb} <id>)"))
}

#[cfg(test)]
mod tests {
    use super::{check_direction, parse_integration};

    /// #4024: `id` is what BOTH downstream surfaces key off — a row without one is unreachable, so it
    /// must be a loud reject rather than a stored blank.
    #[test]
    fn an_integration_without_an_id_is_rejected() {
        for bad in [serde_json::json!({}), serde_json::json!({ "id": "" }), serde_json::json!({ "id": "   " })] {
            assert!(parse_integration(&bad).is_err(), "{bad} must be rejected");
        }
    }

    /// A mistyped direction would file the integration in a bucket nothing reads — invisible to both
    /// the Source pane and the Integrator. Reject it, and name the two that exist.
    #[test]
    fn an_unknown_direction_is_rejected_and_lists_the_valid_ones() {
        let err = parse_integration(&serde_json::json!({ "id": "x", "direction": "inbound" })).unwrap_err();
        assert!(err.contains("inbound"), "the error quotes what was given: {err}");
        assert!(err.contains("source") && err.contains("runtime"), "and lists both valid values: {err}");
        assert!(check_direction("source").is_ok() && check_direction("runtime").is_ok());
    }

    #[test]
    fn an_omitted_direction_defaults_to_runtime() {
        let i = parse_integration(&serde_json::json!({ "id": "stripe" })).unwrap();
        assert_eq!(i.direction, crate::DEFAULT_DIRECTION);
        assert_eq!(i.direction, "runtime");
    }

    /// The base URL arrives as `baseUrl` from an agent writing JSON, but `base_url` is the field name
    /// in the store and in every Rust struct around it. Accept both rather than silently dropping the
    /// value — a dropped base URL means `bsc data connector probe` has nothing to start from.
    #[test]
    fn accepts_both_camel_and_snake_base_url() {
        let camel = parse_integration(&serde_json::json!({ "id": "a", "baseUrl": "https://x" })).unwrap();
        let snake = parse_integration(&serde_json::json!({ "id": "b", "base_url": "https://x" })).unwrap();
        assert_eq!(camel.base_url.as_deref(), Some("https://x"));
        assert_eq!(snake.base_url.as_deref(), Some("https://x"));
    }

    #[test]
    fn parses_a_full_declaration_and_trims_every_field() {
        let i = parse_integration(&serde_json::json!({
            "id": "  salesforce  ", "name": " Salesforce ", "direction": "source",
            "docs": " https://developer.salesforce.com ", "auth": " OAuth2 ", "purpose": " migrate accounts ",
        }))
        .unwrap();
        assert_eq!((i.id.as_str(), i.name.as_str(), i.direction.as_str()), ("salesforce", "Salesforce", "source"));
        assert_eq!(i.docs.as_deref(), Some("https://developer.salesforce.com"));
        assert_eq!(i.purpose.as_deref(), Some("migrate accounts"));
    }

    /// An empty string must read as ABSENT, not as a stored blank — `""` for `docs` would send the
    /// Integrator to a documentation URL that does not exist.
    #[test]
    fn blank_optional_fields_are_absent_not_empty() {
        let i = parse_integration(&serde_json::json!({ "id": "a", "docs": "  ", "purpose": "" })).unwrap();
        assert_eq!(i.docs, None);
        assert_eq!(i.purpose, None);
    }
}
