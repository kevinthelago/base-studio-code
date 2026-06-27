//! `bsc-project` — the agent-facing CLI over the cross-project hub layout (#1720). Unlike `bsc-plan`
//! (scoped to ONE project's plan.db), this lists every local project under
//! `~/.base-studio-code/projects/` and reads/sets the in-place `.published` marker — the
//! hub-lifecycle view, not tied to one plan.db. Installed per-session like the other `bsc-*` helpers
//! and execed by absolute path from `$BSC_PROJECT_BIN`.
//!
//! Commands:
//!   bsc-project list                    # key + published + path for every local project (TSV; --json array)
//!   bsc-project published get <key>     # whether <key> is published
//!   bsc-project published set <key>     # mark <key> published (writes the .published marker)
//! Global flags: --json

use bsc_project::{is_published, list_projects, mark_published};
use std::process::ExitCode;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-project", run)
}

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
    match cmd.as_str() {
        "list" => cmd_list(&args),
        "published" => cmd_published(&args),
        other => Err(format!("unknown command '{other}'\n\n{USAGE}")),
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
fn cmd_published(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    match sub {
        "get" => {
            let key = args.positional.get(2).ok_or("usage: bsc-project published get <key>")?;
            let pub_ = is_published(key);
            if args.json {
                println!("{pub_}");
            } else {
                println!("{}", if pub_ { "published" } else { "unpublished" });
            }
            Ok(())
        }
        "set" => {
            let key = args.positional.get(2).ok_or("usage: bsc-project published set <key>")?;
            mark_published(key)?;
            if !args.json {
                println!("marked {key} published");
            }
            Ok(())
        }
        other => Err(format!("unknown published command '{other}'\n\n{USAGE}")),
    }
}

const USAGE: &str = "\
bsc-project — the cross-project hub lifecycle (#1720)

USAGE:
  bsc-project <command> [args] [--json]

COMMANDS:
  list                          key + published + path for every local project (TSV; --json array)
  published get <key>           print whether <key> is published
  published set <key>           mark <key> published (writes the in-place .published marker)

Projects live under ~/.base-studio-code/projects/<key>/; published-ness is the in-place .published
marker (#922). For a single project's plan + prose, use `bsc-plan` instead.
";

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
}
