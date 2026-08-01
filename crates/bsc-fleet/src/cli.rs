//! The `bsc fleet` subcommand (#4098) — real per-pane liveness, joined onto the roster.

use crate::{FleetRequest, FleetResult, PaneLive, WakeRequest, WakeResult, KIND, WAKE_KIND};
use bsc_cli_util::CmdDoc;

const DEFAULT_TIMEOUT_MS: i64 = 8_000;
const POLL_INTERVAL_MS: u64 = 40;
const STALE_MS: i64 = 60_000;

const TAGLINE: &str = "which fleet panes are ACTUALLY alive — asks the running app (#4098)";

const COMMANDS: &[CmdDoc] = &[CmdDoc {
    name: "list",
    summary: "every tracked pane's real liveness (+ pid), joined onto the roster when there is one",
    usage: "\
USAGE:
  bsc fleet [list] [--roster <path>] [--json|--pretty]

Asks the RUNNING app which panes have a live PTY session and which have something actually running
in them, and prints one row per pane.

  LIVE   a PTY session exists (`pty_create` would reconnect, not launch)
  BUSY   that session has a live descendant — something is running in it
  PID    the session's OS process id

This is the counterpart to the `bsc-fleet` shell helper. That one reads fleet.roster.tsv — a LAUNCH
MANIFEST — and joins coord.log, so it reports what was launched and what each pane has SAID since; it
never checks a process. A pane whose session exited an hour ago read exactly like a live one. Use the
helper to see the planned fleet and its coordination state; use this to see what is running.

With a roster present (the hub's fleet.roster.tsv, or --roster) each row also carries its stream and
role, and a manifest row the app is NOT tracking is reported explicitly rather than omitted — that
gap is the thing worth seeing.

Requires the desktop app: liveness lives in its PTY state, not on disk. Errors plainly when it is not
running rather than reporting everything as dead.",
},
CmdDoc {
    name: "wake",
    summary: "wake a parked/reaped worker — the director's lever over a stopped session",
    usage: "USAGE:
  bsc fleet wake <pane-id> [--prompt <text>] [--force] [--json|--pretty]

Wakes a worker whose session was parked or reclaimed, and hands it a prompt to start on. Without
--prompt the app supplies its standard change-request wake, so a director does not have to reproduce
that prose to use the command.

REFUSES a BUSY pane unless --force. Waking KILLS the PTY before relaunching, so interrupting a worker
that is mid-task is a deliberate act, not something to do by accident. `bsc fleet list` shows which
panes are busy.

The reply carries whether the wake actually landed. A pane the app cannot resolve (or one the user
disabled) reports an ERROR rather than success — the wake path kills first, so a false success would
leave a dead worker behind a caller that believes it is running.

Requires the desktop app: waking is frontend state, so only the app can do it.",
}];

struct Args {
    json: bool,
    pretty: bool,
    roster: Option<String>,
    prompt: Option<String>,
    force: bool,
    timeout_ms: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { json: false, pretty: false, roster: None, prompt: None, force: false, timeout_ms: None, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--roster" => a.roster = Some(it.next().ok_or("--roster needs a path")?),
            "--prompt" => a.prompt = Some(it.next().ok_or("--prompt needs text")?),
            "--force" => a.force = true,
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

/// One roster row's identifying columns — `paneId \t stream \t repo \t branch \t role`.
struct RosterRow {
    pane_id: String,
    stream: String,
    role: String,
}

/// Read the roster if one is there. Absent ⇒ empty: the command still works, it just cannot name a
/// pane's stream or notice a manifest row the app has forgotten.
fn read_roster(explicit: Option<&str>) -> Vec<RosterRow> {
    let path = explicit
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var("BSC_FLEET_ROSTER").ok().map(std::path::PathBuf::from))
        .unwrap_or_else(|| std::path::PathBuf::from("fleet.roster.tsv"));
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let c: Vec<&str> = l.split('\t').collect();
            RosterRow {
                pane_id: c.first().unwrap_or(&"").to_string(),
                stream: c.get(1).unwrap_or(&"").to_string(),
                role: c.get(4).unwrap_or(&"").to_string(),
            }
        })
        .filter(|r| !r.pane_id.is_empty())
        .collect()
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    match args.positional.first().map(String::as_str).unwrap_or("list") {
        "list" => cmd_list(&args),
        "wake" => cmd_wake(&args, prog),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn cmd_wake(args: &Args, prog: &str) -> Result<(), String> {
    let pane = args
        .positional
        .get(1)
        .ok_or_else(|| format!("usage: {prog} wake <pane-id> [--prompt <text>] [--force]"))?;
    let req = WakeRequest {
        pane_id: pane.clone(),
        prompt: args.prompt.clone().unwrap_or_default(),
        force: args.force,
    };
    let timeout = args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let res: WakeResult = ask(WAKE_KIND, &req, timeout)?;
    bsc_cli_util::emit(args.pretty, args.json, &res, || {
        let note = if res.was_busy { " (interrupted a BUSY pane)" } else { "" };
        format!("woke {}{note}", res.pane_id)
    });
    Ok(())
}

fn cmd_list(args: &Args) -> Result<(), String> {
    let roster = read_roster(args.roster.as_deref());
    // Ask about the roster's panes when there is one; otherwise let the app report everything it has.
    let req = FleetRequest { pane_ids: roster.iter().map(|r| r.pane_id.clone()).collect() };
    let res = send(&req, args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;

    if args.json || args.pretty {
        bsc_cli_util::emit(args.pretty, args.json, &res, String::new);
        return Ok(());
    }
    println!("{:<34} {:<22} {:<9} {:<6} {:<6} PID", "PANE", "STREAM", "ROLE", "LIVE", "BUSY");
    if roster.is_empty() {
        for p in &res.panes {
            print_row(&p.pane_id, "", "", Some(p));
        }
    } else {
        for r in &roster {
            print_row(&r.pane_id, &r.stream, &r.role, res.panes.iter().find(|p| p.pane_id == r.pane_id));
        }
    }
    Ok(())
}

/// `None` means the app is NOT tracking this pane — a manifest row with nothing behind it. Printed
/// explicitly (`gone`) rather than skipped: that gap is exactly what the original report was chasing.
fn print_row(pane: &str, stream: &str, role: &str, p: Option<&PaneLive>) {
    let (live, busy, pid) = match p {
        Some(p) => (
            if p.live { "yes" } else { "no" }.to_string(),
            if p.busy { "yes" } else { "no" }.to_string(),
            p.pid.map(|v| v.to_string()).unwrap_or_else(|| "-".into()),
        ),
        None => ("gone".to_string(), "-".to_string(), "-".to_string()),
    };
    println!("{pane:<34} {stream:<22} {role:<9} {live:<6} {busy:<6} {pid}");
}

/// Drop the request, wait for the app's answer.
fn send(req: &FleetRequest, timeout: i64) -> Result<FleetResult, String> {
    ask(KIND, req, timeout)
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
             Is the desktop app running? Liveness lives in its PTY state — `bsc` cannot see it alone. \
             (`bsc-fleet` still shows the launch manifest without the app.)",
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
        let a = parse_args(vec!["list".into(), "--json".into(), "--roster".into(), "/r.tsv".into()]).unwrap();
        assert!(a.json && a.roster.as_deref() == Some("/r.tsv"));
        assert!(parse_args(vec!["--nope".into()]).is_err());
    }

    #[test]
    fn roster_is_optional_and_tolerates_a_ragged_row() {
        // A missing roster must not fail the command — it just loses the stream/role columns.
        assert!(read_roster(Some("no/such/file.tsv")).is_empty());

        let dir = std::env::temp_dir().join(format!("bsc-fleet-cli-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("fleet.roster.tsv");
        // Row 2 is short (no role) and row 3 is blank — neither may panic or produce a junk pane.
        std::fs::write(&p, "p:a\tstream-a\trepo\tbr\tworker\np:b\tstream-b\n\n").unwrap();
        let rows = read_roster(Some(&p.to_string_lossy()));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].role, "worker");
        assert_eq!(rows[1].role, "", "a missing column reads empty, not a panic");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
