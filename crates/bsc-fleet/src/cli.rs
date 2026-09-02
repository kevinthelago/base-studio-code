//! The `bsc fleet` subcommand (#4098) — real per-pane liveness, joined onto the roster.

use crate::gate;
use crate::membership;
use crate::doctor;
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

  running          a session exists and its AGENT is working        leave it alone
  idle             the shell is up but its agent is NOT running     wake it
  stopped          it launched before; no session now               wake it
  never-launched   the plan names the stream, nothing ever ran it   start the fleet

  LIVE / AGENT / PID are the app's raw answer behind that state.

AGENT is a real probe for `claude` / `bsc-agent` (or a wrapper hosting one) among the pane's processes
— NOT `the shell has a child`. Those differ exactly where it matters: a SANDBOXED pane's own `bwrap`
plumbing and the shell inside it are its descendants, so a bare prompt in a cage looked like work and
could never report `idle`. A shell mid-build is the same mistake the other way round. `--json` still
carries `busy` (is anything in flight) for a caller that wants that separate question.

ISSUES is that stream's PROGRESS — its plan issues done/total — because liveness alone does not say
which stopped worker to wake: stopped-having-finished and stopped-at-issue-one look identical
otherwise. A stream that owns no issues shows `-`, never 0/0. Blocked and failed issues cannot show
in a ratio, so the streams holding them are NAMED under the table.

WAITING ON is the DEPENDENCY GATE, and it appears only when something is actually held. `dependsOn`
is planning-time sequencing, so a worker never parks on an upstream at run time — but a stream whose
upstream has not LANDED has nothing to build on, and waking it gets you a worker with no ground under
it. Without this column `stopped 0/7` read the same for a stream ready to go and one that is not.

  waits:a,b   the unlanded upstreams. Wake it once they land.
  cycle:a     it sits in (or downstream of) a `dependsOn` CYCLE and can NEVER become ready. That is a
              PLAN fix — `bsc plan fleet` — not a wake, and the two look identical without this.

LANDED is three signals OR'd, because each is empty on some real fleet: every owned issue done, its
branch merged into its clone's HEAD, or its session reported `maintain`. The rules are shared with the
app's launcher through one contract fixture, so this table and Glance cannot disagree.

This half needs no app: plan.db, the clones' git history and the coord log are all on disk.

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
    summary: "every project's DIRECTOR, running or not — the architect's view of its tier",
    usage: "USAGE:
  bsc fleet directors [--json|--pretty]

One row per project that HAS a director — including the ones whose session is not running. Same four
states `list` reports, because it is the same question one tier up:

  running          it is up and working                          a brief reaches it
  idle             the shell is up but its agent has EXITED       a brief does NOT reach it
  stopped          it launched before; no session now             a brief does NOT reach it
  never-launched   the plan enables one and it never ran          there is nothing to brief

  ISSUES is that PROJECT's plan progress (done/total) — every issue, not one stream's.

WHAT IT IS FOR. The architect's only outbound channel is `bsc plan brief <projectKey>:director`, and
briefing a director that is not running is how work goes quietly missing. So the question this
answers is whether that brief will reach anything — which is why a stopped director must appear as a
ROW rather than be absent. The footer counts the reachable ones, and unreachable rows sort FIRST.

MEMBERSHIP comes from the plan stores (~/.base-studio-code/plans/*.db), read WITHOUT migrating them —
an architect's listing must not write to stores it does not own. LIVENESS comes from the app. A
project with no director in either place is not listed at all, which is how the scratch stores that
accumulate in plans/ stay out of the way.

WHY IT IS SEPARATE FROM `list`. This is the ARCHITECT's read, and the architect must not see
individual workers: that is the director's view, and an architect that reaches past its director is
back in the middle of a fleet it does not run. The scoping is the command, not a flag a caller could
omit — neither source it reads can name a worker.

READ-ONLY, and deliberately so. Seeing a stopped director does not let you start one; that is the
user's click. Requires the desktop app for the liveness half.",
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
    name: "warden-decide",
    summary: "who the warden should hard-pause, from a fleet report on stdin — no app running",
    usage: "\
USAGE:
  bsc fleet warden-decide [--quarantined <paneId>[,<paneId>...]] [--json|--pretty]  < report.json

Reads a FLEET REPORT as JSON on stdin and prints the panes that should be quarantined. The report is
`{panes,tabs,ended,disabled,completed}`; each pane carries `{paneId,streamId,verdict}` where the
verdict is `checkConformance`'s `{onTask,trips}`.

`--quarantined` names panes already hard-paused, so a trip is a ONE-SHOT pause rather than an alert
that repeats on every sweep.

THE VERDICT IS OBEYED, NOT RE-DERIVED. `checkConformance`'s file-lane arm compiles a stream's `owns`
globs with the TypeScript matcher, and `the-two-write-scope-glob-engines-disagree` is an OPEN
maintainer decision about which engine is right. Recomputing it here would silently move a security
boundary onto the other engine while that decision is pending -- so the verdict arrives as a value and
this command decides only WHO to pause, never WHETHER a pane drifted.

THE SWEEP IS BOUNDED to panes with a RUNNING session (in a tab, not ended, not disabled) and never
includes a completed worker. Losing that bound is measured: the planned roster reached 47 panes
against 3 live terminals, ~94 serial git spawns in one synchronous command, `pty_write` at 3280ms.

WHY THIS IS A SUBCOMMAND. The warden is what stops a hijacked worker, so its rules are exactly what a
maintainer wants to tune WHILE a fleet is running. In the app that means rebuilding the binary and
restarting the window -- restarting the process that owns the fleet in order to change the thing
protecting it. Here a rule change goes live by staging a binary. The app keeps the loop, the report
registry and the enforcement; only the decision is here.

An EMPTY reply means nobody should be paused, and that is also what every failure degrades to on the
app side: for this verb the safe direction is DO NOT QUARANTINE, because a false positive hard-pauses
a working agent.",
}, CmdDoc {
    name: "launch-config",
    summary: "everything a pane's launch needs from the sidecar, in ONE call",
    usage: "\
USAGE:
  bsc fleet launch-config --provider <name> [--file <payload>] [--json|--pretty]

Reads a ProviderLaunchConfig as JSON on stdin (or from --file) and returns the whole launch
configuration for that provider. Today that is the provider's shell command; skills and MCP fold onto
the SAME reply next, which is why it is an object and not a bare string.

ONE CALL, NOT FOUR. A launch has four derivations to make. Behind four calls that is ~39ms of spawn
each; behind one it is ~39ms for all of them. This is the lesson #3908 and then #3954 were filed to
teach -- at ~39 panes a per-item command saturated the command pool and `pty_write` measured 3280ms.

WHY IT IS OUT HERE AT ALL. The app's Rust half is a live process behind a webview, so a derivation
living inside it can only change by producing a new binary -- and a new binary restarts the window with
a fleet running in it. `bsc` is a fresh process per call, so the same change goes live by staging a
binary, with no app downtime.

A HARNESS THAT BAKES ITS OWN PROMPT (Claude, bsc-agent) gets NO providerCommand at all -- absence,
never an empty string, because an empty command is something a caller might execute.

THE QUOTING IS THE POINT. The kickoff is interpolated as `--message <quoted>` and is PLAN-AUTHORED
text; it is POSIX single-quoted so a prompt containing an apostrophe cannot terminate the argument and
what follows cannot become shell.",
}, CmdDoc {
    name: "worker-end",
    summary: "the resting-state verdict for a finished worker — from plan.db, with no app running",
    usage: "\
USAGE:
  bsc fleet worker-end <projectKey> --stream <id>[,<id>...] [--json|--pretty]

The verdict for each stream, index-aligned with the ids given. Decided from plan.db OWNED-ISSUE STATUS
-- the structured, recovery-durable source of truth -- not from a worker's free-text \"I'm done\". The
`landed` count folds `coord.log` and is REPORTED in the summary, never decisive: a worker's card closes
on worker-finished, while merged is the director's separate confirmation, and conflating them is how
\"marked complete but the PR never merged\" stops being visible.

THREE ANSWERS, AND TWO OF THEM LOOK ALIKE IF YOU ARE CARELESS. `null` means the project has NO PLAN
STORE and the caller must BAIL rather than end the pane. A stream that owns nothing yields
`needs-attention`, because completion cannot be confirmed from an empty set. Collapsing those would
either end a pane on the strength of a missing file, or leave an evidence-less worker looking finished.

WHY THIS IS A SUBCOMMAND AND NOT ONLY A TAURI COMMAND. The app's Rust half is a live process behind a
webview, so changing a decision that lives inside it means a new binary and a restarted window -- with
a fleet running in it. `bsc` is a fresh process per call, so the same decision here goes live by
staging a binary, with no app downtime. The app keeps a dispatcher that gathers nothing and decides
nothing.

ONE READ PER BATCH: pass every stream in one call. A per-stream invocation is the shape #3908 and
#3954 were filed to undo -- at ~39 panes it saturated the command pool and `pty_write` hit 3280ms.",
}, CmdDoc {
    name: "doctor",
    summary: "the claims this fleet makes about itself that do not hold",
    usage: "\
USAGE:
  bsc fleet doctor [--db <plan.db>] [--fix] [--strict] [--json|--pretty]

One finding per claim that does not hold, each naming the pane, what is wrong, WHAT IT COSTS, and the
fix. Prints nothing when the fleet is clean — a doctor whose normal output is a wall of `ok` is one
nobody reads, and then the one real line scrolls past.

`--fix` repairs `caged-floor` findings in place — rewriting the in-cage hook path to the host form in
every affected pane's `.claude/settings.json`, INCLUDING the director's at the project hub rather than
a stream worktree — then re-checks and reports what is left. The rewrite is the same
`bsc_sandbox::rewrite_guest_hooks` a launch runs, so a manual repair and an automatic one cannot
produce two different files. Nothing else is touched: `no-gate` still needs `bsc fleet wake`, which
places a pane rather than editing a file. Safe to run whether or not anything needed it.

NEEDS NO APP, unlike `fleet list`. Every check is a fact about a worktree on disk or about the stream
id in plan.db, so this answers when the app is DOWN — which is exactly when a director most needs it.

  bad-stream-id the stream id cannot be used as a pane-id tail (`<key>:<id>`) — a colon, or anything
                outside [a-z0-9-]. The pane id then does not parse as a worker, so `bsc fleet wake`
                resolves no plan row and the launch is refused with \"<no cwd>\", naming neither the
                stream nor the id. The ONLY check here that needs no worktree, because a broken id is
                what stops one being created — every other check is blind to it.
  no-gate       the worktree has no `.claude/settings.json`, so the pane has no role gate and no shell
                allow-list. A launch is REFUSED rather than run permission-less (#1819) — `bsc fleet
                wake` (#142) provisions a placeholder gate itself when one is missing, which is enough
                to pass the refusal; the pane's own launch overwrites it with the real settings moments
                later, so waking the pane is the fix.
  caged-floor   its PreToolUse hooks invoke `/bsc-hook`, which exists only inside a mount namespace.
                Launched uncaged, those gates cannot execute and fail NON-BLOCKING — the session runs
                with no write-scope and no dangerous-command floor, looking exactly like one that is
                gated and permitting.

WHY THIS EXISTS. Four bugs in one day shared one signature: an answer that was wrong in the
SAFE-LOOKING direction and left NO DURABLE TRACE — a parked fleet reported as `running`, a dead
permission floor, a wake that killed what it could not relaunch, a prompt silently truncated to half.
Each was found by hand, by reading process trees and server logs. This is the same shape as
`bsc graph doctor` and `bsc ui parity`: compare TWO INDEPENDENT SOURCES that must agree, and report
where they do not. A check that re-derives its answer from the code that produced it proves nothing,
so every check here names its two sources.

Reports and exits 0 by default; `--strict` exits non-zero on any finding. Opt-in for the reason
`bsc ui parity`'s is: a guard that lands red protects nothing.",
}, CmdDoc {
    name: "clone",
    summary: "materialize the project's linked repos into its hub — the prerequisite for any worker",
    usage: "\
USAGE:
  bsc fleet clone [--db <plan.db>] [--repo <name>]… [--source <path-or-url>] [--token <t>] [--local] [--json]

Materializes the repos a fleet needs. Every worker runs in a git worktree cut from its repo's
clone inside the project hub, so a hub with no clone cannot start a single worker — `bsc fleet start`
and `bsc fleet wake` both fail with `ensure_worktree: repo not cloned`, and until now the only thing
that could fix that was a click in the desktop UI. A director is a shell session, so the one act that
unblocks its whole fleet was the one act it could not perform.

THE REPOS COME FROM plan.db, the same store `fleet list` reads membership from — so this and the UI
cannot disagree about which repos the project has. `--repo` narrows it to the ones you name.

IDEMPOTENT: a repo already cloned is reported `already-present` and nothing runs. That is what makes
it safe to run before every launch rather than working out first which repos are missing. It never
re-clones over an existing checkout, which would destroy the worktrees cut from it.

NO APP NEEDED. A clone is git plus a path; this does not go through the desktop, so it works with the
app closed — unlike `start` and `wake`, which place panes and therefore cannot.

--source clones from a local path instead of github.com. Use it when a checkout already exists on this
machine: it is the difference between seconds and re-downloading hundreds of megabytes, and it is the
only form that works with no network.

--token authorizes a private repo. It is redacted from any error, since git echoes the URL it was given.

A PROJECT THAT SHIPS NOWHERE IS INITIALIZED, NOT CLONED. When the plan classifies the project
`usesGithub: false` there is nothing to clone FROM and never was, so this runs `git init` plus a root
commit in the hub instead, and reports the outcome as `initialized` rather than `cloned` — a different
claim, because that repo has no upstream and a director must not be told it can push. Content already
sitting in the directory (a README the architect wrote) is committed rather than left untracked; the
app-managed files are excluded first, exactly as they are from a clone. The root commit exists because
`git init` alone leaves an UNBORN HEAD, and neither the integration branch nor any worker branch can be
cut from a commit that does not exist.

--local forces that path for a project whose classification is missing or wrong. It is an override, not
a default: giving an upstream-less repo to a project that DOES ship to GitHub is the one mistake here
that is hard to notice and hard to undo. --source still wins over both — a local project seeded from a
checkout already on the machine is a clone, and the caller has said so.",
}, CmdDoc {
    name: "wake",
    summary: "wake a parked/reaped worker — the director's lever over a stopped session",
    usage: "USAGE:
  bsc fleet wake <pane-id> [--prompt <text>] [--force] [--json|--pretty]

Wakes a worker whose session was parked or reclaimed, and hands it a prompt to start on. Without
--prompt the app supplies its standard change-request wake, so a director does not have to reproduce
that prose to use the command.

IT ALSO STARTS A STREAM THAT NEVER RAN — the `never-launched` state in `bsc fleet list`. The pane does
not have to exist; the plan row is what has to. The stream is resolved from plan.db, its worktree is
built if it has none, and the pane comes up wired exactly as a fleet launch would have wired it. So
`bsc fleet start` is for bringing up a WHOLE fleet, never for the one stream that did not come up —
it refuses outright while any pane is live. Pass a real --prompt for a never-launched stream: it has
no assignment in its pane yet, so the standard wake would tell it to re-read nothing.

IT ALSO PROVISIONS A MISSING GATE (#142). A worktree can exist with no `.claude/settings.json` — an
earlier `start`/`wake` that built it but never reached the settings write, `bsc fleet doctor`'s
`no-gate` finding. Left alone that pane is refused FOREVER: the launch that would write the real gate
never runs BECAUSE the gate is missing. This wake writes a conservative placeholder gate (the `ask`
posture — mandatory gh/git/bsc plus read-only auto-run, everything else prompts) before asking to
launch, which is enough to pass the refusal; the pane's own launch overwrites it with the real
role+profile settings moments later.

A stream plan.db does NOT name is still an error, and says so — an unknown stream is not the same
thing as an unlaunched one.

REFUSES a BUSY pane unless --force. Waking KILLS the PTY before relaunching, so interrupting a worker
that is mid-task is a deliberate act, not something to do by accident. `bsc fleet list` shows which
panes are busy.

A DISABLED pane (one a person turned off via the Console pane menu, or that a session-end used to set)
is REVIVED, not refused — ending a session no longer keeps the director from waking it back up.

The reply carries whether the wake actually landed. A pane the app cannot resolve — no open tab left to
recreate it in, or a stream neither the roster nor plan.db names — reports an ERROR rather than success,
naming which of the two it was. The wake path kills first, so a false success would leave a dead worker
behind a caller that believes it is running.

THIS IS ALSO THE FIX FOR A WORKTREE WITH NO `.claude/settings.json` — `bsc fleet doctor`'s `no-gate`
finding. The imminent remount this command triggers writes that file before the pane launches, so
waking a stream in that state repairs it — no `--force`, no whole-fleet relaunch, no other pane
touched. `bsc fleet provision <projectKey> --stream <id>` is the same call under a name built for
exactly that repair.

Requires the desktop app: waking is frontend state, so only the app can do it.",
}, CmdDoc {
    name: "provision",
    summary: "rewrite ONE stream's worktree settings.json and bring its pane up — no whole-fleet --force",
    usage: "\
USAGE:
  bsc fleet provision <projectKey> --stream <id> [--prompt <text>] [--force] [--json|--pretty]

Repairs `bsc fleet doctor`'s `no-gate` finding — a worktree with no `.claude/settings.json`, so its
pane has no role gate and no shell allow-list (#1819) — for exactly ONE stream, by project key and
stream id rather than a pre-built pane id.

THIS IS SUGAR OVER `bsc fleet wake <projectKey>:<id>`, not a second launch path: it builds the same
pane id and rides the identical wake round trip, so the settings are written by the one place that
already writes them. Reach for `provision` when a stream's project+id is what you have (a doctor
finding, a plan row); reach for `wake` when you already have the pane id.

NO WHOLE-FLEET DISRUPTION. `bsc fleet start` refuses on an already-running fleet without `--force`,
and `--force` relaunches every other live pane just to repair one — this touches only the named
stream's pane. See `bsc fleet wake help` for the busy/disabled/never-launched semantics this inherits
verbatim (REFUSES a BUSY pane unless --force; a DISABLED pane is REVIVED; a never-launched stream is
started fresh).

Requires the desktop app, for the same reason `wake` does: writing the settings happens at the pane's
imminent remount, which is frontend state.",
}];

struct Args {
    json: bool,
    pretty: bool,
    roster: Option<String>,
    db: Option<String>,
    prompt: Option<String>,
    force: bool,
    /// `doctor --strict`: exit non-zero when anything is found, so it can be a gate. Plain runs
    /// report and exit 0 — a guard that lands red protects nothing (see `bsc ui parity`).
    strict: bool,
    /// `doctor --fix`: repair `caged-floor` findings in place instead of only reporting them.
    fix: bool,
    timeout_ms: Option<i64>,
    /// `launch-config`: which harness the pane launches. Its own flag rather than reusing `--source`,
    /// so the usage text and the parser cannot disagree.
    provider: Option<String>,
    /// `launch-config`: read the payload from a sealed scratch file instead of stdin.
    file: Option<String>,
    /// `clone`: the PAT for a private repo. Never echoed — a failed clone redacts it.
    token: Option<String>,
    /// `clone`: clone FROM here instead of github.com (a local path, or any git URL).
    source: Option<String>,
    /// `clone`: restrict to these repos instead of every one the plan links.
    repos: Vec<String>,
    /// `clone --local`: materialize the repo LOCALLY (`git init` + a root commit) instead of cloning
    /// it from anywhere. Normally inferred from the plan's own `classify.usesGithub`, so this is the
    /// override for a project whose classification is missing or wrong — never a thing to reach for
    /// by default, since a project that DOES ship to GitHub must not get an upstream-less repo.
    local: bool,
    /// `provision`: the stream id to re-provision, combined with the projectKey positional into a
    /// pane id — the same identity `wake` takes directly.
    stream: Option<String>,
    /// `warden-decide --quarantined a,b`: panes this process has ALREADY hard-paused, so a trip stays
    /// a one-shot pause rather than an alert that repeats on every sweep.
    quarantined: Option<String>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args { json: false, pretty: false, roster: None, db: None, prompt: None, force: false, strict: false, fix: false, timeout_ms: None, provider: None, file: None, token: None, source: None, repos: Vec::new(), local: false, stream: None, quarantined: None, positional: Vec::new() };
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        match flag {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--roster" => a.roster = Some(v.value("--roster needs a path")?),
            "--stream" => a.stream = Some(v.value("--stream needs a stream id")?),
            "--quarantined" => a.quarantined = Some(v.value("--quarantined needs a pane id list")?),
            "--db" => a.db = Some(v.value("--db needs a path")?),
            "--prompt" => a.prompt = Some(v.value("--prompt needs text")?),
            "--force" => a.force = true,
            "--strict" => a.strict = true,
            "--fix" => a.fix = true,
            "--token" => a.token = Some(v.value("--token needs a value")?),
            "--source" => a.source = Some(v.value("--source needs a path or URL")?),
            "--provider" => a.provider = Some(v.value("--provider needs a harness name")?),
            "--file" => a.file = Some(v.value("--file needs a scratch-file name")?),
            "--repo" => a.repos.push(v.value("--repo needs an owner/name")?),
            "--local" => a.local = true,
            "--timeout" => {
                let raw = v.value("--timeout needs a value")?;
                a.timeout_ms = Some(raw.parse().map_err(|_| format!("--timeout: not a number: {raw}"))?);
            }
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
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
        "provision" => cmd_provision(&args, prog),
        "clone" => cmd_clone(&args, prog),
        "warden-decide" => cmd_warden_decide(&args),
        "launch-config" => cmd_launch_config(&args),
        "worker-end" => cmd_worker_end(&args),
        "doctor" => cmd_doctor(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// The plan store this session is scoped to — `--db`, else `$BSC_PLAN_DB`. A path naming nothing is
/// `None` rather than a fresh empty store: `Store::open` would mint one, and a project invented by a
/// typo is not a project to clone repos for.
fn plan_db_path(db_flag: Option<&str>) -> Option<std::path::PathBuf> {
    let flag = db_flag.map(str::to_string);
    let path = bsc_cli_util::resolve_store_path(&flag, "BSC_PLAN_DB", || Err("no plan store".to_string())).ok()?;
    path.is_file().then_some(path)
}

/// `bsc fleet warden-decide` — the quarantine decision, from a report on stdin.
///
/// Reads and decides; it does not enforce, does not touch a PTY and holds no state. Everything it
/// needs arrives in the report, which is what makes the whole decision reproducible from a file — and
/// what lets it live in a process the app merely spawns.
fn cmd_warden_decide(a: &Args) -> Result<(), String> {
    let raw = bsc_cli_util::read_payload(None)?;
    let report: crate::warden::FleetReport = serde_json::from_str(raw.trim())
        .map_err(|e| format!("bsc fleet warden-decide: the report on stdin did not parse: {e}"))?;

    let already: std::collections::HashSet<String> = a
        .quarantined
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let trips = crate::warden::decide(&report, &already);
    bsc_cli_util::emit(a.pretty, a.json, &trips, || {
        if trips.is_empty() {
            // Said in words. An empty table would read as "the warden did not run", and those are
            // opposite facts for a verb whose action is to kill a session.
            return "no pane should be quarantined".to_string();
        }
        let mut lines = vec!["pane\tstream\tsummary".to_string()];
        lines.extend(trips.iter().map(|t| format!("{}\t{}\t{}", t.pane_id, t.stream_id, t.summary)));
        lines.join("\n")
    });
    Ok(())
}

/// `bsc fleet launch-config --provider <name>` — the whole launch configuration, in one reply.
///
/// Derives nothing itself: `llm::launch_cmd::launch_config` owns the derivation, so the app's
/// dispatcher and this verb cannot drift from one another.
fn cmd_launch_config(a: &Args) -> Result<(), String> {
    let provider = a
        .provider
        .as_deref()
        .ok_or("usage: bsc fleet launch-config --provider <name> (config as JSON on stdin)")?;
    let raw = bsc_cli_util::read_payload(a.file.as_deref())?;
    // An EMPTY payload is a legitimate "no config" — a provider with no model, prompt or read-files
    // still has a command. Only malformed JSON is an error.
    let cfg: Option<llm::launch_cmd::ProviderLaunchConfig> = if raw.trim().is_empty() {
        None
    } else {
        Some(serde_json::from_str(&raw).map_err(|e| format!("bsc fleet launch-config: bad config JSON: {e}"))?)
    };
    let out = llm::launch_cmd::launch_config(provider, cfg.as_ref());
    bsc_cli_util::emit(a.pretty, a.json, &out, || {
        // Absence is STATED. An empty line here would read as "an empty command", which is exactly the
        // thing a caller must not execute.
        out.provider_command.clone().unwrap_or_else(|| {
            format!("(no launch command — the {provider} harness bakes its own prompt)")
        })
    });
    Ok(())
}

/// `bsc fleet worker-end <projectKey> --stream a,b,c` — the verdict per stream, index-aligned.
///
/// Resolves the two store paths and nothing else: `worker_end::worker_end_verdicts` owns both the
/// gathering and the decision, so there is ONE implementation and the app's dispatcher cannot drift
/// from this one.
fn cmd_worker_end(a: &Args) -> Result<(), String> {
    let key = a.positional.get(1).ok_or("usage: bsc fleet worker-end <projectKey> --stream <id>[,<id>...]")?;
    // Comma-separated so ONE call carries the whole batch — see the usage text on why per-stream is
    // the shape this repo has twice had to undo.
    let streams: Vec<String> = a
        .stream
        .as_deref()
        .ok_or("bsc fleet worker-end: --stream <id>[,<id>...] is required")?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if streams.is_empty() {
        return Err("bsc fleet worker-end: --stream named no streams".into());
    }
    let plan_db = plans_dir().ok_or("no home directory — cannot locate the plan stores")?.join(format!("{key}.db"));
    let verdicts = crate::worker_end::worker_end_verdicts(&plan_db, &logs::log_dir(), &streams);

    bsc_cli_util::emit(a.pretty, a.json, &verdicts, || {
        let mut lines = vec!["stream\tstate\tsummary".to_string()];
        lines.extend(streams.iter().zip(verdicts.iter()).map(|(s, v)| match v {
            // `null` is not a verdict — it says there is no store to read. Rendered as a word rather
            // than an empty cell, which a reader would take for "nothing wrong".
            None => format!("{s}\tno-plan-store\tthe project has no plan.db — the caller must bail"),
            Some(v) => format!("{s}\t{}\t{}", v.state, v.summary),
        }));
        lines.join("\n")
    });
    Ok(())
}

/// A project's key, read off its plan store's filename — plans live at `plans/<key>.db`, and the key
/// is what names the hub the clone lands in. Taken from the PATH rather than from inside the store
/// because that mapping is the one `plan_db_path` in the app already relies on.
fn project_key_from_db(db: &std::path::Path) -> Option<String> {
    db.file_stem().map(|s| s.to_string_lossy().into_owned()).filter(|k| !k.is_empty())
}

/// A non-empty credential from `var`, or `None`. Blank-but-set is treated as absent: an exported
/// `GH_TOKEN=""` is how a shell says "no token", and passing it on would rebuild the anonymous URL
/// this fallback exists to avoid.
fn env_token(var: &str) -> Option<String> {
    std::env::var(var).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Turn git's credential-prompt failure into something the reader can act on.
///
/// Cloning a private repo with no credential does not fail with "unauthorized" — git tries to PROMPT,
/// finds no terminal, and reports `could not read Username for 'https://github.com': No such device
/// or address`. That sentence has sent a maintainer looking for a missing PERMISSION twice: the role
/// gate already grants a director `github: read`, and the actual state was that no GitHub account was
/// connected at all, so there was no token to inject or to read.
fn explain_clone_failure(prog: &str, repo: &str, had_token: bool, err: &str) -> String {
    let auth_prompt = err.contains("could not read Username")
        || err.contains("Authentication failed")
        || err.contains("terminal prompts disabled");
    if !auth_prompt {
        return format!("{prog} clone: {err}");
    }
    if had_token {
        format!(
            "{prog} clone: {repo} refused the credential this session carries. It may not grant \
             access to that repo, or it may have expired — reconnect the account in Settings → \
             GitHub. (original: {err})"
        )
    } else {
        format!(
            "{prog} clone: no GitHub credential, so {repo} could only be tried anonymously and git \
             asked for a username with no terminal to ask on.\n\
             \n\
             If the repo is PRIVATE: connect an account in Settings → GitHub — a session is handed \
             that token as $GH_TOKEN automatically — or pass `--token <t>` for this one call.\n\
             If a checkout is already on this machine: `{prog} clone --source <path>`, which needs \
             no network and no credential at all.\n\
             (original: {err})"
        )
    }
}

/// `clone` — materialize the hub's repo clones, the prerequisite every worker has.
///
/// Deliberately NOT folded into `ensure_worktree`. A clone is minutes and `bsc fleet wake`'s CLI
/// timeout is 8 seconds, so a wake that cloned would report a timeout while the work continued
/// invisibly — and the director would be told its wake failed when a clone was in fact running. A verb
/// with its own timeout is the honest shape for a long operation; `ensure_worktree` names this command
/// in its error instead.
/// Which door `clone` takes: `git init` in the hub, or a fetch from somewhere.
///
/// Pure and separate so the RULE is testable without a network, a hub, or a git binary — the
/// integration test below covers the local path end to end, but the three-way precedence is the part
/// that would rot silently, and it is the part a wrong answer is most expensive on.
///
/// Precedence, nearest first:
///   1. `--source` — the caller has NAMED a thing to clone from, so it is a clone whatever the plan
///      says. A local project seeded from a checkout already on this machine is the ordinary case.
///   2. `--local` — the explicit override, for a plan whose classification is missing or wrong.
///   3. `classify.usesGithub` — the plan's own answer, which is where this normally comes from.
fn materialize_locally(uses_github: bool, local_flag: bool, has_source: bool) -> bool {
    if has_source {
        return false;
    }
    local_flag || !uses_github
}

fn cmd_clone(args: &Args, prog: &str) -> Result<(), String> {
    let db = plan_db_path(args.db.as_deref())
        .ok_or_else(|| format!("{prog} clone: no plan store — pass --db <plan.db> or set BSC_PLAN_DB"))?;
    let key = project_key_from_db(&db).ok_or_else(|| {
        format!("{prog} clone: cannot tell which project {} belongs to", db.display())
    })?;
    let store = plandb::Store::open(&db).map_err(|e| format!("{prog} clone: cannot open {}: {e}", db.display()))?;
    let linked = store.repo_list().map_err(|e| format!("{prog} clone: cannot read the linked repos: {e}"))?;

    // Naming a repo the plan does not link is a mistake worth refusing: it would clone something the
    // fleet has no stream for, into a hub that will never use it.
    let repos: Vec<String> = if args.repos.is_empty() {
        linked.clone()
    } else {
        for r in &args.repos {
            if !linked.contains(r) {
                return Err(format!(
                    "{prog} clone: '{r}' is not linked to '{key}'. Linked: {}",
                    if linked.is_empty() { "(none)".into() } else { linked.join(", ") }
                ));
            }
        }
        args.repos.clone()
    };
    if repos.is_empty() {
        return Err(format!(
            "{prog} clone: '{key}' links no repos, so there is nothing to materialize. \
             `bsc plan repo list` shows what the plan holds; `bsc plan repo add <name>` links one — \
             `owner/repo` for a project that ships to GitHub, a bare name for one that does not."
        ));
    }

    // THE SESSION IS ALREADY HOLDING A CREDENTIAL, and this used to ignore it.
    //
    // `session-launch` puts the app's GitHub token in every session that has any git/gh capability
    // (`if (ghToken && !noGitOrGithub) e.GH_TOKEN = ghToken`), precisely so `gh` and git-over-https
    // work. This verb defaulted `--token` to EMPTY instead of reading it, so a director with a
    // perfectly good token in its environment still cloned anonymously — and a private repo answered
    // with git's prompt failure, `could not read Username for 'https://github.com'`, which names
    // neither the cause nor the fix.
    //
    // `GH_TOKEN` first (what the app injects), then `GITHUB_TOKEN` (what CI and `gh` also honour).
    let token = args
        .token
        .clone()
        .or_else(|| env_token("GH_TOKEN"))
        .or_else(|| env_token("GITHUB_TOKEN"))
        .unwrap_or_default();
    // WHICH KIND OF REPO THIS PROJECT HAS, asked of the plan rather than assumed.
    //
    // A project classified `usesGithub: false` ships nowhere, so there is nothing to clone FROM and
    // never was — `bsc plan repo add` links a bare local name for it, not an `owner/repo`. Cloning
    // such a repo could only ever fail at github.com with a 404 that names neither the cause nor a
    // fix, which is exactly the wall twitter-clone-test hit: an empty `repos` table, a hub directory
    // with no `.git`, and `ensure_worktree` sending the reader to this very command for a repo it
    // could not possibly produce.
    //
    // `--source` still wins when given: a local project seeded from a checkout already on the machine
    // is a clone, not an init, and the caller has said so explicitly.
    let uses_github = store
        .classify_get()
        .ok()
        .flatten()
        .and_then(|c| c.get("usesGithub").and_then(serde_json::Value::as_bool))
        // ABSENT means unclassified, and the historical behaviour is the clone. Defaulting the other
        // way would silently give an upstream-less repo to every project that simply has not run
        // discovery yet, and an init is the harder of the two to notice and undo.
        .unwrap_or(true);
    let materialize_locally = materialize_locally(uses_github, args.local, args.source.is_some());

    let mut rows = Vec::new();
    for repo in &repos {
        // FAIL CLOSED on the first repo that cannot be materialized, naming it. A partial run reported
        // as success is the state where half the fleet starts and the other half fails one wake at a
        // time.
        let (path, outcome) = if materialize_locally {
            // `main` rather than the plan's integration branch: this is the PRODUCTION rung, and
            // `ensure_integration_branch` cuts `develop` from HEAD at the first worktree. Initialising
            // straight onto the integration branch would leave the ladder with no rung above it.
            bsc_project::ensure_local_repo(&key, repo, "main")
                .map_err(|e| format!("{prog} clone: could not materialize '{repo}' locally: {e}"))?
        } else {
            bsc_project::ensure_clone(&key, repo, &token, args.source.as_deref())
                .map_err(|e| explain_clone_failure(prog, repo, !token.is_empty(), &e))?
        };
        rows.push(serde_json::json!({
            "repo": repo,
            "path": path.to_string_lossy(),
            "outcome": match outcome {
                bsc_project::CloneOutcome::AlreadyPresent => "already-present",
                bsc_project::CloneOutcome::Cloned => "cloned",
                bsc_project::CloneOutcome::Initialized => "initialized",
            },
        }));
    }

    let res = serde_json::json!({ "projectKey": key, "repos": rows });
    bsc_cli_util::emit(args.pretty, args.json, &res, || {
        let mut out = String::new();
        for r in &rows {
            out.push_str(&format!(
                "{:<14} {}  {}\n",
                r["outcome"].as_str().unwrap_or(""),
                r["repo"].as_str().unwrap_or(""),
                r["path"].as_str().unwrap_or(""),
            ));
        }
        out.push_str(&format!("{} repo(s) for {key}", rows.len()));
        out
    });
    Ok(())
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

/// `bsc fleet provision <projectKey> --stream <id>` (request #165) — the scoped, discoverable name
/// for exactly what `bsc fleet wake <projectKey>:<id>` already does: rewrite ONE stream's worktree
/// `.claude/settings.json` and bring its pane up, without a whole-fleet `--force` relaunch and
/// without touching any other pane.
///
/// DELIBERATELY NOT A SECOND LAUNCH PATH — this composes the same `pane_id` `wake` takes and rides
/// the identical [`WAKE_KIND`] round trip, so there is exactly one place that resolves a stream to a
/// pane and writes its gate. Request #165 was filed because nothing said `wake` already does this
/// (`bsc fleet doctor`'s `no-gate` finding read as "relaunch the pane from its project", which sounds
/// like the disruptive whole-fleet `--force` path) — `provision` exists for discoverability, not
/// because `wake` was missing a capability.
fn cmd_provision(args: &Args, prog: &str) -> Result<(), String> {
    let key = args.positional.get(1).map(String::as_str).unwrap_or("");
    let stream = args.stream.as_deref().unwrap_or("");
    let req = provision_wake_request(key, stream, args.prompt.as_deref().unwrap_or(""), args.force)
        .map_err(|reason| {
            format!(
                "usage: {prog} provision <projectKey> --stream <id> [--prompt <text>] [--force]\n\n\
                 {reason} — `bsc plan fleet get` shows a project's stream ids."
            )
        })?;
    let timeout = args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let res: WakeResult = ask(WAKE_KIND, &req, timeout)?;
    bsc_cli_util::emit(args.pretty, args.json, &res, || {
        let note = if res.was_busy { " (interrupted a BUSY pane)" } else { "" };
        format!("provisioned {} — its .claude/settings.json is (re)written and the session is up{note}", res.pane_id)
    });
    Ok(())
}

/// The [`WakeRequest`] `provision <projectKey> --stream <id>` sends — pulled out of [`cmd_provision`]
/// so a test can check exactly what pane id and payload `wake` receives without going through the
/// app-channel transport `ask` opens.
///
/// `key:stream` is the SAME pane-id grammar `wake` takes directly (`<projectKey>:<streamId>`,
/// `bsc_fleet::director_pane_id`'s sibling for a worker) — composed here rather than re-derived by
/// `wake`, so `provision` and a hand-built `wake <pane-id>` can never disagree about the pane a given
/// project+stream resolves to.
fn provision_wake_request(key: &str, stream: &str, prompt: &str, force: bool) -> Result<WakeRequest, &'static str> {
    let key = key.trim();
    if key.is_empty() {
        return Err("needs a project key");
    }
    let stream = stream.trim();
    if stream.is_empty() {
        return Err("needs --stream <id>");
    }
    Ok(WakeRequest { pane_id: format!("{key}:{stream}"), prompt: prompt.to_string(), force })
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

/// The DIRECTOR pane-id suffix — ONE definition, re-exported from `membership` rather than spelled
/// again here. Two copies of this string is precisely the drift that would let `director new` create a
/// pane the `directors` read cannot see.
use membership::DIRECTOR_SUFFIX;

/// Where the plan stores live: `~/.base-studio-code/plans/<key>.db`, the central location #2996 moved
/// them to. `$BSC_PLANS_DIR` overrides it, which is what makes the scan testable without a home dir.
fn plans_dir() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("BSC_PLANS_DIR") {
        let p = p.trim();
        if !p.is_empty() {
            return Some(std::path::PathBuf::from(p));
        }
    }
    bsc_util::bsc_base_dir().map(|b| b.join("plans"))
}

/// Read one plan store's director, if it has one. `None` for a store that neither planned a director
/// nor ever launched one — which is how the scan skips the scratch/abandoned stores that accumulate
/// in `plans/` without having to keep a list of them.
///
/// READ-ONLY: `open_read_only` neither creates nor migrates. An architect listing its tier must not
/// write to thirty stores it does not own.
fn director_of(path: &std::path::Path) -> Option<membership::DirectorMember> {
    let store = plandb::Store::open_for_scan(path).ok()?;
    let ledger = store.fleet_session_list_or_empty();
    let fleet = store.fleet_get_or_none().unwrap_or(serde_json::Value::Null);
    let planned = fleet
        .get("director")
        .map(|d| d.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true))
        .unwrap_or(false);

    // Prefer a key OBSERVED in the ledger over the filename: `plans/<key>.db` is the canonical
    // construction, but a legacy or hand-copied store can disagree, and a wrong key would print a
    // pane id that resolves to nothing — which is worse than not listing the project at all.
    let row = ledger.iter().find(|r| r.pane_id.ends_with(membership::DIRECTOR_SUFFIX));
    let key = row
        .map(|r| membership::project_key_of(&r.pane_id).to_string())
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()))?;
    if !planned && row.is_none() {
        return None;
    }

    // The PROJECT's tally — every issue, not one stream's. That is what a director is accountable for.
    let progress = store
        .list(None, None)
        .map(|issues| {
            membership::Progress::tally(issues.iter().map(|i| i.status.as_str()))
        })
        .unwrap_or_default();

    Some(membership::DirectorMember {
        pane_id: format!("{key}{}", membership::DIRECTOR_SUFFIX),
        project_key: key,
        planned,
        launched: row.is_some(),
        ledger_status: row.map(|r| r.status.clone()).unwrap_or_default(),
        launched_at: row.map(|r| r.launched_at).unwrap_or(0),
        last_seen: row.map(|r| r.last_seen).unwrap_or(0),
        progress,
    })
}

/// Every project that HAS a director, from the plan stores. Sorted by key here so the scan is
/// deterministic regardless of readdir order; the caller re-sorts once liveness is known.
fn scan_directors() -> Vec<membership::DirectorMember> {
    let Some(dir) = plans_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut paths: Vec<std::path::PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("db"))
        .collect();
    paths.sort();
    // A store that cannot be opened or read is SKIPPED, never fatal: one corrupt or locked plan.db
    // must not hide every other project's director.
    paths.iter().filter_map(|p| director_of(p)).collect()
}

/// `bsc fleet directors` — one row per project director, with real liveness.
///
/// Scoped by CONSTRUCTION rather than by a flag: membership is the DIRECTOR of each plan store and
/// the app's `:director` panes, and neither source can name a worker. An architect running this
/// cannot widen it to workers, which is the tier boundary this verb exists to hold.
fn cmd_directors(args: &Args) -> Result<(), String> {
    // No roster and no `--db`: the architect does not sit in a hub, and a director's pane id already
    // names its project. An empty `pane_ids` means "everything the app tracks".
    let res = send(&FleetRequest::default(), args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;
    let tracked: Vec<String> = res.panes.iter().map(|p| p.pane_id.clone()).collect();

    let mut rows = scan_directors();
    membership::absorb_tracked_directors(&mut rows, &tracked);
    let live_of = |r: &membership::DirectorMember| {
        res.panes.iter().find(|p| p.pane_id == r.pane_id).map(|p| (p.live, p.busy))
    };
    membership::sort_directors(&mut rows, |r| r.state(live_of(r)));

    if args.json || args.pretty {
        let out: Vec<_> = rows
            .iter()
            .map(|r| {
                let p = res.panes.iter().find(|p| p.pane_id == r.pane_id);
                let mut v = serde_json::to_value(r).unwrap_or(serde_json::Value::Null);
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("state".into(), r.state(live_of(r)).as_str().into());
                    obj.insert("live".into(), p.map(|p| p.live).unwrap_or(false).into());
                    obj.insert("busy".into(), p.map(|p| p.busy).unwrap_or(false).into());
                    if let Some(pid) = p.and_then(|p| p.pid) {
                        obj.insert("pid".into(), pid.into());
                    }
                }
                v
            })
            .collect();
        bsc_cli_util::emit(args.pretty, args.json, &out, String::new);
        return Ok(());
    }
    print!("{}", render_directors(&rows, &res));
    Ok(())
}

/// The architect's table. Dynamic key width for the same reason the fleet table has one: a project
/// key is what goes into `bsc plan brief <key>:director`, so it is never truncated.
fn render_directors(rows: &[membership::DirectorMember], res: &FleetResult) -> String {
    let w = rows.iter().map(|r| r.project_key.len()).max().unwrap_or(7).max(7);
    let mut out = format!(
        "{:<w$}  {:<14} {:<8} {:<5} {:<5} PID\n",
        "PROJECT", "STATE", "ISSUES", "LIVE", "BUSY",
        w = w
    );
    for r in rows {
        let p = res.panes.iter().find(|p| p.pane_id == r.pane_id);
        let live = p.map(|p| p.live).unwrap_or(false);
        out.push_str(&format!(
            "{:<w$}  {:<14} {:<8} {:<5} {:<5} {}\n",
            r.project_key,
            r.state(p.map(|p| (p.live, p.busy))).as_str(),
            r.progress.cell(),
            if live { "yes" } else { "no" },
            if p.map(|p| p.busy).unwrap_or(false) { "yes" } else { "no" },
            p.and_then(|p| p.pid).map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
            w = w,
        ));
    }
    if rows.is_empty() {
        out.push_str("(no project has a director — none planned, none ever launched)\n");
        return out;
    }
    let reachable = rows
        .iter()
        .filter(|r| {
            let p = res.panes.iter().find(|p| p.pane_id == r.pane_id);
            matches!(
                r.state(p.map(|p| (p.live, p.busy))),
                membership::State::Running | membership::State::Idle
            )
        })
        .count();
    out.push_str(&format!(
        "\n{} director(s) — {reachable} reachable by `bsc plan brief <projectKey>:director`\n",
        rows.len()
    ));
    if reachable < rows.len() {
        out.push_str(
            "  briefing a director that is not running is how work goes quietly missing — the rest need the user to start them\n",
        );
    }
    out
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

/// `bsc fleet doctor` — the claims this fleet makes about itself that do not hold.
///
/// APP-FREE. Every check here is a filesystem fact about a worktree, so it answers with the app
/// down — which is exactly when a director most needs it and exactly when `fleet list`, which asks
/// the running app, can say nothing at all.
///
/// Prints NOTHING when the fleet is clean. A doctor whose normal output is a wall of "ok" is one
/// nobody reads, and then the one real line scrolls past.
fn cmd_doctor(args: &Args) -> Result<(), String> {
    let Some((key, members)) = choose_membership(args) else {
        return Err("bsc fleet doctor: no plan store — pass --db or set $BSC_PLAN_DB".into());
    };
    let base = bsc_util::bsc_base_dir().ok_or("bsc fleet doctor: no base dir")?;

    let collect_findings = || -> Vec<doctor::Finding> {
        members
            .iter()
            .flat_map(|m| {
                // The id check runs FIRST and unconditionally. Every other check needs a worktree, and
                // a broken id is what stops one from ever existing — so ordering it after them would
                // put the cause below the symptoms, on the one fleet where there are no symptoms.
                let mut fs = doctor::id_findings_for(&m.pane_id, &m.stream);
                // `member_dir`, not `find_worktree`: the director and every triage pane own no stream,
                // and `find_worktree` answers `None` for a blank one — which `read_facts` turns into
                // "no facts" rather than "no worktree", so every filesystem check silently skipped the
                // pane at the hub.
                let dir = doctor::member_dir(&base, &key, &m.stream);
                fs.extend(doctor::findings_for(&m.pane_id, doctor::read_facts(dir.as_deref())));
                fs
            })
            .collect()
    };

    // `--fix` runs BEFORE the report, so what gets printed is what is STILL wrong. Repairing and then
    // printing the pre-repair findings would read as having done nothing — the same
    // report-that-does-not-match-reality this whole verb exists to catch.
    let mut repaired: Vec<String> = Vec::new();
    if args.fix {
        for m in &members {
            let Some(dir) = doctor::member_dir(&base, &key, &m.stream) else { continue };
            match doctor::repair_settings_file(&dir.join(".claude").join("settings.json")) {
                Ok(true) => repaired.push(m.pane_id.clone()),
                Ok(false) => {}
                // A pane that cannot be repaired is NOT fatal: the remaining panes still get fixed, and
                // the finding it leaves behind is printed below, so the failure stays visible.
                Err(e) => eprintln!("bsc fleet doctor --fix: {}: {e}", m.pane_id),
            }
        }
        if !args.json && !args.pretty && !repaired.is_empty() {
            println!("repaired {} pane(s): {}", repaired.len(), repaired.join(", "));
        }
    }

    let findings: Vec<doctor::Finding> = collect_findings();

    if args.json || args.pretty {
        if args.fix {
            bsc_cli_util::emit(
                args.pretty,
                args.json,
                &serde_json::json!({ "repaired": repaired, "findings": findings }),
                String::new,
            );
        } else {
            bsc_cli_util::emit(args.pretty, args.json, &findings, String::new);
        }
    } else {
        for f in &findings {
            println!("{}  {}", f.pane_id, f.category);
            println!("    {}", f.detail);
            println!("    → {}", f.consequence);
            println!("    fix: {}", f.fix);
        }
    }
    // `--strict` is opt-in for the same reason `bsc ui parity`'s is: a guard that lands red protects
    // nothing. Reporting exits 0 so this can be run habitually; gating is a deliberate choice.
    if args.strict && !findings.is_empty() {
        return Err(format!("bsc fleet doctor: {} finding(s)", findings.len()));
    }
    Ok(())
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
    /// An agent process is running for this pane. What `STATE` is derived from — `busy` is the broader
    /// "something is in flight", which is a different question (see `PaneLive`).
    agent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    /// The UNLANDED upstreams this stream is waiting on
    /// (#the-director-can-see-which-streams-are-held). Empty ⇒ nothing blocks it.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    waiting_on: Vec<String>,
    /// In, or downstream of, a `dependsOn` cycle — it can never become ready on its own.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    deadlocked: bool,
}

/// This project's held streams, keyed by stream id — the `DEPS` column's content.
///
/// Every signal is read HERE rather than asked of the app: plan.db, the repo clones' git history and
/// the coord log are all on disk, so a director gets this answer with the desktop closed. The app's
/// own producer (`fleet_landed_streams`) calls the same function for tier 2, and the pure rules are
/// pinned to `streamGate.ts` by a shared fixture — so the launcher and this reporter cannot disagree.
///
/// Best-effort by design: no plan store, no hub, or a git failure yields an EMPTY map, which reads as
/// "nothing is blocked". That is the safe direction — it degrades to the table that printed before —
/// whereas a partial gate reported as authoritative would tell a director not to wake a ready worker.
fn gate_for(args: &Args, project_key: &str) -> std::collections::HashMap<String, gate::HeldStream> {
    let Some(db) = plan_db_path(args.db.as_deref()) else { return Default::default() };
    let Ok(store) = plandb::Store::open(&db) else { return Default::default() };
    let streams: Vec<gate::GateStream> = store
        .fleet_stream_list()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| {
            let id = r.get("id").and_then(serde_json::Value::as_str)?.to_string();
            let strs = |k: &str| {
                r.get(k)
                    .and_then(serde_json::Value::as_array)
                    .map(|a| a.iter().filter_map(serde_json::Value::as_str).map(str::to_string).collect())
                    .unwrap_or_default()
            };
            Some(gate::GateStream { id, depends_on: strs("dependsOn"), issues: strs("issues") })
        })
        .collect();
    if streams.is_empty() {
        return Default::default();
    }
    let hub = bsc_project::project_dir(project_key).unwrap_or_default();
    let ev = gate::LandedEvidence {
        done_issues: gate::done_issue_refs(&store),
        merged_branches: gate::landed_branches(&hub).into_iter().collect(),
        session_done: gate::maintaining_streams(&logs::log_dir(), project_key),
    };
    gate::partition_by_deps(&streams, &ev)
        .held
        .into_iter()
        .map(|h| (h.stream_id.clone(), h))
        .collect()
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

    // THE DEPENDENCY GATE (#the-director-can-see-which-streams-are-held). Liveness says whether a
    // worker is breathing and ISSUES says what it achieved; neither says whether it is WAITING on
    // another stream — so "stopped 0/7" read the same for a stream ready to wake and one whose
    // upstream has not landed, and picking between them was the director's whole job.
    //
    // Best-effort: a gate that cannot be computed leaves every row unblocked, which degrades to the
    // table this printed before. An empty answer must never read as "everything is held".
    let waiting = gate_for(args, project_key);

    let rows: Vec<Row> = members
        .into_iter()
        .map(|m| {
            let p = res.panes.iter().find(|p| p.pane_id == m.pane_id);
            // AGENT, not busy (#fleet-list-reports-whether-the-agent-is-running). `busy` is "something
            // is in flight", which a sandboxed pane satisfies at a bare prompt — `bwrap` and the shell
            // inside it are its own descendants — so it could never read `idle`.
            let state = membership::State::classify(&m, p.map(|p| (p.live, p.agent)));
            let held = waiting.get(m.stream.as_str());
            Row {
                state,
                live: p.map(|p| p.live).unwrap_or(false),
                busy: p.map(|p| p.busy).unwrap_or(false),
                agent: p.map(|p| p.agent).unwrap_or(false),
                pid: p.and_then(|p| p.pid),
                waiting_on: held.map(|h| h.waiting_on.clone()).unwrap_or_default(),
                deadlocked: held.is_some_and(|h| h.deadlocked),
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
    // The DEPS column is printed only when something is actually held. A column of `-` on every row
    // widens the table for a fleet whose graph is flat and teaches the reader nothing.
    let show_deps = rows.iter().any(|r| !r.waiting_on.is_empty());
    let dw = rows.iter().map(|r| waits_cell(r).len()).max().unwrap_or(4).max(4);
    let mut out = if show_deps {
        format!(
            "{:<w$}  {:<9} {:<14} {:<8} {:<dw$} {:<5} {:<5} PID\n",
            "PANE", "ROLE", "STATE", "ISSUES", "WAITING ON", "LIVE", "AGENT",
            w = w, dw = dw.max("WAITING ON".len())
        )
    } else {
        format!(
            "{:<w$}  {:<9} {:<14} {:<8} {:<5} {:<5} PID\n",
            "PANE", "ROLE", "STATE", "ISSUES", "LIVE", "AGENT",
            w = w
        )
    };
    for r in rows {
        let head = format!(
            "{:<w$}  {:<9} {:<14} {:<8}",
            r.member.pane_id,
            if r.member.role.is_empty() { "-" } else { &r.member.role },
            r.state.as_str(),
            r.member.progress.cell(),
            w = w,
        );
        let tail = format!(
            "{:<5} {:<5} {}",
            if r.live { "yes" } else { "no" },
            // The column shows the AGENT, because that is what STATE is derived from and what the
            // reader is actually asking. `busy` is still in `--json` for anything that wants "is
            // something in flight" — they differ on a sandboxed pane at a bare prompt.
            if r.agent { "yes" } else { "no" },
            r.pid.map(|n| n.to_string()).unwrap_or_else(|| "-".into()),
        );
        if show_deps {
            out.push_str(&format!("{head} {:<dw$} {tail}\n", waits_cell(r), dw = dw.max("WAITING ON".len())));
        } else {
            out.push_str(&format!("{head} {tail}\n"));
        }
    }
    out.push('\n');
    out.push_str(&summarize(rows));
    out.push('\n');
    out
}

/// The widest the `WAITING ON` cell may render before it is elided.
const WAITS_MAX: usize = 28;

/// What a row is waiting on, short enough for a column.
///
/// A DEADLOCK is called out by name rather than shown as an ordinary wait: those two rows look
/// identical in a table (`waiting on X`) and mean opposite things — one resolves when a worker
/// finishes, the other never resolves at all and needs the PLAN edited.
fn waits_cell(r: &Row) -> String {
    if r.waiting_on.is_empty() {
        return "-".into();
    }
    let tag = if r.deadlocked { "cycle" } else { "waits" };
    let names = if r.waiting_on.len() <= 2 {
        r.waiting_on.join(",")
    } else {
        format!("{},{},+{}", r.waiting_on[0], r.waiting_on[1], r.waiting_on.len() - 2)
    };
    // CAPPED. Pane ids in this table already run past 50 characters, and one stream named
    // `commons--kevinthelago-base-studio-code` would otherwise set the column width for all 45 rows
    // and push LIVE/BUSY/PID off an ordinary terminal. The column exists to carry the SIGNAL — held
    // vs cycle, and roughly what by; `--json` carries the full `waitingOn` for anything that needs it.
    let cell = format!("{tag}:{names}");
    if cell.len() <= WAITS_MAX {
        cell
    } else {
        format!("{}…", &cell[..WAITS_MAX - 1])
    }
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
    // The point of the gate: of the workers you COULD wake, say which ones would just sit there. A
    // director picking the next move needs the difference between "not running" and "not runnable".
    let held = rows.iter().filter(|r| !r.waiting_on.is_empty()).count();
    let stuck = rows.iter().filter(|r| r.deadlocked).count();
    if held > 0 {
        out.push_str(&format!(
            "\n  {held} stream(s) WAITING on an upstream that has not landed — waking one now gets a worker with nothing to build on",
        ));
    }
    if stuck > 0 {
        out.push_str(&format!(
            "\n  {stuck} of them sit in a `dependsOn` CYCLE and can never become ready — that is a PLAN fix (`bsc plan fleet`), not a wake",
        ));
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

        // --stream (`provision`'s own flag) needs a value, same as --db/--roster.
        let a = parse_args(vec!["provision".into(), "k".into(), "--stream".into(), "s1".into()]).unwrap();
        assert_eq!(a.stream.as_deref(), Some("s1"));
        assert!(parse_args(vec!["--stream".into()]).is_err());
    }

    /// `provision <projectKey> --stream <id>` composes the SAME `<projectKey>:<streamId>` pane id a
    /// hand-built `wake` call would use — the whole point of it being sugar rather than a second path.
    #[test]
    fn provision_composes_the_same_pane_id_wake_takes_directly() {
        let req = provision_wake_request("studio-code", "mobile-kit-mirror", "", false).unwrap();
        assert_eq!(req.pane_id, "studio-code:mobile-kit-mirror");
        assert_eq!(req.prompt, "");
        assert!(!req.force);
    }

    #[test]
    fn provision_carries_prompt_and_force_through_like_wake_does() {
        let req = provision_wake_request("k", "s1", "go", true).unwrap();
        assert_eq!(req.prompt, "go");
        assert!(req.force);
    }

    /// A `--stream` (or leading edge/trailing) space is trimmed the same way `cmd_start`/`cmd_wake`
    /// trim their positional — `bsc fleet provision "k " --stream " s1 "` must not mint a pane id with
    /// stray whitespace baked in.
    #[test]
    fn provision_trims_both_the_project_key_and_the_stream_id() {
        let req = provision_wake_request(" k ", " s1 ", "", false).unwrap();
        assert_eq!(req.pane_id, "k:s1");
    }

    #[test]
    fn provision_refuses_an_empty_project_key_or_stream_rather_than_minting_a_bogus_pane_id() {
        assert!(provision_wake_request("", "s1", "", false).is_err());
        assert!(provision_wake_request("  ", "s1", "", false).is_err());
        assert!(provision_wake_request("k", "", "", false).is_err());
        assert!(provision_wake_request("k", "   ", "", false).is_err());
    }

    /// `bsc fleet help` and `bsc fleet provision help` (`handle_help`) both walk `COMMANDS`, so a
    /// listed name with no matching `run()` arm — or the reverse — silently strands one of them.
    #[test]
    fn provision_is_registered_in_both_the_command_table_and_the_dispatcher() {
        assert!(COMMANDS.iter().any(|c| c.name == "provision"));
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

    // ── the WAITING ON column (#the-director-can-see-which-streams-are-held) ────────────────────

    fn row_waiting(pane: &str, waiting: &[&str], deadlocked: bool) -> Row {
        Row {
            member: membership::Member {
                pane_id: pane.into(),
                stream: pane.split(':').nth(1).unwrap_or("").into(),
                role: "worker".into(),
                ..Default::default()
            },
            state: membership::State::Stopped,
            live: false,
            busy: false,
            agent: false,
            pid: None,
            waiting_on: waiting.iter().map(|s| s.to_string()).collect(),
            deadlocked,
        }
    }

    #[test]
    fn a_flat_fleet_does_not_grow_a_column_of_dashes() {
        // A DEPS column on a fleet whose graph is flat widens every row to teach the reader nothing.
        let out = render_plan_table(&[row_waiting("k:a", &[], false)]);
        assert!(!out.contains("WAITING ON"), "no column when nothing is held: {out}");
    }

    #[test]
    fn a_held_stream_names_what_it_waits_on() {
        let out = render_plan_table(&[row_waiting("k:a", &[], false), row_waiting("k:b", &["a"], false)]);
        assert!(out.contains("WAITING ON"), "the column appears: {out}");
        assert!(out.contains("waits:a"), "and names the upstream: {out}");
        assert!(out.contains("WAITING on an upstream"), "the summary states the count: {out}");
    }

    #[test]
    fn a_cycle_is_called_out_as_a_cycle_not_as_an_ordinary_wait() {
        // The two look identical in a table and mean opposite things: one resolves when a worker
        // finishes, the other never resolves and needs the PLAN edited. A director that reads a
        // deadlock as a wait waits forever.
        let out = render_plan_table(&[row_waiting("k:a", &["b"], true), row_waiting("k:b", &["a"], true)]);
        assert!(out.contains("cycle:b"), "the row says cycle: {out}");
        assert!(out.contains("can never become ready"), "and the summary says what to do: {out}");
        assert!(out.contains("bsc plan fleet"), "naming the surface that fixes it: {out}");
    }

    #[test]
    fn a_long_wait_list_is_truncated_rather_than_widening_the_table() {
        let out = render_plan_table(&[row_waiting("k:a", &["one", "two", "three", "four"], false)]);
        assert!(out.contains("waits:one,two,+2"), "first two then a count: {out}");
    }

    #[test]
    fn one_long_upstream_name_cannot_set_the_width_for_every_row() {
        // Measured on the real fleet: pane ids already run past 50 chars, and a single
        // `commons--kevinthelago-base-studio-code` upstream pushed LIVE/BUSY/PID off the terminal for
        // all 45 rows. The cell carries the SIGNAL; `--json` carries the full list.
        let out = render_plan_table(&[row_waiting("k:a", &["commons--kevinthelago-base-studio-code"], false)]);
        for line in out.lines().filter(|l| l.contains("waits:")) {
            assert!(line.contains('…'), "the long cell is elided: {line}");
        }
        assert!(out.contains("waits:"), "and still says it is waiting: {out}");
    }

    // ── `clone` (#the-director-can-clone-its-projects-repos) ────────────────────────────────────

    /// A plan store with two LINKED repos, for the clone refusals. Separate from `seed_plan_db`
    /// because that one seeds streams and a ledger and links no repos — and the repo list is the
    /// entire input here.
    fn seed_repo_db(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bsc-fleet-clone-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("demo.db");
        let _ = std::fs::remove_file(&path);
        let store = plandb::Store::open(&path).unwrap();
        store.repo_add("o/one").unwrap();
        store.repo_add("o/two").unwrap();
        path
    }

    /// Serialize the tests that repoint $HOME. It is process-global, so two of them running at once
    /// would land one test's hub inside another's. (Under nextest each test is its own process and
    /// this is inert; under `cargo test --lib` it is what stops the race.)
    fn home_guard() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn clone_args(db: &std::path::Path, extra: &[&str]) -> Args {
        let mut raw = vec!["clone".to_string(), "--db".to_string(), db.to_string_lossy().into_owned()];
        raw.extend(extra.iter().map(|s| s.to_string()));
        parse_args(raw).unwrap()
    }

    #[test]
    fn the_project_key_is_read_off_the_plan_store_filename() {
        // plans live at `plans/<key>.db`, and the key is what names the hub the clone lands in.
        assert_eq!(project_key_from_db(std::path::Path::new("/p/plans/studio-code.db")).unwrap(), "studio-code");
        assert_eq!(project_key_from_db(std::path::Path::new("nm.db")).unwrap(), "nm");
    }

    #[test]
    fn cloning_a_repo_the_plan_does_not_link_is_refused_and_lists_what_it_does() {
        // Not pedantry: it would clone something the fleet has no stream for, into a hub that will
        // never use it — and the useful half of the refusal is being told what IS linked.
        let db = seed_repo_db("unlinked");
        let err = cmd_clone(&clone_args(&db, &["--repo", "o/three"]), "bsc fleet").unwrap_err();
        assert!(err.contains("o/three"), "names the repo asked for: {err}");
        assert!(err.contains("o/one") && err.contains("o/two"), "names what IS linked: {err}");
    }

    #[test]
    fn a_project_that_links_no_repos_says_so_rather_than_succeeding_emptily() {
        // "0 repos cloned" exiting 0 reads as done. It is not — it means the plan has no repos, and
        // the caller's next step is `bsc plan repo`, not another clone.
        let dir = std::env::temp_dir().join(format!("bsc-fleet-clone-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty.db");
        let _ = std::fs::remove_file(&path);
        plandb::Store::open(&path).unwrap();
        let err = cmd_clone(&clone_args(&path, &[]), "bsc fleet").unwrap_err();
        assert!(err.contains("links no repos"), "{err}");
        assert!(err.contains("bsc plan repo list"), "points at where repos come from: {err}");
    }

    // ── local materialization (#a-local-project-cannot-materialize-the-repo-its-fleet-needs) ─────

    #[test]
    fn the_door_clone_takes_follows_the_plan_unless_the_caller_has_named_one() {
        // The plan's own answer is the normal source of this.
        assert!(!materialize_locally(true, false, false), "a GitHub project is cloned");
        assert!(materialize_locally(false, false, false), "a project that ships nowhere is initialized");

        // `--local` overrides a classification that is missing or wrong...
        assert!(materialize_locally(true, true, false));

        // ...but `--source` beats BOTH, and that order is the one worth pinning. A local project
        // seeded from a checkout already on this machine is a CLONE — the caller has named the thing
        // to clone from, which is more specific than anything the plan or a bare flag can say.
        assert!(!materialize_locally(false, false, true), "--source on a local project is still a clone");
        assert!(!materialize_locally(false, true, true), "--source beats --local");
    }

    #[test]
    fn a_project_that_ships_nowhere_is_initialized_locally_and_only_once() {
        // THE WALL twitter-clone-test hit: `usesGithub: false`, so there is nothing to clone FROM and
        // never was — yet `ensure_worktree` sent its director here, and this command could only reach
        // github.com. Every worker in that fleet was unstartable for want of a `git init`.
        let _g = home_guard();
        let home = std::env::temp_dir().join(format!("bsc-fleet-local-{}-{}", std::process::id(), bsc_util::now_ms()));
        std::fs::create_dir_all(&home).unwrap();
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let prev = std::env::var_os(key);
        std::env::set_var(key, &home);

        let path = home.join("localproj.db");
        let store = plandb::Store::open(&path).unwrap();
        store.repo_add("api").unwrap(); // a BARE name — an owner names an account this project has not got
        store.classify_set(&serde_json::json!({ "usesGithub": false })).unwrap();

        cmd_clone(&clone_args(&path, &["--json"]), "bsc fleet").expect("materializes locally");
        let repo = bsc_project::repo_dir("localproj", "api").unwrap();
        assert!(repo.join(".git").exists(), "a real git repo at {}", repo.display());
        // The root commit, without which neither the integration branch nor any worker branch can be
        // cut — the whole reason this is more than `git init`.
        let head = std::process::Command::new("git").current_dir(&repo)
            .args(["rev-parse", "--verify", "HEAD"]).output().unwrap();
        assert!(head.status.success(), "HEAD resolves: {}", String::from_utf8_lossy(&head.stderr));

        // Idempotent: safe to run before every launch rather than working out which repos are missing.
        cmd_clone(&clone_args(&path, &["--json"]), "bsc fleet").expect("second call is a no-op");

        match prev { Some(v) => std::env::set_var(key, v), None => std::env::remove_var(key) }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_unclassified_project_is_still_cloned_rather_than_quietly_initialized() {
        // ABSENT means discovery has not run, not "local". Defaulting the other way would hand an
        // upstream-less repo to every project that simply has not been classified yet — the harder of
        // the two mistakes to notice, and the harder to undo once workers have committed into it.
        assert!(!materialize_locally(true, false, false));
        let db = seed_repo_db("unclassified");
        let store = plandb::Store::open(&db).unwrap();
        assert!(store.classify_get().unwrap().is_none(), "nothing classified this project");
    }

    #[test]
    fn a_plan_store_that_names_nothing_is_not_minted_into_existence() {
        // `Store::open` would happily create one, and a fresh empty store answers "no repos" — the
        // wrong answer for a typo'd --db, and it would litter the disk with empty plan stores.
        let missing = std::env::temp_dir().join(format!("bsc-fleet-no-such-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&missing);
        assert!(plan_db_path(Some(&missing.to_string_lossy())).is_none());
        assert!(!missing.exists(), "the probe must not create it");
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
            agent: busy,
            pid: if live { Some(42) } else { None },
            waiting_on: Vec::new(),
            deadlocked: false,
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

    /// Build a plans DIRECTORY the way the real one looks: several stores, only some with a director,
    /// plus the scratch/abandoned ones that accumulate in `plans/` and must be skipped silently.
    fn seed_plans_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("bsc-fleet-plans-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // alpha — a director both PLANNED and LAUNCHED, with issues.
        {
            let s = plandb::Store::open(&dir.join("alpha.db")).unwrap();
            s.fleet_set(&serde_json::json!({"director": {"enabled": true}, "streams": []})).unwrap();
            s.fleet_session_upsert(&plandb::FleetSession {
                pane_id: "alpha:director".into(),
                role: "director".into(),
                status: "running".into(),
                launched_at: 10,
                last_seen: 20,
                ..Default::default()
            })
            .unwrap();
            for (r, st) in [("a", "verified"), ("b", "open"), ("c", "blocked")] {
                s.upsert(&plandb::PlanIssue {
                    r#ref: r.into(),
                    title: r.into(),
                    status: st.into(),
                    ..Default::default()
                })
                .unwrap();
            }
        }
        // beta — a director PLANNED but never launched.
        {
            let s = plandb::Store::open(&dir.join("beta.db")).unwrap();
            s.fleet_set(&serde_json::json!({"director": {"enabled": true}, "streams": []})).unwrap();
        }
        // gamma — a real project with a fleet but NO director. Not part of this tier.
        {
            let s = plandb::Store::open(&dir.join("gamma.db")).unwrap();
            s.fleet_set(&serde_json::json!({"streams": [{"id": "api", "repo": "o/r"}]})).unwrap();
        }
        // scratch — an empty store, the kind `plans/` accumulates. Nothing planned, nothing launched.
        plandb::Store::open(&dir.join("scratch.db")).unwrap();
        // Not a store at all — the scan must not choke on it.
        std::fs::write(dir.join("notes.txt"), "not a db").unwrap();
        dir
    }

    /// The scan reports a project whose director is NOT running, skips projects that have no director
    /// at all, and does not choke on the junk that shares the directory.
    #[test]
    fn the_scan_finds_every_project_with_a_director_and_only_those() {
        let dir = seed_plans_dir("scan");
        let rows: Vec<_> = {
            std::env::set_var("BSC_PLANS_DIR", &dir);
            let r = scan_directors();
            std::env::remove_var("BSC_PLANS_DIR");
            r
        };
        let keys: Vec<&str> = rows.iter().map(|r| r.project_key.as_str()).collect();
        assert_eq!(keys, vec!["alpha", "beta"], "gamma has no director; scratch has nothing");

        let alpha = &rows[0];
        assert!(alpha.planned && alpha.launched);
        assert_eq!(alpha.pane_id, "alpha:director", "the id `brief` is typed against");
        assert_eq!(alpha.ledger_status, "running");
        // The ledger stamps its OWN launched_at/last_seen on upsert, so the values are whatever it
        // wrote — what matters is that the scan carries them through rather than zeroing them.
        assert!(alpha.launched_at > 0 && alpha.last_seen > 0, "the launch times survive the scan");
        // The PROJECT's tally, not a stream's — 1 of 3 done, 1 blocked.
        assert_eq!(alpha.progress.cell(), "1/3");
        assert_eq!(alpha.progress.blocked, 1);

        let beta = &rows[1];
        assert!(beta.planned && !beta.launched, "planned, never launched");
        assert_eq!(beta.progress.cell(), "-", "no issues at all");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE SIDE-EFFECT GUARANTEE. The architect's listing is READ-ONLY, and a scan that migrated
    /// every store would write to thirty plan.dbs it does not own — some open under a live fleet.
    #[test]
    fn the_scan_does_not_write_to_the_stores_it_reads() {
        let dir = seed_plans_dir("readonly");
        let before: Vec<(std::path::PathBuf, u64, std::time::SystemTime)> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| {
                let m = e.metadata().unwrap();
                (e.path(), m.len(), m.modified().unwrap())
            })
            .collect();
        assert!(!before.is_empty(), "the seed produced something to compare against");

        std::env::set_var("BSC_PLANS_DIR", &dir);
        let rows = scan_directors();
        std::env::remove_var("BSC_PLANS_DIR");
        assert_eq!(rows.len(), 2, "it did read them");

        for (path, len, mtime) in &before {
            let m = std::fs::metadata(path).unwrap();
            assert_eq!(m.len(), *len, "{} changed size", path.display());
            assert_eq!(m.modified().unwrap(), *mtime, "{} was rewritten", path.display());
        }
        // No new plan STORE was minted. Scoped to `.db` deliberately: a read-only query on a WAL
        // database creates its `-wal`/`-shm` coordination files (measured — see
        // `a_read_only_query_creates_the_wal_sidecars` in plandb), so asserting "no new file at all"
        // would be asserting something SQLite does not offer. What the architect's read must never do
        // is change or create a project's DATA, and that is what these two checks cover.
        let dbs = |d: &std::path::Path| -> std::collections::BTreeSet<std::path::PathBuf> {
            std::fs::read_dir(d)
                .unwrap()
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("db"))
                .collect()
        };
        let seen: std::collections::BTreeSet<std::path::PathBuf> =
            before.iter().map(|(p, _, _)| p.clone()).filter(|p| p.extension().and_then(|x| x.to_str()) == Some("db")).collect();
        assert_eq!(dbs(&dir), seen, "the scan minted a plan store");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A missing plans dir is an architect with no projects, not a crash.
    #[test]
    fn a_missing_plans_dir_scans_to_nothing() {
        let missing = std::env::temp_dir().join(format!("bsc-fleet-noplans-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        std::env::set_var("BSC_PLANS_DIR", &missing);
        let rows = scan_directors();
        std::env::remove_var("BSC_PLANS_DIR");
        assert!(rows.is_empty());
    }

    fn pane(id: &str, live: bool, busy: bool) -> PaneLive {
        // `agent` mirrors `busy` in these fixtures: they were written when the two were one signal,
        // and the cases here are about JOINING liveness onto membership, not about telling them apart.
        PaneLive { pane_id: id.into(), live, busy, agent: busy, working: busy, pid: if live { Some(7) } else { None } }
    }

    /// The table must show a stopped director as a ROW — that row is the point — and say plainly how
    /// many of them a brief can actually reach.
    #[test]
    fn the_directors_table_shows_the_unreachable_and_counts_what_a_brief_reaches() {
        let mut rows = vec![
            membership::DirectorMember {
                project_key: "alpha".into(),
                pane_id: "alpha:director".into(),
                planned: true,
                launched: true,
                progress: membership::Progress::tally(vec!["verified", "open"]),
                ..Default::default()
            },
            membership::DirectorMember {
                project_key: "beta".into(),
                pane_id: "beta:director".into(),
                planned: true,
                launched: true,
                ..Default::default()
            },
        ];
        // Only alpha is up.
        let res = FleetResult { panes: vec![pane("alpha:director", true, true)] };
        let live_of = |r: &membership::DirectorMember| {
            res.panes.iter().find(|p| p.pane_id == r.pane_id).map(|p| (p.live, p.busy))
        };
        membership::sort_directors(&mut rows, |r| r.state(live_of(r)));

        let out = render_directors(&rows, &res);
        assert!(out.contains("beta") && out.contains("stopped"), "the stopped one has a row:\n{out}");
        assert!(out.contains("alpha") && out.contains("running"), "{out}");
        assert!(out.contains("2 director(s) — 1 reachable"), "{out}");
        assert!(out.contains("quietly missing"), "the consequence is stated: {out}");
        assert!(out.contains("1/2"), "the project's progress is carried: {out}");
        // Unreachable first — those are the rows an architect must act on.
        let first = out.lines().nth(1).unwrap();
        assert!(first.starts_with("beta"), "the actionable row leads: {first:?}");
    }

    /// An all-running tier is told nothing extra, and an empty one says why it is empty rather than
    /// printing a bare header a reader would take for a failure.
    #[test]
    fn a_healthy_tier_gets_no_warning_and_an_empty_one_explains_itself() {
        let rows = vec![membership::DirectorMember {
            project_key: "alpha".into(),
            pane_id: "alpha:director".into(),
            planned: true,
            launched: true,
            ..Default::default()
        }];
        let res = FleetResult { panes: vec![pane("alpha:director", true, true)] };
        let out = render_directors(&rows, &res);
        assert!(out.contains("1 reachable") && !out.contains("quietly missing"), "{out}");

        let empty = render_directors(&[], &FleetResult::default());
        assert!(empty.contains("no project has a director"), "{empty}");
    }

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

#[cfg(test)]
mod clone_credential_tests {
    use super::*;

    /// The failure a maintainer actually met, twice read as a missing PERMISSION.
    ///
    /// Git does not say "unauthorized" when it has no credential — it tries to PROMPT and fails on
    /// the absent terminal. The message must name the cause (no credential) and both ways out.
    #[test]
    fn a_credential_prompt_failure_names_the_cause_and_the_ways_out() {
        let raw = "Cloning into '/hub/repo'...\nfatal: could not read Username for \
                   'https://github.com': No such device or address";
        let m = explain_clone_failure("bsc fleet", "acme/private", false, raw);
        assert!(m.contains("no GitHub credential"), "names the cause: {m}");
        assert!(m.contains("acme/private"), "names the repo: {m}");
        assert!(m.contains("Settings → GitHub"), "names where a token comes from: {m}");
        assert!(m.contains("$GH_TOKEN"), "says the token reaches a session automatically: {m}");
        assert!(m.contains("--source"), "names the no-network way out: {m}");
        assert!(m.contains(raw) || m.contains("could not read Username"), "keeps the original: {m}");
    }

    /// HAVING a token and being REFUSED is a different problem with a different fix, so it must not
    /// tell the reader to go connect an account they already connected.
    #[test]
    fn a_refusal_with_a_token_in_hand_reads_differently() {
        let m = explain_clone_failure("bsc fleet", "acme/private", true, "fatal: Authentication failed");
        assert!(m.contains("refused the credential"), "{m}");
        assert!(!m.contains("no GitHub credential"), "must not claim there is no token: {m}");
    }

    /// Anything that is NOT an auth prompt passes through untouched — a disk-full or bad-path clone
    /// failure must not be relabelled as a credential problem.
    #[test]
    fn a_non_auth_failure_is_not_dressed_up_as_one() {
        let m = explain_clone_failure("bsc fleet", "acme/pub", false, "fatal: destination path exists");
        assert_eq!(m, "bsc fleet clone: fatal: destination path exists");
    }

    /// A set-but-blank variable is how a shell says "no token"; passing it on would rebuild the
    /// anonymous URL this fallback exists to avoid.
    #[test]
    fn a_blank_env_token_counts_as_absent() {
        // Distinct names per case: nextest gives each test its own process, but these still must not
        // depend on each other's ordering within one.
        std::env::set_var("BSC_TEST_TOKEN_BLANK", "   ");
        assert_eq!(env_token("BSC_TEST_TOKEN_BLANK"), None);
        std::env::set_var("BSC_TEST_TOKEN_REAL", "  ghp_example  ");
        assert_eq!(env_token("BSC_TEST_TOKEN_REAL").as_deref(), Some("ghp_example"));
        assert_eq!(env_token("BSC_TEST_TOKEN_ABSENT_XYZ"), None);
    }
}
