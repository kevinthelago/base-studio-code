//! The `bsc loop` subcommand (#3262) — the CLI over the loop store. A **loop** is a conversation two
//! participants drive to a termination signal, or forever. The designer session (role-gated to `bsc ui`)
//! reports friction; an external session picks it up — turns accumulate, each side sees the whole history,
//! and it runs until a sentinel fires or `--until false` says never.
//!
//! The db is global (`~/.base-studio-code/loops.db`), located via `--db <path>` or `$BSC_LOOP_DB` — an
//! **external** session, not inside any PTY, reaches it the same way. Reads are lean by default;
//! `--json`/`--pretty` for machine-readable JSON. Help is per-command: `bsc loop help` · `bsc loop <cmd> help`.

use crate::{Filter, Loop, NewLoop, SayError, SayInput, Store, Turn, DEFAULT_MAX_TURNS};
use bsc_cli_util::CmdDoc;
use serde::Serialize;
use std::path::PathBuf;
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TAGLINE: &str = "the loop store — a conversation that ends on a signal, or never (#3262)";
/// How long `watch` blocks before it gives up (a loop that never becomes your turn must not hang forever).
const DEFAULT_WATCH_TIMEOUT_SECS: i64 = 600;
const WATCH_POLL_MS: u64 = 1000;

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "new",
        summary: "start a loop between two participants; prints its id",
        usage: "\
USAGE:
  bsc loop new <a> <b> --seed \"<text>\" [--until <sig>|false] [--max-turns N] [--budget F] [--project k]

Opens a conversation. <a> speaks first; turns strictly alternate. Options:
  --seed \"...\"     the opening topic/prompt (required)
  --until <sig>    a sentinel a participant emits to close the loop (e.g. RESOLVED)
  --until false    NEVER close by signal — a first-class mode (only stop/budget/max-turns can halt it)
  --max-turns N    the turn ceiling (default 24; N=0 means unlimited)
  --budget F       the cost ceiling (default none; F<=0 means unlimited)
  --project k      an optional project tag (filter only)
Prints the new loop's id.",
    },
    CmdDoc {
        name: "say",
        summary: "post your turn (must be your turn)",
        usage: "\
USAGE:
  bsc loop say <id> --as <participant> \"<message>\" [--shot PATH] [--tokens N] [--cost F]

Appends your turn. Rejected unless it is your turn (strict alternation, <a> first) and the loop is open.
  --shot PATH      attach a PNG (a `bsc shot` capture, #3261)
  --tokens N       tokens spent producing this turn (accounting)
  --cost F         cost of this turn (the budget is summed from these)
Evaluates the termination signal after the turn: a sentinel closes the loop; a budget/max-turns ceiling
halts it. Prints the turn number, and `closed (<reason>)` if this turn ended the loop.",
    },
    CmdDoc {
        name: "watch",
        summary: "block until it's your turn; print the awaited message",
        usage: "\
USAGE:
  bsc loop watch <id> --as <participant> [--timeout SECS]

Blocks until it is your turn (or the loop closes), then prints the message you're replying to and exits 0.
Exits NON-ZERO on timeout (default 600s) or if the loop is already closed — it never hangs forever.",
    },
    CmdDoc {
        name: "show",
        summary: "the transcript + per-turn cost",
        usage: "\
USAGE:
  bsc loop show <id> [--json|--pretty]

The loop header + the full ordered transcript + the running cost total. --json emits { loop, turns, total_cost }.",
    },
    CmdDoc {
        name: "list",
        summary: "the loop table (newest first)",
        usage: "\
USAGE:
  bsc loop list [--open] [--project k] [--limit N] [--json|--pretty]

The loops, newest first. --open shows only loops still accepting turns; --project filters by tag.",
    },
    CmdDoc {
        name: "reap",
        summary: "close loops an unclean shutdown stranded (crash / kill / force-quit)",
        usage: "USAGE:
  bsc loop reap [--dry-run] [--json]

A loop in flight when the app DIES is never reconciled: nothing closes it, so it stays `open`
forever and `watch` blocks on a turn that will never come. `reap` closes every still-open loop as
`ended_by=interrupted` — a reason distinct from `stop`, because a user halting a loop and a crash
killing one are different facts.

--dry-run reports what WOULD be reaped without writing, which is how the boot banner counts them.

Only meaningful after an UNCLEAN shutdown; the caller decides that (it knows whether the session
lock survived). Run against a live app it would close loops that are legitimately running.",
    },
    CmdDoc {
        name: "stop",
        summary: "halt a loop out-of-band (the participants cannot)",
        usage: "\
USAGE:
  bsc loop stop <id>

Closes an open loop from OUTSIDE the conversation — the only way to halt a `--until false` loop. Deliberately
a separate verb from `say`, so a participant cannot reach it. A no-op (reported) if already closed.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    seed: Option<String>,
    until: Option<String>,
    max_turns: Option<i64>,
    budget: Option<f64>,
    project: Option<String>,
    as_who: Option<String>,
    shot: Option<String>,
    tokens: Option<i64>,
    cost: Option<f64>,
    timeout: Option<i64>,
    open: bool,
    /// #3961 `reap --dry-run`: report what WOULD be reaped, write nothing.
    dry_run: bool,
    limit: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        json: false,
        pretty: false,
        db: None,
        seed: None,
        until: None,
        max_turns: None,
        budget: None,
        project: None,
        as_who: None,
        shot: None,
        tokens: None,
        cost: None,
        timeout: None,
        open: false,
        dry_run: false,
        limit: None,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        let mut val = |flag: &str| -> Result<String, String> { it.next().ok_or_else(|| format!("flag {flag} needs a value")) };
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--open" => a.open = true,
            "--dry-run" => a.dry_run = true,   // #3961: reap COUNTS without writing
            "--db" => a.db = Some(val("--db")?),
            "--seed" => a.seed = Some(val("--seed")?),
            "--until" => a.until = Some(val("--until")?),
            "--project" => a.project = Some(val("--project")?),
            "--as" => a.as_who = Some(val("--as")?),
            "--shot" => a.shot = Some(val("--shot")?),
            "--max-turns" => a.max_turns = Some(val("--max-turns")?.parse().map_err(|_| "--max-turns needs an integer")?),
            "--budget" => a.budget = Some(val("--budget")?.parse().map_err(|_| "--budget needs a number")?),
            "--tokens" => a.tokens = Some(val("--tokens")?.parse().map_err(|_| "--tokens needs an integer")?),
            "--cost" => a.cost = Some(val("--cost")?.parse().map_err(|_| "--cost needs a number")?),
            "--timeout" => a.timeout = Some(val("--timeout")?.parse().map_err(|_| "--timeout needs an integer (seconds)")?),
            "--limit" => a.limit = Some(val("--limit")?.parse().map_err(|_| "--limit needs an integer")?),
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `loop` subcommand entrypoint: `args` is everything after `bsc loop`; `prog` is the display name.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "new" => cmd_new(&args),
        "say" => cmd_say(&args),
        "watch" => cmd_watch(&args),
        "show" => cmd_show(&args),
        "list" => cmd_list(&args),
        "reap" => cmd_reap(&args),
        "stop" => cmd_stop(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `new <a> <b> --seed …` — open a loop; prints its id.
fn cmd_new(args: &Args) -> Result<(), String> {
    let a = args.positional.get(1).ok_or("usage: bsc loop new <a> <b> --seed \"...\"")?;
    let b = args.positional.get(2).ok_or("usage: bsc loop new <a> <b> --seed \"...\"")?;
    let seed = args.seed.clone().ok_or("bsc loop new needs --seed \"<text>\"")?;
    if a == b {
        return Err("the two participants must differ".into());
    }
    // `--until false` (or omitted) → no signal; `--max-turns 0` → unlimited, omitted → the safe default;
    // `--budget <=0` → unlimited, omitted → none.
    let until = args.until.clone().filter(|u| u != "false");
    let max_turns = match args.max_turns {
        Some(0) => None,
        Some(n) => Some(n),
        None => Some(DEFAULT_MAX_TURNS),
    };
    let budget = args.budget.filter(|f| *f > 0.0);
    let new = NewLoop { a: a.clone(), b: b.clone(), seed, until, max_turns, budget, project: args.project.clone() };
    let lp = open_store(&args.db)?.create(&new, now_ms()).map_err(|e| format!("creating loop: {e}"))?;
    println!("{}", lp.id);
    Ok(())
}

/// `say <id> --as <participant> "<message>"` — post a turn.
fn cmd_say(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let who = args.as_who.as_deref().ok_or("bsc loop say needs --as <participant>")?;
    let message = args.positional.get(2).ok_or("usage: bsc loop say <id> --as <who> \"<message>\"")?;
    let input = SayInput {
        message: message.clone(),
        shot_path: args.shot.clone(),
        tokens: args.tokens.unwrap_or(0),
        cost: args.cost.unwrap_or(0.0),
        ts: now_ms(),
    };
    let outcome = open_store(&args.db)?.say(id, who, &input).map_err(say_error)?;
    match outcome.closed {
        Some(why) => println!("turn {} — closed ({why})", outcome.seq),
        None => println!("turn {}", outcome.seq),
    }
    Ok(())
}

/// `watch <id> --as <participant>` — block until it's your turn (or timeout / closed).
fn cmd_watch(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let who = args.as_who.as_deref().ok_or("bsc loop watch needs --as <participant>")?;
    let store = open_store(&args.db)?;
    // Validate participant + existence up front (before blocking).
    let lp = store.get(id).map_err(|e| format!("reading loop: {e}"))?.ok_or_else(|| format!("no loop {id}"))?;
    if who != lp.a && who != lp.b {
        return Err(format!("'{who}' is not a participant of loop {id}"));
    }
    let deadline = Instant::now() + Duration::from_secs(args.timeout.unwrap_or(DEFAULT_WATCH_TIMEOUT_SECS).max(0) as u64);
    loop {
        let lp = store.get(id).map_err(|e| format!("reading loop: {e}"))?.ok_or_else(|| format!("no loop {id}"))?;
        if !lp.is_open() {
            // Nothing to reply to — a closed loop is a non-zero exit, never a hang.
            return Err(format!("loop {id} closed ({})", lp.ended_by.unwrap_or_default()));
        }
        if store.whose_turn(id).map_err(|e| format!("reading loop: {e}"))?.as_deref() == Some(who) {
            // Your turn — print the message you're replying to (the last turn, else the seed).
            let turns = store.turns(id).map_err(|e| format!("reading turns: {e}"))?;
            let awaited = turns.last().map(|t| t.message.clone()).unwrap_or(lp.seed);
            bsc_cli_util::print_raw(&awaited);
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("timed out waiting for your turn on loop {id}"));
        }
        sleep(Duration::from_millis(WATCH_POLL_MS));
    }
}

/// `show <id>` — the transcript + per-turn cost.
fn cmd_show(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let store = open_store(&args.db)?;
    let lp = store.get(id).map_err(|e| format!("reading loop: {e}"))?.ok_or_else(|| format!("no loop {id}"))?;
    let turns = store.turns(id).map_err(|e| format!("reading turns: {e}"))?;
    let total_cost = store.total_cost(id).map_err(|e| format!("reading cost: {e}"))?;
    let out = ShowOut { lp: &lp, turns: &turns, total_cost };
    bsc_cli_util::emit(args.pretty, args.json, &out, || show_block(&lp, &turns, total_cost));
    Ok(())
}

/// `list` — the loop table.
fn cmd_list(args: &Args) -> Result<(), String> {
    let filter = Filter { open_only: args.open, project: args.project.clone(), limit: args.limit };
    let loops = open_store(&args.db)?.list(&filter).map_err(|e| format!("listing loops: {e}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &loops, || {
        if loops.is_empty() {
            "(no loops)".to_string()
        } else {
            loops.iter().map(loop_line).collect::<Vec<_>>().join("\n")
        }
    });
    Ok(())
}

/// `stop <id>` — out-of-band halt.
fn cmd_stop(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let halted = open_store(&args.db)?.stop(id, now_ms()).map_err(|e| format!("stopping loop: {e}"))?;
    println!("{}", if halted { format!("stopped loop {id}") } else { format!("loop {id} was already closed") });
    Ok(())
}

/// `reap` (#3961): close every still-open loop as INTERRUPTED, or just report them under --dry-run.
///
/// The store answers "what was still running?"; deciding those are stranded is the CALLER's job,
/// because only the caller knows the last shutdown was unclean. That split keeps the store out of
/// the business of guessing process liveness.
fn cmd_reap(args: &Args) -> Result<(), String> {
    let store = open_store(&args.db)?;
    let open = store.open_loops().map_err(|e| format!("listing open loops: {e}"))?;
    let dry = args.dry_run;
    let ids: Vec<i64> = open.iter().map(|l| l.id).collect();
    let reaped = if dry {
        0
    } else {
        store.mark_interrupted(&ids, now_ms()).map_err(|e| format!("reaping loops: {e}"))?
    };
    if args.json || args.pretty {
        let out = ReapOut { dry_run: dry, count: open.len(), reaped, loops: &open };
        bsc_cli_util::emit(args.pretty, args.json, &out, String::new);
        return Ok(());
    }
    if open.is_empty() {
        println!("no open loops to reap");
    } else if dry {
        println!("{} open loop(s) would be reaped: {}", open.len(), ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(", "));
    } else {
        println!("reaped {reaped} interrupted loop(s): {}", ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(", "));
    }
    Ok(())
}

/// The `reap --json` payload — what was found, what was written, and the rows themselves so a caller
/// can name the participants in a banner without a second read.
#[derive(Serialize)]
struct ReapOut<'a> {
    dry_run: bool,
    count: usize,
    reaped: usize,
    loops: &'a [Loop],
}

/// The `show --json` payload — the loop, its turns, and the running cost total.
#[derive(Serialize)]
struct ShowOut<'a> {
    #[serde(rename = "loop")]
    lp: &'a Loop,
    turns: &'a [Turn],
    total_cost: f64,
}

/// One lean TSV row for `list`: id, status, a, b, until|∞, turns-cap, project.
fn loop_line(l: &Loop) -> String {
    let state = match &l.ended_by {
        Some(why) if !l.is_open() => format!("closed:{why}"),
        _ => l.status.clone(),
    };
    format!(
        "{}\t{}\t{} <-> {}\t{}\t{}",
        l.id,
        state,
        l.a,
        l.b,
        l.until.as_deref().unwrap_or("(never)"),
        l.project.as_deref().unwrap_or("-"),
    )
}

/// The human `show` block — header + transcript + total cost.
fn show_block(l: &Loop, turns: &[Turn], total_cost: f64) -> String {
    let mut s = format!(
        "loop {}  {} <-> {}  [{}{}]\nseed: {}\nuntil: {} · max-turns: {} · budget: {}",
        l.id,
        l.a,
        l.b,
        l.status,
        l.ended_by.as_ref().map(|w| format!(":{w}")).unwrap_or_default(),
        l.seed,
        l.until.as_deref().unwrap_or("(never)"),
        l.max_turns.map(|n| n.to_string()).unwrap_or_else(|| "∞".into()),
        l.budget.map(|b| b.to_string()).unwrap_or_else(|| "∞".into()),
    );
    for t in turns {
        let shot = t.shot_path.as_ref().map(|p| format!("  [shot: {p}]")).unwrap_or_default();
        let cost = if t.cost > 0.0 { format!("  (${:.4})", t.cost) } else { String::new() };
        s.push_str(&format!("\n  {}. {}: {}{shot}{cost}", t.seq, t.participant, t.message));
    }
    s.push_str(&format!("\n— {} turn(s), total cost ${total_cost:.4}", turns.len()));
    s
}

/// Turn a [`SayError`] into a CLI error string (the store's precise reason).
fn say_error(e: SayError) -> String {
    format!("cannot post turn: {e}")
}

/// Parse the loop id from the first positional after the command word.
fn positional_id(args: &Args) -> Result<i64, String> {
    let raw = args.positional.get(1).ok_or("usage: bsc loop <cmd> <id> …")?;
    raw.parse().map_err(|_| format!("loop id must be an integer (got '{raw}')"))
}

/// Open the global loops.db (resolved from `--db` / `$BSC_LOOP_DB` / `~/.base-studio-code/loops.db`).
fn open_store(db: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Resolve the loops.db path: `--db` → `$BSC_LOOP_DB` → `~/.base-studio-code/loops.db`.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    if let Some(f) = flag {
        return Ok(PathBuf::from(f));
    }
    bsc_sqlite_util::default_store_path("BSC_LOOP_DB", &["loops.db"])
        .ok_or_else(|| "cannot locate loops.db (no home directory); pass --db <path>".to_string())
}

/// Current wall-clock in epoch milliseconds (0 if the clock is before the epoch — never panics).
fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_collects_flags_and_positionals() {
        let a = parse_args(vec![
            "new".into(),
            "designer".into(),
            "ext".into(),
            "--seed".into(),
            "tune the kit".into(),
            "--until".into(),
            "false".into(),
            "--max-turns".into(),
            "0".into(),
            "--budget".into(),
            "2.5".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["new", "designer", "ext"]);
        assert_eq!(a.seed.as_deref(), Some("tune the kit"));
        assert_eq!(a.until.as_deref(), Some("false"));
        assert_eq!(a.max_turns, Some(0));
        assert_eq!(a.budget, Some(2.5));
    }

    #[test]
    fn parse_args_rejects_unknown_flag_and_missing_value() {
        assert!(parse_args(vec!["new".into(), "--nope".into()]).is_err());
        assert!(parse_args(vec!["--budget".into()]).is_err(), "value-flag with no value");
        assert!(parse_args(vec!["--max-turns".into(), "abc".into()]).is_err(), "non-integer");
    }

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn help_overview_and_per_command_help() {
        let ov = bsc_cli_util::help_overview("bsc loop", TAGLINE, COMMANDS);
        for name in ["new", "say", "watch", "show", "list", "stop"] {
            assert!(ov.contains(name), "overview lists {name}");
        }
        let new = bsc_cli_util::help_for("bsc loop", TAGLINE, COMMANDS, "new");
        assert!(new.contains("bsc loop new"));
        assert!(new.contains("--until false"), "documents the never-ending mode");
        let stop = bsc_cli_util::help_for("bsc loop", TAGLINE, COMMANDS, "stop");
        assert!(stop.contains("the participants cannot") || stop.contains("cannot reach"));
    }

    #[test]
    fn end_to_end_new_say_show_over_a_temp_db() {
        let dir = std::env::temp_dir().join(format!("bsc-loop-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("loops.db");
        let _ = std::fs::remove_file(&path);
        std::env::set_var("BSC_LOOP_DB", &path);

        // new → id 1
        cmd_new(&args_for(vec!["new", "designer", "ext"], |a| a.seed = Some("tune it".into()))).unwrap();
        // designer says first; ext can't jump the turn.
        cmd_say(&args_for(vec!["say", "1", "hello"], |a| a.as_who = Some("designer".into()))).unwrap();
        let jump = cmd_say(&args_for(vec!["say", "1", "me first"], |a| a.as_who = Some("designer".into())));
        assert!(jump.is_err(), "designer cannot speak twice in a row");
        cmd_say(&args_for(vec!["say", "1", "on it"], |a| a.as_who = Some("ext".into()))).unwrap();

        let store = open_store(&None).unwrap();
        assert_eq!(store.turns(1).unwrap().len(), 2);
        assert_eq!(store.whose_turn(1).unwrap().as_deref(), Some("designer"));

        std::env::remove_var("BSC_LOOP_DB");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Build an `Args` for a handler test — the command word + positionals, then a mutator for flags.
    fn args_for(positional: Vec<&str>, set: impl FnOnce(&mut Args)) -> Args {
        let mut a = parse_args(positional.into_iter().map(String::from).collect()).unwrap();
        set(&mut a);
        a
    }
}
