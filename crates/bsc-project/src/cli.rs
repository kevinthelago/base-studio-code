//! The `bsc project` subcommand (#1877) — the agent-facing CLI over the cross-project hub layout
//! (#1720). Unlike `bsc plan` (scoped to ONE project's plan.db), this lists every local project
//! under `~/.base-studio-code/projects/` and reads/sets the in-place `.published` marker.
//!
//! Extracted from the old `bsc-project` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the per-command help (#1762) is unchanged:
//!   bsc project help            # compact menu
//!   bsc project published help  # detailed help for ONE command
//!   bsc project <cmd> help      # same, after any command

use crate::store::{self, ProjectRow};
use crate::{
    add_contract, is_published, list_projects, load_github_state, load_links, mark_published,
    remove_link, save_github_state, target_to_json, ContractTarget,
};
use bsc_cli_util::CmdDoc;
use serde::Deserialize;

/// The stdin shape `db add` reads — one JSON object. `pitch` defaults to `""` and `state` to
/// `"drafted"` when absent; `blueprint`/`category` are nullable. Timestamps are NOT read from stdin —
/// the CLI stamps `createdAt`/`updatedAt` itself (epoch millis).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddInput {
    key: String,
    title: String,
    #[serde(default)]
    pitch: String,
    blueprint: Option<String>,
    category: Option<String>,
    state: Option<String>,
}

const TAGLINE: &str =
    "the cross-project hub lifecycle — list local projects + the .published marker (#1720)";

/// The command catalog — drives both dispatch and the shared help system. One detailed `usage` block
/// per top-level command keeps the overview tiny and the detail one-fetch-away.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "key + published + path for every local project",
        usage: "\
USAGE:
  bsc project list [--json]

Prints one row per local project under ~/.base-studio-code/projects/ — its key, whether it is
published, and its absolute path. TSV by default; --json emits an array of { key, published, path }.",
    },
    CmdDoc {
        name: "published",
        summary: "read or set a project's .published marker",
        usage: "\
USAGE:
  bsc project published get <key>     # print whether <key> is published
  bsc project published set <key>     # mark <key> published (writes the in-place .published marker)

Published-ness is the in-place .published marker under the project hub (#922) — setting it never
moves the hub directory. For a single project's plan + prose, use `bsc plan` instead.",
    },
    CmdDoc {
        name: "link",
        summary: "list / add / remove inter-app contracts (the Glance network edges, #2253/#3786)",
        usage: "\
USAGE:
  bsc project link list [--json]              # every contract (--json includes the target endpoint)
  bsc project link add <from> <to> <kind> [target flags]   # add from->to over api|data|events (idempotent; prints the id)
  bsc project link remove <id>                # remove by id (id is \"<from>><to>:<kind>\")

  target flags for `add` (#3786 — default is another project):
    --target-type project|service|mcp   # what <to> is: another project (default), an external service, or an mcp server
    --name <name>                       # display name of the external endpoint
    --url <url>                         # endpoint URL (an http service / mcp server)
    --app-type <type>                   # endpoint app type (api | serverless | static | …), shown on the Glance node

A contract records that project <from> depends on / consumes <to> over <kind> (api | data | events).
<to> is another project by default, or an external service / mcp server via --target-type. Global (not
tied to one plan.db); stored in ~/.base-studio-code/project-links.json. Agents read `link list --json`
to learn what their project consumes; the desktop Glance draws each contract as an edge (external
service/mcp targets render as their own contract node).

  e.g.  bsc project link add my-app postgres data --target-type mcp --app-type serverless
        bsc project link add my-app stripe api --target-type service --url https://api.stripe.com --app-type api",
    },
    CmdDoc {
        name: "github-state",
        summary: "read or replace the persisted last-known GitHub board state (#2446)",
        usage: "\
USAGE:
  bsc project github-state [get]      # print the persisted board-state JSON
  bsc project github-state set        # replace it wholesale from a JSON body on stdin

The desktop app mirrors its last successful GitHub projects fetch here
(~/.base-studio-code/github-state.json) so the last-known board state is reachable offline:
{ records: [{ id, number, title, shortDescription, url, closed, updatedAt, itemsTotalCount,
openCount, closedCount, repos }, ...], fetchedAt: <epoch ms> }. `set` expects that whole envelope
on stdin and rejects anything else, so a malformed write never clobbers the last good state.",
    },
    CmdDoc {
        name: "db",
        summary: "the durable projects store — add/get/list/remove/state over projects.db (#2995)",
        usage: "\
USAGE:
  bsc project db add                  # upsert one project from a JSON object on stdin; prints the stored row
  bsc project db get <key>            # print the project row JSON, or null
  bsc project db list                 # print a JSON array of every project row
  bsc project db remove <key>         # delete by key; prints { \"removed\": <bool> }
  bsc project db state <key> <state>  # set the lifecycle state; prints the row, or errors if <key> is absent

The durable source of truth for what projects/drafts exist — SQLite at ~/.base-studio-code/projects.db
(override with $BSC_PROJECT_DB), separate from the disk-scan `list` (which walks the on-disk hubs).
`add` reads { key, title, pitch?, blueprint?, category?, state? } (pitch defaults \"\", state \"drafted\");
it stamps createdAt on a NEW key and preserves it on an update, always bumping updatedAt. Every row is
{ key, title, pitch, blueprint, category, state, createdAt, updatedAt } (blueprint/category nullable).",
    },
];

/// Parsed global flags + the `link add` contract-target flags (#3786) + leftover positional args.
struct Args {
    json: bool,
    /// `--target-type project|service|mcp` (default project) — the endpoint kind a contract points at.
    target_type: Option<String>,
    /// `--name` — display name of an external endpoint.
    name: Option<String>,
    /// `--url` — the endpoint URL.
    url: Option<String>,
    /// `--app-type` — the endpoint's application-architecture discriminator (api | serverless | …).
    app_type: Option<String>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { json: false, target_type: None, name: None, url: None, app_type: None, positional: Vec::new() };
    // A value flag consumes the NEXT token, so iterate with an index rather than a plain for-each.
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        // The value flags (#3786) take `<flag> <value>`; missing the value is an error.
        let mut take = |flag: &str| it.next().ok_or_else(|| format!("{flag} needs a value"));
        match arg.as_str() {
            "--json" => a.json = true,
            // `-h`/`--help` route to the help command (anywhere on the line).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            "--target-type" => a.target_type = Some(take("--target-type")?),
            "--name" => a.name = Some(take("--name")?),
            "--url" => a.url = Some(take("--url")?),
            "--app-type" => a.app_type = Some(take("--app-type")?),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `project` subcommand entrypoint: `args` is everything after `bsc project`; `prog` is the
/// display name for help/errors (`"bsc project"` from the umbrella, `"bsc-project"` from the legacy
/// shim). Handles help (no command / `help` / `help <cmd>` / `<cmd> help`) before any store read.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "list" => cmd_list(&args),
        "published" => cmd_published(&args, prog),
        "link" => cmd_link(&args, prog),
        "github-state" => cmd_github_state(&args, prog),
        "db" => cmd_db(&args, prog),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `list` — every local project: key + published + absolute path. Human TSV (one row each) or, with
/// `--json`, an array of `{ key, published, path }`.
fn cmd_list(args: &Args) -> Result<(), String> {
    let projects = list_projects();
    if args.json {
        let arr: Vec<serde_json::Value> = projects
            .iter()
            .map(|p| serde_json::json!({ "key": p.key, "published": p.published, "path": p.path.to_string_lossy() }))
            .collect();
        println!("{}", serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into()));
    } else if projects.is_empty() {
        println!("(no local projects)");
    } else {
        for p in &projects {
            println!(
                "{}\t{}\t{}",
                p.key,
                if p.published { "published" } else { "unpublished" },
                p.path.to_string_lossy()
            );
        }
    }
    Ok(())
}

/// `published get|set <key>` — read or set a project's in-place `.published` marker.
fn cmd_published(args: &Args, prog: &str) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "get" => {
            let key = args.positional.get(2).ok_or("usage: bsc project published get <key>")?;
            let pub_ = is_published(key);
            if args.json {
                println!("{pub_}");
            } else {
                println!("{}", if pub_ { "published" } else { "unpublished" });
            }
            Ok(())
        }
        "set" => {
            let key = args.positional.get(2).ok_or("usage: bsc project published set <key>")?;
            mark_published(key)?;
            if !args.json {
                println!("marked {key} published");
            }
            Ok(())
        }
        other => Err(format!(
            "unknown published command '{other}'\n\n{}",
            bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "published")
        )),
    }
}

/// `link list|add|remove` — the project-relationship edges (#2253). Defaults to `list`.
fn cmd_link(args: &Args, prog: &str) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("list");
    match sub {
        "list" => {
            let links = load_links();
            if args.json {
                // Every row emits its target endpoint (#3786) so the desktop cache + agents see the full
                // contract; a legacy project link reads back as `{ "type": "project" }`.
                let arr: Vec<serde_json::Value> = links
                    .iter()
                    .map(|l| serde_json::json!({ "id": l.id, "from": l.from, "to": l.to, "kind": l.kind, "target": target_to_json(&l.target) }))
                    .collect();
                println!("{}", serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into()));
            } else if links.is_empty() {
                println!("(no project links)");
            } else {
                for l in &links {
                    // Human view: annotate a non-project target so the endpoint kind is visible at a glance.
                    let via = if l.target.kind == "project" { String::new() } else { format!(" [{}]", l.target.kind) };
                    println!("{}\t{} -> {}{} ({})", l.id, l.from, l.to, via, l.kind);
                }
            }
            Ok(())
        }
        "add" => {
            let from = args.positional.get(2).ok_or("usage: bsc project link add <from> <to> <kind> [--target-type project|service|mcp] [--name …] [--url …] [--app-type …]")?;
            let to = args.positional.get(3).ok_or("usage: bsc project link add <from> <to> <kind>")?;
            let kind = args.positional.get(4).ok_or("usage: bsc project link add <from> <to> <kind>")?;
            // The target endpoint (#3786) — default is another project when no --target-type is given.
            let target = ContractTarget {
                kind: args.target_type.clone().unwrap_or_else(|| "project".into()),
                name: args.name.clone(),
                url: args.url.clone(),
                app_type: args.app_type.clone(),
            };
            let id = add_contract(from, to, kind, target)?;
            println!("{id}");
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(2).ok_or("usage: bsc project link remove <id>")?;
            remove_link(id)?;
            if !args.json {
                println!("removed {id}");
            }
            Ok(())
        }
        other => Err(format!(
            "unknown link command '{other}'\n\n{}",
            bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "link")
        )),
    }
}

/// `github-state [get]|set` — the persisted last-known GitHub board state (#2446). Defaults to
/// `get`; `set` reads the whole `{ records, fetchedAt }` envelope from stdin (validated by
/// `save_github_state`).
fn cmd_github_state(args: &Args, prog: &str) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("get");
    match sub {
        "get" => {
            match load_github_state() {
                // The state IS JSON — print it verbatim in both modes (`null` when absent under --json).
                Some(json) => println!("{json}"),
                None if args.json => println!("null"),
                None => println!("(no github state — no fetch has been mirrored yet)"),
            }
            Ok(())
        }
        "set" => {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
            save_github_state(&buf)?;
            if !args.json {
                println!("saved");
            }
            Ok(())
        }
        other => Err(format!(
            "unknown github-state command '{other}'\n\n{}",
            bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "github-state")
        )),
    }
}

/// `db add|get|list|remove|state` — the durable projects store (#2995). Timestamps (epoch millis)
/// are stamped HERE via `bsc_util::now_ms` so the store fns stay clock-free. Every verb prints
/// machine JSON on stdout (the frontend/agent contract), independent of the `--json` flag.
fn cmd_db(args: &Args, prog: &str) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "add" => {
            let input: AddInput = bsc_sqlite_util::read_stdin_json_one("project")?;
            let now = bsc_util::now_ms();
            let conn = store::open()?;
            // Get-then-upsert so a NEW key stamps createdAt=now while an existing key keeps its
            // original createdAt (the upsert SQL also preserves it — this belt-and-suspenders keeps
            // the printed row correct even on the insert branch).
            let created_at = store::get(&conn, &input.key).map(|r| r.created_at).unwrap_or(now);
            let row = ProjectRow {
                key: input.key,
                title: input.title,
                pitch: input.pitch,
                blueprint: input.blueprint,
                category: input.category,
                state: input.state.unwrap_or_else(|| "drafted".into()),
                created_at,
                updated_at: now,
            };
            store::upsert(&conn, &row)?;
            let stored = store::get(&conn, &row.key).ok_or("db add: row vanished after upsert")?;
            bsc_sqlite_util::print_json(&stored, false);
            Ok(())
        }
        "get" => {
            let key = args.positional.get(2).ok_or("usage: bsc project db get <key>")?;
            let conn = store::open()?;
            // `Option<ProjectRow>` → the row object, or JSON `null` on a miss.
            bsc_sqlite_util::print_json(&store::get(&conn, key), false);
            Ok(())
        }
        "list" => {
            let conn = store::open()?;
            bsc_sqlite_util::print_json(&store::list(&conn), false);
            Ok(())
        }
        "remove" => {
            let key = args.positional.get(2).ok_or("usage: bsc project db remove <key>")?;
            let conn = store::open()?;
            let removed = store::remove(&conn, key)?;
            bsc_sqlite_util::print_json(&serde_json::json!({ "removed": removed }), false);
            Ok(())
        }
        "state" => {
            let key = args.positional.get(2).ok_or("usage: bsc project db state <key> <state>")?;
            let state = args.positional.get(3).ok_or("usage: bsc project db state <key> <state>")?;
            let conn = store::open()?;
            let row = store::set_state(&conn, key, state, bsc_util::now_ms())?
                .ok_or_else(|| format!("db state: no project '{key}'"))?;
            bsc_sqlite_util::print_json(&row, false);
            Ok(())
        }
        other => Err(format!(
            "unknown db command '{other}'\n\n{}",
            bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "db")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_collects_positionals_and_json_flag() {
        let a = parse_args(vec!["published".into(), "get".into(), "my-key".into(), "--json".into()]).unwrap();
        assert!(a.json);
        assert_eq!(a.positional, vec!["published", "get", "my-key"]);
    }

    #[test]
    fn parse_args_rejects_an_unknown_flag() {
        assert!(parse_args(vec!["list".into(), "--nope".into()]).is_err());
    }

    #[test]
    fn parse_args_collects_the_contract_target_flags() {
        let a = parse_args(vec![
            "link".into(), "add".into(), "app".into(), "stripe".into(), "api".into(),
            "--target-type".into(), "service".into(),
            "--name".into(), "Stripe".into(),
            "--url".into(), "https://api.stripe.com".into(),
            "--app-type".into(), "api".into(),
        ])
        .unwrap();
        assert_eq!(a.target_type.as_deref(), Some("service"));
        assert_eq!(a.name.as_deref(), Some("Stripe"));
        assert_eq!(a.url.as_deref(), Some("https://api.stripe.com"));
        assert_eq!(a.app_type.as_deref(), Some("api"));
        assert_eq!(a.positional, vec!["link", "add", "app", "stripe", "api"]);
    }

    #[test]
    fn parse_args_errors_when_a_value_flag_has_no_value() {
        assert!(parse_args(vec!["link".into(), "add".into(), "--target-type".into()]).is_err());
    }

    #[test]
    fn link_add_dispatch_persists_a_targeted_contract() {
        crate::testhome::with_home(|_home| {
            // A default (project) contract, an mcp-targeted one, and a service-targeted one via the CLI.
            run(vec!["link".into(), "add".into(), "app".into(), "billing".into(), "api".into()], "bsc project").unwrap();
            run(
                vec![
                    "link".into(), "add".into(), "app".into(), "postgres".into(), "data".into(),
                    "--target-type".into(), "mcp".into(), "--app-type".into(), "serverless".into(),
                ],
                "bsc project",
            )
            .unwrap();
            run(
                vec![
                    "link".into(), "add".into(), "app".into(), "stripe".into(), "api".into(),
                    "--target-type".into(), "service".into(), "--url".into(), "https://api.stripe.com".into(),
                ],
                "bsc project",
            )
            .unwrap();

            let links = crate::load_links();
            assert_eq!(links.len(), 3);
            assert_eq!(links.iter().find(|l| l.id == "app>billing:api").unwrap().target.kind, "project");
            let mcp = links.iter().find(|l| l.id == "app>postgres:data").unwrap();
            assert_eq!(mcp.target.kind, "mcp");
            assert_eq!(mcp.target.app_type.as_deref(), Some("serverless"));
            assert_eq!(links.iter().find(|l| l.id == "app>stripe:api").unwrap().target.url.as_deref(), Some("https://api.stripe.com"));

            // list dispatches (both modes) without error, and an unknown target type is rejected.
            run(vec!["link".into(), "list".into(), "--json".into()], "bsc project").unwrap();
            run(vec!["link".into(), "list".into()], "bsc project").unwrap();
            assert!(run(
                vec!["link".into(), "add".into(), "a".into(), "b".into(), "api".into(), "--target-type".into(), "widget".into()],
                "bsc project",
            )
            .is_err());
        });
    }

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn github_state_cli_reads_the_persisted_state() {
        crate::testhome::with_home(|_home| {
            // Absent → still Ok (prints the no-state placeholder / `null` under --json).
            run(vec!["github-state".into()], "bsc project").unwrap();
            run(vec!["github-state".into(), "get".into(), "--json".into()], "bsc project").unwrap();
            // Once the app has mirrored a fetch, `get` reads it back (the default sub IS get).
            crate::save_github_state(r#"{"records":[],"fetchedAt":5}"#).unwrap();
            run(vec!["github-state".into()], "bsc project").unwrap();
            run(vec!["github-state".into(), "get".into()], "bsc project").unwrap();
            // An unknown sub errors with that command's help.
            let err = run(vec!["github-state".into(), "nope".into()], "bsc project").unwrap_err();
            assert!(err.contains("github-state"));
        });
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc project", TAGLINE, COMMANDS);
        assert!(ov.contains("list"));
        assert!(ov.contains("published"));
        assert!(ov.contains("link"));
        assert!(ov.contains("github-state"));
        // The link command's help drills into its add/remove subcommands + the #3786 target flags.
        let link = bsc_cli_util::help_for("bsc project", TAGLINE, COMMANDS, "link");
        assert!(link.contains("bsc project link"));
        assert!(link.contains("add"));
        assert!(link.contains("--target-type"));
        assert!(link.contains("--app-type"));
        // Per-command help shows that one command's detail (incl. its subcommands).
        let one = bsc_cli_util::help_for("bsc project", TAGLINE, COMMANDS, "published");
        assert!(one.contains("bsc project published"));
        assert!(one.contains("set"));
        assert!(!one.contains("list"));
        // An unknown command falls back to the overview.
        let miss = bsc_cli_util::help_for("bsc project", TAGLINE, COMMANDS, "nope");
        assert!(miss.contains("COMMANDS:"));
        // The new `db` command is listed, and its per-command help drills into its verbs.
        assert!(ov.contains("db"));
        let db = bsc_cli_util::help_for("bsc project", TAGLINE, COMMANDS, "db");
        assert!(db.contains("bsc project db"));
        assert!(db.contains("add"));
        assert!(db.contains("state"));
    }

    #[test]
    fn db_cli_dispatch_reads_and_mutates_a_temp_store() {
        crate::testhome::with_home(|home| {
            // Point the store at a temp file — `$BSC_PROJECT_DB` is checked first by default_path,
            // so this is deterministic regardless of the HOME/USERPROFILE precedence. `with_home`
            // holds the process-global env lock for the whole closure, so this set is race-free.
            let db = home.join("projects-cli-test.db");
            std::env::set_var("BSC_PROJECT_DB", &db);

            // Seed a row directly (the `add` verb reads real stdin, which a unit test can't drive).
            let conn = store::open().unwrap();
            store::upsert(
                &conn,
                &ProjectRow {
                    key: "alpha".into(),
                    title: "Alpha".into(),
                    pitch: String::new(),
                    blueprint: None,
                    category: None,
                    state: "drafted".into(),
                    created_at: 1,
                    updated_at: 1,
                },
            )
            .unwrap();
            drop(conn);

            // The read verbs dispatch + open the same store without error.
            run(vec!["db".into(), "get".into(), "alpha".into()], "bsc project").unwrap();
            run(vec!["db".into(), "list".into()], "bsc project").unwrap();

            // `state` hits an existing row (and actually persists the transition)…
            run(vec!["db".into(), "state".into(), "alpha".into(), "published".into()], "bsc project").unwrap();
            let conn = store::open().unwrap();
            assert_eq!(store::get(&conn, "alpha").unwrap().state, "published");
            drop(conn);
            // …and errors on an absent key.
            assert!(run(vec!["db".into(), "state".into(), "ghost".into(), "x".into()], "bsc project").is_err());

            // `remove` deletes the row; an unknown sub errors with the db help.
            run(vec!["db".into(), "remove".into(), "alpha".into()], "bsc project").unwrap();
            let conn = store::open().unwrap();
            assert!(store::get(&conn, "alpha").is_none());
            drop(conn);
            let err = run(vec!["db".into(), "nope".into()], "bsc project").unwrap_err();
            assert!(err.contains("db"));

            std::env::remove_var("BSC_PROJECT_DB");
        });
    }
}
