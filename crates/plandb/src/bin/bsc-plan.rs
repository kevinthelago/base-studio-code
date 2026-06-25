//! `bsc-plan` — the agent-facing CLI over a project's plan.db (#plan-db). The planner writes issues
//! one at a time; workers read their queue + drive their own status; the director reads the
//! `complete` queue and marks verified/failed after checking CI. Replaces having every session
//! read/rewrite issues.json by hand.
//!
//! The DB is located via `--db <path>` or the `BSC_PLAN_DB` env var (set per-session at launch, so
//! the CLI resolves the hub's plan.db even from a worker's worktree). Default output is human text;
//! `--json` emits machine-readable JSON.
//!
//! Commands:
//!   bsc-plan add                      # upsert from JSON on stdin (one object or an array); prints ref(s)
//!   bsc-plan get <ref>                # one issue's full spec
//!   bsc-plan list [--status S] [--stream S]
//!   bsc-plan mine --stream S [--status S]   # alias for `list --stream S`
//!   bsc-plan status <ref> <status>    # open|in_progress|blocked|complete|verified|failed
//!   bsc-plan remove <ref>
//!   bsc-plan render                   # print the issues.json projection to stdout
//! Global flags: --db <path>, --json

use plandb::{is_valid_status, Lesson, PlanFeature, PlanIssue, PlanPhase, Store, STATUSES};
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bsc-plan: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Parsed global flags + leftover positional args.
struct Args {
    json: bool,
    db: Option<String>,
    positional: Vec<String>,
    status: Option<String>,
    stream: Option<String>,
    rule: Option<String>,
    cause: Option<String>,
    from: Option<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { json: false, db: None, positional: Vec::new(), status: None, stream: None, rule: None, cause: None, from: None };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--status" => a.status = Some(it.next().ok_or("--status needs a value")?),
            "--stream" => a.stream = Some(it.next().ok_or("--stream needs a value")?),
            "--rule" => a.rule = Some(it.next().ok_or("--rule needs a value")?),
            "--cause" => a.cause = Some(it.next().ok_or("--cause needs a value")?),
            "--from" => a.from = Some(it.next().ok_or("--from needs a value")?),
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1).collect())?;
    let cmd = args.positional.first().cloned().unwrap_or_default();
    if cmd.is_empty() {
        print!("{USAGE}");
        return Ok(());
    }

    // `render`/writes/reads all need the DB; resolve it once.
    let store = || -> Result<Store, String> {
        let path = resolve_db(&args.db)?;
        Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
    };

    match cmd.as_str() {
        "add" => {
            let s = store()?;
            let refs = cmd_add(&s)?;
            if args.json {
                println!("{}", serde_json::to_string(&refs).unwrap_or_else(|_| "[]".into()));
            } else {
                for r in &refs {
                    println!("{r}");
                }
            }
            Ok(())
        }
        "get" => {
            let r = args.positional.get(1).ok_or("usage: bsc-plan get <ref>")?;
            let s = store()?;
            match s.get(r).map_err(|e| e.to_string())? {
                Some(issue) if args.json => println!("{}", to_json(&issue)),
                Some(issue) => print!("{}", render_issue(&issue)),
                None => return Err(format!("no issue with ref '{r}'")),
            }
            Ok(())
        }
        "list" | "mine" => {
            let s = store()?;
            let issues = s
                .list(args.status.as_deref(), args.stream.as_deref())
                .map_err(|e| e.to_string())?;
            if args.json {
                println!("{}", serde_json::to_string(&issues).unwrap_or_else(|_| "[]".into()));
            } else if issues.is_empty() {
                println!("(no matching issues)");
            } else {
                for issue in &issues {
                    println!("{}", render_issue_line(issue));
                }
            }
            Ok(())
        }
        "status" => {
            let r = args.positional.get(1).ok_or("usage: bsc-plan status <ref> <status>")?;
            let new = args.positional.get(2).ok_or("usage: bsc-plan status <ref> <status>")?;
            if !is_valid_status(new) {
                return Err(format!("unknown status '{new}' (expected one of {STATUSES:?})"));
            }
            let s = store()?;
            let n = s.set_status(r, new).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(format!("no issue with ref '{r}'"));
            }
            if !args.json {
                println!("{r} → {new}");
            }
            Ok(())
        }
        "remove" => {
            let r = args.positional.get(1).ok_or("usage: bsc-plan remove <ref>")?;
            let s = store()?;
            s.remove(r).map_err(|e| e.to_string())?;
            if !args.json {
                println!("removed {r}");
            }
            Ok(())
        }
        "render" => {
            let s = store()?;
            println!("{}", s.render_issues_json().map_err(|e| e.to_string())?);
            Ok(())
        }
        "feature" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `feature add <name>...` registers titles (the roster); with no names it reads a
                // feature object/array on stdin (the detail-fill path, merged by slug).
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
                    if args.json {
                        println!("{}", serde_json::to_string(&slugs).unwrap_or_else(|_| "[]".into()));
                    } else {
                        for sl in &slugs {
                            println!("{sl}");
                        }
                    }
                    Ok(())
                }
                "list" => {
                    let feats = s.feature_list().map_err(|e| e.to_string())?;
                    if args.json {
                        println!("{}", serde_json::to_string(&feats).unwrap_or_else(|_| "[]".into()));
                    } else if feats.is_empty() {
                        println!("(no features)");
                    } else {
                        for f in &feats {
                            println!("{}", render_feature_line(f));
                        }
                    }
                    Ok(())
                }
                "get" => {
                    let slug = args.positional.get(2).ok_or("usage: bsc-plan feature get <slug>")?;
                    match s.feature_get(slug).map_err(|e| e.to_string())? {
                        Some(f) if args.json => println!("{}", serde_json::to_string_pretty(&f).unwrap_or_default()),
                        Some(f) => print!("{}", render_feature(&f)),
                        None => return Err(format!("no feature with slug '{slug}'")),
                    }
                    Ok(())
                }
                "remove" => {
                    let slug = args.positional.get(2).ok_or("usage: bsc-plan feature remove <slug>")?;
                    s.feature_remove(slug).map_err(|e| e.to_string())?;
                    if !args.json {
                        println!("removed {slug}");
                    }
                    Ok(())
                }
                other => Err(format!("unknown feature command '{other}'\n\n{USAGE}")),
            }
        }
        "repo" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `repo add <owner/repo>...` links repo(s) to the project (durable in plan.db).
                "add" => {
                    let names: Vec<&String> = args.positional.iter().skip(2).collect();
                    if names.is_empty() {
                        return Err("usage: bsc-plan repo add <owner/repo>...".into());
                    }
                    for n in &names {
                        s.repo_add(n).map_err(|e| e.to_string())?;
                    }
                    if args.json {
                        println!("{}", serde_json::to_string(&names).unwrap_or_else(|_| "[]".into()));
                    } else {
                        for n in &names {
                            println!("linked {n}");
                        }
                    }
                    Ok(())
                }
                "list" => {
                    let repos = s.repo_list().map_err(|e| e.to_string())?;
                    if args.json {
                        println!("{}", serde_json::to_string(&repos).unwrap_or_else(|_| "[]".into()));
                    } else if repos.is_empty() {
                        println!("(no linked repos)");
                    } else {
                        for r in &repos {
                            println!("{r}");
                        }
                    }
                    Ok(())
                }
                "remove" => {
                    let name = args.positional.get(2).ok_or("usage: bsc-plan repo remove <owner/repo>")?;
                    s.repo_remove(name).map_err(|e| e.to_string())?;
                    if !args.json {
                        println!("unlinked {name}");
                    }
                    Ok(())
                }
                other => Err(format!("unknown repo command '{other}'\n\n{USAGE}")),
            }
        }
        "phase" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `phase add <name> [description...]` — name first, the rest joined as the description.
                "add" => {
                    let name = args.positional.get(2).ok_or("usage: bsc-plan phase add <name> [description]")?;
                    let desc = args.positional.iter().skip(3).cloned().collect::<Vec<_>>().join(" ");
                    s.phase_upsert(&PlanPhase { name: name.clone(), description: desc }).map_err(|e| e.to_string())?;
                    if !args.json {
                        println!("phase: {name}");
                    }
                    Ok(())
                }
                "list" => {
                    let phases = s.phase_list().map_err(|e| e.to_string())?;
                    if args.json {
                        println!("{}", serde_json::to_string(&phases).unwrap_or_else(|_| "[]".into()));
                    } else if phases.is_empty() {
                        println!("(no phases)");
                    } else {
                        for (i, p) in phases.iter().enumerate() {
                            let d = if p.description.is_empty() { String::new() } else { format!("  — {}", p.description) };
                            println!("{}. {}{}", i + 1, p.name, d);
                        }
                    }
                    Ok(())
                }
                "remove" => {
                    let name = args.positional.get(2).ok_or("usage: bsc-plan phase remove <name>")?;
                    s.phase_remove(name).map_err(|e| e.to_string())?;
                    if !args.json {
                        println!("removed {name}");
                    }
                    Ok(())
                }
                other => Err(format!("unknown phase command '{other}'\n\n{USAGE}")),
            }
        }
        "fleet" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `fleet set` reads the whole FleetPlan JSON on stdin (streams + meta) and replaces it.
                "set" => {
                    let mut buf = String::new();
                    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
                    let plan: serde_json::Value =
                        serde_json::from_str(buf.trim()).map_err(|e| format!("parsing fleet JSON: {e}"))?;
                    s.fleet_set(&plan).map_err(|e| e.to_string())?;
                    if !args.json {
                        let n = plan.get("streams").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                        println!("fleet set ({n} streams)");
                    }
                    Ok(())
                }
                "get" | "list" => {
                    match s.fleet_get().map_err(|e| e.to_string())? {
                        Some(f) => println!("{}", serde_json::to_string_pretty(&f).unwrap_or_default()),
                        None => println!("{}", if args.json { "null" } else { "(no fleet)" }),
                    }
                    Ok(())
                }
                "remove" => {
                    let id = args.positional.get(2).ok_or("usage: bsc-plan fleet remove <stream-id>")?;
                    s.fleet_stream_remove(id).map_err(|e| e.to_string())?;
                    if !args.json {
                        println!("removed {id}");
                    }
                    Ok(())
                }
                other => Err(format!("unknown fleet command '{other}'\n\n{USAGE}")),
            }
        }
        "deploy" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `deploy set` reads the whole DeployConfig JSON on stdin and replaces it (one blob).
                "set" => {
                    let mut buf = String::new();
                    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
                    let cfg: serde_json::Value =
                        serde_json::from_str(buf.trim()).map_err(|e| format!("parsing deploy JSON: {e}"))?;
                    s.deploy_set(&cfg).map_err(|e| e.to_string())?;
                    if !args.json {
                        let n = cfg.get("services").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                        println!("deploy set ({n} services)");
                    }
                    Ok(())
                }
                "get" => {
                    match s.deploy_get().map_err(|e| e.to_string())? {
                        Some(c) => println!("{}", serde_json::to_string_pretty(&c).unwrap_or_default()),
                        None => println!("{}", if args.json { "null" } else { "(no deploy config)" }),
                    }
                    Ok(())
                }
                other => Err(format!("unknown deploy command '{other}'\n\n{USAGE}")),
            }
        }
        "deps" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `deps set` reads the whole DependencyManifest JSON on stdin and replaces it (one blob).
                "set" => {
                    let mut buf = String::new();
                    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
                    let manifest: serde_json::Value =
                        serde_json::from_str(buf.trim()).map_err(|e| format!("parsing dependency manifest JSON: {e}"))?;
                    s.deps_set(&manifest).map_err(|e| e.to_string())?;
                    if !args.json {
                        let n = manifest.get("dependencies").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                        println!("deps set ({n} dependencies)");
                    }
                    Ok(())
                }
                "get" => {
                    match s.deps_get().map_err(|e| e.to_string())? {
                        Some(m) => println!("{}", serde_json::to_string_pretty(&m).unwrap_or_default()),
                        None => println!("{}", if args.json { "null" } else { "(no dependency manifest)" }),
                    }
                    Ok(())
                }
                other => Err(format!("unknown deps command '{other}'\n\n{USAGE}")),
            }
        }
        "mcp" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `mcp add <name>...` assigns catalog MCP server(s) to the project (durable in plan.db).
                "add" => {
                    let names: Vec<&String> = args.positional.iter().skip(2).collect();
                    if names.is_empty() {
                        return Err("usage: bsc-plan mcp add <name>...".into());
                    }
                    for n in &names {
                        s.mcp_add(n).map_err(|e| e.to_string())?;
                    }
                    if args.json {
                        println!("{}", serde_json::to_string(&names).unwrap_or_else(|_| "[]".into()));
                    } else {
                        for n in &names {
                            println!("assigned {n}");
                        }
                    }
                    Ok(())
                }
                "list" => {
                    let mcps = s.mcp_list().map_err(|e| e.to_string())?;
                    if args.json {
                        println!("{}", serde_json::to_string(&mcps).unwrap_or_else(|_| "[]".into()));
                    } else if mcps.is_empty() {
                        println!("(no assigned MCP servers)");
                    } else {
                        for m in &mcps {
                            println!("{m}");
                        }
                    }
                    Ok(())
                }
                "remove" => {
                    let name = args.positional.get(2).ok_or("usage: bsc-plan mcp remove <name>")?;
                    s.mcp_remove(name).map_err(|e| e.to_string())?;
                    if !args.json {
                        println!("unassigned {name}");
                    }
                    Ok(())
                }
                other => Err(format!("unknown mcp command '{other}'\n\n{USAGE}")),
            }
        }
        "blueprint" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `blueprint set` reads the whole Blueprint JSON on stdin and replaces it (one blob).
                "set" => {
                    let mut buf = String::new();
                    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
                    let bp: serde_json::Value =
                        serde_json::from_str(buf.trim()).map_err(|e| format!("parsing blueprint JSON: {e}"))?;
                    s.blueprint_set(&bp).map_err(|e| e.to_string())?;
                    if !args.json {
                        let n = bp.get("sections").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                        let name = bp.get("name").and_then(|v| v.as_str()).unwrap_or("blueprint");
                        println!("blueprint set: {name} ({n} sections)");
                    }
                    Ok(())
                }
                "get" => {
                    match s.blueprint_get().map_err(|e| e.to_string())? {
                        Some(b) => println!("{}", serde_json::to_string_pretty(&b).unwrap_or_default()),
                        None => println!("{}", if args.json { "null" } else { "(no blueprint)" }),
                    }
                    Ok(())
                }
                other => Err(format!("unknown blueprint command '{other}'\n\n{USAGE}")),
            }
        }
        "context" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `context require/unrequire <topic>...` shape the DYNAMIC required set as the project
                // clarifies. Context files gate on GENERATION (the gate checks each required
                // `context/<topic>.md` exists) — they are not confirmed (#1028).
                "require" | "unrequire" => {
                    let topics: Vec<&String> = args.positional.iter().skip(2).collect();
                    if topics.is_empty() {
                        return Err(format!("usage: bsc-plan context {sub} <topic>..."));
                    }
                    let required = sub == "require";
                    for t in &topics {
                        s.context_require(t, required).map_err(|e| e.to_string())?;
                    }
                    if args.json {
                        println!("{}", serde_json::to_string(&topics).unwrap_or_else(|_| "[]".into()));
                    } else {
                        let verb = if required { "required" } else { "unrequired" };
                        for t in &topics {
                            println!("{verb} {t}");
                        }
                    }
                    Ok(())
                }
                "list" => {
                    let required = s.context_list().map_err(|e| e.to_string())?;
                    if args.json {
                        println!("{}", serde_json::to_string(&required).unwrap_or_else(|_| "[]".into()));
                    } else if required.is_empty() {
                        println!("(no required context topics)");
                    } else {
                        for t in &required {
                            println!("{t}");
                        }
                    }
                    Ok(())
                }
                other => Err(format!("unknown context command '{other}'\n\n{USAGE}")),
            }
        }
        "integration" => {
            // Runtime (planner-authored) REST connector presets (#1235). These live in the
            // connectors store (~/.base-studio-code/connectors.json) — NOT plan.db — so an
            // authored integration is a native, app-wide connector like the built-ins. The spec
            // is validated + secret-free on add (credentials go to the keychain, #1194).
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
                    if args.json {
                        println!("{}", serde_json::to_string(&presets).unwrap_or_else(|_| "[]".into()));
                    } else if presets.is_empty() {
                        println!("(no runtime integrations)");
                    } else {
                        for p in &presets {
                            println!("{}  {} [{}] — {} resource(s)", p.id, p.label, p.auth, p.resources.len());
                        }
                    }
                    Ok(())
                }
                "get" => {
                    let id = args.positional.get(2).ok_or("usage: bsc-plan integration get <id>")?;
                    match bsc_data::find_runtime_preset(&path, id).map_err(|e| e.to_string())? {
                        Some(p) => println!("{}", serde_json::to_string_pretty(&p).unwrap_or_default()),
                        None if args.json => println!("null"),
                        None => println!("(no integration '{id}')"),
                    }
                    Ok(())
                }
                "remove" => {
                    let id = args.positional.get(2).ok_or("usage: bsc-plan integration remove <id>")?;
                    let removed = bsc_data::remove_runtime_preset(&path, id).map_err(|e| e.to_string())?;
                    if !args.json {
                        println!("{}", if removed { format!("removed {id}") } else { format!("(no integration '{id}')") });
                    }
                    Ok(())
                }
                other => Err(format!("unknown integration command '{other}'\n\n{USAGE}")),
            }
        }
        // Lessons (#1362): the `bsc-learned` capture helper + the review queue speak through these.
        "lesson" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
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
                    println!("{}", serde_json::to_string_pretty(&lessons).unwrap_or_else(|_| "[]".into()));
                    Ok(())
                }
                "confirm" | "discard" => {
                    let id = args.positional.get(2).ok_or(format!("usage: bsc-plan lesson {sub} <id>"))?;
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
                    let id = args.positional.get(2).ok_or("usage: bsc-plan lesson remove <id>")?;
                    s.lesson_remove(id).map_err(|e| e.to_string())?;
                    if !args.json {
                        println!("removed {id}");
                    }
                    Ok(())
                }
                other => Err(format!("unknown lesson command '{other}'\n\n{USAGE}")),
            }
        }
        other => Err(format!("unknown command '{other}'\n\n{USAGE}")),
    }
}

/// Resolve the plan.db path: explicit `--db` wins, else the `BSC_PLAN_DB` env var.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = flag {
        return Ok(PathBuf::from(p));
    }
    std::env::var("BSC_PLAN_DB")
        .map(PathBuf::from)
        .map_err(|_| "no plan.db: pass --db <path> or set BSC_PLAN_DB".to_string())
}

/// Read JSON from stdin (one issue object or an array), upsert each, return the assigned refs.
fn cmd_add(s: &Store) -> Result<Vec<String>, String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
    let buf = buf.trim();
    if buf.is_empty() {
        return Err("add: expected an issue (or array of issues) as JSON on stdin".into());
    }
    let issues: Vec<PlanIssue> = if buf.starts_with('[') {
        serde_json::from_str(buf).map_err(|e| format!("parsing issue array: {e}"))?
    } else {
        vec![serde_json::from_str(buf).map_err(|e| format!("parsing issue: {e}"))?]
    };
    let mut refs = Vec::new();
    for issue in &issues {
        if issue.r#ref.trim().is_empty() {
            return Err("add: each issue needs a non-empty \"ref\"".into());
        }
        if issue.title.trim().is_empty() {
            return Err(format!("add: issue '{}' needs a non-empty \"title\"", issue.r#ref));
        }
        s.upsert(issue).map_err(|e| e.to_string())?;
        refs.push(issue.r#ref.clone());
    }
    Ok(refs)
}

fn to_json(issue: &PlanIssue) -> String {
    serde_json::to_string_pretty(issue).unwrap_or_else(|_| "{}".into())
}

/// Read JSON from stdin (one feature object or an array) and merge-upsert each; return the slugs.
/// Used for the detail-fill phase (`{"slug":"…","behavior":…}`) — title rows are added by name.
fn cmd_feature_add(s: &Store) -> Result<Vec<String>, String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
    let buf = buf.trim();
    if buf.is_empty() {
        return Err("feature add: pass title name(s) as args, or a feature object/array as JSON on stdin".into());
    }
    let feats: Vec<PlanFeature> = if buf.starts_with('[') {
        serde_json::from_str(buf).map_err(|e| format!("parsing feature array: {e}"))?
    } else {
        vec![serde_json::from_str(buf).map_err(|e| format!("parsing feature: {e}"))?]
    };
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

/// A one-line list entry: `F3  [in_progress]  Add login   (auth)`.
fn render_issue_line(i: &PlanIssue) -> String {
    let stream = i.stream.as_deref().map(|s| format!("   ({s})")).unwrap_or_default();
    format!("{:<8} [{}]  {}{}", i.r#ref, i.status, i.title, stream)
}

/// The full human-readable spec of one issue (for `get`).
fn render_issue(i: &PlanIssue) -> String {
    let mut out = format!("{}  [{}]  {}\n", i.r#ref, i.status, i.title);
    let mut meta: Vec<String> = Vec::new();
    if let Some(p) = &i.phase {
        meta.push(format!("phase: {}", p.to_string().trim_matches('"')));
    }
    if let Some(s) = &i.stream {
        meta.push(format!("stream: {s}"));
    }
    if let Some(r) = &i.repo {
        meta.push(format!("repo: {r}"));
    }
    if let Some(p) = &i.parent {
        meta.push(format!("parent: {p}"));
    }
    if !meta.is_empty() {
        out.push_str(&format!("  {}\n", meta.join("   ")));
    }
    if !i.owns.is_empty() {
        out.push_str(&format!("  owns: {}\n", i.owns.join(", ")));
    }
    if !i.depends_on.is_empty() {
        out.push_str(&format!("  depends on: {}\n", i.depends_on.join(", ")));
    }
    if !i.labels.is_empty() {
        out.push_str(&format!("  labels: {}\n", i.labels.join(", ")));
    }
    if !i.acceptance.is_empty() {
        out.push_str("  acceptance:\n");
        for a in &i.acceptance {
            out.push_str(&format!("    - {a}\n"));
        }
    }
    if let Some(b) = &i.body {
        if !b.trim().is_empty() {
            out.push('\n');
            for line in b.lines() {
                out.push_str(&format!("  {line}\n"));
            }
        }
    }
    out
}

const USAGE: &str = "\
bsc-plan — the project plan store (#plan-db)

USAGE:
  bsc-plan <command> [args] [--db <path>] [--json]

COMMANDS:
  add                       upsert from JSON on stdin (one object or array); prints ref(s)
  get <ref>                 print one issue's full spec
  list [--status S] [--stream S]   list issues (optionally filtered)
  mine --stream S [--status S]     your stream's issues (alias for list --stream)
  status <ref> <status>     set status: open|in_progress|blocked|complete|verified|failed
  remove <ref>              delete an issue
  render                    print the issues.json projection to stdout

FEATURES (titles-first):
  feature add <name>...     register feature title(s) — the roster (slug derived from name)
  feature add               (no names) merge details from a feature object/array on stdin, by slug
  feature list              list features (· = title only, ✓ = fully defined)
  feature get <slug>        print one feature's full spec
  feature remove <slug>     delete a feature

REPOS (linked, durable in plan.db):
  repo add <owner/repo>...  link repo(s) to the project
  repo list                 list the linked repos
  repo remove <owner/repo>  unlink a repo

PHASES (the roadmap — features reference a phase by its 1-based order):
  phase add <name> [desc]   add/merge a roadmap phase (in order)
  phase list                list phases in order
  phase remove <name>       delete a phase

FLEET (streams + per-stream permissions/flows + director/topology):
  fleet set                 replace the fleet from a FleetPlan JSON on stdin
  fleet get                 print the fleet (FleetPlan JSON)
  fleet remove <stream-id>  drop one stream

DEPLOY (the Deploy stage's structured config — one blob):
  deploy set                replace the deploy config from a DeployConfig JSON on stdin
  deploy get                print the deploy config (DeployConfig JSON)

DEPS (the Deploy stage's locked dependency manifest — one blob):
  deps set                  replace the manifest from a DependencyManifest JSON on stdin
  deps get                  print the manifest (DependencyManifest JSON)
                            (shape: a `dependencies` array + a `registries` map keyed by source)

MCP (catalog servers scoped to the project):
  mcp add <name>...         assign MCP server(s) by catalog name
  mcp list                  list the assigned servers
  mcp remove <name>         unassign a server

BLUEPRINT (the blueprint an authoring project is designing — one blob):
  blueprint set             replace the blueprint from a Blueprint JSON on stdin
  blueprint get             print the blueprint (Blueprint JSON)

CONTEXT (the Context stage's DYNAMIC required-set — prose lives in context/<topic>.md files):
  context require <topic>...    mark topic(s) required for this project
  context unrequire <topic>...  drop topic(s) from the required set
  context list                  show the required topic set
  (context files gate on GENERATION — written, not confirmed)

INTEGRATION (native REST connectors authored at planning time — app-wide, NOT plan.db; #1235):
  integration add               upsert a RuntimePreset JSON on stdin (validated, secret-free)
  integration list              list the runtime integrations
  integration get <id>          print one integration (RuntimePreset JSON)
  integration remove <id>       delete a runtime integration
  (the spec carries no credentials — secrets live in the OS keychain; auth: oauth|token|apikey|basic)

LESSONS (self-correction candidates — usually captured via the `bsc-learned` helper; #1362):
  lesson add \"<mistake>\" --rule \"<rule>\" [--cause <c>] [--from <prov>]   capture a candidate
  lesson list [--status pending|confirmed|discarded]   list candidates (JSON; queue reads pending)
  lesson confirm <id> | discard <id>    set the user's verdict
  lesson remove <id>            delete a candidate
  (candidates de-dupe on a normalized mistake|rule key — a re-capture bumps a 'seen' counter)

The plan.db is found via --db <path> or the BSC_PLAN_DB env var.
The connectors store is ~/.base-studio-code/connectors.json (BSC_CONNECTORS overrides).
";
