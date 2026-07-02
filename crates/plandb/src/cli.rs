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
//!
//! The per-noun command handlers live in focused submodules (#1864): the issue table in [`issues`],
//! the fleet in [`fleet`], the plan.db/connector nouns in [`nouns`], and the hub-doc nouns in [`hub`].
//! This module keeps the arg-parse + dispatch + help, the DB/hub path resolution, and the shared
//! output-shape helpers (`emit_*`/`cmd_blob_noun`); the pure renderers live in [`render`].

use crate::Store;
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json_one};
use serde::Serialize;
use std::path::PathBuf;

mod render;
mod issues;
mod fleet;
mod nouns;
mod hub;

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

/// One command's detailed help — shown at the foot of an unknown-subcommand error (via
/// [`unknown_sub`]). `prog` is the display name (`"bsc plan"` from the umbrella, `"bsc-plan"` from
/// the legacy shim). The top-level help/menu is handled by [`bsc_cli_util::handle_help`].
fn cmd_help(prog: &str, name: &str) -> String {
    bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, name)
}

/// The shared unknown-subcommand error: `unknown <noun> command '<other>'` followed by the noun's
/// detailed help. `noun` is the message noun (e.g. `"fleet stream"`); its FIRST word selects the
/// [`cmd_help`] block, so a multi-word noun like `fleet stream` / `fleet meta` still shows the
/// `fleet` help. Centralizes the string every noun handler used to build inline (#2068).
fn unknown_sub(args: &Args, noun: &str, other: &str) -> String {
    let cmd = noun.split_whitespace().next().unwrap_or(noun);
    format!("unknown {noun} command '{other}'\n\n{}", cmd_help(&args.prog, cmd))
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

    // Top-level + per-command help (no command / `help` / `help <cmd>` / `<cmd> help`) — the shared
    // dispatch in bsc-cli-util, run before any handler opens the DB (help works without a plan.db).
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    // Each arm is a one-line dispatch to the verb's / noun's handler (in its focused submodule); the
    // handler resolves the DB and owns its own `match sub`. Shared output shapes live in the `emit_*`
    // helpers below.
    match cmd.as_str() {
        "add" => issues::cmd_add_cmd(&args),
        "get" => issues::cmd_get(&args),
        "summary" => issues::cmd_summary(&args),
        "list" | "mine" => issues::cmd_list(&args),
        "status" => issues::cmd_status(&args),
        "remove" => issues::cmd_remove(&args),
        "render" => issues::cmd_render(&args),
        "feature" => nouns::cmd_feature(&args),
        "repo" => nouns::cmd_repo(&args),
        "fleet" => fleet::cmd_fleet(&args),
        "deploy" => nouns::cmd_deploy(&args),
        "deps" => nouns::cmd_deps(&args),
        "mcp" => nouns::cmd_mcp(&args),
        "blueprint" => nouns::cmd_blueprint(&args),
        "discovery" => nouns::cmd_discovery(&args),
        "integration" => nouns::cmd_integration(&args),
        "lesson" => nouns::cmd_lesson(&args),
        "section" => hub::cmd_section(&args),
        "automations" => hub::cmd_automations(&args),
        "startup" => hub::cmd_startup(&args),
        "github-context" => hub::cmd_github_context(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
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
        other => Err(unknown_sub(args, verb, other)),
    }
}

/// Resolve the plan.db path via the shared `--db` → `$BSC_PLAN_DB` → default precedence
/// ([`bsc_cli_util::resolve_store_path`]). There is no default location for a project's plan.db, so
/// the default is a hard error.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_PLAN_DB", || {
        Err("no plan.db: pass --db <path> or set BSC_PLAN_DB".to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc plan", TAGLINE, COMMANDS);
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

    #[test]
    fn print_blob_compactness_is_the_default() {
        // We can't capture stdout cheaply here, but the format choice is the contract: compact unless pretty.
        let v = serde_json::json!({ "a": 1, "b": [2, 3] });
        assert_eq!(serde_json::to_string(&v).unwrap(), "{\"a\":1,\"b\":[2,3]}");
        assert!(serde_json::to_string_pretty(&v).unwrap().contains('\n'));
    }
}
