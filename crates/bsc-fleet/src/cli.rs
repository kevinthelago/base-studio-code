//! The `bsc fleet` subcommand (#4098) — real per-pane liveness, joined onto the roster.

use crate::{
    DirectorNewRequest, DirectorNewResult, DirectorOutcome, FleetRequest, FleetResult, PaneLive,
    WakeRequest, WakeResult, DIRECTOR_KIND, KIND, WAKE_KIND,
};
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
    name: "directors",
    summary: "every project's DIRECTOR and whether it is running — the architect's view of its tier",
    usage: "USAGE:
  bsc fleet directors [--json|--pretty]

One row per project that has a director pane, with the same real liveness `list` reports:

  LIVE   a PTY session exists for that director
  BUSY   it has a live descendant — it is working, not merely open

WHY IT IS SEPARATE FROM `list`. This is the ARCHITECT's read, and the architect must not see
individual workers: that is the director's view, and an architect that reaches past its director is
back in the middle of a fleet it does not run. So the scoping is the command, not a flag a caller
could omit.

READ-ONLY, and deliberately so. Seeing a stopped director does not let you start one — the architect's
only outbound channel is `bsc plan brief <projectKey>:director`. What this answers is whether that
brief will reach anything: briefing a director that is not running is how work goes quietly missing,
which is the same failure the director protocol already warns about for assigns to stopped workers.

Requires the desktop app, like `list` — liveness is the app's fact, not the filesystem's.",
},
CmdDoc {
    name: "director",
    summary: "create a project's DIRECTOR, seeded with what the architect settled",
    usage: "USAGE:
  bsc fleet director new <projectKey> [--json|--pretty]

Creates the director session for an EXISTING project. This is the architect's one create into the
project tier (#architect-creates-a-director-with-discovery).

CREATION CARRIES CONTEXT. The director is BORN knowing what the architect settled: it comes up with a
kickoff naming the requirement, the authority clauses, the discovery prose, the features and the
streams — and the commands to read each of them. That is deliberately different from
`bsc plan brief <key>:director`, which is the RUNTIME voice for a mid-build correction. Creation
seeds; briefing corrects. A director started empty and briefed a moment later is what this verb
exists to prevent.

The context is carried as SOURCES, never as inlined text: the store stays live while a prompt is
written once, so a quoted body would be a second copy that goes stale the moment the architect writes
another discovery file.

THE PROJECT MUST ALREADY EXIST. The key is resolved against the project set and refused when it names
nothing — this creates a DIRECTOR, not a project (`bsc project new` does that).

A PROJECT THAT ALREADY HAS A RUNNING DIRECTOR IS REFUSED, reporting the one that is there. Two
coordinators for one fleet is worse than none: both would merge, both would answer, and each would be
working from a different picture.

An existing `prompts/director-kickoff.md` is LEFT ALONE — a planner-authored kickoff is not
overwritten, and the reply says which director you got.

THERE IS NO STOP HERE, deliberately. A director coordinates a running fleet whose workers, under the
no-app-injection model, have no route back except the user's click. Ending one is the user's act.",
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
        "directors" => cmd_directors(&args),
        // Singular vs plural is a real distinction, not a typo tolerance: `directors` READS the tier,
        // `director` acts on one. Both live under the `bsc fleet director` grant prefix (which still
        // does not reach `bsc fleet wake`).
        "director" => cmd_director(&args, prog),
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

/// `bsc fleet director new <projectKey>` — the architect's create into the project tier.
///
/// Only `new` exists, and that is the design rather than an unfinished switch: there is no `stop`
/// here because a director coordinates a running fleet, and the epic settles that ending one is the
/// user's act. An unknown subcommand says so instead of falling through to a generic error.
fn cmd_director(args: &Args, prog: &str) -> Result<(), String> {
    match args.positional.get(1).map(String::as_str).unwrap_or("") {
        "new" => {
            let key = args.positional.get(2).ok_or_else(|| {
                format!("usage: {prog} director new <projectKey>\n\n`bsc project list` shows the keys.")
            })?;
            if key.trim().is_empty() {
                return Err(format!("usage: {prog} director new <projectKey>"));
            }
            let req = DirectorNewRequest { project_key: key.trim().to_string() };
            let res: DirectorNewResult =
                ask(DIRECTOR_KIND, &req, args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;
            bsc_cli_util::emit(args.pretty, args.json, &res, || describe_director(&res));
            Ok(())
        }
        "stop" | "kill" | "end" => Err(format!(
            "there is no `{prog} director stop`. A director coordinates a RUNNING fleet, and under \
             the no-app-injection model its workers have no route back except the user's click — so \
             ending one is the user's act, not a caller's. `bsc fleet directors` shows what is running."
        )),
        other => Err(format!(
            "unknown director command '{other}'\n\nusage: {prog} director new <projectKey>"
        )),
    }
}

fn describe_director(res: &DirectorNewResult) -> String {
    match res.outcome {
        DirectorOutcome::Created => format!(
            "created the director for {} ({}){}",
            res.project_key,
            res.pane_id,
            if res.kickoff_written {
                " — seeded with the discovery sources"
            } else {
                " — kept the existing prompts/director-kickoff.md"
            }
        ),
        DirectorOutcome::AlreadyRunning => format!(
            "{} already has a running director ({}) — nothing created.\n\
             Brief it with `bsc plan brief {}:director` rather than creating a second one.",
            res.project_key, res.pane_id, res.project_key
        ),
    }
}

/// The DIRECTOR pane-id suffix. Pane identity is `<projectKey>:director` (paneIdentity.ts), so the
/// project key is everything before it — which is also why this needs no roster: the id carries the
/// project.
const DIRECTOR_SUFFIX: &str = ":director";

/// `bsc fleet directors` — one row per project director, with real liveness.
///
/// Scoped by CONSTRUCTION rather than by a flag: it asks the app for every tracked pane and keeps only
/// the director ones. An architect running this cannot widen it to workers, which is the tier boundary
/// this verb exists to hold.
fn cmd_directors(args: &Args) -> Result<(), String> {
    // No roster: the architect does not sit in a project hub, and a director's pane id already names
    // its project. An empty `pane_ids` means "everything the app tracks".
    let res = send(&FleetRequest::default(), args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;
    let mut directors: Vec<&PaneLive> =
        res.panes.iter().filter(|p| p.pane_id.ends_with(DIRECTOR_SUFFIX)).collect();
    directors.sort_by(|a, b| a.pane_id.cmp(&b.pane_id));

    if args.json || args.pretty {
        let rows: Vec<_> = directors
            .iter()
            .map(|p| {
                serde_json::json!({
                    "projectKey": director_project_key(&p.pane_id),
                    "paneId": p.pane_id,
                    "live": p.live,
                    "busy": p.busy,
                    "pid": p.pid,
                })
            })
            .collect();
        bsc_cli_util::emit(args.pretty, args.json, &rows, String::new);
        return Ok(());
    }
    println!("{:<28} {:<34} {:<6} {:<6} PID", "PROJECT", "PANE", "LIVE", "BUSY");
    for p in &directors {
        println!(
            "{:<28} {:<34} {:<6} {:<6} {}",
            director_project_key(&p.pane_id),
            p.pane_id,
            if p.live { "yes" } else { "no" },
            if p.busy { "yes" } else { "no" },
            p.pid.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
        );
    }
    if directors.is_empty() {
        println!("(no director panes — no project fleet is running)");
    }
    Ok(())
}

/// The project key in front of a `<key>:director` pane id.
pub fn director_project_key(pane_id: &str) -> &str {
    pane_id.strip_suffix(DIRECTOR_SUFFIX).unwrap_or(pane_id)
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

#[cfg(test)]
mod director_tests {
    use super::*;

    /// The pane id one spelling, used by create / list / brief alike — a second spelling would create
    /// a director the `directors` read could not see.
    #[test]
    fn the_created_pane_id_is_the_one_the_read_looks_for() {
        let id = crate::director_pane_id("studio-code");
        assert_eq!(id, "studio-code:director");
        assert!(id.ends_with(DIRECTOR_SUFFIX), "the `directors` filter must match what `new` creates");
        assert_eq!(director_project_key(&id), "studio-code");
    }

    /// `stop` is refused with the REASON, not with a generic unknown-command error. An architect that
    /// tries it should learn the asymmetry is deliberate rather than assume a typo.
    #[test]
    fn there_is_no_director_stop_and_the_refusal_says_why() {
        for verb in ["stop", "kill", "end"] {
            let args = parse_args(vec!["director".into(), verb.into(), "studio-code".into()]).unwrap();
            let err = cmd_director(&args, "bsc fleet").unwrap_err();
            assert!(err.contains("no `bsc fleet director stop`"), "{verb}: {err}");
            assert!(err.contains("user's act"), "{verb}: the refusal explains the asymmetry");
        }
    }

    /// A missing key fails BEFORE any request is written, and points at where the keys come from.
    #[test]
    fn a_missing_project_key_is_a_usage_error_naming_where_keys_come_from() {
        for a in [vec!["director".into(), "new".into()], vec!["director".into(), "new".into(), "  ".into()]] {
            let args = parse_args(a).unwrap();
            let err = cmd_director(&args, "bsc fleet").unwrap_err();
            assert!(err.contains("usage:"), "{err}");
        }
        let args = parse_args(vec!["director".into(), "new".into()]).unwrap();
        assert!(cmd_director(&args, "bsc fleet").unwrap_err().contains("bsc project list"));
    }

    #[test]
    fn an_unknown_director_subcommand_points_at_new() {
        let args = parse_args(vec!["director".into(), "restart".into()]).unwrap();
        let err = cmd_director(&args, "bsc fleet").unwrap_err();
        assert!(err.contains("unknown director command 'restart'"));
        assert!(err.contains("director new"));
    }

    /// The two outcomes must read differently in PROSE too, not only in the JSON — and the
    /// already-running line has to point at BRIEFING rather than leaving the caller to retry, because
    /// retrying is how a project ends up with two coordinators.
    #[test]
    fn the_outcomes_read_differently_and_already_running_points_at_the_brief() {
        let mk = |o, w| DirectorNewResult {
            project_key: "studio-code".into(),
            pane_id: "studio-code:director".into(),
            outcome: o,
            kickoff_written: w,
        };
        let created = describe_director(&mk(DirectorOutcome::Created, true));
        let kept = describe_director(&mk(DirectorOutcome::Created, false));
        let running = describe_director(&mk(DirectorOutcome::AlreadyRunning, false));

        assert!(created.contains("seeded with the discovery"));
        assert!(kept.contains("kept the existing"), "a planner kickoff is not silently overwritten");
        assert_ne!(created, kept, "which director you got is visible");
        assert!(running.contains("already has a running director"));
        assert!(running.contains("bsc plan brief"), "the alternative to a second director is a brief");
    }

    /// The kickoff is what makes creation carry context. It must name the requirement FIRST (the thing
    /// the director is accountable to), cite sources as COMMANDS, and never inline a body.
    #[test]
    fn the_kickoff_names_the_discovery_sources_as_commands() {
        let k = crate::discovery_kickoff("studio-code");
        for needle in [
            "bsc plan requirement get",
            "bsc plan stage list",
            "bsc plan feature list",
            "bsc plan fleet get",
            "studio-code",
        ] {
            assert!(k.contains(needle), "the kickoff must cite `{needle}`");
        }
        // The director's lane, stated — it coordinates and never writes feature code.
        assert!(k.contains("do not write feature code"));
        // The empty-requirement case is called out: an architect may still be sealing it, and a
        // director that invents scope to fill the gap is worse than one that waits.
        assert!(k.contains("do not invent scope"));
    }

    /// The wire shapes round-trip verbatim — a rename on either side would surface as "the app did
    /// nothing" rather than as a parse error.
    #[test]
    fn the_director_wire_contract_round_trips() {
        let req = DirectorNewRequest { project_key: "studio-code".into() };
        let back: DirectorNewRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back, req);

        let res = DirectorNewResult {
            project_key: "studio-code".into(),
            pane_id: "studio-code:director".into(),
            outcome: DirectorOutcome::AlreadyRunning,
            kickoff_written: false,
        };
        let json = serde_json::to_string(&res).unwrap();
        assert!(json.contains("\"projectKey\""), "camelCase on the wire");
        assert!(json.contains("\"already-running\""), "kebab-case outcome");
        assert_eq!(serde_json::from_str::<DirectorNewResult>(&json).unwrap(), res);
    }

    /// One channel, routed by kind — the third fleet key must not collide with its siblings.
    #[test]
    fn the_director_routing_key_is_distinct() {
        assert_eq!(DIRECTOR_KIND, "fleet-director");
        for other in [KIND, WAKE_KIND] {
            assert_ne!(DIRECTOR_KIND, other);
        }
    }

    #[test]
    fn reads_the_project_key_out_of_a_director_pane_id() {
        // The pane id carries its project, which is why `directors` needs no roster — the architect
        // does not sit in a project hub and has no fleet.roster.tsv to read.
        assert_eq!(director_project_key("studio-code:director"), "studio-code");
        assert_eq!(director_project_key("a-b-c:director"), "a-b-c");
    }

    #[test]
    fn leaves_a_non_director_id_alone_rather_than_mangling_it() {
        // Defensive: the filter should never hand this a worker id, but silently returning a truncated
        // key would be worse than returning the id — a wrong project name reads as real.
        assert_eq!(director_project_key("studio-code:api"), "studio-code:api");
    }

    #[test]
    fn the_suffix_match_does_not_catch_a_worker_stream_named_director() {
        // `<key>:director` is the director. A worker stream could legitimately be called something
        // ending in "director" (e.g. `art-director`), and `ends_with(":director")` is what keeps that
        // out — the colon is load-bearing, so this pins it.
        assert!("studio-code:director".ends_with(DIRECTOR_SUFFIX));
        assert!(!"studio-code:art-director".ends_with(DIRECTOR_SUFFIX));
    }
}
