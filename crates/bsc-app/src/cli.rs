//! `bsc app` — dispatch for the app's own lifecycle.

use crate::promote::{
    classify_gate_failure, gate_tree_moved, plan_promote, tree_moved_message, Action, GateLeg,
    GateVerdict, PromoteState,
};
use crate::{hooks, rebuild, release, repo, status};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const TAGLINE: &str = "the APP's own lifecycle: is it current, may develop be promoted into it, rebuild it, release it";

/// The branch the repo root is expected to hold — the app's tree. Named once so the guard, the
/// refusal text and the distance report cannot disagree about which ref they mean.
pub const APP_BRANCH: &str = "main";

/// The dedicated, detached worktree the gate runs in.
///
/// DOT-PREFIXED, and not `wt-promote-gate`, because `wt-*` is this repo's convention for a WORK tree
/// and a detached one with no branch reads as free. MEASURED on the first real run: another session
/// claimed it mid-gate and checked develop's newer tip out from under the gate, which the moved-check
/// then correctly refused — the guard worked, the address was wrong. A dotted name is not the shape
/// anybody's "find a spare worktree" habit reaches for, and `bsc worktree cap` only caps `wt-*`.
pub const GATE_TREE: &str = ".promote-gate";

pub fn command_docs() -> &'static [bsc_cli_util::CmdDoc] {
    &[
        bsc_cli_util::CmdDoc {
            name: "status",
            summary: "is the built app behind main? (answers, never acts)",
            usage: "\
USAGE:
  bsc app status [--root <dir>] [--json]

`--no-watch` traded a LOUD interruption for a QUIET staleness, and a quiet staleness is its own bug.
The watcher used to answer 'am I running current code?' by relaunching you; with it off, nothing
answers unless something asks. This asks.

IT COUNTS COMMITS, and uses mtime only as a tiebreak. A rebuild touches the mtime without changing
what it was built from, so mtime alone calls a fresh rebuild of old code 'current' — the
reassuring-but-wrong answer this verb exists to avoid.

It compares against `main`, deliberately NOT against `develop`: the app runs main, and work sitting
on develop is not something the app is behind on — that is `bsc app promote --dry-run`'s question.",
        },
        bsc_cli_util::CmdDoc {
            name: "promote",
            summary: "fast-forward main to develop AT THE REPO ROOT — explicit, never on your behalf",
            usage: "\
USAGE:
  bsc app promote [--root <dir>] [--dry-run] [--skip-gate]

THE ROOT IS THE APP'S TREE. `tauri dev` runs from a checkout, and that checkout used to be the SAME
one every `git merge --no-ff` landed in — so integrating work restarted the app under whoever was
using it, and the person integrating is the person being interrupted. MEASURED across one session's
five merges: 4 of 5 wrote watched files. Narrowing a watcher cannot fix that; the fix is that the app
does not run from the tree you merge into.

IT REFUSES ON DOUBT. Nothing is moved on any refusal, and it says so:

  no app tree · detached HEAD · the root on a branch that is not main · uncommitted TRACKED work ·
  the app ref AHEAD of develop · an unreadable or STALE gate verdict · a gate tree that MOVED mid-run

A STALE VERDICT IS WORSE THAN NONE, because it looks authoritative — so it is refused, not trusted.
An unreadable HEAD counts as MOVED: a check that cannot see the tree must not certify it.

IT NEVER MERGES NON-FAST-FORWARD. If it cannot fast-forward, something committed straight to main,
and that is a fault to look at rather than paper over. The one exception is the RECONCILE case, which
is announced and provable: when every ahead commit is a merge AND the app ref adds nothing beyond the
merge base, its unique commits only re-state history develop already has. That repairs the doom loop
where each hand-run `--no-ff` made the next `--ff-only` impossible — measured at 17 merges deep.

A FAILED GATE whose every red leg is a DECLARED known-red still promotes, and says which item owns
each. That is NOT `--skip-gate`: an undeclared red still refuses.",
        },
        bsc_cli_util::CmdDoc {
            name: "rebuild",
            summary: "rebuild + relaunch the app from cold, for when something is wedged",
            usage: "\
USAGE:
  bsc app rebuild [--root <dir>] [--dry-run]

`npm run build` does NOT update the running app — it writes `dist/`, which only `tauri build` reads.
The dev app serves its frontend from the vite dev server. So `npm run build` can succeed every time
and change nothing you can see.

Five steps: stop the running app, clear the emitted record tree, drop TRUNCATED binaries, build the
sidecars, relaunch detached. IT STOPS on a real build error rather than launching a stale app.

The 0-byte step is the subtle one: cargo will not rebuild a truncated artifact on its own, because
its fingerprint says the unit is current — a plain rebuild reports `Finished` and leaves the empty
file exactly where it was.

WHAT IT KILLS is matched on ABSOLUTE paths, never a bare name: `pkill -f base-studio-code` would
match your editor, a grep for the string, and this process. It never reaches into another checkout.

It deliberately does NOT `cargo clean` — that discards ~20 GB for nothing this needs.",
        },
        bsc_cli_util::CmdDoc {
            name: "release",
            summary: "cut a release: bump both version files, stamp the CHANGELOG, commit, tag, push",
            usage: "\
USAGE:
  bsc app release [<version>|major|minor|patch] [--root <dir>] [--no-push] [--dry-run]

Bumps the app version in BOTH package.json and src-tauri/tauri.conf.json, stamps the CHANGELOG
[Unreleased] section as the new version, commits, tags vX.Y.Z, and pushes --follow-tags so the
tag-triggered release.yml builds the installers and cuts the GitHub Release.

  bsc app release                 # patch bump — the 1.0.4n cadence (1.0.41 -> 1.0.42)
  bsc app release 1.0.5           # an explicit version (a themed step, or 2.0.0)
  bsc app release minor           # a semver bump — used from v2 on
  bsc app release 1.0.42 --no-push   # everything except the push

IT REFUSES a dirty TRACKED tree. Untracked files (nested worktrees, scratch assets) are not part of
the release commit and do not wedge the cut.

Only those two files carry the app version; src-tauri/Cargo.toml keeps its crate version. THIS IS THE
ONE VERB HERE THAT REACHES A REMOTE, and it is a deliberate act — `--no-push` does everything else.",
        },
        bsc_cli_util::CmdDoc {
            name: "hooks",
            summary: "install the repo's git hooks into the COMMON .git/hooks (governs every worktree)",
            usage: "\
USAGE:
  bsc app hooks [--root <dir>]

EXPLICIT, never a postinstall: a hook that refuses operations must be something you chose.

`.git/hooks` lives in the git COMMON dir, so these govern EVERY worktree — which is why the
destination comes from `--git-common-dir` rather than the cwd's `.git`.",
        },
    ]
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn root_of(args: &[String]) -> Result<PathBuf, String> {
    repo::app_root(flag(args, "--root").as_deref())
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let docs = command_docs();
    if bsc_cli_util::handle_help(prog, TAGLINE, docs, &args) {
        return Ok(());
    }
    match args.first().map(String::as_str) {
        Some("status") => cmd_status(&args),
        Some("promote") => cmd_promote(&args),
        Some("rebuild") => cmd_rebuild(&args),
        Some("release") => cmd_release(&args),
        Some("hooks") => cmd_hooks(&args),
        Some(other) => Err(bsc_cli_util::unknown_command(prog, TAGLINE, docs, other)),
        None => Err(bsc_cli_util::help_overview(prog, TAGLINE, docs)),
    }
}

// ── status ───────────────────────────────────────────────────────────────────────────────────────

fn cmd_status(args: &[String]) -> Result<(), String> {
    let root = root_of(args)?;
    let facts = status::survey(&root);
    let verdict = status::judge_app_binary(&facts);

    if has(args, "--json") {
        bsc_cli_util::print_raw(
            &serde_json::to_string_pretty(&serde_json::json!({
                "state": verdict.state.as_str(),
                "reason": verdict.reason,
                "behind": facts.behind,
                "binary": root.join("target/debug/base-studio-code").to_string_lossy(),
            }))
            .map_err(|e| e.to_string())?,
        );
        return Ok(());
    }
    match verdict.state {
        status::AppState::Absent => {
            bsc_util::emit_line("[app status] no app binary built yet — `npm run app:dev` will build one.");
        }
        status::AppState::Current => {
            bsc_util::emit_line("[app status] the built app matches main. Nothing waiting.");
        }
        status::AppState::Stale => {
            bsc_util::emit_line(&format!(
                "[app status] the built app is BEHIND main by {} commit(s):",
                facts.behind
            ));
            let since = format!("--since={}", (facts.binary_ms / 1000.0).floor() as i64);
            if let Ok(log) = repo::git(&root, &["log", "--oneline", "--no-decorate", &since, "main"]) {
                for line in log.lines().filter(|l| !l.is_empty()).take(10) {
                    bsc_util::emit_line(&format!("    {line}"));
                }
            }
            bsc_util::emit_line("[app status] Restart the app when you want them. Nothing will restart it for you.");
        }
    }
    Ok(())
}

// ── promote ──────────────────────────────────────────────────────────────────────────────────────

fn fail(msg: impl AsRef<str>) -> String {
    format!("[app promote] {}", msg.as_ref())
}

/// Gather everything `plan_promote` is allowed to look at.
fn survey_promote(root: &Path) -> PromoteState {
    let branch = repo::current_branch(root);
    let (ahead, behind, ahead_content, ahead_adds_nothing) = match branch.as_deref() {
        Some(b) => {
            let ahead = repo::count(root, &format!("develop..{b}"), &[]);
            let behind = repo::count(root, &format!("{b}..develop"), &[]);
            // Both asked of git rather than inferred: how many ahead commits carry CONTENT (a merge
            // carries none of its own), and whether the ref adds anything beyond the merge base.
            let content =
                if ahead > 0 { repo::count(root, &format!("develop..{b}"), &["--no-merges"]) } else { 0 };
            let adds_nothing =
                ahead > 0 && repo::adds_nothing_beyond_merge_base(root, b, "develop");
            (ahead, behind, content, adds_nothing)
        }
        None => (0, 0, 0, false),
    };
    PromoteState {
        tree_exists: true,
        branch,
        dirty: repo::tracked_dirty(root),
        ahead,
        behind,
        ahead_content,
        ahead_adds_nothing,
        app_branch: Some(APP_BRANCH.to_string()),
    }
}

fn refusal_text(root: &Path, s: &PromoteState, reason: &str) -> String {
    let branch = s.branch.as_deref().unwrap_or("(detached)");
    match reason {
        "detached-head" => format!(
            "the repo root is in detached HEAD; check out the app branch ({APP_BRANCH}) first."
        ),
        "wrong-app-branch" => {
            let app_behind = repo::count(root, &format!("{APP_BRANCH}..develop"), &[]);
            format!(
                "the repo root is on '{branch}', not the app branch '{APP_BRANCH}'.\n  \
                 Promoting would fast-forward '{branch}' and leave '{APP_BRANCH}' where it is —\n  \
                 which is {app_behind} commit(s) behind develop right now, the thing you actually asked about.\n  \
                 The root is the APP's tree and belongs on '{APP_BRANCH}'; work branches belong in a wt-* worktree.\n  \
                 If '{branch}' is real work, move it: git checkout {APP_BRANCH} (the branch ref is kept)."
            )
        }
        "dirty-app-tree" => format!(
            "the repo root has uncommitted changes — refusing to promote over them:\n{}",
            s.dirty.iter().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n")
        ),
        "app-tree-ahead" => format!(
            "{branch} is {} commit(s) AHEAD of develop — it has history develop does not.\n  \
             A fast-forward is impossible, which means something committed straight to {branch}.\n  \
             Look at it (git log develop..{branch}) rather than merging around it.",
            s.ahead
        ),
        other => other.to_string(),
    }
}

/// The declared known-red legs, from the SAME store `bsc work gate` reads — never a second list here.
///
/// ASKS THIS BINARY, not a resolved one. The JavaScript ran `pickUsable(candidatePaths(...))` to find
/// SOME `bsc` and asked it — a three-candidate chain that could legitimately pick a different, older
/// binary than the one running the promote. `current_exe()` removes the question entirely: the answer
/// comes from exactly the build the caller invoked.
///
/// An unreadable store degrades to "nothing is declared", which REFUSES the promote. That is the safe
/// direction: a missing store must not become a reason to promote an unverified develop.
fn declared_known_red() -> HashMap<String, String> {
    let Ok(exe) = std::env::current_exe() else { return HashMap::new() };
    let Ok(out) = std::process::Command::new(exe)
        .args(["work", "known-red", "list", "--json"])
        .stdin(std::process::Stdio::null())
        .output()
    else {
        return HashMap::new();
    };
    if !out.status.success() {
        return HashMap::new();
    }
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return HashMap::new();
    };
    v.as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(leg, val)| {
                    val.get("ref").and_then(|r| r.as_str()).filter(|r| !r.is_empty()).map(|r| {
                        (leg.clone(), r.to_string())
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The gate's own verdict artifact from the tree it ran in.
fn gate_verdict(tree: &Path) -> Option<GateVerdict> {
    let raw = std::fs::read_to_string(tree.join("target").join("gate-result.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let legs = v.get("legs").and_then(|l| l.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|leg| {
                Some(GateLeg {
                    key: leg.get("key")?.as_str()?.to_string(),
                    ok: leg.get("ok").and_then(serde_json::Value::as_bool).unwrap_or(false),
                })
            })
            .collect()
    });
    let finished_at_ms = v
        .get("finishedAt")
        .and_then(|f| f.as_str())
        .and_then(parse_iso8601_ms);
    Some(GateVerdict { finished_at_ms, legs })
}

/// Epoch milliseconds from an ISO-8601 timestamp, or `None` — which reads as a STALE verdict.
///
/// Deliberately narrow: only the shape `gate.mjs` writes (`YYYY-MM-DDTHH:MM:SS[.sss]Z`). Anything
/// else is unparseable and refuses, which is the direction that costs a re-run rather than a
/// promotion of something unverified.
fn parse_iso8601_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // Days from the civil epoch — Howard Hinnant's `days_from_civil`, which is exact for any
    // proleptic-Gregorian date and needs no calendar table.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let millis = s
        .get(19..)
        .and_then(|rest| rest.strip_prefix('.'))
        .and_then(|f| f.get(..3))
        .and_then(|f| f.parse::<i64>().ok())
        .unwrap_or(0);
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec) * 1000) + millis)
}

/// Is a dev server running FOR THIS TREE?
///
/// Two signals, because either alone lies: **the port is MACHINE-GLOBAL**. A listener on 1420 says
/// only that SOME worktree has a dev server up, and the first version of this check reported "the app
/// is RUNNING" off that alone while the Tauri shell was not running at all. So: find the listener's
/// pid, then ask whether its working directory is this tree. A pid we cannot inspect degrades to
/// "cannot tell", which prints the conservative message rather than a confident wrong one.
#[cfg(target_os = "linux")]
fn app_is_running(root: &Path) -> bool {
    let Ok(out) = std::process::Command::new("ss").args(["-ltnp"]).output() else { return false };
    let text = String::from_utf8_lossy(&out.stdout);
    let Some(line) = text.lines().find(|l| l.contains(":1420 ") || l.contains(".1420 ")) else {
        return false;
    };
    let Some(pid) = line.split("pid=").nth(1).and_then(|r| r.split(',').next()) else { return false };
    // Exactly this tree. A dev server in a WORKTREE has that worktree as its cwd, so an equality test
    // is both the simplest and the correct one — a prefix match would claim every worktree's server
    // as ours, which is the machine-global mistake one layer down.
    std::fs::read_link(format!("/proc/{pid}/cwd")).is_ok_and(|p| p == root)
}

#[cfg(not(target_os = "linux"))]
fn app_is_running(_root: &Path) -> bool {
    false
}

/// A worktree holding EXACTLY `sha`, that no other session writes to — where the gate can run without
/// the ground moving under it.
///
/// WHY NOT `wt-integrate`, which is where this used to gate. That is the ONE tree every session merges
/// into, so a 4-minute gate there is racing every integration on the box; measured cadence was a merge
/// every 2-8 minutes, which made a clean promote a coin flip. Nothing about promoting NEEDS that tree
/// — merging develop into main takes only the ref. It was borrowed purely because `gate-tree-guard`
/// refuses a second cargo over the root's `target/`, and any other worktree satisfies that as well.
///
/// DETACHED at `sha` on purpose: it holds no branch, so it can never be mistaken for somewhere work
/// belongs, and checking out a sha cannot disturb a ref another session is using.
///
/// IT IS CREATED ON FIRST USE AND KEPT, and the first use is EXPENSIVE. MEASURED end to end: 1179s
/// (19.7 min) for a promote whose gate tree had no `target/`, against roughly 4 min warm. So NEVER
/// `git worktree remove` this directory to tidy up — the next promote then pays the 20 minutes again.
fn gate_tree(root: &Path, sha: &str) -> Result<PathBuf, String> {
    let path = root.join(GATE_TREE);
    let listed = repo::git(root, &["worktree", "list", "--porcelain"])?;
    let exists = listed.lines().any(|l| l.strip_prefix("worktree ") == Some(&path.to_string_lossy()));
    if !exists {
        bsc_util::emit_line(&format!(
            "[app promote] creating the gate worktree {GATE_TREE}. FIRST USE IS SLOW — it builds its own\n  \
             target/ from cold, measured at 19.7 min end to end against ~4 min once warm. It is kept\n  \
             between promotes for exactly that reason; do not delete it to tidy up."
        ));
        repo::git(root, &["worktree", "add", "--detach", &path.to_string_lossy(), sha])?;
        return Ok(path);
    }
    let dirty = repo::tracked_dirty(&path);
    if !dirty.is_empty() {
        return Err(fail(format!(
            "the gate worktree {GATE_TREE} has uncommitted changes, so gating there would verify something\n  \
             other than develop@{}:\n{}\n  It exists only to run the gate. Clean it, or remove it with \
             `git worktree remove {GATE_TREE}`.",
            &sha[..9.min(sha.len())],
            dirty.iter().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n"),
        )));
    }
    repo::git(&path, &["checkout", "--detach", sha])?;
    Ok(path)
}

/// Why a failed gate is not promotable, said in the caller's terms.
fn gate_refusal(v: &crate::promote::GateClassification) -> String {
    let base = "the gate FAILED — develop is not promotable. Nothing was moved.";
    let why = match v.reason {
        "no-verdict" => "\n  The gate wrote no readable verdict at target/gate-result.json, so which legs were red is\n  unknown. An absent verdict reads as ABSENT, never as a pass.".to_string(),
        "stale-verdict" => "\n  The verdict at target/gate-result.json predates this run, so it describes a DIFFERENT gate.\n  A stale artifact is worse than none, because it looks authoritative.".to_string(),
        "failed-outside-the-legs" => "\n  The gate failed with no red leg — something failed around them (gate-tree-guard, a crash, a\n  lock). A known-red declaration is about a leg and cannot speak for that.".to_string(),
        "unexplained-red" => format!(
            "\n  Unexplained red leg(s): {}.\n  Declare one with `bsc work known-red add <leg> --ref <plan-ref>` only if an item genuinely\n  owns it — a declaration explains a failure, it never launders one.",
            v.unexplained.join(", ")
        ),
        _ => String::new(),
    };
    format!("{base}{why}")
}

fn cmd_promote(args: &[String]) -> Result<(), String> {
    let root = root_of(args)?;
    let dry_run = has(args, "--dry-run");
    let skip_gate = has(args, "--skip-gate");

    let state = survey_promote(&root);
    let decision = plan_promote(&state);
    let branch = state.branch.clone().unwrap_or_else(|| "(detached)".into());

    if decision.action == Action::Fail {
        return Err(fail(refusal_text(&root, &state, decision.reason)));
    }

    if decision.action == Action::Reconcile {
        // THE DOOM-LOOP REPAIR, announced and never silent — it moves a ref the caller did not name.
        bsc_util::emit_line(&format!(
            "[app promote] {branch} is {} commit(s) ahead of develop, and EVERY one is a merge\n  \
             commit adding nothing beyond where the two diverged. That is the residue of promoting by\n  \
             hand with --no-ff, where each merge makes the next --ff-only impossible.",
            state.ahead
        ));
        if dry_run {
            bsc_util::emit_line(
                "[app promote] --dry-run: would merge the app ref back into develop (no content change), so\n  \
                 that fast-forward promotion works again.",
            );
            return Ok(());
        }
        // `None` rather than a fallback to the root: this merge would otherwise run in the APP's
        // tree, on the app's branch, which is the one place this whole surface exists to leave alone.
        let tree = repo::integration_tree(&root).ok_or_else(|| {
            fail("cannot reconcile: no worktree has `develop` checked out, so there is nowhere to merge into.\n  \
                  Check out develop somewhere (the convention is wt-integrate) and re-run.")
        })?;
        // Plain `merge`, not `--ff-only`: when develop has not moved this IS a fast-forward and git
        // does it without writing anything, and when develop HAS moved it writes one merge commit
        // that changes no file. Either way the app ref becomes an ancestor of develop, which is the
        // property `--ff-only` promotion needs. Demanding a fast-forward here would refuse the second
        // case, which is the common one.
        repo::git(
            &tree,
            &["merge", &branch, "-m", &format!("merge: {branch} into develop — reconcile the promote bookkeeping")],
        )?;
        bsc_util::emit_line(&format!(
            "[app promote] reconciled: {branch} merged back into develop. Fast-forward promotion works again."
        ));
        // Re-ask git rather than assuming which case it was — develop may ALSO have been ahead.
        if repo::count(&root, &format!("{branch}..develop"), &[]) == 0 {
            bsc_util::emit_line(&format!("[app promote] {branch} already matches develop — nothing further to promote."));
            return Ok(());
        }
    }

    if decision.action == Action::Noop {
        bsc_util::emit_line(&format!("[app promote] {branch} already matches develop — nothing to promote."));
        return Ok(());
    }

    let to_promote = repo::count(&root, &format!("{branch}..develop"), &[]);
    bsc_util::emit_line(&format!("[app promote] {branch} is {to_promote} commit(s) behind develop:"));
    if let Ok(log) = repo::git(&root, &["log", "--oneline", "--no-decorate", &format!("{branch}..develop")]) {
        for line in log.lines().take(12) {
            bsc_util::emit_line(&format!("    {line}"));
        }
    }

    // THE COMMIT THIS PROMOTE IS ABOUT, pinned before anything is verified. Everything below gates
    // and fast-forwards to THIS sha, never to `develop` as it stands later.
    let pinned = repo::git(&root, &["rev-parse", "develop"])?;
    let short = &pinned[..9.min(pinned.len())];

    if !skip_gate {
        bsc_util::emit_line(&format!("[app promote] running the FULL gate on develop@{short} before promoting…"));
        let tree = gate_tree(&root, &pinned)?;
        let started_at = now_ms();
        let head_before = repo::head_of(&tree);
        // In a tree nobody else writes to this is now an INVARIANT rather than a coin flip; if it
        // ever fires it means something genuinely unexpected touched the gate tree.
        let gate_failed = !std::process::Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" })
            .args(["run", "gate", "--", "--full"])
            .current_dir(&tree)
            .status()
            .map_err(|e| fail(format!("could not run the gate: {e}")))?
            .success();

        // ASKED BEFORE THE VERDICT IS READ, and before a known-red declaration gets a chance to speak
        // for it. A declaration explains a leg that genuinely failed; it cannot explain a result that
        // is not about this tree. Order matters, and it is the whole reason this is not folded into
        // `classify_gate_failure`.
        let moved = gate_tree_moved(head_before.as_deref(), repo::head_of(&tree).as_deref());
        if moved.moved {
            return Err(fail(tree_moved_message(&moved, Some(&tree.to_string_lossy()))));
        }

        if gate_failed {
            let verdict = classify_gate_failure(gate_verdict(&tree).as_ref(), &declared_known_red(), started_at);
            if !verdict.proceed {
                return Err(fail(gate_refusal(&verdict)));
            }
            bsc_util::emit_line("[app promote] the gate FAILED, and every red leg is a DECLARED known-red:");
            for e in &verdict.explained {
                bsc_util::emit_line(&format!("    {}  — owned by {}", e.key, e.git_ref));
            }
            bsc_util::emit_line(
                "[app promote] 0 unexplained. Promoting on that declaration — develop WAS verified, and the\n  \
                 leg(s) above stay red and stay owned. This is not --skip-gate: an undeclared red still refuses.",
            );
        }
    } else {
        bsc_util::emit_line("[app promote] --skip-gate: promoting WITHOUT verifying develop.");
    }

    if dry_run {
        bsc_util::emit_line(&format!("[app promote] --dry-run: would fast-forward {branch} to develop@{short}."));
        return Ok(());
    }

    // BSC_PROMOTE is the ONE sanctioned hole in the ref guard (scripts/guard-policy.mjs): moving the
    // app's ref is refused everywhere else, so this announces itself explicitly rather than being
    // sniffed for.
    //
    // TO THE PINNED SHA, not to `develop`. develop may well have moved during the gate — that is
    // normal — but what was verified is this commit, so this is what lands. Anything newer waits for
    // the next promote, which is the honest trade: `main` moves to something that was actually gated.
    let out = std::process::Command::new("git")
        .args(["merge", "--ff-only", &pinned])
        .current_dir(&root)
        .env("BSC_PROMOTE", "1")
        .output()
        .map_err(|e| fail(format!("could not run git merge: {e}")))?;
    if !out.status.success() {
        return Err(fail(format!(
            "the fast-forward failed. Nothing was moved.\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let now = repo::git(&root, &["rev-parse", "--short", &branch]).unwrap_or_default();
    bsc_util::emit_line(&format!("[app promote] {branch} → {now}"));
    bsc_util::emit_line(if app_is_running(&root) {
        "[app promote] A dev server for THIS tree is up — it is rebuilding and will relaunch now."
    } else {
        "[app promote] No dev server for this tree; the app picks this up on its next launch."
    });
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── rebuild ──────────────────────────────────────────────────────────────────────────────────────

fn cmd_rebuild(args: &[String]) -> Result<(), String> {
    let root = root_of(args)?;
    let dry_run = has(args, "--dry-run");
    bsc_util::emit_line("Rebuilding base-studio-code from cold.");

    bsc_util::emit_line("\n[1/5] Stopping any running app…");
    let killed = if dry_run { 0 } else { stop_running_app(&root) };
    bsc_util::emit_line(&format!(
        "      ✓ {}",
        if dry_run { "--dry-run: nothing stopped".to_string() } else if killed > 0 { format!("stopped {killed} process(es)") } else { "nothing was running".to_string() }
    ));

    bsc_util::emit_line("\n[2/5] Clearing the emitted record tree…");
    // ~1,000 frontend modules ship as RECORDS and are materialized here from the seed. A stale tree
    // is the most common reason a seed edit does not reach the screen. Regenerated in step 4.
    if !dry_run {
        let _ = std::fs::remove_dir_all(root.join(".bsc-records"));
    }
    bsc_util::emit_line("      ✓ removed .bsc-records/ — it regenerates from the seed");

    bsc_util::emit_line("\n[3/5] Dropping any truncated binaries…");
    let truncated = rebuild::truncated_binaries(&root);
    if !dry_run {
        for p in &truncated {
            let _ = std::fs::remove_file(p);
        }
    }
    bsc_util::emit_line(&format!(
        "      ✓ {}",
        if truncated.is_empty() {
            "none were truncated".to_string()
        } else {
            format!(
                "removed empty: {}",
                truncated.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).collect::<Vec<_>>().join(", ")
            )
        }
    ));

    if dry_run {
        bsc_util::emit_line("\n--dry-run: stopping before the build and the relaunch.");
        return Ok(());
    }

    bsc_util::emit_line("\n[4/5] Building the sidecars (bsc, bsc-agent, bsc-hook)…");
    // STOPS HERE on a real build error rather than launching a stale app.
    let ok = std::process::Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" })
        .args(["run", "build:plan"])
        .current_dir(&root)
        .status()
        .map_err(|e| format!("could not run npm run build:plan: {e}"))?
        .success();
    if !ok {
        return Err("`npm run build:plan` failed.\n  This is a real build error — the rebuild stopped here rather than launching a stale app.".into());
    }
    bsc_util::emit_line("      ✓ sidecars built, verified and staged");

    bsc_util::emit_line("\n[5/5] Launching the app (this also builds the app binary + re-emits records)…");
    launch_detached(&root)?;
    Ok(())
}

/// Stop a running dev app. Matched on the exact binary path and the tauri CLI, never a bare name.
#[cfg(unix)]
fn stop_running_app(root: &Path) -> usize {
    let Ok(out) = std::process::Command::new("ps").args(["-eo", "pid,cmd", "--no-headers"]).output() else {
        return 0;
    };
    let me = std::process::id();
    let mut killed = 0;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let line = line.trim();
        let Some((pid, cmd)) = line.split_once(char::is_whitespace) else { continue };
        let Ok(pid) = pid.parse::<u32>() else { continue };
        if pid == me || !rebuild::should_kill(cmd.trim(), root) {
            continue;
        }
        // Already gone between the listing and the signal is fine — nothing to do.
        if std::process::Command::new("kill").arg("-TERM").arg(pid.to_string()).status().is_ok_and(|s| s.success()) {
            killed += 1;
        }
    }
    killed
}

#[cfg(not(unix))]
fn stop_running_app(_root: &Path) -> usize {
    0
}

/// Detached on purpose: the app must outlive this process and whatever shell started it, so closing
/// the terminal — or an agent session ending — does not take the app down with it.
fn launch_detached(root: &Path) -> Result<(), String> {
    let log = bsc_util::home_dir()
        .unwrap_or_else(|| root.to_path_buf())
        .join(".base-studio-code")
        .join("dev-app.log");
    if let Some(parent) = log.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| format!("could not open {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| format!("could not duplicate the log handle: {e}"))?;

    let mut cmd = std::process::Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" });
    cmd.args(["run", "dev:app"]).current_dir(root).stdin(std::process::Stdio::null()).stdout(out).stderr(err);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A new session, so the app survives this process and its terminal.
        unsafe {
            cmd.pre_exec(|| {
                libc_setsid();
                Ok(())
            });
        }
    }
    let child = cmd.spawn().map_err(|e| format!("could not launch the app: {e}"))?;
    bsc_util::emit_line(&format!("      ✓ started (pid {}), detached from this terminal", child.id()));
    bsc_util::emit_line("\nThe window takes ~30-60s to appear while Rust builds.");
    bsc_util::emit_line(&format!("Watch it:   tail -f {}", log.display()));
    bsc_util::emit_line("Stop it:    bsc app rebuild   (it stops the old one first)  — or close the window.");
    Ok(())
}

#[cfg(unix)]
fn libc_setsid() {
    // Detach from the controlling terminal without pulling in a libc dependency for one call.
    extern "C" {
        fn setsid() -> i32;
    }
    unsafe {
        setsid();
    }
}

// ── release ──────────────────────────────────────────────────────────────────────────────────────

fn cmd_release(args: &[String]) -> Result<(), String> {
    let root = root_of(args)?;
    let dry_run = has(args, "--dry-run");
    let no_push = has(args, "--no-push");
    let spec = args.iter().skip(1).find(|a| !a.starts_with("--")).map(String::as_str);

    // Only TRACKED changes block a release — the release commits the version bump + changelog stamp,
    // and untracked files are not part of it.
    let dirty = repo::tracked_dirty(&root);
    if !dirty.is_empty() {
        return Err(format!(
            "release: working tree has uncommitted changes — commit or stash first.\n{}",
            dirty.iter().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n")
        ));
    }
    if let Some(branch) = repo::current_branch(&root) {
        if branch != "develop" {
            bsc_util::emit_line(&format!("release: on '{branch}', not 'develop' — continuing anyway."));
        }
    }

    let pkg_path = root.join("package.json");
    let tauri_path = root.join("src-tauri").join("tauri.conf.json");
    let changelog_path = root.join("CHANGELOG.md");

    let pkg = std::fs::read_to_string(&pkg_path).map_err(|e| format!("release: {}: {e}", pkg_path.display()))?;
    let cur = pkg
        .split("\"version\"")
        .nth(1)
        .and_then(|r| r.split('"').nth(1))
        .ok_or("release: could not find a version field in package.json")?
        .to_string();

    let next = release::next_version(&cur, &release::parse_spec(spec)?)?;
    bsc_util::emit_line(&format!("release: {cur} → {next}"));

    let tauri = std::fs::read_to_string(&tauri_path).map_err(|e| format!("release: {}: {e}", tauri_path.display()))?;
    let changelog = std::fs::read_to_string(&changelog_path).map_err(|e| format!("release: {}: {e}", changelog_path.display()))?;

    let new_pkg = release::set_version(&pkg, &next).ok_or("release: could not find a version field in package.json")?;
    let new_tauri = release::set_version(&tauri, &next).ok_or("release: could not find a version field in tauri.conf.json")?;
    let date = today_iso();
    let new_changelog = release::stamp_changelog(&changelog, &next, &date).map_err(|e| format!("release: {e}"))?;

    if dry_run {
        bsc_util::emit_line(&format!(
            "release: --dry-run — would bump both version files to {next}, stamp the CHANGELOG as\n  \
             '## [{next}] — {date}', commit, tag v{next}{}.",
            if no_push { "" } else { " and push --follow-tags" }
        ));
        return Ok(());
    }

    std::fs::write(&pkg_path, new_pkg).map_err(|e| format!("release: {e}"))?;
    std::fs::write(&tauri_path, new_tauri).map_err(|e| format!("release: {e}"))?;
    std::fs::write(&changelog_path, new_changelog).map_err(|e| format!("release: {e}"))?;

    repo::git(&root, &["add", "package.json", "src-tauri/tauri.conf.json", "CHANGELOG.md"])?;
    repo::git(&root, &["commit", "-m", &format!("chore(release): v{next}")])?;
    repo::git(&root, &["tag", &format!("v{next}")])?;
    bsc_util::emit_line(&format!("release: committed + tagged v{next}"));

    if no_push {
        bsc_util::emit_line("release: --no-push set. To ship: git push --follow-tags");
    } else {
        repo::git(&root, &["push", "--follow-tags"])?;
        bsc_util::emit_line(&format!(
            "release: pushed v{next} — release.yml will build the installers + cut the GitHub Release."
        ));
    }
    Ok(())
}

/// `YYYY-MM-DD` in UTC, the same slice `new Date().toISOString().slice(0, 10)` produced.
fn today_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    // The inverse of `days_from_civil` — exact, no calendar table.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

// ── hooks ────────────────────────────────────────────────────────────────────────────────────────

fn cmd_hooks(args: &[String]) -> Result<(), String> {
    let root = root_of(args)?;
    let installed = hooks::install(&root)?;
    for name in &installed.names {
        bsc_util::emit_line(&format!("[app hooks] installed {name} → {}", installed.dest.display()));
    }
    bsc_util::emit_line("[app hooks] these govern EVERY worktree — .git/hooks lives in the common dir.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn every_advertised_verb_dispatches() {
        // The catalog and the dispatch must not disagree — the failure `bsc perf` and `bsc serve`
        // shipped with, where a real verb appeared in no help output.
        for doc in command_docs() {
            let r = run(args(&[doc.name, "--root", "/definitely/not/here"]), "bsc app");
            if let Err(e) = r {
                assert!(!e.contains("unknown command"), "{} fell through to unknown: {e}", doc.name);
            }
        }
    }

    #[test]
    fn an_unknown_verb_is_named_rather_than_silently_ignored() {
        let e = run(args(&["ship-it"]), "bsc app").unwrap_err();
        assert!(e.contains("ship-it"), "{e}");
    }

    #[test]
    fn parses_the_iso_timestamp_shape_the_gate_writes() {
        // EVERY VALUE HERE WAS COMPUTED INDEPENDENTLY (python `datetime` and `date -u -d`, agreeing),
        // not read off the implementation. The first draft of this test hand-wrote 1_788_015_600_000
        // for the line below and the parser was RIGHT — a hand-written expectation is exactly the
        // thing this repo's method says to stop writing, and it cost a red test to find out.
        assert_eq!(parse_iso8601_ms("2026-09-01T15:00:00Z"), Some(1_788_274_800_000));
        // Fractional seconds are kept — a gate that finishes twice in one second must still order.
        assert_eq!(parse_iso8601_ms("2026-09-01T15:00:00.250Z"), Some(1_788_274_800_250));
        // A round-trip against the epoch itself, so a sign or offset error cannot hide.
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_ms("2000-03-01T00:00:00Z"), Some(951_868_800_000));
    }

    #[test]
    fn an_unparseable_timestamp_is_none_so_the_verdict_reads_as_stale() {
        // The direction that costs a re-run rather than promoting something unverified.
        for bad in ["", "not-a-time", "2026-09-01", "2026/09/01T15:00:00Z", "2026-13-01T15:00:00Z", "2026-09-32T15:00:00Z"] {
            assert_eq!(parse_iso8601_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn today_iso_round_trips_through_the_timestamp_parser() {
        // The two calendar conversions are inverses; this catches a drift in either without pinning
        // the test to a date.
        let today = today_iso();
        let parsed = parse_iso8601_ms(&format!("{today}T00:00:00Z")).expect("today parses");
        assert_eq!(parsed % 86_400_000, 0, "midnight UTC should land on a day boundary");
    }

    #[test]
    fn the_refusal_text_names_the_branch_and_what_to_do_about_it() {
        // A refusal that does not say what was found sends the reader to git to work it out.
        let root = crate::repo::tests::scratch_repo("refusal");
        let s = PromoteState {
            tree_exists: true,
            branch: Some("a-work-branch".into()),
            app_branch: Some(APP_BRANCH.to_string()),
            ..PromoteState::default()
        };
        let text = refusal_text(&root, &s, "wrong-app-branch");
        assert!(text.contains("a-work-branch"), "{text}");
        assert!(text.contains(APP_BRANCH), "{text}");
        assert!(text.contains("git checkout main"), "it must say how to fix it: {text}");

        let dirty = PromoteState { dirty: vec![" M src/app/App.tsx".into()], ..s };
        let text = refusal_text(&root, &dirty, "dirty-app-tree");
        assert!(text.contains("src/app/App.tsx"), "it must NAME the files: {text}");
        std::fs::remove_dir_all(&root).ok();
    }

    // ── against a REAL repository ────────────────────────────────────────────────────────────────
    //
    // The arithmetic below (ahead, behind, --no-merges, merge-base) is the half a hand-written state
    // cannot prove. `plan_promote` is fully covered by invented states in promote.rs; what is NOT
    // covered there is whether `survey_promote` ASKS GIT THE RIGHT QUESTIONS. A wrong range argument
    // — `develop..main` where `main..develop` was meant — produces a perfectly plausible number and
    // every unit test still passes.

    use crate::repo::tests::{run_git, scratch_repo};

    /// A repo with `main` (the app branch) and `develop`, both at one commit.
    fn promote_repo(tag: &str) -> PathBuf {
        let root = scratch_repo(tag);
        run_git(&root, &["branch", "develop"]);
        root
    }

    fn commit(root: &Path, file: &str, body: &str, msg: &str) {
        std::fs::write(root.join(file), body).unwrap();
        run_git(root, &["add", "-A"]);
        run_git(root, &["commit", "-qm", msg]);
    }

    #[test]
    fn a_real_repo_that_is_simply_behind_develop_promotes() {
        let root = promote_repo("real-behind");
        run_git(&root, &["checkout", "-q", "develop"]);
        commit(&root, "b.txt", "work", "work on develop");
        run_git(&root, &["checkout", "-q", "main"]);

        let s = survey_promote(&root);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!((s.ahead, s.behind), (0, 1), "the ranges must not be swapped");
        assert!(s.dirty.is_empty());
        assert_eq!(plan_promote(&s).action, Action::Promote);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_real_content_commit_on_main_refuses_and_a_merge_only_divergence_reconciles() {
        // THE DOOM LOOP AND THE FAULT IT WAS CONFUSED WITH, told apart against real git objects.
        // These two states differ only in what the ahead commits CONTAIN, which is precisely the
        // distinction `--no-merges` plus the merge-base diff exists to draw.
        let root = promote_repo("real-ahead");

        // (a) main gains a MERGE of develop that adds no content of its own.
        run_git(&root, &["checkout", "-q", "develop"]);
        commit(&root, "b.txt", "develop work", "develop work");
        run_git(&root, &["checkout", "-q", "main"]);
        run_git(&root, &["merge", "-q", "--no-ff", "-m", "merge: develop into main", "develop"]);
        let s = survey_promote(&root);
        assert!(s.ahead > 0, "main holds a commit develop does not");
        assert_eq!(s.ahead_content, 0, "...and it carries no content of its own");
        assert!(s.ahead_adds_nothing, "...and adds nothing beyond the merge base");
        assert_eq!(plan_promote(&s).action, Action::Reconcile);

        // (b) ...and now a REAL content commit lands straight on main. Same shape to a careless
        // reader — still ahead, still has merges — and it must refuse.
        commit(&root, "c.txt", "straight to main", "committed straight to main");
        let s = survey_promote(&root);
        assert!(s.ahead_content > 0, "a non-merge commit is content");
        assert!(!s.ahead_adds_nothing);
        assert_eq!(plan_promote(&s), crate::promote::PromotePlan { action: Action::Fail, reason: "app-tree-ahead" });
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_root_left_on_a_work_branch_refuses_instead_of_reporting_nothing_to_do() {
        // MEASURED 2026-09-01, and the failure was SILENT AND GREEN: someone had run
        // `git checkout -B <work-ref> develop` at the repo ROOT, so `behind` was 0 against the WRONG
        // ref and promote exited 0 saying "already matches develop" while main sat five commits back.
        let root = promote_repo("real-wrongbranch");
        run_git(&root, &["checkout", "-q", "develop"]);
        for i in 0..5 {
            commit(&root, "b.txt", &format!("v{i}"), &format!("develop {i}"));
        }
        // The root is left on a work branch cut from develop — so it is level with develop.
        run_git(&root, &["checkout", "-q", "-B", "a-work-branch", "develop"]);

        let s = survey_promote(&root);
        assert_eq!(s.behind, 0, "level with develop — which is exactly why the old bug read as 'nothing to do'");
        let d = plan_promote(&s);
        assert_eq!(d.action, Action::Fail);
        assert_eq!(d.reason, "wrong-app-branch");
        // ...and main really is behind, which is the thing the caller asked about.
        assert_eq!(crate::repo::count(&root, "main..develop", &[]), 5);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_commit_landing_between_the_two_head_reads_is_reported() {
        // THE RACE ITSELF, reproduced against a real repository rather than asserted over two
        // strings. A commit lands between the two `git rev-parse HEAD` reads — which is precisely
        // what a concurrent `bsc plan integrate` does to a shared tree — and the check reports it.
        // Run against a scratch repo on purpose: reproducing it in `wt-integrate` would mean moving
        // develop's HEAD under every other session gating at that moment, which is the hazard this
        // guard is about.
        let root = scratch_repo("real-race");
        let before = crate::repo::head_of(&root);
        assert!(!gate_tree_moved(before.as_deref(), crate::repo::head_of(&root).as_deref()).moved);

        // …another session merges into the shared tree while the gate is running.
        commit(&root, "a.txt", "two", "a merge landing mid-gate");

        let after = crate::repo::head_of(&root);
        assert_ne!(after, before);
        let v = gate_tree_moved(before.as_deref(), after.as_deref());
        assert!(v.moved);
        assert_eq!(v.reason, "head-moved");
        let msg = tree_moved_message(&v, Some(&root.to_string_lossy()));
        assert!(msg.contains(after.as_deref().unwrap()), "the message must name the sha it saw");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_dirty_app_tree_is_refused_before_any_divergence_is_considered() {
        // Precedence against real git: the uncommitted work is the only thing here that cannot be
        // recovered, so it outranks a divergence that would otherwise have reconciled.
        let root = promote_repo("real-dirty");
        run_git(&root, &["checkout", "-q", "develop"]);
        commit(&root, "b.txt", "develop work", "develop work");
        run_git(&root, &["checkout", "-q", "main"]);
        run_git(&root, &["merge", "-q", "--no-ff", "-m", "merge: develop into main", "develop"]);
        std::fs::write(root.join("a.txt"), "edited in the running copy").unwrap();

        let s = survey_promote(&root);
        assert!(!s.dirty.is_empty());
        assert_eq!(plan_promote(&s).reason, "dirty-app-tree", "even though it would otherwise reconcile");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_gate_verdict_is_read_from_the_tree_the_gate_ran_in() {
        // And an unreadable or malformed one reads as ABSENT, never as a pass.
        let root = scratch_repo("verdict");
        assert!(gate_verdict(&root).is_none(), "no artifact at all");

        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("gate-result.json"), "{ not json").unwrap();
        assert!(gate_verdict(&root).is_none(), "unparseable reads as absent");

        std::fs::write(
            target.join("gate-result.json"),
            r#"{"finishedAt":"2026-09-01T15:04:00Z","legs":[{"key":"nextest","ok":false},{"key":"lint","ok":true}]}"#,
        )
        .unwrap();
        let v = gate_verdict(&root).expect("a well-formed verdict parses");
        assert_eq!(v.finished_at_ms, Some(1_788_275_040_000));
        let legs = v.legs.expect("legs");
        assert_eq!(legs.len(), 2);
        assert!(!legs[0].ok);
        assert!(legs[1].ok);

        // A verdict with no `legs` array is NOT an empty gate — it is an unreadable one.
        std::fs::write(target.join("gate-result.json"), r#"{"finishedAt":"2026-09-01T15:04:00Z"}"#).unwrap();
        assert!(gate_verdict(&root).expect("parses").legs.is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn the_gate_refusal_says_which_of_the_four_cases_it_is() {
        use crate::promote::GateClassification;
        let cases = [
            ("no-verdict", "never as a pass"),
            ("stale-verdict", "looks authoritative"),
            ("failed-outside-the-legs", "cannot speak for that"),
            ("unexplained-red", "never launders one"),
        ];
        for (reason, want) in cases {
            let v = GateClassification {
                proceed: false,
                reason,
                explained: Vec::new(),
                unexplained: vec!["nextest".into()],
            };
            let msg = gate_refusal(&v);
            assert!(msg.contains("Nothing was moved"), "every refusal must say this: {msg}");
            assert!(msg.contains(want), "{reason} should explain itself: {msg}");
        }
    }
}
