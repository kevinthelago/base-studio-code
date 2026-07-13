//! The hub-doc + structured-doc nouns of `bsc plan` (#1864): `section`/`automations`/`startup`/
//! `github-context`, plus the hub-dir path helpers they share. Split out of `cli.rs` as a pure move —
//! [`super::run`] dispatches each here; the shared plumbing (`Args`/`open_store`/`emit_*`/`resolve_db`/
//! `unknown_sub`) stays in the parent module. The flat prose `.md` files live beside plan.db in the
//! hub dir; `automations`/`startup` also carry structured rows in plan.db. Output is byte-for-byte
//! what `cli.rs` emitted before the split.

use super::{emit_json_or_lines, emit_set_result, open_store, resolve_db, unknown_sub, Args};
use crate::{Automation, StartupScript};
use bsc_sqlite_util::print_json;
use std::io::Read;
use std::path::{Path, PathBuf};

/// `stage` — the project's flat prose files (goal/scope/stack/architecture/users/…). They live
/// beside plan.db in the hub dir, so this is the prose side of the same per-project plan `bsc plan`
/// already owns. Path-safe: a name is a bare stage doc (the `.md` implied), never a traversal.
pub(crate) fn cmd_stage(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let hub = resolve_hub(&args.db)?;
    match sub {
        "list" => {
            let names = list_hub_sections(&hub);
            emit_json_or_lines(args.json, &names, "(no stage docs)", |_, n| n.clone());
            Ok(())
        }
        "get" => {
            let name = args.positional.get(2).ok_or("usage: bsc plan stage get <name>")?;
            get_hub_doc(&hub_md_path(&hub, name)?, &format!("stage '{name}'"))
        }
        "set" => {
            let name = args.positional.get(2).ok_or("usage: bsc plan stage set <name>  (content on stdin)")?;
            set_hub_doc(&hub_md_path(&hub, name)?, args.json)
        }
        other => Err(unknown_sub(args, "stage", other)),
    }
}

/// `automations` — the project's assigned automations. TWO surfaces under one noun:
/// - **structured** rows in plan.db (`add`/`list`/`remove`) — the cron/on-demand recipes an agent
///   actually runs; the section poll reflects these into the app (#2009).
/// - the **prose** `automations.md` hub doc (`get`/`set`) — the human-readable recipe scratchpad.
pub(crate) fn cmd_automations(args: &Args) -> Result<(), String> {
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
        other => Err(unknown_sub(args, "automations", other)),
    }
}

/// `startup` — per-repo kickoff/triage prompt docs the planner assigns (#2010). The section poll
/// reflects these into the app so opening a repo's console (`dev`) / triage pass (`triage`) launches
/// with the assigned script. Keyed by (repo, mode); replaces the `<startup_script>` stream tag.
pub(crate) fn cmd_startup(args: &Args) -> Result<(), String> {
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
        other => Err(unknown_sub(args, "startup", other)),
    }
}

/// `github-context` — the named `github_context.md` hub doc (app-generated GitHub context). Read-only.
pub(crate) fn cmd_github_context(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let path = resolve_hub(&args.db)?.join("github_context.md");
    match sub {
        "get" => get_hub_doc(&path, "github context"),
        other => Err(unknown_sub(args, "github-context", other)),
    }
}

/// `artifact` — planner OUTPUT artifacts (#2997), durable CONTENT in plan.db keyed by (kind, name).
/// The substrate for later moving planner-produced content (discovery prose, contract specs, kickoff
/// briefs) off flat hub files and into plan.db. `set` reads the content on stdin (like the prose-doc
/// `set`s); `get`/`list` read it back; `remove` drops one. Additive + unwired — nothing else touches
/// it yet.
pub(crate) fn cmd_artifact(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    match sub {
        // `artifact set <kind> <name>` — content on stdin → upsert.
        "set" => {
            let kind = args
                .positional
                .get(2)
                .ok_or("usage: bsc plan artifact set <kind> <name>  (content on stdin)")?;
            let name = args
                .positional
                .get(3)
                .ok_or("usage: bsc plan artifact set <kind> <name>  (content on stdin)")?;
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
            open_store(&args.db)?.artifact_set(kind, name, &buf).map_err(|e| e.to_string())?;
            if !args.json {
                println!("wrote artifact {kind}/{name}");
            }
            Ok(())
        }
        // `artifact get <kind> <name>` — content verbatim, or (`--json`) the Artifact JSON / `null`.
        "get" => {
            let kind = args.positional.get(2).ok_or("usage: bsc plan artifact get <kind> <name>")?;
            let name = args.positional.get(3).ok_or("usage: bsc plan artifact get <kind> <name>")?;
            let s = open_store(&args.db)?;
            if args.json {
                let found = s
                    .artifact_list(Some(kind))
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .find(|a| &a.name == name);
                // to_value on an Option: Some → the object, None → JSON null.
                print_json(&serde_json::to_value(&found).unwrap_or(serde_json::Value::Null), args.pretty);
                Ok(())
            } else {
                match s.artifact_get(kind, name).map_err(|e| e.to_string())? {
                    Some(c) => {
                        print!("{c}");
                        Ok(())
                    }
                    None => Err(format!("no artifact '{kind}/{name}'")),
                }
            }
        }
        // `artifact list [<kind>]` — all artifacts, or one kind; --json for the full objects.
        "list" => {
            let kind = args.positional.get(2).map(String::as_str);
            let items = open_store(&args.db)?.artifact_list(kind).map_err(|e| e.to_string())?;
            emit_json_or_lines(args.json, &items, "(no artifacts)", |_, a| {
                format!("{}\t{}", a.kind, a.name)
            });
            Ok(())
        }
        // `artifact remove <kind> <name>` — delete; echo removed/absent.
        "remove" => {
            let kind = args.positional.get(2).ok_or("usage: bsc plan artifact remove <kind> <name>")?;
            let name = args.positional.get(3).ok_or("usage: bsc plan artifact remove <kind> <name>")?;
            let removed = open_store(&args.db)?.artifact_remove(kind, name).map_err(|e| e.to_string())?;
            if !args.json {
                if removed {
                    println!("removed artifact {kind}/{name}");
                } else {
                    println!("no artifact {kind}/{name}");
                }
            }
            Ok(())
        }
        other => Err(unknown_sub(args, "artifact", other)),
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
