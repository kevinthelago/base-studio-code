//! The `bsc fleet` subcommand (#4098) — real per-pane liveness, joined onto the roster.

use crate::membership;
use crate::{
    DirectorNewRequest, DirectorNewResult, DirectorOutcome, FleetRequest, FleetResult, PaneLive,
    StartOutcome, StartRequest, StartResult, WakeRequest, WakeResult, DIRECTOR_KIND, KIND,
    START_KIND, WAKE_KIND,
};
use bsc_cli_util::CmdDoc;

const DEFAULT_TIMEOUT_MS: i64 = 8_000;
const POLL_INTERVAL_MS: u64 = 40;
const STALE_MS: i64 = 60_000;

const TAGLINE: &str = "which fleet panes are ACTUALLY alive — asks the running app (#4098)";

const COMMANDS: &[CmdDoc] = &[CmdDoc {
    name: "list",
    summary: "every worker this project has, running or not — plan.db's membership joined onto real liveness",
    usage: "\
USAGE:
  bsc fleet [list] [--db <plan.db>] [--roster <path>] [--json|--pretty]

One row per pane in this project's fleet — INCLUDING the ones that are not running. Each row carries
the state, and each state is one move:

  running          a session exists and its agent is working        leave it alone
  idle             the shell is up but its agent has EXITED         wake it
  stopped          it launched before; no session now               wake it
  never-launched   the plan names the stream, nothing ever ran it   start the fleet

  LIVE / BUSY / PID are the app's raw answer behind that state.

ISSUES is that stream's PROGRESS — its plan issues done/total — because liveness alone does not say
which stopped worker to wake: stopped-having-finished and stopped-at-issue-one look identical
otherwise. A stream that owns no issues shows `-`, never 0/0. Blocked and failed issues cannot show
in a ratio, so the streams holding them are NAMED under the table.

WHERE THE LIST COMES FROM, and why it matters. MEMBERSHIP is plan.db's — the fleet-session ledger
(every agent this project has launched, persisted across a clean quit) unioned with the planned
streams. LIVENESS is the app's, because the PTY sessions live in its state and no file on disk knows
whether something is running. Asking the app for both is what used to lose the stopped workers: a
pane with no session is not a key in its session map, so it produced no row at all, and a director
looking at a 38-stream fleet saw one row — itself.

The plan store is found at --db, else $BSC_PLAN_DB (set for every project session, so a director in
its hub needs neither). Without one — a plain console that is not part of a fleet — this falls back
to the hub's fleet.roster.tsv, and then to whatever the app is tracking.

--roster <path> names the set yourself and wins over the plan store. Note the hub's fleet.roster.tsv
is a LAUNCH MANIFEST rewritten by each launch, so a director-only relaunch clobbers its worker rows;
that is why it is the fallback and not the source.

There is no STREAM column: a worker's pane id IS <projectKey>:<stream>, and the pane id is what you
pass to `bsc fleet wake` / bsc-answer / bsc-assign. --json carries `stream` along with the role,
state, ledger status, launch timestamps and the full `issues` tally.

Requires the desktop app for the liveness half: it errors plainly when the app is not running rather
than reporting a live fleet as dead.",
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
    name: "start",
    summary: "launch a project's whole fleet — the director and every worker stream",
    usage: "\
USAGE:
  bsc fleet start <projectKey> [--force] [--timeout <ms>] [--json|--pretty]

Brings up the fleet a project PLANNED: its director at the hub, and one worker per stream in its own
git worktree on a stream-named branch. The whole-fleet sibling of `bsc fleet director new`, which
creates the coordinator alone.

THE FLEET COMES FROM plan.db, the sole fleet store — so this and a UI launch read the same rows and
cannot disagree about what the fleet is. `bsc plan fleet` shows what will launch.

IT FAILS CLOSED. Every worker's worktree is created BEFORE any session is placed; if one cannot be
created, NO session starts and the error names the stream. A half-launched fleet reported as success
is the failure this ordering prevents.

A STREAM THAT NAMES NO REPO is skipped and REPORTED — it cannot be given a worktree, and a stream that
silently never launches is invisible.

AN ALREADY-RUNNING FLEET IS REFUSED, naming the live panes, rather than launched a second time: two
workers on one worktree would fight over the same branch. `--force` relaunches anyway.

The pane creation happens in the app (a pane is frontend state), so the desktop app must be running —
the same requirement `bsc fleet wake` and `bsc fleet director new` have.",
}, CmdDoc {
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
    db: Option<String>,
    prompt: Option<String>,
    force: bool,
    timeout_ms: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { json: false, pretty: false, roster: None, db: None, prompt: None, force: false, timeout_ms: None, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--roster" => a.roster = Some(it.next().ok_or("--roster needs a path")?),
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
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
        "start" => cmd_start(&args, prog),
        "wake" => cmd_wake(&args, prog),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `start <projectKey>` — launch the whole fleet.
fn cmd_start(args: &Args, prog: &str) -> Result<(), String> {
    let key = args
        .positional
        .get(1)
        .cloned()
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| format!("{prog} start: needs a project key (`bsc project list` shows them)"))?;
    let req = StartRequest { project_key: key.trim().to_string(), force: args.force };
    // A fleet launch builds worktrees and places many panes, so it is given a longer default than the
    // read verbs — a timeout here would report failure for a fleet that is in fact coming up.
    let res: StartResult = ask(START_KIND, &req, args.timeout_ms.unwrap_or(45_000))?;
    bsc_cli_util::emit(args.pretty, args.json, &res, || describe_start(&res));
    Ok(())
}

fn describe_start(res: &StartResult) -> String {
    let mut out = match res.outcome {
        StartOutcome::AlreadyRunning => format!(
            "{}: already running — {} live session(s): {}. Re-run with --force to relaunch.",
            res.project_key,
            res.streams.len(),
            res.streams.join(", ")
        ),
        StartOutcome::Launched => format!(
            "{}: launched {}{} worker(s){}",
            res.project_key,
            if res.director { "a director and " } else { "" },
            res.streams.len(),
            if res.streams.is_empty() { String::new() } else { format!(": {}", res.streams.join(", ")) }
        ),
    };
    if !res.skipped_no_repo.is_empty() {
        out.push_str(&format!(
            "\n  skipped (no repo assigned): {}",
            res.skipped_no_repo.join(", ")
        ));
    }
    out
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

/// Read the project's fleet MEMBERSHIP out of plan.db — the ledger of what launched, unioned with
/// the planned streams. `None` when no plan store resolves (no `--db`, no `$BSC_PLAN_DB`, or the path
/// names nothing), which is the case for a plain console session that is not part of a project fleet.
///
/// A missing file is NOT created here. `Store::open` would happily mint an empty db at whatever
/// `$BSC_PLAN_DB` points at, and a fresh empty store answers "this fleet has no members" — the exact
/// wrong answer for a command whose job is to prove a stopped worker still exists.
fn plan_membership(db_flag: &Option<String>) -> Option<(String, Vec<membership::Member>)> {
    let path = bsc_cli_util::resolve_store_path(db_flag, "BSC_PLAN_DB", || {
        Err("no plan store".to_string())
    })
    .ok()?;
    if !path.is_file() {
        return None;
    }
    let store = plandb::Store::open(&path).ok()?;
    let ledger: Vec<membership::LedgerRow> = store
        .fleet_session_list()
        .ok()?
        .into_iter()
        .map(|s| membership::LedgerRow {
            pane_id: s.pane_id,
            stream_id: s.stream_id,
            role: s.role,
            launched_at: s.launched_at,
            last_seen: s.last_seen,
            status: s.status,
        })
        .collect();
    let fleet = store.fleet_get().ok().flatten().unwrap_or(serde_json::Value::Null);
    let streams: Vec<String> = fleet
        .get("streams")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|s| s.get("id").and_then(|v| v.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let director = fleet
        .get("director")
        .map(|d| d.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true))
        .unwrap_or(false);

    // The key names the panes the plan has no ledger row for. Prefer one OBSERVED in the ledger over
    // the db's filename: the filename is the canonical construction (`plans/<key>.db`) but an explicit
    // `--db` can name anything, and a wrong key would mint pane ids that resolve to nothing.
    let key = ledger
        .first()
        .map(|r| membership::project_key_of(&r.pane_id).to_string())
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()))?;

    let mut members = membership::build(&key, &ledger, &streams, director);
    if members.is_empty() {
        return None;
    }
    // Progress, from the same store: what each worker has ACHIEVED, not merely whether it breathes.
    // A failed read leaves every tally at zero, which renders as `-` — the same as a stream with no
    // issues. That is the right failure: a missing tally must never read as "nothing done".
    if let Ok(issues) = store.list(None, None) {
        let mut by_stream: std::collections::HashMap<String, Vec<&str>> =
            std::collections::HashMap::new();
        for i in &issues {
            if let Some(st) = i.stream.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                by_stream.entry(st.to_string()).or_default().push(&i.status);
            }
        }
        let tallies = by_stream
            .into_iter()
            .map(|(k, v)| (k, membership::Progress::tally(v)))
            .collect();
        membership::attach_progress(&mut members, &tallies);
    }
    Some((key, members))
}

/// Which source names the panes. plan.db unless the caller named a roster themselves — an explicit
/// `--roster` is the caller asserting the set, and second-guessing it would make the flag a no-op.
fn choose_membership(args: &Args) -> Option<(String, Vec<membership::Member>)> {
    if args.roster.is_some() {
        return None;
    }
    plan_membership(&args.db)
}

fn cmd_list(args: &Args) -> Result<(), String> {
    if let Some((key, members)) = choose_membership(args) {
        return list_from_plan(args, &key, members);
    }
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

/// One member joined with the app's liveness answer — the shape `--json` emits and the table prints.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    #[serde(flatten)]
    member: membership::Member,
    state: membership::State,
    live: bool,
    busy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
}

/// Join plan.db's membership onto the app's liveness.
///
/// The request asks for EVERYTHING the app tracks rather than naming the members, because naming them
/// is what makes a pane the plan store never heard of invisible — and a session running outside the
/// plan is exactly the thing a director needs told about.
fn list_from_plan(
    args: &Args,
    project_key: &str,
    mut members: Vec<membership::Member>,
) -> Result<(), String> {
    let res = send(&FleetRequest::default(), args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;
    membership::absorb_tracked(
        &mut members,
        project_key,
        &res.panes.iter().map(|p| p.pane_id.clone()).collect::<Vec<_>>(),
    );

    let rows: Vec<Row> = members
        .into_iter()
        .map(|m| {
            let p = res.panes.iter().find(|p| p.pane_id == m.pane_id);
            let state = membership::State::classify(&m, p.map(|p| (p.live, p.busy)));
            Row {
                state,
                live: p.map(|p| p.live).unwrap_or(false),
                busy: p.map(|p| p.busy).unwrap_or(false),
                pid: p.and_then(|p| p.pid),
                member: m,
            }
        })
        .collect();

    if args.json || args.pretty {
        bsc_cli_util::emit(args.pretty, args.json, &rows, String::new);
        return Ok(());
    }
    print!("{}", render_plan_table(&rows));
    Ok(())
}

/// The STREAM column is deliberately absent: a worker's pane id IS `<key>:<stream>`, and the pane id is
/// the argument to wake / bsc-answer / bsc-assign, so printing both doubles a 50-column table's width
/// to repeat itself. `--json` carries `stream` for anything that wants the field.
fn render_plan_table(rows: &[Row]) -> String {
    // Width from the data: pane ids run from `k:api` to `network-monitor:safety-test-suite-and-adapter-fixtures`,
    // and a fixed column either truncates the id — which is the argument a director has to TYPE — or
    // pads every short fleet to the width of the longest one that ever existed.
    let w = rows.iter().map(|r| r.member.pane_id.len()).max().unwrap_or(4).max(4);
    let mut out = format!(
        "{:<w$}  {:<9} {:<14} {:<8} {:<5} {:<5} PID\n",
        "PANE", "ROLE", "STATE", "ISSUES", "LIVE", "BUSY",
        w = w
    );
    for r in rows {
        out.push_str(&format!(
            "{:<w$}  {:<9} {:<14} {:<8} {:<5} {:<5} {}\n",
            r.member.pane_id,
            if r.member.role.is_empty() { "-" } else { &r.member.role },
            r.state.as_str(),
            r.member.progress.cell(),
            if r.live { "yes" } else { "no" },
            if r.busy { "yes" } else { "no" },
            r.pid.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
            w = w,
        ));
    }
    out.push('\n');
    out.push_str(&summarize(rows));
    out.push('\n');
    out
}

/// The tally, plus the ONE next move it implies. A 39-row table whose 38 stopped rows scroll past is
/// how the gap stayed invisible even once the rows existed, so the count is stated rather than left
/// to be counted.
fn summarize(rows: &[Row]) -> String {
    let count = |s: membership::State| rows.iter().filter(|r| r.state == s).count();
    let (running, idle, stopped, never) = (
        count(membership::State::Running),
        count(membership::State::Idle),
        count(membership::State::Stopped),
        count(membership::State::NeverLaunched),
    );
    let mut out = format!(
        "{} pane(s) — {running} running · {idle} idle · {stopped} stopped · {never} never launched",
        rows.len()
    );
    if idle + stopped > 0 {
        out.push_str(
            "\n  idle/stopped workers do not come back on their own: `bsc fleet wake <pane-id> --prompt \"<what to do>\"`",
        );
    }
    if never > 0 {
        out.push_str(
            "\n  a never-launched stream has no session to wake — `bsc fleet start <projectKey>` brings the fleet up",
        );
    }
    // ISSUES is done/total, so a stuck issue is invisible in it — a stream sitting at 2/7 reads the
    // same whether the other five are untouched or blocked. Name the streams instead of leaving the
    // difference to be counted out of the table.
    let stuck: Vec<String> = rows
        .iter()
        .filter(|r| r.member.progress.stuck() > 0)
        .map(|r| {
            format!(
                "{} ({})",
                r.member.pane_id,
                [
                    (r.member.progress.blocked, "blocked"),
                    (r.member.progress.failed, "failed"),
                ]
                .iter()
                .filter(|(n, _)| *n > 0)
                .map(|(n, label)| format!("{n} {label}"))
                .collect::<Vec<_>>()
                .join(", ")
            )
        })
        .collect();
    if !stuck.is_empty() {
        out.push_str(&format!("\n  stuck issues — {}", stuck.join("; ")));
    }
    out
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

        // --db is the plan store this fleet's MEMBERSHIP comes from; without a value it must fail
        // rather than silently swallow the next positional as a path.
        let a = parse_args(vec!["list".into(), "--db".into(), "/p.db".into()]).unwrap();
        assert_eq!(a.db.as_deref(), Some("/p.db"));
        assert!(parse_args(vec!["--db".into()]).is_err());
    }

    fn args_with(db: Option<&str>, roster: Option<&str>) -> Args {
        let mut raw = vec!["list".to_string()];
        if let Some(d) = db {
            raw.extend(["--db".to_string(), d.to_string()]);
        }
        if let Some(r) = roster {
            raw.extend(["--roster".to_string(), r.to_string()]);
        }
        parse_args(raw).unwrap()
    }

    /// Seed a real plan.db: a launched ledger and a plan whose streams outnumber it — the two records
    /// membership is built from. Returns its path.
    fn seed_plan_db(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bsc-fleet-plan-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nm.db");
        let _ = std::fs::remove_file(&path);
        let store = plandb::Store::open(&path).unwrap();
        store
            .fleet_set(&serde_json::json!({
                "director": { "enabled": true },
                "streams": [
                    { "id": "api", "repo": "o/r" },
                    { "id": "ui", "repo": "o/r" },
                    { "id": "docs", "repo": "o/r" },
                ],
            }))
            .unwrap();
        for (pane, stream, role) in [
            ("network-monitor:director", "", "director"),
            ("network-monitor:api", "api", "worker"),
            ("network-monitor:ui", "ui", "worker"),
        ] {
            store
                .fleet_session_upsert(&plandb::FleetSession {
                    pane_id: pane.into(),
                    stream_id: stream.into(),
                    role: role.into(),
                    status: "running".into(),
                    launched_at: 1000,
                    last_seen: 2000,
                    ..Default::default()
                })
                .unwrap();
        }
        path
    }

    /// THE FIX, at the CLI seam. Membership comes out of plan.db — every planned stream and every
    /// launched agent — with no roster file anywhere and nothing running. The old path produced at
    /// most the panes the app was tracking, which is why a stopped worker had no row.
    #[test]
    fn membership_comes_from_the_plan_store_with_no_roster_and_nothing_running() {
        let db = seed_plan_db("members");
        let (key, members) = choose_membership(&args_with(Some(&db.to_string_lossy()), None))
            .expect("a plan store with a fleet yields membership");
        assert_eq!(key, "network-monitor", "the key is read off the ledger's own pane ids");
        let ids: Vec<&str> = members.iter().map(|m| m.pane_id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "network-monitor:director",
                "network-monitor:api",
                "network-monitor:ui",
                "network-monitor:docs",
            ],
            "director, then the plan's streams in plan order"
        );
        // `docs` is planned and never launched; the other two launched. That difference is the whole
        // reason both records are read instead of just one.
        let docs = members.iter().find(|m| m.pane_id.ends_with(":docs")).unwrap();
        assert!(docs.planned && !docs.launched);
        assert!(members.iter().find(|m| m.pane_id.ends_with(":api")).unwrap().launched);
    }

    /// An explicit --roster is the caller naming the set. If the plan store won anyway the flag would
    /// be a no-op, and `bsc fleet list --roster <a-manifest-you-are-debugging>` could not be used to
    /// debug that manifest.
    #[test]
    fn an_explicit_roster_wins_over_the_plan_store() {
        let db = seed_plan_db("precedence");
        let db = db.to_string_lossy().to_string();
        assert!(choose_membership(&args_with(Some(&db), None)).is_some());
        assert!(
            choose_membership(&args_with(Some(&db), Some("/some/roster.tsv"))).is_none(),
            "--roster must send the command down the roster path"
        );
    }

    /// A `$BSC_PLAN_DB` (or --db) naming a file that does not exist must fall back, NOT mint an empty
    /// store: `Store::open` creates one, and a fresh empty store answers "this fleet has no members" —
    /// the precise wrong answer for a command whose job is proving a stopped worker still exists.
    #[test]
    fn a_missing_plan_store_falls_back_and_is_never_created() {
        let missing = std::env::temp_dir()
            .join(format!("bsc-fleet-absent-{}", std::process::id()))
            .join("nope.db");
        let _ = std::fs::remove_file(&missing);
        assert!(choose_membership(&args_with(Some(&missing.to_string_lossy()), None)).is_none());
        assert!(!missing.exists(), "the fallback must not leave a db behind");
    }

    /// A plan store that exists but holds no fleet and no ledger is not a fleet report — fall back
    /// rather than printing an empty table that reads as "you have no workers".
    #[test]
    fn an_empty_plan_store_falls_back_rather_than_reporting_an_empty_fleet() {
        let dir = std::env::temp_dir().join(format!("bsc-fleet-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blank.db");
        let _ = std::fs::remove_file(&path);
        plandb::Store::open(&path).unwrap();
        assert!(choose_membership(&args_with(Some(&path.to_string_lossy()), None)).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn row(pane: &str, role: &str, state: membership::State, live: bool, busy: bool) -> Row {
        Row {
            member: membership::Member {
                pane_id: pane.into(),
                role: role.into(),
                ..Default::default()
            },
            state,
            live,
            busy,
            pid: if live { Some(42) } else { None },
        }
    }

    /// The table must print a row for a pane with NO session — that row is the entire point. The old
    /// renderer never received one, because the pane set came from the app's session map.
    #[test]
    fn the_table_prints_a_row_for_a_pane_with_no_session() {
        let rows = vec![
            row("nm:director", "director", membership::State::Running, true, true),
            row("nm:api", "worker", membership::State::Stopped, false, false),
            row("nm:ui", "worker", membership::State::Idle, true, false),
            row("nm:docs", "worker", membership::State::NeverLaunched, false, false),
        ];
        let out = render_plan_table(&rows);
        for pane in ["nm:director", "nm:api", "nm:ui", "nm:docs"] {
            assert!(out.contains(pane), "{pane} is missing from:\n{out}");
        }
        assert!(out.contains("stopped") && out.contains("idle") && out.contains("never-launched"));
        // The pane id is what a director types, so it is never truncated — the column grows to fit.
        let header = out.lines().next().unwrap();
        assert!(header.starts_with("PANE       "), "column widens to the longest id: {header:?}");
    }

    /// The tally states the thing that scrolls off: 38 stopped rows above the fold read as a healthy
    /// fleet. Each non-running state names the move that clears it — and the two moves differ, so a
    /// never-launched stream must not be pointed at `wake`.
    #[test]
    fn the_summary_counts_the_states_and_names_the_move_for_each() {
        let rows = vec![
            row("nm:director", "director", membership::State::Running, true, true),
            row("nm:api", "worker", membership::State::Stopped, false, false),
            row("nm:ui", "worker", membership::State::Stopped, false, false),
        ];
        let s = summarize(&rows);
        assert!(s.contains("3 pane(s)"), "{s}");
        assert!(s.contains("1 running") && s.contains("2 stopped"), "{s}");
        assert!(s.contains("bsc fleet wake"), "a stopped worker's move is named: {s}");
        assert!(!s.contains("bsc fleet start"), "nothing is unlaunched here: {s}");

        // An all-running fleet is told to do nothing — the hints are for the states that need one.
        let quiet = summarize(&[row("nm:director", "director", membership::State::Running, true, true)]);
        assert!(!quiet.contains("bsc fleet wake") && !quiet.contains("bsc fleet start"), "{quiet}");

        // A planned stream that never ran has no session to wake; it needs a launch.
        let unlaunched = summarize(&[row("nm:docs", "worker", membership::State::NeverLaunched, false, false)]);
        assert!(unlaunched.contains("bsc fleet start"), "{unlaunched}");
        assert!(!unlaunched.contains("bsc fleet wake"), "{unlaunched}");
    }

    /// The tally is only useful if it reaches the table. `done/total` beside each row is what turns
    /// "38 stopped" into "34 finished, 4 stalled at the start".
    #[test]
    fn the_table_carries_each_streams_progress() {
        let mut finished = row("nm:api", "worker", membership::State::Stopped, false, false);
        finished.member.progress = membership::Progress::tally(vec!["verified", "complete"]);
        let mut barely = row("nm:ui", "worker", membership::State::Stopped, false, false);
        barely.member.progress = membership::Progress::tally(vec!["open", "open", "complete"]);
        let director = row("nm:director", "director", membership::State::Running, true, true);

        let out = render_plan_table(&[director, finished, barely]);
        assert!(out.contains("ISSUES"), "the column is labelled: {out}");
        assert!(out.contains("2/2") && out.contains("1/3"), "{out}");
        // The director owns no stream, so it gets no ratio — a `0/0` there would read as no progress.
        let dir_line = out.lines().find(|l| l.starts_with("nm:director")).unwrap();
        assert!(dir_line.contains(" - "), "a streamless row shows `-`: {dir_line:?}");
    }

    /// `done/total` cannot show a stuck issue: 2/7 reads the same whether the other five are
    /// untouched or blocked. The streams are NAMED under the table rather than left to be counted.
    #[test]
    fn stuck_issues_are_named_by_stream_under_the_table() {
        let mut stuck = row("nm:api", "worker", membership::State::Stopped, false, false);
        stuck.member.progress =
            membership::Progress::tally(vec!["complete", "blocked", "blocked", "failed"]);
        let clean = row("nm:ui", "worker", membership::State::Running, true, true);

        let s = summarize(&[stuck, clean]);
        assert!(s.contains("stuck issues"), "{s}");
        assert!(s.contains("nm:api"), "the stuck stream is named: {s}");
        assert!(s.contains("2 blocked") && s.contains("1 failed"), "{s}");
        assert!(!s.contains("nm:ui"), "a stream with nothing stuck is not listed: {s}");

        // No stuck work anywhere ⇒ no line. The exception report must stay an exception.
        let quiet = summarize(&[row("nm:ui", "worker", membership::State::Running, true, true)]);
        assert!(!quiet.contains("stuck issues"), "{quiet}");
    }

    /// `--json` is what a director reads programmatically, so the joined fields must be on the wire
    /// under stable camelCase names — and `stream` in particular, since the table drops that column.
    #[test]
    fn the_json_row_carries_the_joined_shape() {
        let mut r = row("nm:api", "worker", membership::State::Stopped, false, false);
        r.member.stream = "api".into();
        r.member.launched = true;
        r.member.ledger_status = "running".into();
        r.member.launched_at = 1000;
        r.member.last_seen = 2000;
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["paneId"], "nm:api");
        assert_eq!(v["stream"], "api");
        assert_eq!(v["role"], "worker");
        assert_eq!(v["state"], "stopped");
        assert_eq!(v["live"], false);
        assert_eq!(v["launched"], true);
        assert_eq!(v["ledgerStatus"], "running");
        assert_eq!(v["launchedAt"], 1000);
        assert_eq!(v["lastSeen"], 2000);
        assert_eq!(v["issues"]["total"], 0);
        // A pane with no session has no pid; the key is absent rather than a misleading 0.
        assert!(v.get("pid").is_none(), "{v}");
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
