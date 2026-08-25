//! The `bsc errors` subcommand (#2260) — the agent-facing CLI over a project's error.db. Runtime
//! producers (the slice-2 collector, or an agent that hit a fault while testing) `record` faults; the
//! director/maintenance loop (#2265) reads `list --unresolved --since` and `resolve`s a fixed fault.
//!
//! The DB is located via `--db <path>` or `$BSC_ERROR_DB` (set per-session at launch, cwd-derived like
//! `$BSC_PLAN_DB`, so the CLI resolves the hub's error.db even from a worker's worktree). Reads are lean
//! (a compact TSV) by default; `--json`/`--pretty` for machine-readable JSON.
//!
//! Help is per-command (#1762): `bsc errors help` (menu) · `bsc errors <cmd> help` (one command).

use crate::{Fault, FaultInput, Filter, Store};
use bsc_cli_util::CmdDoc;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const TAGLINE: &str = "the project runtime-fault store — fingerprinted errors + alerts (#2258)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "add",
        summary: "record a fault occurrence; prints its fingerprint",
        usage: "\
USAGE:
  bsc errors add <level> <title> [--stage S] [--stack -] [--source X] [--release R]

Records one runtime fault. <level> is one of: warn | error | fatal. Upserts by a stable fingerprint
(a repeat bumps the count, keeps the highest level, and re-opens a resolved fault). `--stack -` reads
the stack/detail from stdin (used for the fingerprint + kept as the sample). --stage defaults to
`runtime` (the only stage with a producer today). Prints the fingerprint id.",
    },
    CmdDoc {
        name: "run",
        summary: "run a command; record a fault if it fails, clear its own if it passes",
        usage: "\
USAGE:
  bsc errors run --stage <stage> [--project <key>|--db <path>] [--source <tag>] [--level L] -- <cmd>…

Every verb below also takes --project <key> (or --db <path>) to name the store, so a session that is
not inside the app can still reach one. --db and --project together are refused, not ranked.

Runs <cmd>, streams its output through UNCHANGED, and exits with the command's OWN exit code. If it
fails, the diagnostic is extracted from the output and recorded as one fingerprinted fault. If it
passes, the faults this same --source recorded at this stage are resolved.

It is a tee, never a gate. Recording cannot change the exit code, the output, or the timing: no store,
an unopenable db, or a write error are all silent. Chain it exactly where you would have chained the
command.

  --stage <s>    which lifecycle stage failed — compile | build | typecheck | launch | … (required)
  --source <t>   this producer's identity; defaults to the command itself. A green run clears by it,
                 so two commands that should clear independently need different tags.
  --level <l>    warn | error | fatal (default error)

WHAT IS NOT A FAILURE: a command killed by a signal. Ctrl-C on a dev server exits 130, and filing a
fault for that would put a defect in the store every time someone stopped their own server.

THE TITLE IS THE DIAGNOSTIC, NOT THE COMMAND. Faults dedup on stage + title + first detail line, so a
compiler error that moves to another line is still ONE fault with a rising count. The command rides on
the event row instead. When nothing in the output is recognizable the fault names the command, because
then there is genuinely nothing else to say.

THE COST: the child's stdout/stderr are pipes, so a tool that colorizes only for a terminal will stop
(CARGO_TERM_COLOR=always turns it back on) and one that wants a TTY for interactive keys will not get
one. Wrap batch commands — a build, a typecheck, a launch — not an interactive dev server. stdin stays
inherited, so a child that prompts still can.",
    },
    CmdDoc {
        name: "list",
        summary: "the fault table (lean TSV; newest-seen first)",
        usage: "\
USAGE:
  bsc errors list [--stage S] [--unresolved] [--since EPOCH] [--limit N] [--json|--pretty]

The fault table, newest-seen first. Lean TSV by default (fingerprint, level, stage, count, last_seen,
resolved?, title); --json emits the full rows. Filters:
  --unresolved     only faults not yet resolved
  --stage S        only one lifecycle stage (runtime | test | build | …)
  --since EPOCH    only faults with last_seen >= EPOCH (the resume-delta the fix loop polls with)
  --limit N        cap to N rows",
    },
    CmdDoc {
        name: "tail",
        summary: "the most-recently-seen faults (list, limited)",
        usage: "\
USAGE:
  bsc errors tail [--limit N] [--unresolved] [--json|--pretty]

The most-recently-seen faults — `list` ordered by last_seen with a small default limit (20).",
    },
    CmdDoc {
        name: "projects",
        summary: "every project holding faults — the entry point when you know no ids",
        usage: "\
USAGE:
  bsc errors projects [--unresolved] [--json|--pretty]

Every project hub with an error.db, with its unresolved count, worst level and newest fault — so a
session that knows nothing can find which project broke and read it with `--project <key>`.

This is the read path for a session OUTSIDE the app. Every other verb resolves its store from --db or
$BSC_ERROR_DB, and $BSC_ERROR_DB is set per-session at launch — which is exactly the thing that is not
running when an app failed to launch. A project with no faults is listed with a zero count rather than
omitted: absent and clean are different answers, and only one of them means \"look somewhere else\".",
    },
    CmdDoc {
        name: "get",
        summary: "one fault's full record",
        usage: "\
USAGE:
  bsc errors get <fingerprint> [--json|--pretty]

One fault's full record — the sample stack/source/release the lean list omits.",
    },
    CmdDoc {
        name: "resolve",
        summary: "mark a fault resolved by fingerprint",
        usage: "\
USAGE:
  bsc errors resolve <fingerprint>

Stamps the fault resolved (drops it from `list --unresolved`). A no-op (reported) for an unknown or
already-resolved fingerprint. A later recurrence re-opens it.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    project: Option<String>,
    level: Option<String>,
    stage: Option<String>,
    stack: Option<String>,
    source: Option<String>,
    release: Option<String>,
    unresolved: bool,
    since: Option<i64>,
    limit: Option<i64>,
    positional: Vec<String>,
    /// Everything after a bare `--` — the command `run` executes, kept out of this CLI's own parsing
    /// so a child's flags (`cargo build --release`) can never be mistaken for ours.
    trailing: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        json: false,
        pretty: false,
        db: None,
        project: None,
        level: None,
        stage: None,
        stack: None,
        source: None,
        release: None,
        unresolved: false,
        since: None,
        limit: None,
        positional: Vec::new(),
        trailing: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        // A value-flag reads the next token; a missing value is an error.
        let mut val = |flag: &str| -> Result<String, String> {
            it.next().ok_or_else(|| format!("flag {flag} needs a value"))
        };
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--unresolved" => a.unresolved = true,
            "--db" => a.db = Some(val("--db")?),
            "--project" => a.project = Some(val("--project")?),
            "--level" => a.level = Some(val("--level")?),
            "--stage" => a.stage = Some(val("--stage")?),
            "--stack" => a.stack = Some(val("--stack")?),
            "--source" => a.source = Some(val("--source")?),
            "--release" => a.release = Some(val("--release")?),
            "--since" => a.since = Some(val("--since")?.parse().map_err(|_| "--since needs an integer epoch")?),
            "--limit" => a.limit = Some(val("--limit")?.parse().map_err(|_| "--limit needs an integer")?),
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            // A bare `--` ends OUR arguments: everything after it is the child's, verbatim.
            "--" => {
                a.trailing.extend(it.by_ref());
                break;
            }
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `errors` subcommand entrypoint: `args` is everything after `bsc errors`; `prog` is the display
/// name for help/errors. Help is resolved before any handler opens the DB.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "add" => cmd_add(&args),
        "run" => cmd_run(&args),
        "projects" => cmd_projects(&args),
        "list" => cmd_list(&args, &args.filter()),
        "tail" => cmd_list(&args, &Filter { limit: Some(args.limit.unwrap_or(20)), unresolved: args.unresolved, ..Default::default() }),
        "get" => cmd_get(&args),
        "resolve" => cmd_resolve(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

impl Args {
    fn filter(&self) -> Filter {
        Filter { stage: self.stage.clone(), unresolved: self.unresolved, since: self.since, limit: self.limit }
    }
}

/// `add <level> <title>` — record one fault occurrence; prints the fingerprint.
fn cmd_add(args: &Args) -> Result<(), String> {
    let level = args.positional.get(1).ok_or("usage: bsc errors add <level> <title>")?;
    let title = args.positional.get(2).ok_or("usage: bsc errors add <level> <title>")?;
    if !crate::is_valid_level(level) {
        return Err(format!("invalid level '{level}' (one of: {})", crate::LEVELS.join(" | ")));
    }
    if let Some(stage) = &args.stage {
        if !crate::is_valid_stage(stage) {
            return Err(format!("invalid stage '{stage}' (one of: {})", crate::STAGES.join(" | ")));
        }
    }
    // `--stack -` reads the stack/detail from stdin; a literal value is taken verbatim.
    let stack = match args.stack.as_deref() {
        Some("-") => Some(read_stdin()?),
        Some(s) => Some(s.to_string()),
        None => None,
    };
    let input = FaultInput {
        stage: args.stage.clone().unwrap_or_default(),
        level: level.clone(),
        title: title.clone(),
        stack,
        source_hint: args.source.clone(),
        release: args.release.clone(),
        context: None,
        ts: now_ms(),
    };
    let fault = open_store(&args.db, &args.project)?.record(&input).map_err(|e| format!("recording fault: {e}"))?;
    println!("{}", fault.fingerprint);
    Ok(())
}

/// `list` / `tail` — the fault table under `filter`.
fn cmd_list(args: &Args, filter: &Filter) -> Result<(), String> {
    let faults = open_store(&args.db, &args.project)?.list(filter).map_err(|e| format!("listing faults: {e}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &faults, || {
        if faults.is_empty() {
            "(no faults)".to_string()
        } else {
            faults.iter().map(fault_line).collect::<Vec<_>>().join("\n")
        }
    });
    Ok(())
}

/// `get <fingerprint>` — one fault's full record.
fn cmd_get(args: &Args) -> Result<(), String> {
    let fp = args.positional.get(1).ok_or("usage: bsc errors get <fingerprint>")?;
    let fault = open_store(&args.db, &args.project)?
        .get(fp)
        .map_err(|e| format!("reading fault: {e}"))?
        .ok_or_else(|| format!("no fault {fp}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &fault, || fault_block(&fault));
    Ok(())
}

/// `resolve <fingerprint>` — mark a fault resolved.
fn cmd_resolve(args: &Args) -> Result<(), String> {
    let fp = args.positional.get(1).ok_or("usage: bsc errors resolve <fingerprint>")?;
    let matched = open_store(&args.db, &args.project)?.resolve(fp, now_ms()).map_err(|e| format!("resolving fault: {e}"))?;
    println!("{}", if matched { format!("resolved {fp}") } else { format!("no unresolved fault {fp}") });
    Ok(())
}

/// One lean TSV row: fingerprint, level, stage, count, last_seen, resolved?, title.
fn fault_line(f: &Fault) -> String {
    format!(
        "{}\t{}\t{}\t{}x\t{}\t{}\t{}",
        f.fingerprint,
        f.level,
        f.stage,
        f.count,
        f.last_seen,
        if f.resolved_at.is_some() { "resolved" } else { "open" },
        f.title,
    )
}

/// The full one-fault block for `get` (human form).
fn fault_block(f: &Fault) -> String {
    let mut s = format!(
        "{}  [{}/{}]  x{}  {}\n{}",
        f.fingerprint,
        f.level,
        f.stage,
        f.count,
        if f.resolved_at.is_some() { "resolved" } else { "open" },
        f.title,
    );
    if let Some(src) = &f.source_hint {
        s.push_str(&format!("\nsource: {src}"));
    }
    if let Some(rel) = &f.release {
        s.push_str(&format!("\nrelease: {rel}"));
    }
    if let Some(stack) = &f.sample_stack {
        s.push_str(&format!("\n\n{stack}"));
    }
    s
}

/// `run --stage <s> -- <cmd>…` — the producer. See [`crate::run`] for why it is a tee and not a gate.
///
/// The store is resolved but NOT required: a build failing on a machine with no project hub is still a
/// build that should run, and refusing here would make the wrapper unusable in exactly the case it was
/// added for (a fresh clone, CI, a bare shell). No store ⇒ run the command and record nothing.
fn cmd_run(args: &Args) -> Result<(), String> {
    let cmd = &args.trailing;
    if cmd.is_empty() {
        return Err("usage: bsc errors run --stage <stage> -- <cmd>…  (the `--` is required)".to_string());
    }
    let stage = args.stage.clone().unwrap_or_else(|| crate::DEFAULT_STAGE.to_string());
    if !crate::is_valid_stage(&stage) {
        return Err(format!("invalid stage '{stage}' (one of: {})", crate::STAGES.join(" | ")));
    }
    let level = args.level.clone().unwrap_or_else(|| crate::DEFAULT_LEVEL.to_string());
    if !crate::is_valid_level(&level) {
        return Err(format!("invalid level '{level}' (one of: {})", crate::LEVELS.join(" | ")));
    }
    // The command IS the default identity: stable for a given wrapped command, distinct across
    // different ones, and never part of the fingerprint — so using it here cannot affect dedup.
    let source = args.source.clone().unwrap_or_else(|| cmd.join(" "));
    // Resolution failing is not fatal here, unlike every other verb.
    let db = resolve_db(&args.db, &args.project).ok();
    crate::run::run_and_record(cmd, db.as_deref(), &stage, &source, &level, now_ms()).map(|_| ())
}

/// One project's fault summary — the row `projects` prints.
#[derive(serde::Serialize)]
struct ProjectFaults {
    key: String,
    unresolved: usize,
    /// The worst unresolved level present (`fatal` > `error` > `warn`), or absent when clean.
    #[serde(skip_serializing_if = "Option::is_none")]
    worst: Option<String>,
    /// `last_seen` of the newest unresolved fault, or absent when clean.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_seen: Option<i64>,
    /// The newest unresolved fault's title — enough to know whether to look, without a second call.
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

/// `projects` — every hub holding an error.db, with its unresolved count.
///
/// Read-only in the strictest sense: it opens only paths that already EXIST, because `Store::open`
/// creates and migrates, and a discovery verb that minted an empty db for every directory it looked at
/// would be writing to answer a question.
fn cmd_projects(args: &Args) -> Result<(), String> {
    let mut rows = scan_projects(&projects_dir()?)?;
    if args.unresolved {
        rows.retain(|r| r.unresolved > 0);
    }
    bsc_cli_util::emit(args.pretty, args.json, &rows, || {
        if rows.is_empty() {
            "(no project has an error.db)".to_string()
        } else {
            rows.iter()
                .map(|r| {
                    format!(
                        "{}\t{}\t{}\t{}",
                        r.key,
                        r.unresolved,
                        r.worst.as_deref().unwrap_or("-"),
                        r.title.as_deref().unwrap_or(""),
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    });
    Ok(())
}

/// The scan itself, over an explicit hubs directory — so a test can drive real dbs in a temp tree
/// without mutating `HOME`, which under a thread-parallel runner would leak into every other test.
fn scan_projects(dir: &std::path::Path) -> Result<Vec<ProjectFaults>, String> {
    let mut rows: Vec<ProjectFaults> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("reading {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let key = entry.file_name().to_string_lossy().to_string();
        let db = entry.path().join("error.db");
        if !db.is_file() {
            continue;
        }
        let Ok(store) = Store::open(&db) else { continue };
        let faults = store.list(&Filter { unresolved: true, ..Default::default() }).unwrap_or_default();
        let newest = faults.iter().max_by_key(|f| f.last_seen);
        rows.push(ProjectFaults {
            key,
            unresolved: faults.len(),
            worst: worst_level(&faults),
            last_seen: newest.map(|f| f.last_seen),
            title: newest.map(|f| f.title.clone()),
        });
    }
    // Noisiest first — the answer to "where do I look" is the top row.
    rows.sort_by(|a, b| b.unresolved.cmp(&a.unresolved).then_with(|| a.key.cmp(&b.key)));
    Ok(rows)
}

/// The worst level among `faults` — `fatal` > `error` > `warn`; `None` for an empty set.
fn worst_level(faults: &[Fault]) -> Option<String> {
    crate::LEVELS
        .iter()
        .rev()
        .find(|l| faults.iter().any(|f| f.level == **l))
        .map(|l| l.to_string())
}

/// `~/.base-studio-code/projects` — the one place a project hub lives.
fn projects_dir() -> Result<PathBuf, String> {
    bsc_util::bsc_base_dir()
        .map(|b| b.join("projects"))
        .ok_or_else(|| "could not resolve the project hubs; set HOME/USERPROFILE".to_string())
}

/// Open the project's error.db (resolved from `--db` / `$BSC_ERROR_DB`). Opened lazily so a pure error
/// path (bad usage, unknown sub) never touches the disk.
fn open_store(db: &Option<String>, project: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db, project)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Resolve the error.db path via `--project <key>` / `--db <path>` → `$BSC_ERROR_DB` → (no default →
/// error).
///
/// `--project` exists because `$BSC_ERROR_DB` is set per-SESSION at launch, so the one caller who most
/// needs to read these faults — a session outside the app, after the app failed to start — is precisely
/// the one that does not have it. Before this, that caller had to know
/// `~/.base-studio-code/projects/<key>/error.db` by heart.
///
/// It derives the path exactly as the app's `error_db_path` does. It does NOT check that the hub
/// exists: `Store::open` creates and migrates, so naming a new project and recording into it is a
/// legitimate first write, and a pre-check here would only refuse it later and less clearly.
///
/// **`--db` and `--project` together are REFUSED, not ranked.** They are two typed answers to the same
/// question, and there is no reading of the pair where the caller meant one of them — a precedence rule
/// would just decide silently which store a write went to, which is the one mistake worth being loud
/// about here.
fn resolve_db(flag: &Option<String>, project: &Option<String>) -> Result<PathBuf, String> {
    let key = project.as_deref().map(str::trim).filter(|k| !k.is_empty());
    if key.is_some() && flag.is_some() {
        return Err("--db and --project name two different stores; pass one".to_string());
    }
    if let Some(key) = key {
        return Ok(projects_dir()?.join(key).join("error.db"));
    }
    bsc_cli_util::resolve_store_path(flag, "BSC_ERROR_DB", || {
        Err("no error.db: pass --db <path>, --project <key>, or set BSC_ERROR_DB".to_string())
    })
}

/// Current wall-clock in epoch milliseconds (0 if the clock is before the epoch — never panics).
fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_stdin() -> Result<String, String> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).map_err(|e| format!("reading stdin: {e}"))?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_collects_flags_and_positionals() {
        let a = parse_args(vec![
            "list".into(),
            "--unresolved".into(),
            "--stage".into(),
            "runtime".into(),
            "--since".into(),
            "500".into(),
            "--json".into(),
        ])
        .unwrap();
        assert!(a.unresolved && a.json);
        assert_eq!(a.stage.as_deref(), Some("runtime"));
        assert_eq!(a.since, Some(500));
        assert_eq!(a.positional, vec!["list"]);
    }

    #[test]
    fn parse_args_rejects_unknown_flag_and_missing_value() {
        assert!(parse_args(vec!["list".into(), "--nope".into()]).is_err());
        assert!(parse_args(vec!["--since".into()]).is_err(), "value-flag with no value");
        assert!(parse_args(vec!["--since".into(), "abc".into()]).is_err(), "non-integer epoch");
    }

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn help_overview_and_per_command_help() {
        let ov = bsc_cli_util::help_overview("bsc errors", TAGLINE, COMMANDS);
        for name in ["add", "list", "tail", "get", "resolve"] {
            assert!(ov.contains(name), "overview lists {name}");
        }
        let add = bsc_cli_util::help_for("bsc errors", TAGLINE, COMMANDS, "add");
        assert!(add.contains("bsc errors add"));
        assert!(add.contains("--stack -"));
        // A single command's detail shows only that command.
        let one = bsc_cli_util::help_for("bsc errors", TAGLINE, COMMANDS, "resolve");
        assert!(one.contains("bsc errors resolve") && !one.contains("--stack"));
    }

    /// The `--` split is what lets a child carry flags of its own. Without it `cargo build --release`
    /// would be parsed as OUR `--release`, which this CLI does not have, and the wrapper would refuse
    /// every real build command.
    #[test]
    fn a_bare_dashdash_hands_everything_after_it_to_the_child() {
        let a = parse_args(vec![
            "run".into(), "--stage".into(), "compile".into(), "--json".into(),
            "--".into(),
            "cargo".into(), "build".into(), "--release".into(), "--json".into(),
        ])
        .unwrap();
        assert_eq!(a.stage.as_deref(), Some("compile"));
        assert!(a.json, "our own flag before the `--` still parses");
        assert_eq!(a.trailing, vec!["cargo", "build", "--release", "--json"]);
        assert_eq!(a.positional, vec!["run"], "the child's words are not our positionals");
    }

    /// `run` without a `--` is refused rather than guessed at: taking the positionals as the command
    /// would make `bsc errors run --stage build` (a typo, no command) try to execute something.
    #[test]
    fn run_without_a_command_is_a_usage_error() {
        let err = run(vec!["run".into(), "--stage".into(), "build".into()], "bsc errors").unwrap_err();
        assert!(err.contains("usage:") && err.contains("--"), "{err}");
    }

    /// An invalid stage is refused BEFORE the command runs. Running it first and then discovering the
    /// stage is bad would leave a build that ran and a fault that could not be filed.
    #[test]
    fn run_refuses_a_bad_stage_before_executing_anything() {
        let err = run(
            vec!["run".into(), "--stage".into(), "nonsense".into(), "--".into(), "true".into()],
            "bsc errors",
        )
        .unwrap_err();
        assert!(err.contains("invalid stage"), "{err}");
        for stage in crate::STAGES {
            assert!(err.contains(stage), "the refusal names `{stage}`");
        }
    }

    /// `--project <key>` derives the hub path the app's `error_db_path` derives, so a session outside
    /// the app reaches the same db the app writes — without knowing any path.
    #[test]
    fn project_resolves_the_hub_db_and_beats_the_env() {
        let p = resolve_db(&None, &Some("studio-code".into())).expect("resolves from HOME");
        assert!(p.ends_with(std::path::Path::new("projects/studio-code/error.db")), "{}", p.display());
        // Both together are REFUSED rather than ranked: silently choosing one decides which store a
        // write lands in, which is exactly the mistake to be loud about.
        let err = resolve_db(&Some("/tmp/x.db".into()), &Some("studio-code".into())).unwrap_err();
        assert!(err.contains("--db") && err.contains("--project"), "{err}");
        // With neither, and no env, the error names all three ways in.
        std::env::remove_var("BSC_ERROR_DB");
        let err = resolve_db(&None, &None).unwrap_err();
        assert!(err.contains("--db") && err.contains("--project") && err.contains("BSC_ERROR_DB"), "{err}");
        // A blank --project is not a project: it would silently resolve to `projects/error.db`.
        assert!(resolve_db(&None, &Some("   ".into())).is_err());
    }

    /// The discovery verb: which project broke, ranked, from a session that knows nothing.
    #[test]
    fn projects_ranks_the_noisiest_and_reports_a_clean_hub_as_zero() {
        let base = std::env::temp_dir().join(format!("errordb-projects-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let mk = |key: &str| {
            let d = base.join(key);
            std::fs::create_dir_all(&d).unwrap();
            Store::open(&d.join("error.db")).unwrap()
        };
        let noisy = mk("noisy");
        for (i, t) in ["a", "b"].iter().enumerate() {
            noisy.record(&FaultInput { level: "error".into(), title: (*t).into(), ts: 10 + i as i64, ..Default::default() }).unwrap();
        }
        noisy.record(&FaultInput { level: "fatal".into(), title: "worst".into(), ts: 30, ..Default::default() }).unwrap();
        let quiet = mk("quiet");
        let fp = quiet.record(&FaultInput { level: "warn".into(), title: "meh".into(), ts: 5, ..Default::default() }).unwrap().fingerprint;
        quiet.resolve(&fp, 6).unwrap();
        // A hub with no error.db at all is skipped — it is not a project that has faults.
        std::fs::create_dir_all(base.join("no-store")).unwrap();

        let rows = scan_projects(&base).unwrap();
        assert_eq!(rows.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), vec!["noisy", "quiet"],
                   "noisiest first; a hub without an error.db is not listed");
        assert_eq!(rows[0].unresolved, 3);
        assert_eq!(rows[0].worst.as_deref(), Some("fatal"), "the worst level present, not the newest");
        assert_eq!(rows[0].title.as_deref(), Some("worst"), "the newest fault's title");
        // A hub whose faults are all resolved reports ZERO rather than vanishing: absent and clean are
        // different answers, and only one of them means look somewhere else.
        assert_eq!(rows[1].unresolved, 0);
        assert_eq!(rows[1].worst, None);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Discovery must not WRITE. `Store::open` creates and migrates, so a scan that opened every
    /// directory would mint an empty error.db for each one — answering a question by changing it.
    #[test]
    fn projects_never_creates_a_store_for_a_hub_that_has_none() {
        let base = std::env::temp_dir().join(format!("errordb-projects-ro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("bare")).unwrap();
        assert!(scan_projects(&base).unwrap().is_empty());
        assert!(!base.join("bare").join("error.db").exists(), "the scan created a store");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn end_to_end_add_list_get_resolve_over_a_temp_db() {
        // Drive the CLI through $BSC_ERROR_DB against a temp file (the same resolution a session uses).
        let dir = std::env::temp_dir().join(format!("errordb-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("error.db");
        let _ = std::fs::remove_file(&path);
        // Seed two faults via the lib (the CLI's now_ms would be nondeterministic).
        {
            let s = Store::open(&path).unwrap();
            s.record(&FaultInput { level: "error".into(), title: "boom".into(), ts: 10, ..Default::default() }).unwrap();
            s.record(&FaultInput { level: "warn".into(), title: "meh".into(), ts: 20, ..Default::default() }).unwrap();
        }
        std::env::set_var("BSC_ERROR_DB", &path);
        // list --unresolved --json returns both, newest-first.
        let faults = open_store(&None, &None).unwrap().list(&Filter { unresolved: true, ..Default::default() }).unwrap();
        assert_eq!(faults.len(), 2);
        assert_eq!(faults[0].title, "meh");
        // resolve one, then --unresolved returns one.
        let fp = faults[1].fingerprint.clone();
        assert!(open_store(&None, &None).unwrap().resolve(&fp, 99).unwrap());
        assert_eq!(open_store(&None, &None).unwrap().list(&Filter { unresolved: true, ..Default::default() }).unwrap().len(), 1);
        std::env::remove_var("BSC_ERROR_DB");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
