//! `bsc-skill` — the session-facing CLI over the GLOBAL skills + task-groups store (#1338, an
//! instance of #1325). Injected into EVERY console session (Solution B-global), so a group authored
//! in one session (the planner, or any session) is reachable + resolvable by every other live
//! session, and queryable from a session's own shell.
//!
//! The db is located via `--db <path>` or the `BSC_SKILL_DB` env var (set per-session at launch),
//! defaulting to `~/.base-studio-code/skills.db`. Output is JSON to stdout (like `bsc-plan`);
//! `resolve` prints the group's member skills (the SKILL.md-bound shape), de-duped + ordered +
//! existence-filtered.
//!
//! Commands:
//!   bsc-skill list                          # every skill, JSON
//!   bsc-skill add                           # upsert from JSON on stdin (one object or array); prints id(s)
//!   bsc-skill group add                     # upsert a group from JSON on stdin; prints id
//!   bsc-skill group list                    # every group, JSON
//!   bsc-skill group get <id>                # one group, JSON
//!   bsc-skill group remove <id>
//!   bsc-skill group member <group> <skill> [--off]   # toggle membership; prints resulting ids
//!   bsc-skill resolve <group-id>            # the group's member skills, JSON
//! Global flag: --db <path>

use skilldb::{Skill, SkillGroup, Store};
use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bsc-skill: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Parsed global flags + leftover positional args.
struct Args {
    db: Option<String>,
    off: bool,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { db: None, off: false, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--off" => a.off = true,
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

    let store = || -> Result<Store, String> {
        let path = resolve_db(&args.db)?;
        Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
    };

    match cmd.as_str() {
        "list" => {
            let s = store()?;
            let skills = s.list().map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&skills).unwrap_or_else(|_| "[]".into()));
            Ok(())
        }
        "add" => {
            let s = store()?;
            let ids = cmd_add(&s)?;
            println!("{}", serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into()));
            Ok(())
        }
        "resolve" => {
            let gid = args.positional.get(1).ok_or("usage: bsc-skill resolve <group-id>")?;
            let s = store()?;
            let skills = s.resolve(gid).map_err(|e| e.to_string())?;
            println!("{}", serde_json::to_string_pretty(&skills).unwrap_or_else(|_| "[]".into()));
            Ok(())
        }
        "group" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            let s = store()?;
            match sub {
                // `group add` reads a SkillGroup JSON on stdin and upserts it (by id); prints the id.
                "add" => {
                    let mut buf = String::new();
                    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
                    let buf = buf.trim();
                    if buf.is_empty() {
                        return Err("group add: expected a SkillGroup object as JSON on stdin".into());
                    }
                    let group: SkillGroup =
                        serde_json::from_str(buf).map_err(|e| format!("parsing group: {e}"))?;
                    if group.id.trim().is_empty() {
                        return Err("group add: the group needs a non-empty \"id\"".into());
                    }
                    let id = s.group_add(&group).map_err(|e| e.to_string())?;
                    println!("{}", serde_json::to_string(&id).unwrap_or_default());
                    Ok(())
                }
                "list" => {
                    let groups = s.group_list().map_err(|e| e.to_string())?;
                    println!("{}", serde_json::to_string_pretty(&groups).unwrap_or_else(|_| "[]".into()));
                    Ok(())
                }
                "get" => {
                    let id = args.positional.get(2).ok_or("usage: bsc-skill group get <id>")?;
                    match s.group_get(id).map_err(|e| e.to_string())? {
                        Some(g) => println!("{}", serde_json::to_string_pretty(&g).unwrap_or_default()),
                        None => println!("null"),
                    }
                    Ok(())
                }
                "remove" => {
                    let id = args.positional.get(2).ok_or("usage: bsc-skill group remove <id>")?;
                    s.group_remove(id).map_err(|e| e.to_string())?;
                    println!("{}", serde_json::to_string(id).unwrap_or_default());
                    Ok(())
                }
                // `group member <group> <skill> [--off]` toggles membership; prints the resulting ids.
                "member" => {
                    let gid = args.positional.get(2).ok_or("usage: bsc-skill group member <group> <skill> [--off]")?;
                    let sid = args.positional.get(3).ok_or("usage: bsc-skill group member <group> <skill> [--off]")?;
                    let ids = s.group_toggle_member(gid, sid, !args.off).map_err(|e| match e {
                        rusqlite::Error::QueryReturnedNoRows => format!("no group with id '{gid}'"),
                        other => other.to_string(),
                    })?;
                    println!("{}", serde_json::to_string(&ids).unwrap_or_else(|_| "[]".into()));
                    Ok(())
                }
                other => Err(format!("unknown group command '{other}'\n\n{USAGE}")),
            }
        }
        other => Err(format!("unknown command '{other}'\n\n{USAGE}")),
    }
}

/// Resolve the skills.db path: explicit `--db` wins, then `BSC_SKILL_DB`, else the default global
/// store at `~/.base-studio-code/skills.db`.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    if let Some(p) = flag {
        return Ok(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var("BSC_SKILL_DB") {
        return Ok(PathBuf::from(p));
    }
    let home = home_dir().ok_or("could not resolve a home directory; pass --db <path> or set BSC_SKILL_DB")?;
    Ok(home.join(".base-studio-code").join("skills.db"))
}

/// The user's home directory, from the platform's standard env var (no extra dependency).
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Read JSON from stdin (one skill object or an array), upsert each, return the ids.
fn cmd_add(s: &Store) -> Result<Vec<String>, String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
    let buf = buf.trim();
    if buf.is_empty() {
        return Err("add: expected a skill (or array of skills) as JSON on stdin".into());
    }
    let skills: Vec<Skill> = if buf.starts_with('[') {
        serde_json::from_str(buf).map_err(|e| format!("parsing skill array: {e}"))?
    } else {
        vec![serde_json::from_str(buf).map_err(|e| format!("parsing skill: {e}"))?]
    };
    let mut ids = Vec::new();
    for skill in &skills {
        if skill.id.trim().is_empty() {
            return Err("add: each skill needs a non-empty \"id\"".into());
        }
        s.upsert(skill).map_err(|e| e.to_string())?;
        ids.push(skill.id.clone());
    }
    Ok(ids)
}

const USAGE: &str = "\
bsc-skill — the global skills + task-groups store (#1338)

USAGE:
  bsc-skill <command> [args] [--db <path>]

SKILLS (the global library):
  list                      print every skill (JSON)
  add                       upsert from a skill object/array JSON on stdin; prints id(s)

GROUPS (task groups — named, reusable bundles of skills, toggled as one):
  group add                 upsert a group from a SkillGroup JSON on stdin; prints the id
  group list                print every group (JSON)
  group get <id>            print one group (JSON, or null)
  group remove <id>         delete a group
  group member <g> <s>      add skill <s> to group <g>  (--off removes it); prints resulting ids

RESOLVE:
  resolve <group-id>        print the group's member skills (JSON) — ordered, de-duped,
                            existence-filtered (the expandGroups semantics)

The skills.db is found via --db <path>, the BSC_SKILL_DB env var, or the default global store at
~/.base-studio-code/skills.db.
";
