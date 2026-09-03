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
        // `repo add <name>...` links repo(s) to the project. The name is stored VERBATIM and is not
        // required to be `owner/repo`: a project that ships nowhere links a bare local name, which
        // `bsc fleet clone` materializes with `git init` instead of fetching from github.com.
        "add" => {
            let names: Vec<&String> = args.positional.iter().skip(2).collect();
            if names.is_empty() {
                return Err("usage: bsc plan repo add <name>...  (owner/repo for a GitHub project, a bare name for a local one)".into());
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

/// `classify` — the project classification (one blob, #3783/#3784/#4115): the planner's discovery
/// output that shapes the plan (who renders the UI, where its algorithms come from, the UI mode, the
/// taxonomy axes, and which optional stages the project needs). Validated at set-time; the echo
/// mirrors the recorded uiSystem + algorithmSystem + uiMode + which optional stages are on.
/// `requirement` — the architect's handoff (#requirement-and-authority-store): the user's
/// statement, the discovery it ran, and the AUTHORITY clauses the tiers below cite when they decide
/// something unattended. One blob per project, read whole by the director.
pub(crate) fn cmd_requirement(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "requirement", "requirement JSON", "(no requirement)",
        crate::validate::validate_requirement,
        |s, v| s.requirement_set(v).map_err(|e| e.to_string()),
        |s| s.requirement_get().map_err(|e| e.to_string()),
        |v| {
            let n = v.get("authority").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
            format!("requirement set ({n} authority clause{})", if n == 1 { "" } else { "s" })
        },
    )
}

pub(crate) fn cmd_classify(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "classify", "classification JSON", "(no classification)",
        |v| {
            crate::validate::validate_classify_config(v)?;
            verify_classify_model(v)
        },
        |s, v| s.classify_set(v).map_err(|e| e.to_string()),
        |s| s.classify_get().map_err(|e| e.to_string()),
        |v| format!("classify set{}", crate::validate::classify_readiness(v)),
    )
}

/// The classification's `model` axis, checked against what can actually be launched
/// (`discovery-chooses-the-model`).
///
/// THE SAME ONE RULE every other level of the precedence chain applies — `llm::cli::verify_model`,
/// shared with `bsc persona model` and `bsc teams model` so a name one level accepts is a name the
/// others do. A Claude tier short-circuits before any probe, so a machine with no local runtime can
/// still classify a project onto one.
///
/// WHY IT IS NOT IN `validate_classify_config`. That function is pure and every one of its tests is a
/// `json!` literal; deciding whether a model name is real requires asking the local runtime, and
/// probing from there would put a network call inside a validator and inside every test that reaches
/// it. The shape check stays there, the existence check lives here — the same split
/// `bsc persona model` and `bsc teams model` already make between argument parsing and the probe.
///
/// An UNREACHABLE runtime is NOT a refusal, for the reason it is not one anywhere else: ollama being
/// down is a normal state, and refusing to record a discovery decision because a daemon is asleep
/// would block the conversation this axis exists to capture. The warning goes to stderr so a `--json`
/// payload stays clean.
fn verify_classify_model(v: &serde_json::Value) -> Result<(), String> {
    let Some(model) = v.get("model").and_then(|m| m.as_str()).map(str::trim).filter(|m| !m.is_empty())
    else {
        return Ok(());
    };
    match llm::cli::verify_model(model, None) {
        llm::cli::ModelVerdict::Tier | llm::cli::ModelVerdict::Installed => Ok(()),
        llm::cli::ModelVerdict::Unknown(installed) => {
            let have = if installed.is_empty() {
                "the local runtime has no models installed".to_string()
            } else {
                format!("installed locally: {}", installed.join(" | "))
            };
            Err(format!(
                "bsc plan classify: \"model\": '{model}' is neither a Claude tier nor a model this machine has.\n  \
                 tiers: {}\n  {have}\n  \
                 (omit \"model\" entirely to let each session fall through to its persona's default)",
                bsc_util::model_id_list()
            ))
        }
        llm::cli::ModelVerdict::Unverifiable(why) => {
            eprintln!(
                "bsc plan classify: stored, but could not verify '{model}' against the local runtime ({why}).\n                   If that name is wrong the fleet will fail at launch — check with `bsc llm status`."
            );
            Ok(())
        }
    }
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
/// `decision` — the DECISION LEDGER (#funnel-unattended-director). Every choice the director made
/// under granted authority, recorded against the clause that permitted it.
///
///   bsc plan decision add "<what was decided>" --clause <id> [--stage features|plan] [--why "<why>"]
///   bsc plan decision list [--stage <stage>] [--json]
///
/// APPEND-ONLY on purpose: there is no edit and no remove. A decision that turned out wrong is
/// answered by a LATER decision, never by rewriting the record of what was actually done. The clause
/// is validated against the stored requirement, so a citation is checkable rather than decorative —
/// an unknown id (or no requirement at all) is REFUSED and nothing is written.
pub(crate) fn cmd_decision(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(&args.db)?;
    match sub {
        "add" => {
            let what = args.positional.get(2).cloned().unwrap_or_default();
            let d = plandb_decision(args, what);
            let id = s.decision_add(&d).map_err(|e| e.to_string())?;
            println!("{}", if args.json { serde_json::to_string(&id).unwrap_or_default() } else { id });
            Ok(())
        }
        "list" => {
            let rows = s.decision_list(args.stage.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
            print_json(&serde_json::to_value(&rows).unwrap_or_default(), args.pretty);
            Ok(())
        }
        // The GRANTED clauses, so a session can see what it may decide before it decides it.
        "authority" => {
            let ids = s.authority_clause_ids().map_err(|e| e.to_string())?;
            print_json(&serde_json::to_value(&ids).unwrap_or_default(), args.pretty);
            Ok(())
        }
        _ => Err(format!(
            "usage: {} decision add \"<what>\" --clause <id> [--stage <stage>] [--why \"<why>\"] | decision list [--stage <s>] | decision authority",
            args.prog
        )),
    }
}

fn plandb_decision(args: &Args, what: String) -> crate::Decision {
    crate::Decision {
        stage: args.stage.clone().unwrap_or_default(),
        decision: what,
        clause: args.clause.clone().unwrap_or_default(),
        rationale: args.why.clone().unwrap_or_default(),
        ..Default::default()
    }
}

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

/// A one-line feature entry: `invite-teammates  ✓ Invite teammates   (auth)` — ✓ = fully defined,
/// which since #requires-names-components INCLUDES a non-empty `requires`.
fn render_feature_line(f: &PlanFeature) -> String {
    // A feature is not fully defined until it says WHAT IT DRAWS ON. `requires` is the plan -> library
    // edge (algorithm implementations and UI components alike), and the worker charter renders it as the
    // Reference implementations section — so an empty one means a worker is told to build from nothing
    // and re-derives what the library already holds.
    //
    // MEASURED when this was added: 124 features across six projects, THREE with a requires list. The
    // edge and the worker protocol were both correct; the input was empty, and nothing said so.
    let defined = !f.name.is_empty()
        && f.behavior.as_deref().map(|b| !b.trim().is_empty()).unwrap_or(false)
        && !f.acceptance.is_empty()
        && !f.requires.is_empty();
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
    // #4267: the plan → library edge. It round-tripped and showed under `--json`, but was absent from
    // the HUMAN view — so a session or a user reading a feature could not see which library records it
    // is meant to be built from, which is the one thing `requires` exists to communicate.
    if !f.requires.is_empty() {
        out.push_str(&format!("  requires: {}\n", f.requires.join(", ")));
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
/// `brief <target> [--ref <ref>]` — push a tier-to-tier BRIEF, body on stdin
/// (#funnel-generalize-brief-channel).
///
/// The same coord record `bsc-brief` writes, reached as a `bsc` VERB. That distinction is the whole
/// point: the ARCHITECT is a `restrictedAllow` session, so its allow-list IS its auto-runnable surface,
/// and `sessionRoles.test.ts` pins every entry on such a surface to a `bsc ` store verb — a shell
/// function there would break that invariant. The shell helper stays for unrestricted senders.
///
/// Touches NO store: a brief is a coordination signal, not plan state. So this deliberately does not
/// `open_store` — an architect has no project db and must not need one to speak to a director.
///
/// WHERE a brief may LAND is not decided here. The emitter records the target; `briefRouting` decides
/// who receives it, and refuses an architect that names anything but a director. Enforcing the tier at
/// the delivery end rather than the emitter is what makes it hold for a replayed log too.
pub(crate) fn cmd_brief(args: &Args) -> Result<(), String> {
    let target = args.positional.get(1).cloned().unwrap_or_default();
    // `list` / `ack` are SUB-VERBS of brief, not separate nouns: a brief's whole lifecycle stays under
    // one word, the way `bsc plan request` keeps new/list/resolve together.
    match target.trim() {
        "list" => return cmd_brief_list(args),
        "ack" => return cmd_brief_ack(args),
        _ => {}
    }
    if target.trim().is_empty() {
        return Err("usage: bsc plan brief <target> [--ref <ref>]   # body on stdin
   or: bsc plan brief list | bsc plan brief ack <id> --note \"<what you reconciled>\"".into());
    }
    let mut body = String::new();
    std::io::stdin().read_to_string(&mut body).map_err(|e| format!("reading stdin: {e}"))?;
    if body.trim().is_empty() {
        return Err("a brief needs a body on stdin".into());
    }
    crate::coord::emit3(crate::coord::KIND_BRIEF, target.trim(), body.trim(), args.brief_ref.as_deref().unwrap_or(""));
    // PRINT THE ID. A sender that cannot name what it just sent has no way to ask about it later — and
    // the architect's whole complaint is that briefing is fire-and-forget. Re-derived from the log rather
    // than remembered, so it is the same id `list` and `ack` use.
    let id = coord_log_path()
        .map(|p| crate::coord::open_briefs(&p))
        .unwrap_or_default()
        .into_iter()
        .rev()
        .find(|b| b.target == target.trim())
        .map(|b| b.id);
    match id {
        Some(id) => println!("briefed {} — {}", target.trim(), id),
        // No coord log configured: the brief still emitted (best-effort, as every coord write is), there
        // is simply nothing to read an id back from. Say so rather than printing a fabricated one.
        None => println!("briefed {} (no $BSC_COORD_LOG — no id to read back)", target.trim()),
    }
    Ok(())
}

/// The coord log this session writes to, if it has one.
fn coord_log_path() -> Option<std::path::PathBuf> {
    let p = std::env::var("BSC_COORD_LOG").ok()?;
    if p.is_empty() { None } else { Some(std::path::PathBuf::from(p)) }
}

/// `bsc plan brief list` — briefs awaiting acknowledgement, addressed to THIS session.
fn cmd_brief_list(args: &Args) -> Result<(), String> {
    let Some(log) = coord_log_path() else {
        return Err("no $BSC_COORD_LOG — a brief queue needs the coordination log this session writes to".into());
    };
    let mut open = crate::coord::open_briefs(&log);
    // SCOPED BY EXACT TARGET, not by project prefix. A brief is ADDRESSED (`<project>:director`), and the
    // receiving session's own pane is that exact string — so exact match is both simpler and more precise
    // than the project rule the ask queue needs for broadcast traffic. A bare shell (no pane) sees all.
    if let Ok(me) = std::env::var("BSC_AUDIT_PANE") {
        if !me.is_empty() && me != "?" {
            open.retain(|b| b.target == me);
        }
    }
    bsc_cli_util::emit(args.pretty, args.json, &open, || {
        if open.is_empty() {
            return "no briefs awaiting acknowledgement".to_string();
        }
        let mut lines = vec!["id	from	body".to_string()];
        for b in &open {
            lines.push(format!("{}	{}	{}", b.id, b.from, b.body));
        }
        lines.join("
")
    });
    Ok(())
}

/// `bsc plan brief ack <id> --note "<what you reconciled>"` — close one brief.
fn cmd_brief_ack(args: &Args) -> Result<(), String> {
    let id = args.positional.get(2).cloned().unwrap_or_default();
    if id.trim().is_empty() {
        return Err("usage: bsc plan brief ack <id> --note \"<what you reconciled>\"   (ids from `bsc plan brief list`)".into());
    }
    let Some(log) = coord_log_path() else {
        return Err("no $BSC_COORD_LOG — nothing to acknowledge against".into());
    };
    // REFUSED, NOT RECORDED, on an unknown id. An ack for nothing would empty nothing while printing
    // success — and the sender would go on believing its brief was reconciled.
    if !crate::coord::open_briefs(&log).iter().any(|b| b.id == id.trim()) {
        return Err(format!(
            "no brief awaiting acknowledgement with id '{}' — run `bsc plan brief list` (an already-acked brief is gone)",
            id.trim()
        ));
    }
    let note = args.note.clone().unwrap_or_default();
    crate::coord::emit(crate::coord::KIND_BRIEF_ACK, id.trim(), note.trim());
    println!("acked {}", id.trim());
    Ok(())
}

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
            // `--to` names the TIER this is addressed to; absent ⇒ the director, which is what a
            // request has always meant. `--ref` cites the plan item it concerns, exactly as
            // `brief --ref` does — and it is what makes "the items the architect is responsible
            // for" answerable: `request list --to architect --status open`.
            let target = args.to.as_deref().unwrap_or("");
            let id = s
                .request_new_to(
                    &text,
                    args.command.as_deref().unwrap_or(""),
                    from,
                    target,
                    args.brief_ref.as_deref().unwrap_or(""),
                )
                .map_err(|e| e.to_string())?;
            // Announce it (#4001). The pump re-derives its pending set from the LOG, so a request
            // that is stored but not announced is invisible to the director forever.
            //
            // The TARGET rides in the announcement too. Without it every tier's pump would surface
            // every request, and a director would be handed the asks it just sent upward.
            crate::coord::emit3(
                crate::coord::KIND_REQUEST,
                &id.to_string(),
                &text,
                if target.is_empty() { crate::requests::TARGET_DIRECTOR } else { target },
            );
            println!("{}", if args.json { serde_json::to_string(&id).unwrap_or_default() } else { id.to_string() });
            Ok(())
        }
        // `request list [--status open|claimed|resolved]` — the queue, oldest first (JSON).
        "list" => {
            let items = s
                .request_list_for(
                    args.status.as_deref().unwrap_or(""),
                    args.to.as_deref().unwrap_or(""),
                )
                .map_err(|e| e.to_string())?;
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

#[cfg(test)]
mod feature_defined_tests {
    use super::*;

    fn f(requires: Vec<String>) -> PlanFeature {
        PlanFeature {
            slug: "invite".into(),
            name: "Invite teammates".into(),
            behavior: Some("send an invite".into()),
            acceptance: vec!["an invite arrives".into()],
            requires,
            ..Default::default()
        }
    }

    /// A feature is not fully defined until it says what it draws on.
    ///
    /// MEASURED when this rule was added: 124 features across six projects carried THREE `requires`
    /// lists between them. The plan → library edge existed, the worker protocol used it correctly, and
    /// the section it renders was blank almost every time — because nothing reported the gap. `·` is
    /// what makes it visible in the one place a planner already looks.
    #[test]
    fn an_empty_requires_is_not_fully_defined() {
        assert!(render_feature_line(&f(vec![])).contains('·'), "no requires ⇒ pending");
        assert!(render_feature_line(&f(vec!["a-star.rs".into()])).contains('✓'), "with requires ⇒ defined");
    }

    /// The other three conditions still hold — this ADDS a requirement, it does not replace them.
    #[test]
    fn the_existing_conditions_are_unchanged() {
        let mut none_behavior = f(vec!["a-star.rs".into()]);
        none_behavior.behavior = None;
        assert!(render_feature_line(&none_behavior).contains('·'));

        let mut no_acceptance = f(vec!["a-star.rs".into()]);
        no_acceptance.acceptance = vec![];
        assert!(render_feature_line(&no_acceptance).contains('·'));
    }

    /// A requires entry may name EITHER library — the marker does not care which, only that the
    /// feature said something.
    #[test]
    fn either_library_counts() {
        assert!(render_feature_line(&f(vec!["ui-button".into()])).contains('✓'), "a component id counts");
    }
}
