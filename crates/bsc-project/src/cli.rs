//! The `bsc project` subcommand (#1877) — the agent-facing CLI over the cross-project hub layout
//! (#1720). Unlike `bsc plan` (scoped to ONE project's plan.db), this lists every local project
//! under `~/.base-studio-code/projects/` and reads/sets the in-place `.published` marker.
//!
//! Extracted from the old `bsc-project` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the per-command help (#1762) is unchanged:
//!   bsc project help            # compact menu
//!   bsc project published help  # detailed help for ONE command
//!   bsc project <cmd> help      # same, after any command

use crate::{add_link, is_published, list_projects, load_links, mark_published, remove_link};
use bsc_cli_util::CmdDoc;

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
        summary: "list / add / remove project relationships (the Glance network edges, #2253)",
        usage: "\
USAGE:
  bsc project link list [--json]              # every project relationship
  bsc project link add <from> <to> <kind>     # add from->to over api|data|events (idempotent; prints the id)
  bsc project link remove <id>                # remove by id (id is \"<from>><to>:<kind>\")

A link records that project <from> depends on / consumes project <to> over a contract of <kind>
(api | data | events). Global (not tied to one plan.db); stored in ~/.base-studio-code/project-links.json.
Agents read `link list --json` to learn what their project consumes.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    json: bool,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { json: false, positional: Vec::new() };
    for arg in raw {
        match arg.as_str() {
            "--json" => a.json = true,
            // `-h`/`--help` route to the help command (anywhere on the line).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
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
                let arr: Vec<serde_json::Value> = links
                    .iter()
                    .map(|l| serde_json::json!({ "id": l.id, "from": l.from, "to": l.to, "kind": l.kind }))
                    .collect();
                println!("{}", serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into()));
            } else if links.is_empty() {
                println!("(no project links)");
            } else {
                for l in &links {
                    println!("{}\t{} -> {} ({})", l.id, l.from, l.to, l.kind);
                }
            }
            Ok(())
        }
        "add" => {
            let from = args.positional.get(2).ok_or("usage: bsc project link add <from> <to> <kind>")?;
            let to = args.positional.get(3).ok_or("usage: bsc project link add <from> <to> <kind>")?;
            let kind = args.positional.get(4).ok_or("usage: bsc project link add <from> <to> <kind>")?;
            let id = add_link(from, to, kind)?;
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
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc project", TAGLINE, COMMANDS);
        assert!(ov.contains("list"));
        assert!(ov.contains("published"));
        assert!(ov.contains("link"));
        // The link command's help drills into its add/remove subcommands.
        let link = bsc_cli_util::help_for("bsc project", TAGLINE, COMMANDS, "link");
        assert!(link.contains("bsc project link"));
        assert!(link.contains("add"));
        // Per-command help shows that one command's detail (incl. its subcommands).
        let one = bsc_cli_util::help_for("bsc project", TAGLINE, COMMANDS, "published");
        assert!(one.contains("bsc project published"));
        assert!(one.contains("set"));
        assert!(!one.contains("list"));
        // An unknown command falls back to the overview.
        let miss = bsc_cli_util::help_for("bsc project", TAGLINE, COMMANDS, "nope");
        assert!(miss.contains("COMMANDS:"));
    }
}
