//! The `bsc skill` subcommand (#1877) — the session-facing CLI over the GLOBAL skills + task-groups
//! store (#1338, an instance of #1325). Injected into EVERY console session (Solution B-global), so a
//! group authored in one session (the planner, or any session) is reachable + resolvable by every
//! other live session, and queryable from a session's own shell.
//!
//! Extracted from the old `bsc-skill` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the legacy `bsc-skill` shim delegates here too.
//!
//! The db is located via `--db <path>` or the `BSC_SKILL_DB` env var (set per-session at launch),
//! defaulting to `~/.base-studio-code/skills.db`. Output is JSON to stdout (like `bsc plan`) —
//! **compact by default**, indented with `--pretty` (#1762). `resolve` prints the group's member
//! skills (the SKILL.md-bound shape), de-duped + ordered + existence-filtered.
//!
//! Help is per-command so a model loads only what it needs (#1762):
//!   bsc skill help          # compact menu (the small "what commands exist" prompt)
//!   bsc skill group help    # detailed help for ONE command
//!   bsc skill <cmd> help    # same, after any command

use crate::{Skill, SkillGroup, Store};
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json, read_stdin_json_one};
use std::path::PathBuf;

const TAGLINE: &str = "the global skills + task-groups store — author/resolve reusable skill bundles (#1338)";

/// The command catalog — drives the shared help system. One detailed `usage` block per top-level
/// command keeps the overview tiny and the detail one-fetch-away; `group`'s subcommands live in its
/// own usage block. Output is JSON throughout (compact; `--pretty` indents).
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "navigate skills — facets, ranked, paginated (JSON)",
        usage: "\
USAGE:
  bsc skill list [--kind k] [--source s] [--project p] [--group g] [--pinned] [--query q]
                 [--sort rank|uses|updated|name] [--limit N] [--offset M] [--full] [--pretty]

Navigate the library the way the Skills page does. Filters: --kind, --source, --project (global +
project-scoped), --group (members of a task group), --pinned, --query (name/desc/id substring).
Sort (default `rank` = usage weighted by update-recency, so regularly-used + fresh skills surface
first): rank | uses | updated | name. Paginated: --limit (default 20) + --offset; the result is
{ skills:[lean rows], total, offset, limit, returned } — page until `returned` is 0. Each row omits
the heavy `prompt` body (one `get <id>` away). --full emits the COMPLETE skill objects (prompt +
tools/profiles/packaged) as a plain array, unpaginated — the full-fidelity read for library
hydration (#2142).",
    },
    CmdDoc {
        name: "add",
        summary: "upsert skill(s) from JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc skill add [--group <id>] [--pretty]   # skill JSON (one object or an array) on stdin

Upserts each skill by its (required, non-empty) \"id\". With --group, each skill is also added to
that group (the group is created, named after its id, if it does not exist yet).",
    },
    CmdDoc {
        name: "get",
        summary: "print one skill (JSON, or null)",
        usage: "\
USAGE:
  bsc skill get <id> [--pretty]

Prints the skill JSON for <id>, or `null` if absent.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete one skill by id (no-op if absent)",
        usage: "\
USAGE:
  bsc skill remove <id> [--pretty]

Deletes the skill keyed by <id>. A no-op (not an error) when it does not exist.",
    },
    CmdDoc {
        name: "group",
        summary: "task-group CRUD + membership (named, reusable skill bundles)",
        usage: "\
USAGE:
  bsc skill group add                       # upsert a SkillGroup from JSON on stdin; prints the id
  bsc skill group list                      # print every group (JSON)
  bsc skill group get <id>                  # print one group (JSON, or null)
  bsc skill group remove <id>               # delete a group
  bsc skill group member <group> <skill>    # add <skill> to <group> (--off removes); prints ids

A task group is a named, reusable bundle of skills toggled as one. Members are stored as ids;
`resolve` expands a group to its actual skills.",
    },
    CmdDoc {
        name: "resolve",
        summary: "a group's member skills, ordered + paginated (JSON)",
        usage: "\
USAGE:
  bsc skill resolve <group-id> [--limit N] [--offset M] [--pretty]

\"Display just this group's skills\" — the group's member skills, ordered, de-duped, and
existence-filtered (the expandGroups semantics the app binds to SKILL.md files). Paginated like
`list`: { skills:[lean rows], total, offset, limit, returned }.",
    },
    CmdDoc {
        name: "groups",
        summary: "find task groups + their live member counts (JSON)",
        usage: "\
USAGE:
  bsc skill groups [--query q] [--pretty]

Lists every task group with its live member count (id, name, hue, memberCount), optionally filtered
by --query (name/id substring). The entry point for `resolve <group-id>` (\"show just that group\").",
    },
    CmdDoc {
        name: "use",
        summary: "record a use of a skill (bumps its usage counter)",
        usage: "\
USAGE:
  bsc skill use <id|slug>

Records one use of a skill: increments its usage counter and stamps its last-used time. Accepts a
stable id or a name-slug. This is the single chokepoint the user (UI/CLI) and an agent both call, so
usage is counted uniformly — it then drives the `list --sort rank|uses` ordering + the Skills-page
usage chart. Prints { id, uses, lastUsedAt }.",
    },
];

/// Default page size for the paginated reads (`list`/`resolve`) — small so a session reads a peek,
/// not the whole library, keeping the agent's context cheap (#A).
const DEFAULT_PAGE: usize = 20;

/// Parsed global flags + leftover positional args.
struct Args {
    db: Option<String>,
    off: bool,
    /// `add --group <id>`: also add each upserted skill to this group (created if missing). Doubles as
    /// the `list --group <id>` membership filter (#A).
    group: Option<String>,
    /// Indent the JSON output (#1762). The default is compact, matching every other `bsc-*` CLI;
    /// `--json` is accepted as an explicit no-op since `bsc skill`'s output is always JSON.
    pretty: bool,
    /// `list --full`: emit the COMPLETE `Skill` objects (with the heavy `prompt` body + `tools`/
    /// `profiles`/`packaged`) as a plain JSON array, bypassing the lean paginated projection — the
    /// full-fidelity read the desktop library hydration needs (#2142). Ignored by other subcommands.
    full: bool,
    // ── navigation facets + pagination (#A): the same axes the user navigates the Skills page by ──
    kind: Option<String>,
    source: Option<String>,
    /// `list --project <p>`: skills that apply to project `p` (global skills + ones scoped to it).
    project: Option<String>,
    pinned: bool,
    /// `list --sort rank|uses|updated|name` (default `rank` = uses × updated-recency).
    sort: Option<String>,
    /// `list`/`groups --query <q>`: case-insensitive substring over name/desc/id.
    query: Option<String>,
    limit: Option<usize>,
    offset: usize,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        db: None, off: false, group: None, pretty: false, full: false, kind: None, source: None,
        project: None, pinned: false, sort: None, query: None, limit: None, offset: 0,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--off" => a.off = true,
            "--group" => a.group = Some(it.next().ok_or("--group needs a group id")?),
            "--pretty" => a.pretty = true,
            "--full" => a.full = true,
            // Output is always JSON; --json is accepted so callers can be explicit.
            "--json" => {}
            "--kind" => a.kind = Some(it.next().ok_or("--kind needs a value")?),
            "--source" => a.source = Some(it.next().ok_or("--source needs a value")?),
            "--project" => a.project = Some(it.next().ok_or("--project needs a value")?),
            "--pinned" => a.pinned = true,
            "--sort" => a.sort = Some(it.next().ok_or("--sort needs a value")?),
            "--query" => a.query = Some(it.next().ok_or("--query needs a value")?),
            "--limit" => {
                let v = it.next().ok_or("--limit needs a number")?;
                a.limit = Some(v.parse().map_err(|_| format!("--limit: '{v}' is not a number"))?);
            }
            "--offset" => {
                let v = it.next().ok_or("--offset needs a number")?;
                a.offset = v.parse().map_err(|_| format!("--offset: '{v}' is not a number"))?;
            }
            // `-h`/`--help` route to the help command (handled in run()).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// Recency bucket for an `updated_at` (epoch s) vs `now`: more recent = higher. Bounded so usage stays
/// the dominant ranking term while a freshly-updated skill still lifts above an ancient one. Pure.
fn recency_bucket(updated_at: i64, now: i64) -> i64 {
    match (now - updated_at).max(0) / 86_400 {
        0..=1 => 4,
        2..=7 => 3,
        8..=30 => 2,
        31..=90 => 1,
        _ => 0,
    }
}

/// The default `rank` score: usage weighted ABOVE recency, so "regularly used AND updated" surfaces
/// first (the navigation ask). Pure → unit-tested.
fn rank_score(uses: i64, updated_at: i64, now: i64) -> i64 {
    uses * 2 + recency_bucket(updated_at, now)
}

/// Directory-safe slug of a skill name — mirrors the frontend `skillSlug` + the Rust `skill_slug` so
/// `use <name>` resolves the same id the launch path keys by: lowercase, keep `[a-z0-9-]`, collapse
/// other runs to one `-`, trim `-`.
fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            if pending && !out.is_empty() {
                out.push('-');
            }
            pending = false;
            out.push(c);
        } else {
            pending = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// The compact, navigation-friendly projection of a skill for the paginated `list`/`resolve` reads —
/// the metadata + usage the user navigates by, minus the heavy `prompt` body (one `get <id>` away).
fn lean_skill_row(s: &Skill) -> serde_json::Value {
    serde_json::json!({
        "id": s.id, "name": s.name, "kind": s.kind, "source": s.source,
        "pinned": s.pinned, "enabled": s.enabled, "uses": s.uses,
        "lastUsedAt": s.last_used_at, "updatedAt": s.updated_at,
        "projects": s.projects, "desc": s.desc,
    })
}

/// Slice `rows` to one page and wrap it with pagination metadata — the shared shape `list`/`resolve`
/// both return, so an agent can page deterministically (`offset += returned` until `returned == 0`).
fn paginate(rows: Vec<Skill>, limit: usize, offset: usize, pretty: bool) {
    let total = rows.len();
    let offset = offset.min(total);
    let page: Vec<serde_json::Value> = rows.iter().skip(offset).take(limit).map(lean_skill_row).collect();
    let returned = page.len();
    print_json(
        &serde_json::json!({ "skills": page, "total": total, "offset": offset, "limit": limit, "returned": returned }),
        pretty,
    );
}

/// The `skill` subcommand entrypoint: `args` is everything after `bsc skill`; `prog` is the display
/// name for help/errors (`"bsc skill"` from the umbrella, `"bsc-skill"` from the legacy shim).
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help (no command / `help` / `help <cmd>` / `<cmd> help`) — the shared
    // dispatch in bsc-cli-util, run before opening the store (help works without a skills.db).
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    // One-line dispatch to the verb's focused handler (each opens the store itself), mirroring the
    // `bsc plan` cli split so the entrypoint stays a table of contents.
    match cmd.as_str() {
        "list" => cmd_list(&args),
        "groups" => cmd_groups(&args),
        "use" => cmd_use(&args),
        "add" => cmd_add(&args),
        "get" => cmd_get(&args),
        "remove" => cmd_remove(&args),
        "resolve" => cmd_resolve(&args),
        "group" => cmd_group(&args, prog),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// Open the global skills.db (resolved from `--db` / `BSC_SKILL_DB`). Every DB-backed handler opens
/// its own connection, so the entrypoint doesn't own one.
fn open_store(args: &Args) -> Result<Store, String> {
    let path = resolve_db(&args.db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Faceted, sorted, paginated navigation — the same axes the user navigates the Skills page by
/// (type/source/project/group/pinned), ranked by usage × recency, in cheap pages (#A).
fn cmd_list(args: &Args) -> Result<(), String> {
    let s = open_store(args)?;
    let now = bsc_util::now_secs();
    let mut skills = s.list().map_err(|e| e.to_string())?;
    if let Some(k) = &args.kind {
        skills.retain(|sk| &sk.kind == k);
    }
    if let Some(src) = &args.source {
        skills.retain(|sk| &sk.source == src);
    }
    if let Some(p) = &args.project {
        // Applies to project p: a global skill (no project scope) or one scoped to it.
        skills.retain(|sk| sk.projects.is_empty() || sk.projects.contains(p));
    }
    if args.pinned {
        skills.retain(|sk| sk.pinned);
    }
    if let Some(g) = &args.group {
        let members: std::collections::HashSet<String> = s
            .group_get(g)
            .map_err(|e| e.to_string())?
            .map(|grp| grp.skill_ids.into_iter().collect())
            .unwrap_or_default();
        skills.retain(|sk| members.contains(&sk.id));
    }
    if let Some(q) = &args.query {
        let ql = q.to_lowercase();
        skills.retain(|sk| {
            sk.name.to_lowercase().contains(&ql)
                || sk.desc.to_lowercase().contains(&ql)
                || sk.id.to_lowercase().contains(&ql)
        });
    }
    match args.sort.as_deref().unwrap_or("rank") {
        "rank" => skills.sort_by(|a, b| {
            rank_score(b.uses, b.updated_at, now)
                .cmp(&rank_score(a.uses, a.updated_at, now))
                .then(b.updated_at.cmp(&a.updated_at))
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        }),
        "uses" => skills.sort_by(|a, b| b.uses.cmp(&a.uses).then(b.updated_at.cmp(&a.updated_at))),
        "updated" => skills.sort_by_key(|s| std::cmp::Reverse(s.updated_at)),
        "name" => skills.sort_by_key(|s| s.name.to_lowercase()),
        other => return Err(format!("unknown --sort '{other}' (expected rank|uses|updated|name)")),
    }
    if args.full {
        // Full-fidelity, unpaginated: the complete `Skill` objects (prompt/tools/profiles/packaged
        // included) as a plain array — the shape the desktop library hydration needs (#2142).
        print_json(&skills, args.pretty);
    } else {
        paginate(skills, args.limit.unwrap_or(DEFAULT_PAGE), args.offset, args.pretty);
    }
    Ok(())
}

/// Find groups (the "display just a group's skills" entry point): every task group + its live member
/// count, optionally filtered by `--query` over name/id (#A).
fn cmd_groups(args: &Args) -> Result<(), String> {
    let s = open_store(args)?;
    let live: std::collections::HashSet<String> =
        s.list().map_err(|e| e.to_string())?.into_iter().map(|sk| sk.id).collect();
    let ql = args.query.as_ref().map(|q| q.to_lowercase());
    let rows: Vec<serde_json::Value> = s
        .group_list()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|g| {
            ql.as_ref().is_none_or(|q| g.name.to_lowercase().contains(q) || g.id.to_lowercase().contains(q))
        })
        .map(|g| {
            let count = g.skill_ids.iter().filter(|id| live.contains(*id)).count();
            serde_json::json!({ "id": g.id, "name": g.name, "hue": g.hue, "memberCount": count })
        })
        .collect();
    print_json(&rows, args.pretty);
    Ok(())
}

/// Record a USE of a skill (#A): the chokepoint the user (UI/CLI) and an agent both call, so usage is
/// counted uniformly. Accepts a stable id OR a name-slug.
fn cmd_use(args: &Args) -> Result<(), String> {
    let key = args.positional.get(1).ok_or("usage: bsc skill use <id|slug>")?;
    let s = open_store(args)?;
    let id = if s.get(key).map_err(|e| e.to_string())?.is_some() {
        key.clone()
    } else {
        let want = slug(key);
        s.list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|sk| slug(&sk.name) == want)
            .map(|sk| sk.id)
            .ok_or_else(|| format!("no skill with id or name-slug '{key}'"))?
    };
    if s.record_use(&id).map_err(|e| e.to_string())? == 0 {
        return Err(format!("no skill with id '{id}'"));
    }
    let after = s.get(&id).map_err(|e| e.to_string())?;
    print_json(
        &serde_json::json!({
            "id": id,
            "uses": after.as_ref().map(|sk| sk.uses).unwrap_or(0),
            "lastUsedAt": after.map(|sk| sk.last_used_at).unwrap_or(0),
        }),
        args.pretty,
    );
    Ok(())
}

/// Upsert skill(s) from JSON on stdin (optionally pairing them into `--group`); prints the ids.
fn cmd_add(args: &Args) -> Result<(), String> {
    let s = open_store(args)?;
    let ids = upsert_skills_from_stdin(&s, args.group.as_deref())?;
    print_json(&ids, args.pretty);
    Ok(())
}

/// Print one skill by id (the skill JSON, or `null` for a miss).
fn cmd_get(args: &Args) -> Result<(), String> {
    let id = args.positional.get(1).ok_or("usage: bsc skill get <id>")?;
    let s = open_store(args)?;
    // `print_json` of the `Option` prints `null` for a miss (the skill JSON for a hit).
    print_json(&s.get(id).map_err(|e| e.to_string())?, args.pretty);
    Ok(())
}

/// Delete one skill by id (no-op if absent); prints the id.
fn cmd_remove(args: &Args) -> Result<(), String> {
    let id = args.positional.get(1).ok_or("usage: bsc skill remove <id>")?;
    let s = open_store(args)?;
    s.remove(id).map_err(|e| e.to_string())?;
    print_json(&id, args.pretty);
    Ok(())
}

/// "Display just this group's skills" — the group's member skills, paginated like `list` (#A).
fn cmd_resolve(args: &Args) -> Result<(), String> {
    let gid = args.positional.get(1).ok_or("usage: bsc skill resolve <group-id> [--limit N] [--offset M]")?;
    let s = open_store(args)?;
    let skills = s.resolve(gid).map_err(|e| e.to_string())?;
    paginate(skills, args.limit.unwrap_or(DEFAULT_PAGE), args.offset, args.pretty);
    Ok(())
}

/// Task-group CRUD + membership (`group add|list|get|remove|member`). `prog` is threaded through for
/// the per-subcommand help on an unknown group verb.
fn cmd_group(args: &Args, prog: &str) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
    let s = open_store(args)?;
    match sub {
        // `group add` reads a SkillGroup JSON on stdin and upserts it (by id); prints the id.
        "add" => {
            // The shared object-on-stdin read every other `bsc-* add`/`set` uses (#1621).
            let group: SkillGroup = read_stdin_json_one("group")?;
            if group.id.trim().is_empty() {
                return Err("group add: the group needs a non-empty \"id\"".into());
            }
            let id = s.group_add(&group).map_err(|e| e.to_string())?;
            print_json(&id, args.pretty);
            Ok(())
        }
        "list" => {
            let groups = s.group_list().map_err(|e| e.to_string())?;
            print_json(&groups, args.pretty);
            Ok(())
        }
        "get" => {
            let id = args.positional.get(2).ok_or("usage: bsc skill group get <id>")?;
            // `print_json` of the `Option` prints `null` for a miss.
            print_json(&s.group_get(id).map_err(|e| e.to_string())?, args.pretty);
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(2).ok_or("usage: bsc skill group remove <id>")?;
            s.group_remove(id).map_err(|e| e.to_string())?;
            print_json(&id, args.pretty);
            Ok(())
        }
        // `group member <group> <skill> [--off]` toggles membership; prints the resulting ids.
        "member" => {
            let gid = args.positional.get(2).ok_or("usage: bsc skill group member <group> <skill> [--off]")?;
            let sid = args.positional.get(3).ok_or("usage: bsc skill group member <group> <skill> [--off]")?;
            let ids = s.group_toggle_member(gid, sid, !args.off).map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => format!("no group with id '{gid}'"),
                other => other.to_string(),
            })?;
            print_json(&ids, args.pretty);
            Ok(())
        }
        other => Err(format!(
            "unknown group command '{other}'\n\n{}",
            bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "group")
        )),
    }
}

/// Resolve the skills.db path via the shared `--db` → `$BSC_SKILL_DB` → default precedence
/// ([`bsc_cli_util::resolve_store_path`]); the default is the global store at
/// `~/.base-studio-code/skills.db`.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_SKILL_DB", || {
        bsc_util::bsc_base_dir()
            .map(|base| base.join("skills.db"))
            .ok_or_else(|| "could not resolve a home directory; pass --db <path> or set BSC_SKILL_DB".to_string())
    })
}

/// Read JSON from stdin (one skill object or an array), upsert each, return the ids. When `group`
/// is set, also add every upserted skill to that group — creating the group (named after its id, a
/// placeholder the app overwrites with the project name) if it doesn't exist yet. This is how the
/// planner pairs the skills it authors into its per-project session group in one command (#1419).
fn upsert_skills_from_stdin(s: &Store, group: Option<&str>) -> Result<Vec<String>, String> {
    let skills: Vec<Skill> = read_stdin_json("skill")?;
    let mut ids = Vec::new();
    for skill in &skills {
        if skill.id.trim().is_empty() {
            return Err("add: each skill needs a non-empty \"id\"".into());
        }
        s.upsert(skill).map_err(|e| e.to_string())?;
        ids.push(skill.id.clone());
    }
    if let Some(gid) = group.map(str::trim).filter(|g| !g.is_empty()) {
        pair_into_group(s, gid, &ids).map_err(|e| e.to_string())?;
    }
    Ok(ids)
}

/// Add `skill_ids` to group `gid`, creating the group (named after its id — a placeholder the app
/// overwrites with the project name) if it doesn't exist yet, so membership never fails on a fresh
/// planning session (#1419). Idempotent: re-adding an existing member is a no-op.
fn pair_into_group(s: &Store, gid: &str, skill_ids: &[String]) -> rusqlite::Result<()> {
    if s.group_get(gid)?.is_none() {
        s.group_add(&SkillGroup { id: gid.to_string(), name: gid.to_string(), ..Default::default() })?;
    }
    for id in skill_ids {
        s.group_toggle_member(gid, id, true)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_store() -> Store {
        Store::open_in_memory().expect("open in-memory skills.db")
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc skill", TAGLINE, COMMANDS);
        for c in ["list", "add", "get", "remove", "group", "groups", "resolve", "use"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // `group help` shows the group command's subcommands, not the whole menu.
        let g = bsc_cli_util::help_for("bsc skill", TAGLINE, COMMANDS, "group");
        assert!(g.contains("bsc skill group"));
        assert!(g.contains("member"));
        assert!(!g.contains("resolve <group-id>"));
        // The new navigation/usage commands have their own detailed help.
        assert!(bsc_cli_util::help_for("bsc skill", TAGLINE, COMMANDS, "use").contains("usage counter"));
        assert!(bsc_cli_util::help_for("bsc skill", TAGLINE, COMMANDS, "groups").contains("member count"));
        assert!(bsc_cli_util::help_for("bsc skill", TAGLINE, COMMANDS, "list").contains("--sort"));
        // An unknown command falls back to the overview.
        assert!(bsc_cli_util::help_for("bsc skill", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }

    #[test]
    fn rank_weights_usage_above_recency_but_recency_breaks_ties() {
        let now = 1_000_000_000;
        let day = 86_400;
        // More uses always outranks fewer, regardless of recency.
        assert!(rank_score(5, now - 365 * day, now) > rank_score(1, now, now), "usage dominates");
        // Among equal usage, the more recently updated ranks higher.
        assert!(rank_score(2, now, now) > rank_score(2, now - 200 * day, now), "recency breaks ties");
        // A freshly-updated zero-use skill still outranks an ancient zero-use one.
        assert!(rank_score(0, now, now) > rank_score(0, now - 365 * day, now));
        // recency_bucket is bounded + monotonic in staleness.
        assert_eq!(recency_bucket(now, now), 4);
        assert_eq!(recency_bucket(now - 365 * day, now), 0);
        assert!(recency_bucket(now - 3 * day, now) >= recency_bucket(now - 20 * day, now));
    }

    #[test]
    fn full_flag_parses_and_defaults_off() {
        // `--full` (the #2142 full-fidelity library read) flips the flag; it is off by default so the
        // lean paginated projection stays the default `list` shape.
        assert!(!parse_args(vec!["list".into()]).unwrap().full, "default list is lean/paginated");
        assert!(parse_args(vec!["list".into(), "--full".into()]).unwrap().full, "--full opts into full rows");
    }

    #[test]
    fn slug_matches_the_launch_path_keying() {
        assert_eq!(slug("Open a PR"), "open-a-pr");
        assert_eq!(slug("  Triage!! failing  test "), "triage-failing-test");
        assert_eq!(slug("already-slug"), "already-slug");
        assert_eq!(slug("***"), "");
    }

    #[test]
    fn skill_round_trip_add_get_remove() {
        let s = mem_store();
        // Absent id → get is None (the CLI prints `null`).
        assert!(s.get("sk1").unwrap().is_none());
        // Add, then get finds it.
        s.upsert(&Skill { id: "sk1".into(), name: "First".into(), ..Default::default() }).unwrap();
        let got = s.get("sk1").unwrap().expect("skill was added");
        assert_eq!(got.id, "sk1");
        assert_eq!(got.name, "First");
        // Remove, then get is None again.
        s.remove("sk1").unwrap();
        assert!(s.get("sk1").unwrap().is_none(), "removed skill is gone");
        // Removing an absent id is a no-op (no error), like `group remove`.
        s.remove("sk1").unwrap();
    }

    #[test]
    fn pair_into_group_creates_the_group_when_missing_then_adds_members() {
        let s = mem_store();
        // The group does not exist yet — pairing must create it (named after the id) and add the skill.
        pair_into_group(&s, "grp-session-acme", &["sk1".to_string(), "sk2".to_string()]).unwrap();
        let g = s.group_get("grp-session-acme").unwrap().expect("group was created");
        assert_eq!(g.name, "grp-session-acme", "placeholder name = the id until the app renames it");
        assert_eq!(g.skill_ids, vec!["sk1".to_string(), "sk2".to_string()]);
    }

    #[test]
    fn pair_into_group_is_idempotent_and_preserves_existing_members() {
        let s = mem_store();
        // Seed a group named like the app would (project title) with one member already.
        s.group_add(&SkillGroup {
            id: "grp-session-acme".into(),
            name: "Acme".into(),
            skill_ids: vec!["sk1".into()],
            ..Default::default()
        })
        .unwrap();
        pair_into_group(&s, "grp-session-acme", &["sk1".to_string(), "sk2".to_string()]).unwrap();
        let g = s.group_get("grp-session-acme").unwrap().unwrap();
        assert_eq!(g.name, "Acme", "an existing group keeps its (app-set) name");
        assert_eq!(g.skill_ids, vec!["sk1".to_string(), "sk2".to_string()], "sk1 not duplicated, sk2 added");
    }
}
