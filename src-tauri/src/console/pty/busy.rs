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
    // A wrapper: the agent is named in the ARGUMENTS rather than in the process name. `cli.js` alone
    // is far too generic to match on, so it counts only under a claude-ish path — and argv[0] is
    // skipped because it is the interpreter, which is exactly what we already failed to recognise.
    argv.iter().skip(1).any(|a| {
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
            let root = Pid::from(*pid as usize);
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

    #[test]
    fn an_ordinary_workload_is_busy_but_is_not_an_agent() {
        // The other half of why these are two probes: a shell mid-build must stay BUSY (Resume must
        // not type into it) while reading as no-agent (a director should see `idle` and wake it).
        assert!(!is_agent_process("cargo", &argv(["cargo", "build", "--release"].as_ref())));
        assert!(!is_agent_process("git", &argv(["git", "push"].as_ref())));
        assert!(!is_agent_process("node", &argv(["node", "scripts/emit-records.mjs"].as_ref())));
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
}
