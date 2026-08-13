//! The `bsc session` subcommand — the architect's lever over the app-owned system sessions.

use crate::{
    LifecycleAction, LifecycleOutcome, LifecycleRequest, LifecycleResult, SessionListRequest,
    SessionListResult, KIND, LIFECYCLE_KIND, SYSTEM_SESSIONS,
};
use bsc_cli_util::CmdDoc;

const DEFAULT_TIMEOUT_MS: i64 = 8_000;
const POLL_INTERVAL_MS: u64 = 40;
const STALE_MS: i64 = 60_000;

const TAGLINE: &str = "the app-owned SYSTEM SESSIONS — start · stop · list (#architect-orchestrates)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every system session and whether it is actually running",
        usage: "\
USAGE:
  bsc session [list] [--json|--pretty]

One row per app-owned system session, with the same real liveness `bsc fleet list` reports:

  LIVE   a PTY session exists (`start` would be a no-op, `stop` would end it)
  BUSY   that session has a live descendant — something is running in it
  PID    the session's OS process id

Check this BEFORE starting: a system session is a singleton on a fixed pane id, so `start` on one that
is already live changes nothing, and a caller that assumed otherwise is waiting for a session it did
not create.

Requires the desktop app: liveness lives in its PTY state, not on disk.",
    },
    CmdDoc {
        name: "start",
        summary: "bring up a system session (no-op if it is already running)",
        usage: "\
USAGE:
  bsc session start <id> [--json|--pretty]

Brings up one app-owned system session. Because its pane id is fixed and stable, a session started
here RESUMES its previous conversation (`claude --continue`) rather than beginning blank.

THE ID IS A CLOSED SET — run `bsc session list` for it. Anything outside it is refused, and the
refusal names the valid ids. This verb reaches only the app-owned system sessions: not fleet workers,
and not a project's director.

The started session keeps its OWN role gate. Starting the designer yields a designer confined to
`bsc ui`, exactly as if it had been opened from the UI — starting a session grants no capability the
caller did not already have.

Already running ⇒ reported as `already-running`, not as a fresh start. That distinction matters: a
singleton pane cannot host two sessions, so a second `start` is a no-op and saying otherwise would be
a false success.",
    },
    CmdDoc {
        name: "stop",
        summary: "end a system session you started (never a director)",
        usage: "\
USAGE:
  bsc session stop <id> [--json|--pretty]

Ends one app-owned system session: its PTY is killed and its warm mount released.

CHEAP AND REVERSIBLE, deliberately. The pane id is stable, so `start` afterwards resumes the same
conversation — stopping reclaims the process, it does not discard the work.

IT CANNOT REACH A DIRECTOR, and not by a check that could be dropped: this verb's whole argument space
is the system-session registry, so a director pane id is not expressible. That asymmetry is the
settled design — a director coordinates a RUNNING FLEET whose workers, under the no-app-injection
model, have no route back except the user's click. Ending one is the user's act.

Not running ⇒ reported as `not-running` rather than an error: stopping something already stopped is
the state the caller wanted.",
    },
];

struct Args {
    json: bool,
    pretty: bool,
    timeout_ms: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { json: false, pretty: false, timeout_ms: None, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--timeout" => {
                let v = it.next().ok_or("--timeout needs a value")?;
                a.timeout_ms = Some(v.parse().map_err(|_| format!("--timeout: not a number: {v}"))?);
            }
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    match args.positional.first().map(String::as_str).unwrap_or("list") {
        "list" => cmd_list(&args),
        "start" => cmd_lifecycle(&args, prog, LifecycleAction::Start),
        "stop" => cmd_lifecycle(&args, prog, LifecycleAction::Stop),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `bsc session start|stop <id>`.
///
/// The id is resolved against the closed set HERE, before anything is written to the channel, so an
/// invalid one costs a local error rather than a round trip — and, more to the point, so the string the
/// caller supplied never reaches the app as an instruction. The app resolves it again on receipt; this
/// is the fast, explanatory half of a boundary that is enforced on both sides.
fn cmd_lifecycle(args: &Args, prog: &str, action: LifecycleAction) -> Result<(), String> {
    let verb = match action {
        LifecycleAction::Start => "start",
        LifecycleAction::Stop => "stop",
    };
    let id = args
        .positional
        .get(1)
        .ok_or_else(|| format!("usage: {prog} {verb} <id>\n\nValid ids: {}", crate::valid_ids().join(" · ")))?;
    let session = match action {
        LifecycleAction::Start => crate::resolve(id)?,
        LifecycleAction::Stop => crate::resolve_stoppable(id)?,
    };

    let req = LifecycleRequest { id: session.id.to_string(), action };
    let res: LifecycleResult = ask(LIFECYCLE_KIND, &req, args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;
    bsc_cli_util::emit(args.pretty, args.json, &res, || describe(&res));
    Ok(())
}

/// The human line for an outcome. Each one says what the state IS now, not just what was attempted —
/// a caller reading "already running" knows it can go straight to using the session.
fn describe(res: &LifecycleResult) -> String {
    match res.outcome {
        LifecycleOutcome::Started => format!("started {} ({})", res.id, res.pane_id),
        LifecycleOutcome::AlreadyRunning => {
            format!("{} was already running ({}) — nothing to do", res.id, res.pane_id)
        }
        LifecycleOutcome::Stopped => format!("stopped {} ({})", res.id, res.pane_id),
        LifecycleOutcome::NotRunning => format!("{} was not running ({})", res.id, res.pane_id),
    }
}

fn cmd_list(args: &Args) -> Result<(), String> {
    let res: SessionListResult =
        ask(KIND, &SessionListRequest::default(), args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;

    if args.json || args.pretty {
        bsc_cli_util::emit(args.pretty, args.json, &res, String::new);
        return Ok(());
    }
    println!("{:<16} {:<32} {:<6} {:<6} {:<8} WHAT IT IS", "ID", "PANE", "LIVE", "BUSY", "PID");
    for s in SYSTEM_SESSIONS {
        let state = res.sessions.iter().find(|r| r.id == s.id);
        let (live, busy, pid) = match state {
            Some(r) => (
                if r.live { "yes" } else { "no" }.to_string(),
                if r.busy { "yes" } else { "no" }.to_string(),
                r.pid.map(|v| v.to_string()).unwrap_or_else(|| "-".into()),
            ),
            // The app answered without this session at all. Printed rather than skipped: a registry the
            // app does not recognise is exactly the drift worth seeing, not hiding behind a blank row.
            None => ("?".into(), "?".into(), "-".into()),
        };
        println!("{:<16} {:<32} {live:<6} {busy:<6} {pid:<8} {}", s.id, s.pane_id, s.summary);
    }
    Ok(())
}

/// The shared request/await for every verb here — one transport, so a new verb cannot drift onto a
/// second one.
fn ask<Q: serde::Serialize, R: serde::de::DeserializeOwned>(
    kind: &str,
    req: &Q,
    timeout: i64,
) -> Result<R, String> {
    let chan = bsc_appchan::chan_dir()?;
    let now = bsc_util::now_ms();
    let _ = bsc_appchan::sweep_stale(&chan, now, STALE_MS);

    let id = bsc_appchan::new_id(now);
    bsc_appchan::write_request(&chan, &id, kind, now, req)?;

    let reply = bsc_appchan::poll_reply(&chan, &id, timeout, POLL_INTERVAL_MS, || {
        format!(
            "timed out after {timeout}ms waiting for the app to answer.\n\
             The request is at {}.\n\
             Is the desktop app running? A system session lives in its window — `bsc` cannot start one \
             on its own.",
            bsc_appchan::request_path(&chan, &id).display()
        )
    })?;
    bsc_appchan::take_payload(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_reads_the_flags() {
        let a = parse_args(vec!["start".into(), "designer".into(), "--json".into()]).unwrap();
        assert!(a.json);
        assert_eq!(a.positional, vec!["start", "designer"]);
        assert!(parse_args(vec!["--nope".into()]).is_err());
    }

    /// A flag-looking id must not be swallowed as a flag and leave the verb with no argument — that
    /// would turn a bad id into a usage error and hide which of the two the caller got wrong.
    #[test]
    fn an_unknown_flag_is_an_error_rather_than_a_silent_drop() {
        assert!(parse_args(vec!["stop".into(), "--director".into()]).is_err());
    }

    /// `bsc session` with no verb lists, rather than erroring. Listing is the read a caller wants
    /// before acting, and it is the only verb here that changes nothing.
    #[test]
    fn the_default_verb_is_list() {
        let a = parse_args(vec![]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str).unwrap_or("list"), "list");
    }

    /// The outcome text has to distinguish the no-ops from the acting cases in PROSE too, not only in
    /// the JSON — an agent reads the human line when it does not pass `--json`.
    #[test]
    fn each_outcome_reads_differently() {
        let mk = |o| LifecycleResult { id: "designer".into(), pane_id: "design-studio:designer".into(), outcome: o };
        let started = describe(&mk(LifecycleOutcome::Started));
        let already = describe(&mk(LifecycleOutcome::AlreadyRunning));
        let stopped = describe(&mk(LifecycleOutcome::Stopped));
        let not_running = describe(&mk(LifecycleOutcome::NotRunning));
        for line in [&started, &already, &stopped, &not_running] {
            assert!(line.contains("designer"), "every line names the session");
        }
        assert!(already.contains("already"), "a no-op must not read as a fresh start");
        assert!(not_running.contains("not running"));
        assert_ne!(started, already);
        assert_ne!(stopped, not_running);
    }

    /// The usage error for a missing id carries the valid set — the caller is one command short of
    /// knowing what to type, and `list` needs the app running while this does not.
    #[test]
    fn a_missing_id_names_the_valid_set() {
        let args = parse_args(vec!["start".into()]).unwrap();
        let err = cmd_lifecycle(&args, "bsc session", LifecycleAction::Start).unwrap_err();
        assert!(err.contains("usage:"));
        for id in crate::valid_ids() {
            assert!(err.contains(id), "the usage error lists {id}");
        }
    }

    /// An id outside the closed set fails BEFORE any request is written — the resolution is the
    /// boundary, and a rejected argument must never become a file in the channel dir for the app to
    /// parse. (If this ever regressed the test would hang on the round trip rather than return an
    /// error, which is itself the signal.)
    #[test]
    fn a_bad_id_is_refused_without_reaching_the_channel() {
        let args = parse_args(vec!["stop".into(), "studio-code:director".into()]).unwrap();
        let err = cmd_lifecycle(&args, "bsc session", LifecycleAction::Stop).unwrap_err();
        assert!(err.contains("is not a system session"));
        assert!(err.contains("director"), "and it explains why a director is out of scope");
    }
}
