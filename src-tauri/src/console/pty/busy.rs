//! Is a pane's shell actually running something? (#3998)
//!
//! `pty_create` reconnects to a live session and returns before it would ever consult `init_cmd`
//! (`mod.rs`), so the backend has historically had no notion of *what* is running inside a pane —
//! a bare `$` prompt keeps its `PtyState` key exactly as much as a working agent does. The frontend
//! filled that gap by guessing from `paneWasClaude` ("claude ran here at some point"), which is why
//! Resume did nothing on a pane whose agent had already exited: it looked busy, so nothing restarted
//! it, and Glance kept drawing it live.
//!
//! ## The predicate is "has a live descendant", not "is claude running"
//! Deliberately, and the question the caller actually has is the broader one. Resume's decision is
//! "may I type a command at this shell's prompt?" — and that is unsafe whenever the shell is running
//! ANYTHING, not only an agent. A pane mid-build or mid-`git` has no prompt to type at; injecting
//! there corrupts whatever is in flight. A claude-name match would call those shells idle.
//!
//! Name matching is also less portable than it looks. A survey of the live desktop found agent
//! processes appearing as `claude.exe`, and separately as `node.exe` (an npx-style install) — so the
//! name to match for is itself install-dependent, while "has a child" is not.
//!
//! So:
//!   • no descendants ⇒ the shell is at a prompt ⇒ it is safe to type a command into it;
//!   • any descendant ⇒ something is mid-flight ⇒ do not touch it.
//! The false direction is the safe one: an unrelated long-running command makes Resume decline
//! rather than corrupt a session.
//!
//! ## …except console plumbing
//! `conhost.exe` is the Windows console host, attached to a shell as a CHILD without representing any
//! work. The same survey found a shell whose only descendant was a `conhost.exe` — idle in every sense
//! that matters, but reported busy, so Resume would have silently declined to revive it. It is
//! filtered out by name (see [`IGNORED_DESCENDANTS`]); every real workload keeps its own process.
//!
//! ## Cost
//! On demand only — nothing here runs on the PTY streaming path. The alternative considered was a
//! side-tap on the emitter (like `pty_faults::observe`) parsing the OSC-100 `run`/`idle` markers the
//! `claude()` wrapper already emits; that is cheap per byte but pays on EVERY pane's output forever,
//! and has to carry a partial-marker tail buffer for chunks that split across a flush. A resume is a
//! human-scale event, so paying a few milliseconds at the press is the better trade. `pty_pane_runtime`
//! takes the whole pane list and refreshes ONCE for all of them, so a project-wide resume costs one
//! process walk rather than one per pane.

use std::collections::HashMap;
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System};

/// Depth cap for the parent walk. Guards against a PID-reuse cycle making the walk spin; real
/// descendant chains here are 1–3 deep (bash → agent → its workers).
const MAX_DEPTH: usize = 32;

/// Descendants that do not count as work — console plumbing a shell can carry while sitting idle at
/// its prompt. Compared case-insensitively against the process name. Kept deliberately tiny: every
/// entry here is a way for Resume to type into a shell that turns out to be busy, so a name only
/// belongs if it can NEVER represent a running workload.
const IGNORED_DESCENDANTS: &[&str] = &["conhost.exe"];

/// Name test, split out from [`is_ignored`] so it is unit-testable without a live process table.
fn ignored_name(name: &str) -> bool {
    IGNORED_DESCENDANTS.iter().any(|ign| name.eq_ignore_ascii_case(ign))
}

/// The sandbox's own wrapper processes, which sit BETWEEN the PTY's session process and the pane's
/// real shell. Compared case-insensitively against the process name.
///
/// These are NOT ignorable descendants in the [`IGNORED_DESCENDANTS`] sense — they are not plumbing
/// hanging off the shell, they are the shell's ANCESTORS, and a pane that has them has them for its
/// whole life. That is why they need their own treatment: `PtyState` records the pid it spawned,
/// which for a caged pane is the outermost wrapper, so "does the session process have a descendant"
/// is answered `true` by the cage itself, before any work exists. MEASURED on the live desktop, on a
/// pane sitting at an idle prompt with no agent in it:
///
/// ```text
/// 2384280 bwrap                  <- the session pid, what shells_with_descendants was asked about
///  \_ 2384283 bwrap
///      \_ 2384284 /bin/bash -i   <- the prompt the user was actually looking at
/// ```
///
/// Two descendants, no work. `planResume` read that as `already-running`, declined to type the
/// resume in, and `TerminalView` then marked the pane claude-active — so Resume did nothing and the
/// UI painted a live agent over a bare shell. The sibling predicate [`is_agent_process`] was already
/// fixed for this exact chain (see its doc, which names it); this is the same blindness in the busy
/// walk, which is the one Resume consults.
const SANDBOX_WRAPPERS: &[&str] = &["bwrap", "systemd-run"];

/// Name test for [`SANDBOX_WRAPPERS`], split out so the descent below is unit-testable.
fn is_wrapper_name(name: &str) -> bool {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim_end_matches(".exe");
    SANDBOX_WRAPPERS.iter().any(|w| base.eq_ignore_ascii_case(w))
}

/// Descend from a pane's session process past the cage's wrapper chain to the shell that actually
/// holds the prompt. Returns `root` unchanged for an uncaged pane, so the host path is untouched.
///
/// PURE over two lookups (name, children) so every shape is testable without a live process table.
///
/// Stops at the first non-wrapper, and refuses to descend through a wrapper with anything other than
/// exactly one child: the cage's chain is strictly linear, so a fork means this is not the chain we
/// think it is, and treating the wrapper as the shell keeps the answer CONSERVATIVE — it reports
/// busy, so Resume declines rather than typing into something mid-flight, which is the safe
/// direction the module doc names.
fn descend_past_wrappers(
    root: Pid,
    name_of: impl Fn(Pid) -> Option<String>,
    children_of: impl Fn(Pid) -> Vec<Pid>,
) -> Pid {
    let mut cur = root;
    for _ in 0..MAX_DEPTH {
        match name_of(cur) {
            Some(name) if is_wrapper_name(&name) => {}
            _ => return cur,
        }
        match children_of(cur).as_slice() {
            [only] => cur = *only,
            _ => return cur,
        }
    }
    cur
}

/// Is this process one of the ignored console-plumbing helpers?
fn is_ignored(procs: &HashMap<Pid, Process>, pid: Pid) -> bool {
    procs.get(&pid).is_some_and(|p| ignored_name(&p.name().to_string_lossy()))
}

/// Does `pid`'s ancestor chain reach `root`?
///
/// Walks parents rather than building a children index: the caller tests every process against a
/// handful of roots, and chains are shallow, so the walk is cheaper than materialising the tree.
fn is_descendant_of(start: Pid, root: Pid, procs: &HashMap<Pid, Process>) -> bool {
    let mut pid = start;
    for _ in 0..MAX_DEPTH {
        let Some(parent) = procs.get(&pid).and_then(|p| p.parent()) else { return false };
        if parent == root {
            return true;
        }
        pid = parent;
    }
    false
}

/// Which of `shell_pids` currently have at least one live descendant process.
///
/// Returns a parallel `Vec<bool>` so the caller can zip it back onto its own keys. Refreshes the
/// full process table once — the whole point of taking a batch.
/// Is this process an AGENT — the thing whose absence makes a pane idle to a director?
///
/// A DIFFERENT QUESTION from [`shells_with_descendants`], deliberately kept apart. That one asks "may
/// I type at this prompt", and its answer must stay broad: a shell mid-build has no prompt to type at
/// either. This one asks "is the work actually being done", which is what `bsc fleet list` reports and
/// what it was getting wrong — its help claimed "the agent is that child", and on a sandboxed pane the
/// child is `bwrap`, then another `bwrap`, then a bare `/bin/bash -i`.
///
/// Matched on the NAME and on argv, because a real install is one of several shapes. Observed on this
/// machine and on the survey `IGNORED_DESCENDANTS` came from:
///
///   claude --model sonnet --continue        a direct binary        → name
///   node …/@anthropic-ai/claude-code/cli.js an npx-style install   → argv
///   bsc-agent …                             the model-agnostic run → name
///
/// The argv arm is what makes the wrapper case work, and it is why this is not simply a name test: a
/// node-hosted agent presents as `node`, which no name list can distinguish from any other node.
///
/// PURE, over `(name, argv)`, so every shape above is unit-testable without a live process table.
pub(crate) fn is_agent_process(name: &str, argv: &[String]) -> bool {
    let base = |s: &str| {
        s.rsplit(['/', '\\']).next().unwrap_or(s).trim_end_matches(".exe").to_ascii_lowercase()
    };
    const AGENTS: &[&str] = &["claude", "bsc-agent"];
    if AGENTS.contains(&base(name).as_str()) {
        return true;
    }
    // Scan what the process RUNS, never what it merely mentions.
    //
    // A `bsc-sandbox` cage is the case that forced this distinction. `bwrap` CONFIGURES with paths and
    // RUNS what follows `--`, and its configuration names the agent binary as both bind-mount source
    // and target — `--ro-bind-try /usr/bin/claude /usr/bin/claude`, plus the versioned install bound
    // over the same path. MEASURED: `claude` appears NINE times in one caged pane's own argv while its
    // real tree was `bwrap → bwrap → bash` with no agent at all. Scanning the whole argv therefore made
    // every caged pane report an agent PERMANENTLY, since that argv never changes — so `bsc fleet list`
    // showed `running` for panes sitting at a bare prompt and the director never had anything to wake.
    //
    // Splitting at `--` keeps the case that matters in the other direction: a pane launched straight
    // into a caged agent (`bwrap … -- claude --model sonnet`) has `bwrap` as its session process, and
    // reporting THAT idle while it works would be the same failure inverted.
    //
    // Split at the LAST `--`, not the first, because wrappers NEST. `SANDBOX_WRAPPERS` carries
    // `systemd-run` as well as `bwrap`, and a systemd scope above a cage puts the entire bwrap command
    // line — bind mounts and all — after its own separator. Taking the last one lands on the command
    // in both shapes, and on `bwrap … -- timeout 600 -- claude` it still lands on the agent.
    let words: &[String] = if is_wrapper_name(name) {
        match argv.iter().rposition(|a| a == "--") {
            Some(i) => &argv[i + 1..],
            // A wrapper with no command to run is plumbing and nothing else.
            None => &[],
        }
    } else {
        // A wrapper: the agent is named in the ARGUMENTS rather than in the process name. argv[0] is
        // skipped because it is the interpreter, which is exactly what we already failed to recognise.
        argv.get(1..).unwrap_or(&[])
    };
    // `cli.js` alone is far too generic to match on, so it counts only under a claude-ish path.
    words.iter().any(|a| {
        let b = base(a);
        AGENTS.contains(&b.as_str()) || (b == "cli.js" && a.to_ascii_lowercase().contains("claude"))
    })
}

/// Which shells have an AGENT among their descendants — the fleet table's `running` vs `idle`.
///
/// Same walk as [`shells_with_descendants`] and the same cost, on the same refreshed snapshot when the
/// caller asks for both. The ROOT is included in the test, unlike the busy walk: a pane launched
/// straight into the agent (no wrapping shell) has the agent AS its session process, and excluding the
/// root would report that pane idle while it works.
pub(crate) fn shells_with_agents(shell_pids: &[Option<u32>]) -> Vec<bool> {
    if shell_pids.iter().all(|p| p.is_none()) {
        return vec![false; shell_pids.len()];
    }
    let mut sys = System::new();
    // `cmd()` is needed here (the wrapper arm reads argv), so this refresh asks for more than the busy
    // walk's `nothing()` — still no memory or CPU sampling.
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always));
    let procs = sys.processes();

    shell_pids
        .iter()
        .map(|maybe| {
            let Some(pid) = maybe else { return false };
            let root = Pid::from(*pid as usize);
            procs.iter().any(|(&p, proc_)| {
                if p != root && !is_descendant_of(p, root, procs) {
                    return false;
                }
                let argv: Vec<String> =
                    proc_.cmd().iter().map(|s| s.to_string_lossy().into_owned()).collect();
                is_agent_process(&proc_.name().to_string_lossy(), &argv)
            })
        })
        .collect()
}

/// Which shells have an agent that is DOING something — `bsc session list`'s `BUSY` column.
///
/// # Why neither existing predicate answers this
///
/// [`shells_with_descendants`] asks "may I type a command at this shell's prompt?", and for an agent
/// session the answer is permanently no: the agent process is itself a descendant, so that predicate
/// cannot read false while the session is up. Reporting it as `BUSY` made the column a restatement of
/// `live` — measured on an idle designer, whose whole tree was `bash → claude` sitting at its prompt.
///
/// [`shells_with_agents`] looks like the fix and is not. It reports whether an agent is *present*,
/// which is equally true of an idle one; it separates "agent session" from "shell mid-build", not
/// "working" from "idle".
///
/// The OSC-100 `run`/`idle` markers do not answer it either — they are emitted from `PROMPT_COMMAND`,
/// so they describe the SHELL, which reads `run` for the entire time the agent is foregrounded.
///
/// # The predicate: the agent has a child of its own
///
/// An agent parked at its prompt has spawned nothing; one running a tool call has. That is observable
/// from the process table with no cooperation from the agent, and it is what this walks.
///
/// # The limit, stated rather than implied
///
/// An agent THINKING — waiting on a model response with no subprocess — has no children either, so it
/// reads as idle. This predicate answers "is it running something", not "is it occupied". That is the
/// honest bound of what the process table can see, and the direction that matters is safe here: this
/// value reports state, it does not gate typing (that stays [`shells_with_descendants`], unchanged).
pub(crate) fn agents_doing_work(shell_pids: &[Option<u32>]) -> Vec<bool> {
    if shell_pids.iter().all(|p| p.is_none()) {
        return vec![false; shell_pids.len()];
    }
    let mut sys = System::new();
    // `cmd()` is required: recognising an agent reads argv (a node-hosted agent presents as `node`).
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(sysinfo::UpdateKind::Always),
    );
    let procs = sys.processes();

    shell_pids
        .iter()
        .map(|maybe| {
            let Some(pid) = maybe else { return false };
            let root = Pid::from(*pid as usize);
            // The agents under this shell. The ROOT is included, matching `shells_with_agents`: a pane
            // launched straight into the agent has it AS the session process.
            let agents: Vec<Pid> = procs
                .iter()
                .filter(|(&p, _)| p == root || is_descendant_of(p, root, procs))
                .filter(|(_, proc_)| {
                    let argv: Vec<String> =
                        proc_.cmd().iter().map(|s| s.to_string_lossy().into_owned()).collect();
                    is_agent_process(&proc_.name().to_string_lossy(), &argv)
                })
                .map(|(&p, _)| p)
                .collect();
            // Working ⇔ some agent has a descendant that is real work (console plumbing does not count,
            // for the same reason it does not in the busy walk).
            agents.iter().any(|&agent| {
                procs
                    .iter()
                    .any(|(&p, _)| p != agent && is_descendant_of(p, agent, procs) && !is_ignored(procs, p))
            })
        })
        .collect()
}

pub(crate) fn shells_with_descendants(shell_pids: &[Option<u32>]) -> Vec<bool> {
    // Nothing to ask about — skip the (comparatively expensive) process walk entirely.
    if shell_pids.iter().all(|p| p.is_none()) {
        return vec![false; shell_pids.len()];
    }
    let mut sys = System::new();
    // ProcessesToUpdate::All: we must see processes we do NOT already track, since a descendant is by
    // definition one we never registered. `nothing()` keeps this to the pid/parent fields we read —
    // no memory or CPU sampling, which is what makes a full walk affordable here.
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let procs = sys.processes();

    shell_pids
        .iter()
        .map(|maybe| {
            let Some(pid) = maybe else { return false };
            // The pane's REAL shell, which for a caged pane is NOT the pid we spawned — see
            // `SANDBOX_WRAPPERS`. Uncaged, this is the session pid unchanged.
            let root = descend_past_wrappers(
                Pid::from(*pid as usize),
                |p| procs.get(&p).map(|q| q.name().to_string_lossy().into_owned()),
                |p| procs.iter().filter(|(_, q)| q.parent() == Some(p)).map(|(&k, _)| k).collect(),
            );
            procs
                .keys()
                .any(|&p| p != root && !is_ignored(procs, p) && is_descendant_of(p, root, procs))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── the AGENT predicate (#fleet-list-reports-whether-the-agent-is-running) ──────────────────
    //
    // Every shape below was READ OFF THIS MACHINE while the bug was live, not invented: the director
    // pane ran `claude --model sonnet --continue`, and the worker pane that reported `running` was
    // `bwrap → bwrap → /bin/bash -i` with no agent anywhere in it.

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_direct_agent_is_recognised_by_name() {
        assert!(is_agent_process("claude", &argv(["claude", "--model", "sonnet", "--continue"].as_ref())));
        assert!(is_agent_process("claude.exe", &argv(["claude.exe"].as_ref())));
        assert!(is_agent_process("bsc-agent", &argv(["bsc-agent", "--provider", "openai"].as_ref())));
    }

    #[test]
    fn a_wrapper_hosting_the_agent_is_recognised_by_its_arguments() {
        // The npx-style install the `IGNORED_DESCENDANTS` survey found: the process is `node`, which
        // no name list can tell from any other node — the agent is named in argv.
        assert!(is_agent_process(
            "node",
            &argv(["node", "/home/u/.npm/_npx/@anthropic-ai/claude-code/cli.js", "--continue"].as_ref()),
        ));
        assert!(is_agent_process("node", &argv(["node", "/opt/bin/claude"].as_ref())));
    }

    #[test]
    fn the_shells_and_the_sandbox_plumbing_are_not_agents() {
        // THE REPORTED BUG, as a unit test. A sandboxed pane is `bwrap → bwrap → bash -i`; every one
        // of those is a descendant, so `shells_with_descendants` says busy and the table said running.
        assert!(!is_agent_process("bwrap", &argv(["/usr/bin/bwrap", "--unshare-all", "--share-net"].as_ref())));
        assert!(!is_agent_process("bash", &argv(["/bin/bash", "-i"].as_ref())));
        assert!(!is_agent_process("bash", &argv(["/bin/bash"].as_ref())));
    }

    /// The cage's own CONFIGURATION names the agent binary, and that must not read as a running agent.
    ///
    /// THE ABBREVIATION IS WHY THIS SURVIVED. The test above says the sandbox plumbing is not an
    /// agent, and it passes — but it asserts on THREE arguments. A real cage carries ~200, and the
    /// ones that were trimmed for readability are exactly the ones that break it: `bsc-sandbox` binds
    /// the agent binary into the namespace, so `/usr/bin/claude` appears in the argv as both source
    /// and target, plus once more for the versioned install bound over the same path.
    ///
    /// MEASURED on the live network-monitor fleet: pane `domain-model-and-adapter-traits` (pid 598682)
    /// was `bwrap → bwrap → bash` with no agent, its argv mentioned `claude` NINE times, and the table
    /// reported `running / AGENT yes`. Because the argv of a running cage never changes, that pane
    /// could never become `idle` — `bsc fleet list` returned `idle: []` for a fleet that was entirely
    /// parked, and the director had nothing to wake.
    ///
    /// So this test keeps the bind-mount arguments verbatim. Shortening them is what hid the bug.
    #[test]
    fn a_cages_bind_mounts_do_not_make_it_an_agent() {
        let caged_shell = argv([
            "/usr/bin/bwrap", "--unshare-all", "--share-net", "--die-with-parent", "--clearenv",
            "--ro-bind", "/usr/lib", "/usr/lib",
            "--ro-bind-try", "/usr/bin/bash", "/usr/bin/bash",
            // The three that matter — the agent bound in by path, twice as a pair and once versioned.
            "--ro-bind-try", "/usr/bin/claude", "/usr/bin/claude",
            "--ro-bind", "/home/u/.local/share/claude/versions/2.1.247", "/usr/bin/claude",
            "--ro-bind", "/home/u/.base-studio-code/bin/bsc-hook", "/bsc-hook",
            "--bind", "/home/u/.base-studio-code/worktrees/p/r--stream", "/repo",
            "--chdir", "/repo", "--setenv", "HOME", "/home/agent",
            // ...and the command it ACTUALLY runs: a bare interactive shell.
            "--", "/bin/bash", "-i",
        ].as_ref());
        assert!(
            !is_agent_process("bwrap", &caged_shell),
            "a cage running a bare shell has no agent, however many times its bind mounts say 'claude'",
        );

        // The other direction, which the fix must not break: a pane launched STRAIGHT into a caged
        // agent has `bwrap` as its session process, and calling that idle while it works would be the
        // same mistake inverted.
        let caged_agent = argv([
            "/usr/bin/bwrap", "--unshare-all",
            "--ro-bind-try", "/usr/bin/claude", "/usr/bin/claude",
            "--", "claude", "--model", "sonnet", "--continue",
        ].as_ref());
        assert!(is_agent_process("bwrap", &caged_agent), "a cage RUNNING the agent is working");

        // A caged agent reached through the node wrapper still counts, for the same reason.
        let caged_wrapper = argv([
            "/usr/bin/bwrap", "--ro-bind-try", "/usr/bin/claude", "/usr/bin/claude",
            "--", "node", "/home/agent/.npm/@anthropic-ai/claude-code/cli.js", "--continue",
        ].as_ref());
        assert!(is_agent_process("bwrap", &caged_wrapper));

        // A cage that wraps nothing is plumbing, even with the binds present.
        let no_command = argv([
            "/usr/bin/bwrap", "--ro-bind-try", "/usr/bin/claude", "/usr/bin/claude",
        ].as_ref());
        assert!(!is_agent_process("bwrap", &no_command));

        // NESTED wrappers, which is why the split takes the LAST `--` rather than the first.
        // `SANDBOX_WRAPPERS` carries `systemd-run` too, and a scope above a cage puts the whole
        // bwrap command line — bind mounts included — after its own separator. Splitting at the
        // first would hand back exactly the configuration this fix exists to stop reading.
        let scoped_shell = argv([
            "systemd-run", "--scope", "--user", "--",
            "/usr/bin/bwrap", "--ro-bind-try", "/usr/bin/claude", "/usr/bin/claude",
            "--", "/bin/bash", "-i",
        ].as_ref());
        assert!(!is_agent_process("systemd-run", &scoped_shell), "a scoped cage at a prompt is idle");

        let scoped_agent = argv([
            "systemd-run", "--scope", "--user", "--",
            "/usr/bin/bwrap", "--ro-bind-try", "/usr/bin/claude", "/usr/bin/claude",
            "--", "claude", "--continue",
        ].as_ref());
        assert!(is_agent_process("systemd-run", &scoped_agent), "a scoped cage running the agent works");

        // And a command that carries its own `--` still resolves to the agent beyond it.
        let via_timeout = argv([
            "/usr/bin/bwrap", "--ro-bind-try", "/usr/bin/claude", "/usr/bin/claude",
            "--", "timeout", "600", "--", "claude",
        ].as_ref());
        assert!(is_agent_process("bwrap", &via_timeout));
    }

    #[test]
    fn a_non_cage_still_scans_its_whole_argv() {
        // The `--` split is scoped to the sandbox wrapper on purpose. Everything else keeps the old
        // rule, so an ordinary wrapper that names the agent anywhere in its arguments still counts.
        //
        // (Not asserted here: `npx --yes @anthropic-ai/claude-code`. Its basename is `claude-code`,
        // which has never been in AGENTS, so it did not match before this change either. Widening the
        // predicate to catch it would be a separate decision, not a side effect of this fix.)
        assert!(is_agent_process("sh", &argv(["sh", "-c", "exec", "bsc-agent"].as_ref())));
        // ...and a bare `--` in a non-cage argv is just an argument, not a command boundary.
        assert!(is_agent_process("timeout", &argv(["timeout", "600", "--", "claude"].as_ref())));
    }

    #[test]
    fn an_ordinary_workload_is_busy_but_is_not_an_agent() {
        // The other half of why these are two probes: a shell mid-build must stay BUSY (Resume must
        // not type into it) while reading as no-agent (a director should see `idle` and wake it).
        assert!(!is_agent_process("cargo", &argv(["cargo", "build", "--release"].as_ref())));
        assert!(!is_agent_process("git", &argv(["git", "push"].as_ref())));
        assert!(!is_agent_process("node", &argv(["node", "scripts/emit-records.mjs"].as_ref())));
    }

    /// THE REGRESSION (#session-list-reports-every-agent-session-as-busy): an agent sitting at its own
    /// prompt must read as NOT working, and the same agent running a tool call must read as working.
    ///
    /// Driven against the real process table, because that is the only thing that can be wrong here —
    /// the pure half (`is_agent_process`) was already right, and the bug was choosing the wrong walk.
    /// A copy of `bash` NAMED `claude` is a genuine agent to every probe in this module: the name test
    /// is exactly what identifies one, so the fake is faithful where it matters.
    #[cfg(unix)]
    #[test]
    fn an_agent_at_its_prompt_is_not_working_and_one_running_a_tool_is() {
        // The dir name feeds a `bash -c` string, so it must contain NOTHING the shell parses. The
        // obvious `{:?}` of a ThreadId renders `ThreadId(2)` — and those parentheses are a bash syntax
        // error, so the agent never spawns, the tree is empty, and the idle assertion passes for
        // entirely the wrong reason. Digits only.
        let tid: String =
            format!("{:?}", std::thread::current().id()).chars().filter(char::is_ascii_digit).collect();
        let dir = std::env::temp_dir().join(format!("bsc-working-{}-{tid}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("claude");
        std::fs::copy("/bin/bash", &fake).expect("a shell to masquerade as the agent");

        // Both panes are the PRODUCTION shape — a shell with the agent as its child — because that is
        // the shape the broad predicate gets wrong. IDLE runs `read`, a bash builtin, so the agent
        // blocks with no child: a session waiting at its TUI prompt. WORKING has a tool call in flight.
        let spawn = |inner: &str| {
            // Its OWN process group, so cleanup can take the whole tree. Killing the outer shell alone
            // orphans the agent and its `sleep`, which outlive the test — nextest reports that as a LEAK,
            // and a test that leaves strays behind on every run is not finished.
            use std::os::unix::process::CommandExt;
            std::process::Command::new("/bin/bash")
                .arg("-c")
                // The trailing `; true` on BOTH levels defeats bash's exec optimization: `bash -c 'sleep 30'`
                // REPLACES itself with `sleep`, collapsing shell → agent → tool into a bare `sleep` with no
                // agent anywhere in it. With a second statement present each level stays a real process.
                .arg(format!("{} -c '{inner}; true'; true", fake.display()))
                .stdin(std::process::Stdio::piped())
                .process_group(0)
                .spawn()
                .expect("spawn the pane shell")
        };
        let mut idle = spawn("read x");
        let mut working = spawn("sleep 30");

        // Let the grandchild actually appear in the process table before walking it.
        std::thread::sleep(std::time::Duration::from_millis(500));

        let pids = [Some(idle.id()), Some(working.id()), None];
        let got = agents_doing_work(&pids);
        // Measured on the SAME snapshot moment, so the contrast below is not a timing artifact.
        let broad = shells_with_descendants(&pids);

        // Negative pid = the whole process group, which `process_group(0)` made equal to each shell's
        // own pid. This is what actually reaps the agent and its tool call.
        for child in [&idle, &working] {
            let _ = std::process::Command::new("kill")
                .arg("-9")
                .arg(format!("-{}", child.id()))
                .status();
        }
        let _ = idle.wait();
        let _ = working.wait();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(!got[0], "an agent parked at its prompt has no child and is NOT working");
        assert!(got[1], "an agent running a tool call has a child and IS working");
        assert!(!got[2], "a pane with no shell pid is never working");

        // THE BUG, as an assertion: the broad predicate calls BOTH busy, because the agent is itself a
        // descendant of the shell. That is correct for its own question ("may I type here") and useless
        // as a state indicator — which is why `bsc session list` needed the narrower walk rather than a
        // change to this one. Both must keep answering their own question.
        assert!(broad[0], "the idle pane is still `busy` — Resume must not type into it");
        assert!(broad[1], "and so is the working one; the broad walk cannot tell them apart");
    }

    #[test]
    fn a_generic_cli_js_does_not_pass_on_its_name_alone() {
        // `cli.js` is far too common to match by itself — it counts only under a claude-ish path.
        assert!(!is_agent_process("node", &argv(["node", "/home/u/some-tool/cli.js"].as_ref())));
    }

    #[test]
    fn the_interpreter_in_argv0_never_makes_a_process_an_agent() {
        // argv[0] is skipped on purpose: matching it would make `/usr/bin/claude-something` or a shell
        // invoked FROM a claude path read as the agent itself.
        assert!(!is_agent_process("sh", &argv(["/home/u/claude/bin/sh", "-c", "echo hi"].as_ref())));
    }


    /// Both directions, against the SAME spawned process, in one test.
    ///
    /// Deliberately not two tests: cargo runs them as threads of ONE process, so a "this process has
    /// no children" assertion would see the other test's child and fail — which is exactly how the
    /// first version of this test failed. Asserting against a freshly spawned LEAF is immune to that,
    /// and it pins the pair of behaviours Resume depends on:
    ///   • a live child registers on its parent  ⇒ Resume declines a pane whose agent is mid-turn;
    ///   • the leaf itself reports no descendants ⇒ Resume acts on a pane sitting at its prompt.
    #[test]
    fn a_live_child_registers_on_its_parent_but_not_on_itself() {
        // Spawned WITHOUT a shell wrapper: `cmd /C ping …` would make cmd the child and ping its
        // grandchild, so the "leaf" end of this test would have a descendant of its own.
        let mut child = if cfg!(windows) {
            std::process::Command::new("ping").args(["-n", "6", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn()
        } else {
            std::process::Command::new("sleep").arg("5").spawn()
        }
        .expect("spawn probe child");

        let own = std::process::id();
        let found = shells_with_descendants(&[Some(own), Some(child.id())]);
        let _ = child.kill();
        let _ = child.wait();

        assert!(found[0], "a spawned child must register as a descendant of this process");
        assert!(!found[1], "a leaf process must report no descendants");
    }

    /// `ProcessRefreshKind::nothing()` is what keeps the full process walk affordable — but if it
    /// also skipped the NAME, `is_ignored` would be comparing against empty strings and would
    /// silently stop filtering anything, with no visible failure.
    #[test]
    fn the_cheap_refresh_still_populates_process_names() {
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let own = Pid::from(std::process::id() as usize);
        let name = sys.processes().get(&own).map(|p| p.name().to_string_lossy().into_owned());
        assert!(name.is_some_and(|n| !n.is_empty()), "names must survive the cheap refresh");
    }

    /// Console plumbing is filtered; anything that could be real work is not. The survey that
    /// motivated this found a live shell whose ONLY descendant was a conhost.
    #[test]
    fn only_console_plumbing_is_ignored() {
        assert!(ignored_name("conhost.exe"));
        assert!(ignored_name("ConHost.exe"), "matched case-insensitively");
        for real in ["claude.exe", "node.exe", "bash.exe", "git.exe", "cargo.exe", ""] {
            assert!(!ignored_name(real), "{real} must count as work");
        }
    }

    /// A pane with no recorded shell pid must not be reported busy — otherwise Resume would decline
    /// for exactly the panes that most need it.
    #[test]
    fn a_missing_pid_is_not_busy() {
        assert_eq!(shells_with_descendants(&[None, None]), vec![false, false]);
    }

    /// Batching is positional — the caller zips the answer back onto its own pane keys, so a shifted
    /// or short result would silently mis-attribute busyness between panes.
    #[test]
    fn results_are_positional() {
        let own = std::process::id();
        let out = shells_with_descendants(&[None, Some(own), None]);
        assert_eq!(out.len(), 3);
        assert!(!out[0] && !out[2]);
    }

    // ── the CAGE descent (#a-session-with-history-always-resumes) ───────────────────────────────
    //
    // The fixture is the real tree, read off the live desktop while the pane the maintainer was
    // looking at sat at a bare `bash-5.2$`:
    //
    //     2384280 bwrap  ->  2384283 bwrap  ->  2384284 /bin/bash -i
    //
    // `PtyState` recorded 2384280, so the busy walk asked about the OUTERMOST wrapper and found two
    // descendants — the cage itself. Resume declined on a pane that had nothing running in it.

    /// A tiny (pid, parent, name) table, so the descent is exercised without a live process table.
    fn tree(rows: &[(usize, Option<usize>, &str)]) -> Vec<(Pid, Option<Pid>, String)> {
        rows.iter()
            .map(|(pid, parent, name)| {
                (Pid::from(*pid), parent.map(Pid::from), (*name).to_string())
            })
            .collect()
    }

    /// Run the pure descent over a fixture table.
    fn descend(root: usize, rows: &[(Pid, Option<Pid>, String)]) -> usize {
        let got = descend_past_wrappers(
            Pid::from(root),
            |p| rows.iter().find(|(pid, _, _)| *pid == p).map(|(_, _, n)| n.clone()),
            |p| rows.iter().filter(|(_, parent, _)| *parent == Some(p)).map(|(pid, _, _)| *pid).collect(),
        );
        usize::from(got)
    }

    #[test]
    fn the_descent_walks_the_cage_chain_to_the_real_shell() {
        let t = tree(&[
            (2384280, None, "bwrap"),
            (2384283, Some(2384280), "bwrap"),
            (2384284, Some(2384283), "bash"),
        ]);
        assert_eq!(descend(2384280, &t), 2384284, "the prompt is below two bwraps, not at the session pid");
    }

    /// The systemd scope arm (`sandbox: cgroup caps via the USER systemd scope`) puts one more
    /// wrapper on top, so the chain length is not something the descent may assume.
    #[test]
    fn the_descent_handles_a_systemd_scope_above_the_cage() {
        let t = tree(&[
            (100, None, "systemd-run"),
            (101, Some(100), "bwrap"),
            (102, Some(101), "bwrap"),
            (103, Some(102), "bash"),
        ]);
        assert_eq!(descend(100, &t), 103);
    }

    /// An UNCAGED pane must take the exact path it always did — the host session process IS its shell.
    #[test]
    fn the_descent_is_a_no_op_for_an_uncaged_pane() {
        let t = tree(&[(200, None, "bash"), (201, Some(200), "claude")]);
        assert_eq!(descend(200, &t), 200, "a host shell is never descended past");
    }

    /// A wrapper that has FORKED is not the linear chain this understands, so the descent stops and
    /// the walk reports busy — Resume declines rather than typing into something mid-flight.
    #[test]
    fn the_descent_refuses_to_guess_through_a_forked_wrapper() {
        let t = tree(&[
            (300, None, "bwrap"),
            (301, Some(300), "bash"),
            (302, Some(300), "bash"),
        ]);
        assert_eq!(descend(300, &t), 300, "ambiguous chain stays conservative");
    }

    /// A wrapper whose child is gone (the cage tearing down) must not walk off the end.
    #[test]
    fn the_descent_stops_at_a_childless_wrapper() {
        let t = tree(&[(400, None, "bwrap")]);
        assert_eq!(descend(400, &t), 400);
    }

    /// The wrapper names are matched the same way the agent names are — basename, case-insensitive,
    /// `.exe` trimmed — so a path-qualified `/usr/bin/bwrap` is recognised.
    #[test]
    fn wrapper_names_are_matched_by_basename() {
        assert!(is_wrapper_name("bwrap"));
        assert!(is_wrapper_name("/usr/bin/bwrap"));
        assert!(is_wrapper_name("BWRAP"));
        assert!(is_wrapper_name("systemd-run"));
        for shell in ["bash", "claude", "node", "sh", "zsh", ""] {
            assert!(!is_wrapper_name(shell), "{shell} is not a cage wrapper");
        }
    }

    /// THE REGRESSION, end to end over the pure descent: a caged pane at a prompt has no descendant
    /// BELOW its real shell, which is what makes `planResume` return `started` for it. Asking about
    /// the session pid instead finds the cage and calls it busy — the bug.
    #[test]
    fn a_caged_pane_at_a_prompt_is_idle_below_its_real_shell() {
        let t = tree(&[
            (2384280, None, "bwrap"),
            (2384283, Some(2384280), "bwrap"),
            (2384284, Some(2384283), "bash"),
        ]);
        let shell = Pid::from(descend(2384280, &t));
        let has_work = t.iter().any(|(pid, parent, _)| *pid != shell && *parent == Some(shell));
        assert!(!has_work, "no agent under the shell => the pane is resumable");

        // …and the same tree WITH an agent still reads busy, so the fix cannot make Resume type into
        // a working session.
        let mut busy_tree = t.clone();
        busy_tree.push((Pid::from(2384999), Some(Pid::from(2384284)), "claude".to_string()));
        let shell = Pid::from(descend(2384280, &busy_tree));
        let has_work = busy_tree.iter().any(|(pid, parent, _)| *pid != shell && *parent == Some(shell));
        assert!(has_work, "an agent under the shell => leave it alone");
    }
}
