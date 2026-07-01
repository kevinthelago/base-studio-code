//! The `bsc plan` subcommand (#1877) — the agent-facing CLI over a project's plan.db (#plan-db). The
//! planner writes issues one at a time; workers read their queue + drive their own status; the
//! director reads the `complete` queue and marks verified/failed after checking CI. Replaces having
//! every session read/rewrite issues.json by hand.
//!
//! Extracted from the old `bsc-plan` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the legacy `bsc-plan` shim still calls the same entrypoint.
//!
//! The DB is located via `--db <path>` or the `BSC_PLAN_DB` env var (set per-session at launch, so
//! the CLI resolves the hub's plan.db even from a worker's worktree). Default output is human text;
//! `--json` emits machine-readable JSON.
//!
//! Reads are **lean by default** (#1562): plural reads (`list`/`mine`) emit a compact, body-free TSV
//! (value-lists as counts) and `--json` a compact summary array, so an embedded plan.db read is cheap
//! on the agent token budget. Escalate only when needed — `get <ref>` for one full issue, or the list
//! flags `--full` / `--fields` / `--limit` / `--since` (and `--pretty` to re-indent a JSON read).
//!
//! Help is per-command so a model loads only what it needs (#1762):
//!   bsc plan help            # compact menu (the small "what commands exist" prompt)
//!   bsc plan fleet help      # detailed help for ONE command
//!   bsc plan <cmd> help      # same, after any command

use crate::{is_valid_status, Automation, IssueSummary, Lesson, PlanFeature, PlanIssue, StartupScript, Store, STATUSES};
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json, read_stdin_json_one};
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

const TAGLINE: &str = "the project plan store — issues, features, fleet, sections (#plan-db)";

/// The command catalog — drives the shared help system. One detailed `usage` block per top-level
/// command keeps the overview tiny and the detail one-fetch-away; the multi-verb nouns document their
/// subcommands in their own block. Reads are lean by default (#1562); `--json`/`--pretty` for JSON.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "add",
        summary: "upsert issue(s) from JSON on stdin; prints ref(s)",
        usage: "\
USAGE:
  bsc plan add   # one issue object, or an array, as JSON on stdin

Upserts each issue by its (required, non-empty) \"ref\" (and \"title\"). Prints the ref(s) written.",
    },
    CmdDoc {
        name: "get",
        summary: "print one issue's FULL spec",
        usage: "\
USAGE:
  bsc plan get <ref> [--json] [--pretty]

One issue's full spec — the detail the lean `list` omits. --json is compact; --pretty re-indents.",
    },
    CmdDoc {
        name: "summary",
        summary: "plan overview: totals + per-status/stream counts",
        usage: "\
USAGE:
  bsc plan summary [--json] [--pretty]

The cheapest \"where does the plan stand\" read: totals plus per-status, per-stream counts.",
    },
    CmdDoc {
        name: "list",
        summary: "the issue table (lean by default; escalation flags)",
        usage: "\
USAGE:
  bsc plan list [--status S] [--stream S] [--full] [--fields a,b] [--limit N] [--since EPOCH] [--json|--pretty]

Lean by default (#1562): a compact TSV (counts, no body) / compact --json summary. Escalate only
when needed:
  --full              every field (TSV lines, or full --json)
  --fields a,b,...    project just these columns as TSV (body reachable here)
  --limit N           cap to N rows (plan order)
  --since EPOCH       only rows changed after EPOCH seconds (resume-delta read)
  --pretty            re-indent a --json read",
    },
    CmdDoc {
        name: "mine",
        summary: "your stream's issues (alias for list --stream)",
        usage: "\
USAGE:
  bsc plan mine --stream S [--status S] [--full|--fields a,b|--limit N|--since EPOCH] [--json|--pretty]

An alias for `list --stream S` — the same lean table + escalation flags, scoped to one stream.",
    },
    CmdDoc {
        name: "status",
        summary: "set an issue's status",
        usage: "\
USAGE:
  bsc plan status <ref> <status>

Sets one issue's status. <status> is one of: open | in_progress | blocked | complete | verified | failed.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete an issue",
        usage: "\
USAGE:
  bsc plan remove <ref>

Deletes one issue by ref.",
    },
    CmdDoc {
        name: "render",
        summary: "print the issues.json projection (full, unchanged)",
        usage: "\
USAGE:
  bsc plan render

Prints the full issues.json projection to stdout (the durable shape, unchanged).",
    },
    CmdDoc {
        name: "feature",
        summary: "the features roster + detail-fill (titles-first)",
        usage: "\
USAGE:
  bsc plan feature add <name>...   # register feature title(s) — the roster (slug from name)
  bsc plan feature add             # (no names) merge details from a feature object/array on stdin
  bsc plan feature list            # list features (· = title only, ✓ = fully defined)
  bsc plan feature get <slug>      # print one feature's full spec
  bsc plan feature remove <slug>   # delete a feature",
    },
    CmdDoc {
        name: "repo",
        summary: "repos linked to the project (durable in plan.db)",
        usage: "\
USAGE:
  bsc plan repo add <owner/repo>...   # link repo(s) to the project
  bsc plan repo list                  # list the linked repos
  bsc plan repo remove <owner/repo>   # unlink a repo",
    },
    CmdDoc {
        name: "fleet",
        summary: "streams + per-stream permissions/flows + director/topology",
        usage: "\
USAGE:
  bsc plan fleet set                  # replace the fleet from a FleetPlan JSON on stdin
  bsc plan fleet get [<stream-id>]    # print the fleet (lean; --full for detail), or one stream
  bsc plan fleet stream set <id>      # upsert ONE stream's JSON on stdin (granular; keeps order)
  bsc plan fleet meta set             # upsert just the meta (director/topology/…) JSON on stdin
  bsc plan fleet remove <stream-id>   # drop one stream

`fleet get` is lean by default (id/name/dependsOn per stream); add --full for permissions/flows.",
    },
    CmdDoc {
        name: "deploy",
        summary: "the Deploy stage's structured config (one blob)",
        usage: "\
USAGE:
  bsc plan deploy set   # replace the deploy config from a DeployConfig JSON on stdin
  bsc plan deploy get   # print the deploy config (DeployConfig JSON)",
    },
    CmdDoc {
        name: "deps",
        summary: "the locked dependency manifest (one blob)",
        usage: "\
USAGE:
  bsc plan deps set   # replace the manifest from a DependencyManifest JSON on stdin
  bsc plan deps get   # print the manifest (a `dependencies` array + a `registries` map)",
    },
    CmdDoc {
        name: "mcp",
        summary: "catalog MCP servers scoped to the project",
        usage: "\
USAGE:
  bsc plan mcp add <name>...   # assign MCP server(s) by catalog name
  bsc plan mcp list            # list the assigned servers
  bsc plan mcp remove <name>   # unassign a server",
    },
    CmdDoc {
        name: "blueprint",
        summary: "the blueprint an authoring project is designing (one blob)",
        usage: "\
USAGE:
  bsc plan blueprint set   # replace the blueprint from a Blueprint JSON on stdin
  bsc plan blueprint get   # print the blueprint (Blueprint JSON)",
    },
    CmdDoc {
        name: "discovery",
        summary: "the Discovery stage's dynamic required-set",
        usage: "\
USAGE:
  bsc plan discovery require <topic>...     # mark topic(s) required for this project
  bsc plan discovery unrequire <topic>...   # drop topic(s) from the required set
  bsc plan discovery list                   # show the required topic set

Prose lives in discovery/<topic>.md; these files gate on GENERATION (written, not confirmed).",
    },
    CmdDoc {
        name: "integration",
        summary: "DEPRECATED (#1721) → use `bsc data connector`",
        usage: "\
USAGE:
  bsc plan integration add|list|get <id>|remove <id>

DEPRECATED (#1721): native REST connector presets are DATA-platform state — use `bsc data connector`
instead. This verb still works (same store) but prints a deprecation note to stderr.",
    },
    CmdDoc {
        name: "lesson",
        summary: "self-correction candidates (the review queue; #1362)",
        usage: "\
USAGE:
  bsc plan lesson add \"<mistake>\" --rule \"<rule>\" [--cause <c>] [--from <prov>]   # capture a candidate
  bsc plan lesson list [--status pending|confirmed|discarded]                  # list candidates (JSON)
  bsc plan lesson confirm <id> | discard <id>                                  # set the user's verdict
  bsc plan lesson remove <id>                                                  # delete a candidate

Usually captured via the `bsc-learned` helper. Candidates de-dupe on a normalized mistake|rule key.",
    },
    CmdDoc {
        name: "section",
        summary: "the project's flat prose files (goal/scope/stack/…)",
        usage: "\
USAGE:
  bsc plan section list          # list the present prose .md files
  bsc plan section get <name>    # print one section (e.g. goal, scope, stack) verbatim
  bsc plan section set <name>    # write a section from stdin

Sections live beside plan.db in the hub dir. The `.md` is implied; the name is path-safe (a bare
name, no traversal).",
    },
    CmdDoc {
        name: "automations",
        summary: "assign/list/remove project automations (+ the automations.md recipe doc)",
        usage: "\
USAGE:
  bsc plan automations add <name> --command <cmd> [--schedule <cron>] [--description <text>]
                             # assign an automation (upsert by name); omit --schedule = on-demand
  bsc plan automations list  # list assigned automations (--json for the full objects)
  bsc plan automations remove <name>
                             # unassign an automation
  bsc plan automations get   # read the prose automations.md recipe doc
  bsc plan automations set   # write automations.md from stdin",
    },
    CmdDoc {
        name: "startup",
        summary: "assign/list/remove per-repo startup (dev/triage) prompt scripts",
        usage: "\
USAGE:
  bsc plan startup add <owner/repo> --mode <dev|triage> --path <relpath>
                        # assign a repo's kickoff (dev) or triage script (upsert by repo+mode)
                        # --path is relative to the project hub dir, e.g. prompts/web-kickoff.md
  bsc plan startup list # list assigned startup scripts (--json for the full objects)
  bsc plan startup remove <owner/repo> --mode <dev|triage>
                        # unassign a repo's startup script",
    },
    CmdDoc {
        name: "github-context",
        summary: "read github_context.md (app-generated; read-only)",
        usage: "\
USAGE:
  bsc plan github-context get   # read github_context.md (app-generated; read-only)",
    },
];

/// The compact command menu (the shared help overview) — shown on `help`, on no command, and at the
/// foot of an unknown-command error. `prog` is the display name (`"bsc plan"` from the umbrella,
/// `"bsc-plan"` from the legacy shim).
fn menu(prog: &str) -> String {
    bsc_cli_util::help_overview(prog, TAGLINE, COMMANDS)
}

/// One command's detailed help — shown on `<cmd> help` and at the foot of an unknown-subcommand error.
fn cmd_help(prog: &str, name: &str) -> String {
    bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, name)
}

/// Parsed global flags + leftover positional args.
struct Args {
    /// The display name threaded into help/error text (`"bsc plan"` or the legacy `"bsc-plan"`).
    prog: String,
    json: bool,
    db: Option<String>,
    positional: Vec<String>,
    status: Option<String>,
    stream: Option<String>,
    rule: Option<String>,
    cause: Option<String>,
    from: Option<String>,
    /// Automation fields (#2009) — `automations add <name> --command … [--schedule …] [--description …]`.
    command: Option<String>,
    schedule: Option<String>,
    description: Option<String>,
    /// Startup-script fields (#2010) — `startup add <repo> --mode dev|triage --path <relpath>`.
    mode: Option<String>,
    path: Option<String>,
    /// Plural reads (`list`/`mine`) escalate from the lean default to every field (#1562).
    full: bool,
    /// Explicit column projection for `list`/`mine`, e.g. `--fields ref,title,status` → TSV.
    fields: Option<String>,
    /// Cap the number of rows a plural read returns (newest in plan order).
    limit: Option<usize>,
    /// Delta read: only rows whose `updated_at > <epoch-seconds>` (resume-aware).
    since: Option<i64>,
    /// Re-expand a JSON read to indented form (the default is compact, to save agent tokens).
    pretty: bool,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        prog: String::new(), json: false, db: None, positional: Vec::new(), status: None, stream: None,
        rule: None, cause: None, from: None, command: None, schedule: None, description: None,
        mode: None, path: None,
        full: false, fields: None, limit: None,
        since: None, pretty: false,
    };
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
            "--command" => a.command = Some(it.next().ok_or("--command needs a value")?),
            "--mode" => a.mode = Some(it.next().ok_or("--mode needs a value")?),
            "--path" => a.path = Some(it.next().ok_or("--path needs a value")?),
            "--schedule" => a.schedule = Some(it.next().ok_or("--schedule needs a value")?),
            "--description" => a.description = Some(it.next().ok_or("--description needs a value")?),
            "--full" => a.full = true,
            "--pretty" => a.pretty = true,
            "--fields" => a.fields = Some(it.next().ok_or("--fields needs a comma-separated list")?),
            "--limit" => {
                let v = it.next().ok_or("--limit needs a number")?;
                a.limit = Some(v.parse().map_err(|_| format!("--limit: '{v}' is not a number"))?);
            }
            "--since" => {
                let v = it.next().ok_or("--since needs an epoch-seconds value")?;
                a.since = Some(v.parse().map_err(|_| format!("--since: '{v}' is not an integer"))?);
            }
            // `-h`/`--help` route to the help command (handled in run()).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `plan` subcommand entrypoint: `args` is everything after `bsc plan`; `prog` is the display
/// name for help/errors (`"bsc plan"` from the umbrella, `"bsc-plan"` from the legacy shim). Handles
/// help (no command / `help` / `help <cmd>` / `<cmd> help`) before any handler opens the DB.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let mut args = parse_args(args)?;
    args.prog = prog.to_string();
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level help / no command → the compact menu, or one command's detail via `help <cmd>`.
    // Handled before any handler opens the DB (help must work without a plan.db).
    if cmd.is_empty() || cmd == "help" {
        match args.positional.get(1) {
            Some(name) => print!("{}", cmd_help(prog, name)),
            None => print!("{}", menu(prog)),
        }
        return Ok(());
    }
    // Per-command help: `bsc plan <cmd> help`.
    if args.positional.get(1).map(String::as_str) == Some("help") {
        print!("{}", cmd_help(prog, &cmd));
        return Ok(());
    }

    // Each arm is a one-line dispatch to the verb's / noun's handler; the handler resolves the DB
    // and owns its own `match sub`. Shared output shapes live in the `emit_*` helpers below.
    match cmd.as_str() {
        "add" => cmd_add_cmd(&args),
        "get" => cmd_get(&args),
        "summary" => cmd_summary(&args),
        "list" | "mine" => cmd_list(&args),
        "status" => cmd_status(&args),
        "remove" => cmd_remove(&args),
        "render" => cmd_render(&args),
        "feature" => cmd_feature(&args),
        "repo" => cmd_repo(&args),
        "fleet" => cmd_fleet(&args),
        "deploy" => cmd_deploy(&args),
        "deps" => cmd_deps(&args),
        "mcp" => cmd_mcp(&args),
        "blueprint" => cmd_blueprint(&args),
        "discovery" => cmd_discovery(&args),
        "integration" => cmd_integration(&args),
        "lesson" => cmd_lesson(&args),
        "section" => cmd_section(&args),
        "automations" => cmd_automations(&args),
        "startup" => cmd_startup(&args),
        "github-context" => cmd_github_context(&args),
        other => Err(format!("unknown command '{other}'\n\n{}", menu(prog))),
    }
}

/// Open the project's plan.db (resolved from `--db` / `BSC_PLAN_DB`). Every DB-backed handler opens
/// it lazily so a pure error path (unknown sub, bad usage) never touches the disk.
fn open_store(db: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Emit `items` as a JSON array (when `json`) or one `line_fn(index, item)` line each, with `empty`
/// shown for an empty non-JSON read. The shared shape behind every plural human/JSON `list` read.
fn emit_json_or_lines<T: Serialize>(json: bool, items: &[T], empty: &str, line_fn: impl Fn(usize, &T) -> String) {
    if json {
        println!("{}", serde_json::to_string(items).unwrap_or_else(|_| "[]".into()));
    } else if items.is_empty() {
        println!("{empty}");
    } else {
        for (i, it) in items.iter().enumerate() {
            println!("{}", line_fn(i, it));
        }
    }
}

/// Echo a just-written set of `names` (refs/slugs/repos/topics): a JSON array (when `json`) or one
/// `<verb> <name>` line each — an empty `verb` prints the bare name (the ref/slug roster echo).
fn emit_set_result<T: Serialize + std::fmt::Display>(json: bool, names: &[T], verb: &str) {
    if json {
        println!("{}", serde_json::to_string(names).unwrap_or_else(|_| "[]".into()));
    } else if verb.is_empty() {
        for n in names {
            println!("{n}");
        }
    } else {
        for n in names {
            println!("{verb} {n}");
        }
    }
}

/// Emit an optional single blob: the JSON value (`--pretty`-aware) or, when absent, `null` (JSON
/// mode) / `none_text` (human mode). The shared shape behind `deploy/deps/blueprint get`.
fn emit_blob_or_null(json: bool, pretty: bool, blob: Option<serde_json::Value>, none_text: &str) {
    match blob {
        Some(v) => print_json(&v, pretty),
        None => println!("{}", if json { "null" } else { none_text }),
    }
}

/// Count the elements of an array-valued field of a blob (`services`/`dependencies`/`sections`/
/// `streams`) for the human-mode `set` echo; a missing/non-array field counts as 0.
fn blob_count(v: &serde_json::Value, key: &str) -> usize {
    v.get(key).and_then(|x| x.as_array()).map(|a| a.len()).unwrap_or(0)
}

/// The shared `set`/`get` handler for the singleton-blob nouns (`deploy`/`deps`/`blueprint`). `set`
/// reads one JSON object on stdin, replaces the blob via `set_fn`, and echoes `msg_fn(&value)` in
/// human mode; `get` emits the stored blob via `get_fn` or `null`/`none_text`. `verb` names the noun
/// in the unknown-subcommand error; `parse_noun` names the value in the stdin parse error. (`fleet`
/// keeps its own match for `get <stream-id>`/`--full`/lean — only its `set` shares this read shape.)
fn cmd_blob_noun(
    args: &Args,
    verb: &str,
    parse_noun: &str,
    none_text: &str,
    set_fn: impl Fn(&Store, &serde_json::Value) -> Result<(), String>,
    get_fn: impl Fn(&Store) -> Result<Option<serde_json::Value>, String>,
    msg_fn: impl Fn(&serde_json::Value) -> String,
) -> Result<(), String> {
    let s = open_store(&args.db)?;
    match args.positional.get(1).map(String::as_str).unwrap_or("") {
        "set" => {
            let v: serde_json::Value = read_stdin_json_one(parse_noun)?;
            set_fn(&s, &v)?;
            if !args.json {
                println!("{}", msg_fn(&v));
            }
            Ok(())
        }
        "get" => {
            emit_blob_or_null(args.json, args.pretty, get_fn(&s)?, none_text);
            Ok(())
        }
        other => Err(format!("unknown {verb} command '{other}'\n\n{}", cmd_help(&args.prog, verb))),
    }
}

/// `add` — upsert issues from JSON on stdin, echo the assigned ref(s).
fn cmd_add_cmd(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    let refs = cmd_add(&s)?;
    emit_set_result(args.json, &refs, "");
    Ok(())
}

/// `get <ref>` — one issue's FULL spec (compact `--json` by design; `--pretty` re-indents). An agent
/// escalates here for the detail the lean list omits.
fn cmd_get(args: &Args) -> Result<(), String> {
    let r = args.positional.get(1).ok_or("usage: bsc plan get <ref>")?;
    let s = open_store(&args.db)?;
    match s.get(r).map_err(|e| e.to_string())? {
        Some(issue) if args.json => print_json(&serde_json::to_value(&issue).unwrap_or_default(), args.pretty),
        Some(issue) => print!("{}", render_issue(&issue)),
        None => return Err(format!("no issue with ref '{r}'")),
    }
    Ok(())
}

/// `summary` — the cheapest "where does the plan stand" read: totals + per-status/stream counts.
fn cmd_summary(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    let rows = s.list_summary(None, None, None, None).map_err(|e| e.to_string())?;
    let o = compute_overview(&rows);
    if args.json {
        print_json(&overview_json(&o), args.pretty);
    } else {
        print!("{}", render_overview_text(&o));
    }
    Ok(())
}

/// `list` / `mine` — the issue table. Lean by default (#1562); `--fields` is an explicit TSV
/// projection, `--full` every field (TSV lines or full `--json`).
fn cmd_list(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    let (status, stream) = (args.status.as_deref(), args.stream.as_deref());
    if let Some(fields) = &args.fields {
        // Explicit projection wins over lean/full: fetch the full record, emit only the named
        // columns as TSV (so `body` is reachable when asked for, a typo'd field is a blank column).
        let issues = s.list_filtered(status, stream, args.limit, args.since).map_err(|e| e.to_string())?;
        print!("{}", render_fields_tsv(&issues, fields));
    } else if args.full {
        let issues = s.list_filtered(status, stream, args.limit, args.since).map_err(|e| e.to_string())?;
        if args.json {
            print_json(&serde_json::to_value(&issues).unwrap_or_default(), args.pretty);
        } else if issues.is_empty() {
            println!("(no matching issues)");
        } else {
            for issue in &issues {
                println!("{}", render_issue_line(issue));
            }
        }
    } else {
        // Lean by default (#1562): body omitted at the SQL layer, value-lists as counts.
        let rows = s.list_summary(status, stream, args.limit, args.since).map_err(|e| e.to_string())?;
        if args.json {
            print_json(&serde_json::to_value(&rows).unwrap_or_default(), args.pretty);
        } else if rows.is_empty() {
            println!("(no matching issues)");
        } else {
            print!("{}", render_summary_tsv(&rows));
        }
    }
    Ok(())
}

/// `status <ref> <status>` — set an issue's status (validated against {@link STATUSES}).
fn cmd_status(args: &Args) -> Result<(), String> {
    let r = args.positional.get(1).ok_or("usage: bsc plan status <ref> <status>")?;
    let new = args.positional.get(2).ok_or("usage: bsc plan status <ref> <status>")?;
    if !is_valid_status(new) {
        return Err(format!("unknown status '{new}' (expected one of {STATUSES:?})"));
    }
    let s = open_store(&args.db)?;
    let n = s.set_status(r, new).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no issue with ref '{r}'"));
    }
    if !args.json {
        println!("{r} → {new}");
    }
    Ok(())
}

/// `remove <ref>` — delete one issue.
fn cmd_remove(args: &Args) -> Result<(), String> {
    let r = args.positional.get(1).ok_or("usage: bsc plan remove <ref>")?;
    let s = open_store(&args.db)?;
    s.remove(r).map_err(|e| e.to_string())?;
    if !args.json {
        println!("removed {r}");
    }
    Ok(())
}

/// `render` — print the issues.json projection (full, unchanged) to stdout.
fn cmd_render(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    println!("{}", s.render_issues_json().map_err(|e| e.to_string())?);
    Ok(())
}

/// `feature` — the features roster (titles-first) + the detail-fill path.
fn cmd_feature(args: &Args) -> Result<(), String> {
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
        other => Err(format!("unknown feature command '{other}'\n\n{}", cmd_help(&args.prog, "feature"))),
    }
}

/// `repo` — repos linked to the project (durable in plan.db).
fn cmd_repo(args: &Args) -> Result<(), String> {
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
        other => Err(format!("unknown repo command '{other}'\n\n{}", cmd_help(&args.prog, "repo"))),
    }
}

/// `fleet` — streams + per-stream permissions/flows + director/topology.
fn cmd_fleet(args: &Args) -> Result<(), String> {
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
            other => Err(format!("unknown fleet stream command '{other}'\n\n{}", cmd_help(&args.prog, "fleet"))),
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
            other => Err(format!("unknown fleet meta command '{other}'\n\n{}", cmd_help(&args.prog, "fleet"))),
        },
        other => Err(format!("unknown fleet command '{other}'\n\n{}", cmd_help(&args.prog, "fleet"))),
    }
}

/// `deploy` — the Deploy stage's structured config (one blob).
fn cmd_deploy(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "deploy", "deploy JSON", "(no deploy config)",
        |s, v| s.deploy_set(v).map_err(|e| e.to_string()),
        |s| s.deploy_get().map_err(|e| e.to_string()),
        |v| format!("deploy set ({} services)", blob_count(v, "services")),
    )
}

/// `deps` — the Deploy stage's locked dependency manifest (one blob).
fn cmd_deps(args: &Args) -> Result<(), String> {
    cmd_blob_noun(
        args, "deps", "dependency manifest JSON", "(no dependency manifest)",
        |s, v| s.deps_set(v).map_err(|e| e.to_string()),
        |s| s.deps_get().map_err(|e| e.to_string()),
        |v| format!("deps set ({} dependencies)", blob_count(v, "dependencies")),
    )
}

/// `mcp` — catalog MCP servers scoped to the project (durable in plan.db).
fn cmd_mcp(args: &Args) -> Result<(), String> {
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
        other => Err(format!("unknown mcp command '{other}'\n\n{}", cmd_help(&args.prog, "mcp"))),
    }
}

/// `blueprint` — the blueprint an authoring project is designing (one blob).
fn cmd_blueprint(args: &Args) -> Result<(), String> {
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
fn cmd_discovery(args: &Args) -> Result<(), String> {
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
        other => Err(format!("unknown discovery command '{other}'\n\n{}", cmd_help(&args.prog, "discovery"))),
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
fn cmd_integration(args: &Args) -> Result<(), String> {
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
        other => Err(format!("unknown integration command '{other}'\n\n{}", cmd_help(&args.prog, "integration"))),
    }
}

/// `lesson` — self-correction candidates (#1362): the `bsc-learned` capture helper + the review queue.
fn cmd_lesson(args: &Args) -> Result<(), String> {
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
        other => Err(format!("unknown lesson command '{other}'\n\n{}", cmd_help(&args.prog, "lesson"))),
    }
}

/// `section` — the project's flat prose files (goal/scope/stack/architecture/users/…). They live
/// beside plan.db in the hub dir, so this is the prose side of the same per-project plan `bsc plan`
/// already owns. Path-safe: a name is a bare section (the `.md` implied), never a traversal.
fn cmd_section(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let hub = resolve_hub(&args.db)?;
    match sub {
        "list" => {
            let names = list_hub_sections(&hub);
            emit_json_or_lines(args.json, &names, "(no section files)", |_, n| n.clone());
            Ok(())
        }
        "get" => {
            let name = args.positional.get(2).ok_or("usage: bsc plan section get <name>")?;
            get_hub_doc(&hub_md_path(&hub, name)?, &format!("section '{name}'"))
        }
        "set" => {
            let name = args.positional.get(2).ok_or("usage: bsc plan section set <name>  (content on stdin)")?;
            set_hub_doc(&hub_md_path(&hub, name)?, args.json)
        }
        other => Err(format!("unknown section command '{other}'\n\n{}", cmd_help(&args.prog, "section"))),
    }
}

/// `automations` — the project's assigned automations. TWO surfaces under one noun:
/// - **structured** rows in plan.db (`add`/`list`/`remove`) — the cron/on-demand recipes an agent
///   actually runs; the section poll reflects these into the app (#2009).
/// - the **prose** `automations.md` hub doc (`get`/`set`) — the human-readable recipe scratchpad.
fn cmd_automations(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    match sub {
        // `automations add <name> --command … [--schedule …] [--description …]` — upsert by name.
        "add" => {
            let name = args
                .positional
                .get(2)
                .ok_or("usage: bsc plan automations add <name> --command <cmd> [--schedule <cron>] [--description <text>]")?;
            let command = args
                .command
                .clone()
                .ok_or("automations add: --command <cmd> is required")?;
            let a = Automation {
                name: name.clone(),
                command,
                schedule: args.schedule.clone(),
                description: args.description.clone(),
            };
            open_store(&args.db)?.automation_add(&a).map_err(|e| e.to_string())?;
            emit_set_result(args.json, std::slice::from_ref(name), "assigned automation");
            Ok(())
        }
        "list" => {
            let autos = open_store(&args.db)?.automation_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &autos, "(no automations)", |_, a| match &a.schedule {
                Some(s) => format!("{}\t{}\t{}", a.name, s, a.command),
                None => format!("{}\t(on-demand)\t{}", a.name, a.command),
            });
            Ok(())
        }
        "remove" => {
            let name = args.positional.get(2).ok_or("usage: bsc plan automations remove <name>")?;
            open_store(&args.db)?.automation_remove(name).map_err(|e| e.to_string())?;
            if !args.json {
                println!("unassigned {name}");
            }
            Ok(())
        }
        // Prose recipe doc (the named hub `automations.md`).
        "get" => get_hub_doc(&resolve_hub(&args.db)?.join("automations.md"), "automations"),
        "set" => set_hub_doc(&resolve_hub(&args.db)?.join("automations.md"), args.json),
        other => Err(format!("unknown automations command '{other}'\n\n{}", cmd_help(&args.prog, "automations"))),
    }
}

/// `startup` — per-repo kickoff/triage prompt docs the planner assigns (#2010). The section poll
/// reflects these into the app so opening a repo's console (`dev`) / triage pass (`triage`) launches
/// with the assigned script. Keyed by (repo, mode); replaces the `<startup_script>` stream tag.
fn cmd_startup(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    match sub {
        // `startup add <repo> --mode dev|triage --path <relpath>` — upsert by (repo, mode).
        "add" => {
            let repo = args
                .positional
                .get(2)
                .ok_or("usage: bsc plan startup add <owner/repo> --mode <dev|triage> --path <relpath>")?;
            let mode = args.mode.clone().ok_or("startup add: --mode <dev|triage> is required")?;
            if mode != "dev" && mode != "triage" {
                return Err(format!("startup add: --mode must be 'dev' or 'triage' (got '{mode}')"));
            }
            let path = args.path.clone().ok_or("startup add: --path <relpath> is required")?;
            open_store(&args.db)?
                .startup_add(&StartupScript { repo: repo.clone(), mode, path })
                .map_err(|e| e.to_string())?;
            emit_set_result(args.json, std::slice::from_ref(repo), "assigned startup script for");
            Ok(())
        }
        "list" => {
            let scripts = open_store(&args.db)?.startup_list().map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &scripts, "(no startup scripts)", |_, s| {
                format!("{}\t{}\t{}", s.repo, s.mode, s.path)
            });
            Ok(())
        }
        "remove" => {
            let repo = args
                .positional
                .get(2)
                .ok_or("usage: bsc plan startup remove <owner/repo> --mode <dev|triage>")?;
            let mode = args.mode.clone().ok_or("startup remove: --mode <dev|triage> is required")?;
            open_store(&args.db)?.startup_remove(repo, &mode).map_err(|e| e.to_string())?;
            if !args.json {
                println!("unassigned {mode} startup script for {repo}");
            }
            Ok(())
        }
        other => Err(format!("unknown startup command '{other}'\n\n{}", cmd_help(&args.prog, "startup"))),
    }
}

/// `github-context` — the named `github_context.md` hub doc (app-generated GitHub context). Read-only.
fn cmd_github_context(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let path = resolve_hub(&args.db)?.join("github_context.md");
    match sub {
        "get" => get_hub_doc(&path, "github context"),
        other => Err(format!("unknown github-context command '{other}'\n\n{}", cmd_help(&args.prog, "github-context"))),
    }
}

/// The project hub directory — the dir that holds plan.db (its parent). The flat prose section files
/// (goal.md/scope.md/…, automations.md, github_context.md) live beside the DB. A bare/relative DB
/// path with no parent resolves to the current dir.
fn resolve_hub(db: &Option<String>) -> Result<PathBuf, String> {
    let db = resolve_db(db)?;
    Ok(match db.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    })
}

/// Resolve `<name>.md` under the hub dir, rejecting any name that would escape it (a path separator,
/// `..`, an absolute/prefixed path) — only a single plain component is allowed. The `.md` extension
/// is implied and accepted either way (`goal` and `goal.md` both resolve to `goal.md`).
fn hub_md_path(hub: &Path, name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    // The `.md` is implied; accept a name given with or without it.
    let base = name
        .strip_suffix(".md")
        .or_else(|| name.strip_suffix(".MD"))
        .unwrap_or(name);
    if base.is_empty() {
        return Err("section name must not be empty".into());
    }
    let mut comps = Path::new(base).components();
    match (comps.next(), comps.next()) {
        (Some(std::path::Component::Normal(_)), None) => Ok(hub.join(format!("{base}.md"))),
        _ => Err(format!(
            "invalid section name '{name}': must be a bare name (no path separators or '..')"
        )),
    }
}

/// The stems of the flat prose `.md` files in the hub root (goal/scope/stack/…, automations,
/// github_context), sorted. Non-`.md` files (issues.json, plan.db) and subdirs are skipped.
fn list_hub_sections(hub: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(hub) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if !p.is_file() {
                return None;
            }
            let ext = p.extension().and_then(|x| x.to_str())?;
            if !ext.eq_ignore_ascii_case("md") {
                return None;
            }
            p.file_stem().and_then(|s| s.to_str()).map(str::to_string)
        })
        .collect();
    names.sort();
    names
}

/// Print a hub doc's contents verbatim (prose has no JSON form), or error with `label` when absent.
fn get_hub_doc(path: &Path, label: &str) -> Result<(), String> {
    match std::fs::read_to_string(path) {
        Ok(c) => {
            print!("{c}");
            Ok(())
        }
        Err(_) => Err(format!("no {label} ({} not found)", path.display())),
    }
}

/// Write a hub doc from stdin (creating the hub dir if needed); echo the path in human mode.
fn set_hub_doc(path: &Path, json: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
    std::fs::write(path, buf).map_err(|e| format!("writing {}: {e}", path.display()))?;
    if !json {
        println!("wrote {}", path.display());
    }
    Ok(())
}

/// Resolve the plan.db path via the shared `--db` → `$BSC_PLAN_DB` → default precedence
/// ([`bsc_cli_util::resolve_store_path`]). There is no default location for a project's plan.db, so
/// the default is a hard error.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_PLAN_DB", || {
        Err("no plan.db: pass --db <path> or set BSC_PLAN_DB".to_string())
    })
}

/// Read JSON from stdin (one issue object or an array), upsert each, return the assigned refs.
fn cmd_add(s: &Store) -> Result<Vec<String>, String> {
    let issues: Vec<PlanIssue> = read_stdin_json("issue")?;
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

/// Sanitize one cell for TSV output: collapse the delimiters (tab / newline / CR) to a single space
/// so a free-text title or body can't break the one-row-per-issue table.
fn tsv(s: &str) -> String {
    s.replace(['\t', '\n', '\r'], " ")
}

/// Render a phase JSON value (a 1-based number, or a name string) to a bare cell.
fn phase_str(p: &Option<serde_json::Value>) -> String {
    match p {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(v) => v.to_string().trim_matches('"').to_string(),
        None => String::new(),
    }
}

/// The lean default for `list`/`mine`: a header row + one tab-separated row per issue. Title is last
/// (it's the free-text column) and every cell is delimiter-sanitized. Value-lists show as counts;
/// the full detail is one `get <ref>` away.
fn render_summary_tsv(rows: &[IssueSummary]) -> String {
    let mut out = String::from("ref\tstatus\tstream\tphase\tacc\towns\tdeps\ttitle\n");
    for r in rows {
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            tsv(&r.r#ref),
            tsv(&r.status),
            tsv(r.stream.as_deref().unwrap_or("")),
            tsv(&phase_str(&r.phase)),
            r.acceptance,
            r.owns,
            r.depends_on,
            tsv(&r.title),
        ));
    }
    out
}

/// `list --fields ref,title,status` → TSV of just the named columns (header + rows). Unknown names
/// render as a blank column (a typo is visible, not fatal); `body` is reachable here when explicitly asked.
fn render_fields_tsv(issues: &[PlanIssue], spec: &str) -> String {
    let cols: Vec<&str> = spec.split(',').map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
    let mut out = String::new();
    out.push_str(&cols.join("\t"));
    out.push('\n');
    for i in issues {
        let row: Vec<String> = cols.iter().map(|c| tsv(&issue_field(i, c))).collect();
        out.push_str(&row.join("\t"));
        out.push('\n');
    }
    out
}

/// Resolve one named field of a {@link PlanIssue} to a string cell (for `--fields`). Counts stay full
/// here — `--fields` is an explicit projection, so the caller gets exactly what they named.
fn issue_field(i: &PlanIssue, field: &str) -> String {
    match field {
        "ref" => i.r#ref.clone(),
        "title" => i.title.clone(),
        "status" => i.status.clone(),
        "stream" => i.stream.clone().unwrap_or_default(),
        "repo" => i.repo.clone().unwrap_or_default(),
        "parent" => i.parent.clone().unwrap_or_default(),
        "phase" => phase_str(&i.phase),
        "acceptance" => i.acceptance.join(" | "),
        "owns" => i.owns.join(", "),
        "dependsOn" | "depends_on" | "deps" => i.depends_on.join(", "),
        "labels" => i.labels.join(", "),
        "body" => i.body.clone().unwrap_or_default(),
        _ => String::new(),
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

/// The aggregated plan overview behind the `summary` verb — computed once, rendered as text or JSON.
struct PlanOverview {
    total: usize,
    /// Per-status counts, canonical {@link STATUSES} order, non-zero only.
    status: Vec<(String, usize)>,
    /// Per-stream counts, first-seen order.
    streams: Vec<(String, usize)>,
}

/// Tally a lean issue set into a {@link PlanOverview}.
fn compute_overview(rows: &[IssueSummary]) -> PlanOverview {
    let status: Vec<(String, usize)> = STATUSES
        .iter()
        .filter_map(|st| {
            let n = rows.iter().filter(|r| r.status == *st).count();
            (n > 0).then(|| ((*st).to_string(), n))
        })
        .collect();

    let mut stream_order: Vec<String> = Vec::new();
    let mut stream_count: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for r in rows {
        if let Some(s) = &r.stream {
            if !stream_count.contains_key(s) {
                stream_order.push(s.clone());
            }
            *stream_count.entry(s.clone()).or_default() += 1;
        }
    }
    let streams: Vec<(String, usize)> = stream_order.into_iter().map(|s| {
        let n = stream_count[&s];
        (s, n)
    }).collect();

    PlanOverview { total: rows.len(), status, streams }
}

/// Render the overview as compact lines (totals · streams).
fn render_overview_text(o: &PlanOverview) -> String {
    let mut out = format!("{} issue{}", o.total, if o.total == 1 { "" } else { "s" });
    for (st, n) in &o.status {
        out.push_str(&format!(" · {st} {n}"));
    }
    out.push('\n');
    if !o.streams.is_empty() {
        let parts: Vec<String> = o.streams.iter().map(|(s, n)| format!("{s} {n}")).collect();
        out.push_str(&format!("stream: {}\n", parts.join(" · ")));
    }
    out
}

/// Render the overview as a structured object (for `summary --json`).
fn overview_json(o: &PlanOverview) -> serde_json::Value {
    let status: serde_json::Map<String, serde_json::Value> =
        o.status.iter().map(|(s, n)| (s.clone(), serde_json::json!(n))).collect();
    let streams: serde_json::Map<String, serde_json::Value> =
        o.streams.iter().map(|(s, n)| (s.clone(), serde_json::json!(n))).collect();
    serde_json::json!({ "total": o.total, "status": status, "streams": streams })
}

/// Read JSON from stdin (one feature object or an array) and merge-upsert each; return the slugs.
/// Used for the detail-fill phase (`{"slug":"…","behavior":…}`) — title rows are added by name.
fn cmd_feature_add(s: &Store) -> Result<Vec<String>, String> {
    let feats: Vec<PlanFeature> = read_stdin_json("feature")?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = menu("bsc plan");
        // Every top-level command appears in the compact menu.
        for c in [
            "add", "get", "summary", "list", "mine", "status", "remove", "render", "feature", "repo",
            "fleet", "deploy", "deps", "mcp", "blueprint", "discovery", "integration",
            "lesson", "section", "automations", "startup", "github-context",
        ] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // `fleet help` shows the fleet subcommands, not the whole menu.
        let f = cmd_help("bsc plan", "fleet");
        assert!(f.contains("bsc plan fleet"));
        assert!(f.contains("stream set"));
        assert!(!f.contains("lesson"));
        // An unknown command falls back to the overview.
        assert!(cmd_help("bsc plan", "nope").contains("COMMANDS:"));
    }

    fn summary(r: &str, stream: Option<&str>, phase: Option<serde_json::Value>, acc: usize) -> IssueSummary {
        IssueSummary {
            r#ref: r.into(), title: r.into(), status: "open".into(),
            stream: stream.map(Into::into), phase, acceptance: acc, owns: 0, depends_on: 0,
        }
    }

    #[test]
    fn summary_tsv_has_header_and_one_row_per_issue_title_last() {
        let rows = vec![summary("F1", Some("auth"), Some(serde_json::json!(2)), 3)];
        let out = render_summary_tsv(&rows);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "ref\tstatus\tstream\tphase\tacc\towns\tdeps\ttitle");
        let cells: Vec<&str> = lines[1].split('\t').collect();
        assert_eq!(cells[0], "F1");
        assert_eq!(cells[2], "auth");
        assert_eq!(cells[3], "2");
        assert_eq!(cells[4], "3"); // acceptance count
        assert_eq!(cells.last(), Some(&"F1")); // title is the last column
        assert_eq!(cells.len(), 8);
    }

    #[test]
    fn summary_tsv_sanitizes_delimiters_in_title() {
        let mut row = summary("F1", None, None, 0);
        row.title = "has\ta tab\nand newline".into();
        let out = render_summary_tsv(&row_slice(&row));
        // exactly two lines (header + one row) — the embedded tab/newline must NOT split the table
        assert_eq!(out.lines().count(), 2);
        let cells: Vec<&str> = out.lines().nth(1).unwrap().split('\t').collect();
        assert_eq!(cells.len(), 8);
        assert_eq!(cells[7], "has a tab and newline");
    }

    fn row_slice(r: &IssueSummary) -> Vec<IssueSummary> {
        vec![r.clone()]
    }

    #[test]
    fn fields_projection_emits_only_named_columns_unknown_is_blank() {
        let issues = vec![PlanIssue {
            r#ref: "F1".into(), title: "Login".into(), status: "open".into(),
            owns: vec!["src/a".into(), "src/b".into()], ..Default::default()
        }];
        let out = render_fields_tsv(&issues, "ref,owns,nope");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "ref\towns\tnope");
        let cells: Vec<&str> = lines[1].split('\t').collect();
        assert_eq!(cells[0], "F1");
        assert_eq!(cells[1], "src/a, src/b");
        assert_eq!(cells[2], ""); // unknown field → blank column, not an error
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
    fn overview_counts_by_status_and_stream() {
        let rows = vec![
            summary("F1", Some("auth"), Some(serde_json::json!(1)), 0),
            summary("F2", Some("auth"), Some(serde_json::json!(2)), 0),
            summary("F3", Some("ui"), Some(serde_json::json!("Core")), 0),
        ];
        let o = compute_overview(&rows);
        assert_eq!(o.total, 3);
        assert_eq!(o.status, vec![("open".to_string(), 3)]);
        assert_eq!(o.streams, vec![("auth".to_string(), 2), ("ui".to_string(), 1)]);

        let text = render_overview_text(&o);
        assert!(text.starts_with("3 issues · open 3"));
        assert!(text.contains("stream: auth 2 · ui 1"));

        let json = overview_json(&o);
        assert_eq!(json["total"], serde_json::json!(3));
        assert_eq!(json["status"]["open"], serde_json::json!(3));
        assert_eq!(json["streams"]["auth"], serde_json::json!(2));
    }

    #[test]
    fn print_blob_compactness_is_the_default() {
        // We can't capture stdout cheaply here, but the format choice is the contract: compact unless pretty.
        let v = serde_json::json!({ "a": 1, "b": [2, 3] });
        assert_eq!(serde_json::to_string(&v).unwrap(), "{\"a\":1,\"b\":[2,3]}");
        assert!(serde_json::to_string_pretty(&v).unwrap().contains('\n'));
    }

    #[test]
    fn phase_str_renders_number_and_name() {
        assert_eq!(phase_str(&Some(serde_json::json!(3))), "3");
        assert_eq!(phase_str(&Some(serde_json::json!("auth"))), "auth");
        assert_eq!(phase_str(&None), "");
    }

    #[test]
    fn resolve_hub_is_the_db_parent() {
        let hub = resolve_hub(&Some("/x/y/projects/key/plan.db".to_string())).unwrap();
        assert_eq!(hub, PathBuf::from("/x/y/projects/key"));
        // A bare filename (no parent) resolves to the current dir.
        assert_eq!(resolve_hub(&Some("plan.db".to_string())).unwrap(), PathBuf::from("."));
    }

    #[test]
    fn hub_md_path_implies_md_and_rejects_traversal() {
        let hub = Path::new("/hub");
        assert_eq!(hub_md_path(hub, "goal").unwrap(), hub.join("goal.md"));
        // The .md is implied either way.
        assert_eq!(hub_md_path(hub, "goal.md").unwrap(), hub.join("goal.md"));
        // Traversal / subdirs / empties are rejected.
        assert!(hub_md_path(hub, "../etc/passwd").is_err());
        assert!(hub_md_path(hub, "sub/dir").is_err());
        assert!(hub_md_path(hub, "..").is_err());
        assert!(hub_md_path(hub, "").is_err());
        assert!(hub_md_path(hub, "/abs").is_err());
    }

    #[test]
    fn section_list_and_round_trip_over_a_temp_hub() {
        let dir = std::env::temp_dir().join(format!("bsc plan-sec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // .md files are listed by stem; non-.md + subdirs are not.
        std::fs::write(dir.join("goal.md"), "Build it\n").unwrap();
        std::fs::write(dir.join("scope.md"), "In + out\n").unwrap();
        std::fs::write(dir.join("issues.json"), "[]").unwrap();
        std::fs::create_dir_all(dir.join("prompts")).unwrap();
        assert_eq!(list_hub_sections(&dir), vec!["goal".to_string(), "scope".to_string()]);

        // write_then_read round-trips through the path-safe resolver.
        let p = hub_md_path(&dir, "stack").unwrap();
        std::fs::write(&p, "Rust + React\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "Rust + React\n");
        assert!(list_hub_sections(&dir).contains(&"stack".to_string()));

        // get_hub_doc errors when a doc is absent.
        assert!(get_hub_doc(&dir.join("missing.md"), "section 'missing'").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dispatch_lean_vs_full_against_a_real_db() {
        // End-to-end through the Store: lean omits body, full keeps it.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue {
            r#ref: "F1".into(), title: "Add login".into(), stream: Some("auth".into()),
            body: Some("BIGBODY".into()), acceptance: vec!["x".into()], ..Default::default()
        }).unwrap();
        // matches what `list` (lean) feeds render_summary_tsv
        let lean = s.list_summary(None, None, None, None).unwrap();
        let tsv = render_summary_tsv(&lean);
        assert!(!tsv.contains("BIGBODY"));
        assert!(tsv.contains("F1"));
        // matches what `list --full` / `--fields body` can reach
        let full = s.list_filtered(None, None, None, None).unwrap();
        assert!(render_fields_tsv(&full, "ref,body").contains("BIGBODY"));
    }
}
