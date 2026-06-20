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

use plandb::{is_valid_status, PlanFeature, PlanIssue, Store, STATUSES};
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
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { json: false, db: None, positional: Vec::new(), status: None, stream: None };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--status" => a.status = Some(it.next().ok_or("--status needs a value")?),
            "--stream" => a.stream = Some(it.next().ok_or("--stream needs a value")?),
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

The plan.db is found via --db <path> or the BSC_PLAN_DB env var.
";
