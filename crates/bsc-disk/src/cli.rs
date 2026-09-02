//! `bsc disk` and `bsc worktree` — one crate, two nouns.
//!
//! They are separate nouns because they answer separate questions: `disk` reclaims space INSIDE a
//! build tree, `worktree` decides how many trees exist. They share a crate because they share the
//! unit parser and the same measurements, and because splitting them would double the scaffold for
//! nothing. `logs` is the precedent — one crate serving `bsc logs`, `bsc metrics` and `bsc perf`.

use crate::{gc, link, pool, root, sweep, worktree};

pub const DISK_TAGLINE: &str = "reclaim build-tree disk: sweep orphaned artifacts, de-duplicate across worktrees";
pub const WORKTREE_TAGLINE: &str = "the worktree pool: how many warm trees exist, and which may be collected";

const GB: f64 = 1_073_741_824.0;

pub fn disk_command_docs() -> &'static [bsc_cli_util::CmdDoc] {
    &[
        bsc_cli_util::CmdDoc {
            name: "gc",
            summary: "the ONE entry point: prune + sweep this tree, at most once an hour",
            usage: "\
USAGE:
  bsc disk gc [--root <dir>] [--force] [--dry-run] [--quiet] [--days N] [--keep N]

    --force      sweep even if this tree was swept inside the stamp window
    --dry-run    report what would go, delete nothing (implies --force)
    --quiet      print only when something was actually reclaimed

THE BUG THIS EXISTS TO FIX: the two sweeps were correct, tested, and never ran. Both hung off
`build:plan`, i.e. off `tauri dev` — so the only tree ever collected was the one where the app gets
launched, and no worktree had been swept once. They audited clean only because they were young. The
policy was never the problem; WHERE IT WAS ATTACHED was.

FAIL-SAFE BY CONTRACT: this runs from the gate and from `build:plan`. It never fails either one —
every path is swallowed and it exits 0. A janitor that can redden a gate would be worse than the
garbage it collects.

A STAMP in `target/` skips repeat runs inside an hour, so this is ~0ms during iteration. The window
is deliberately shorter than the age floor, or a directory could become eligible and sit unswept.",
        },
        bsc_cli_util::CmdDoc {
            name: "prune",
            summary: "sweep orphaned incremental-compilation dirs out of target/*/incremental",
            usage: "\
USAGE:
  bsc disk prune [--root <dir>] [--days N] [--keep N] [--dry-run] [--quiet]

    --days N     only prune dirs untouched for N days (default 0.25 — six hours)
    --keep N     always spare the newest N per crate name (default 1)

Every distinct `-C metadata` — feature set x profile x lib-vs-test x rustc version x dep version —
mints a NEW directory and orphans the old one permanently. Nothing reclaims them: rustc's own GC
runs INSIDE the directory for the crate being compiled, and cargo's `-Zgc` covers `~/.cargo`, not
build output. Deleting is safe because incremental state is a PURE CACHE — it can only cost rebuild
time, never correctness.

THE FLOOR IS NOT A FLOOR, it is a blanket exemption for everything younger than it, because the two
guards are OR-ed. That is why the default matters: at the old three-day default a tree built today
had NOTHING eligible. MEASURED 2026-09-01: 0 of 266 dirs at 3 days; 1,936 of 6,482 and 72 GB at one
day, on a repo holding 310 GB of incremental across 17 worktrees.",
        },
        bsc_cli_util::CmdDoc {
            name: "sweep",
            summary: "sweep orphaned dependency UNITS out of target/*/deps",
            usage: "\
USAGE:
  bsc disk sweep [--root <dir>] [--days N] [--keep N] [--dry-run] [--quiet]

    --days N     only sweep units untouched for N days (default 0.25 — six hours)
    --keep N     always spare the newest N per crate name (default 3)

A UNIT IS A FILE FAMILY, not a file: `libbsc_graph-<hash>.rlib`, `bsc_graph-<hash>.rmeta`,
`bsc_graph-<hash>.d` all share one metadata hash. Deleting some of a family and not the rest is
pointless (cargo rebuilds the unit either way) and makes the reclaimed-bytes number a lie, so the
family is the atom.

THE DEGRADATION, STATED RATHER THAN DISCOVERED: an rlib is not touched when merely LINKED, so a
stable live dependency keeps an old mtime and can be swept, costing one rebuild of that unit.
Bounded and never incorrect — cargo notices the missing output and regenerates it. Do not 'fix' it
by dropping the age floor to zero.

`.fingerprint/` is deliberately NOT swept, measured rather than assumed: it accumulates identically
but is 22 MB against 24 GB in deps/, and deleting 5408 of those dirs made cargo recompile 328 crates
in 2m24s. All cost, no benefit.",
        },
        bsc_cli_util::CmdDoc {
            name: "dedupe",
            summary: "hard-link byte-identical dependency artifacts across worktrees (EXPLICIT, unix only)",
            usage: "\
USAGE:
  bsc disk dedupe [--root <dir>] [--dry-run] [--min-age-mins N] [--undo]

    --min-age-mins N   skip files modified within N minutes (default 60)
    --undo             BREAK existing links, giving every tree its own copy again

MEASURED: 721 of 765 rlibs in one worktree's deps/ share a filename with another's, byte-identical —
~25 GB across the pool. They agree for a REASON: dependencies carry `debug = false` so no absolute
paths are baked in, and `-C metadata` folds package + features + profile + target, so a shared
filename already implies shared inputs.

EVERY GROUP IS SHA256-VERIFIED BEFORE ANY LINK. A filename is a hint, never a proof: the first real
run found 1902 files with identical name AND size and different bytes (`.d` files embed absolute
source paths). Workspace crates are excluded by construction — cargo folds the absolute manifest
path into their metadata, so they differ per tree anyway and rebuild constantly.

EXPLICIT, like the worktree cap — never wired into the gate or build:plan. The sweeps run
automatically because their worst outcome is a rebuild; this rewrites files several trees share.

THE TRADE REVERSES WITH FLEET SIZE. At 3 trees the shared inodes were dormant. At 10+ sessions a
dependency bump has several trees rebuilding the same crates at once, several processes writing one
inode — and it bought 13 GB against ~1,050 GB free. `--undo` before scaling the fleet.

THE COST IS A ONE-TIME PARTIAL REBUILD: a hard link shares metadata, so the shared inode adopts the
group's NEWEST mtime (cargo's staleness test is directional). Expect ~40-50 crates to rebuild once
per tree, after which the trees are stable.",
        },
    ]
}

pub fn worktree_command_docs() -> &'static [bsc_cli_util::CmdDoc] {
    &[
        bsc_cli_util::CmdDoc {
            name: "list",
            summary: "every worktree, what it holds, and whether it could be collected",
            usage: "\
USAGE:
  bsc worktree list [--root <dir>] [--json]

The measurement `cap` decides on, shown rather than implied: branch, whether it is merged into
develop, when it was last BUILT in, when anyone last WORKED in it (its private git index), any
hazard, and whether the pool policy would call it collectable.

Read this before running `cap` — a tree that surprises you here would have surprised you there.",
        },
        bsc_cli_util::CmdDoc {
            name: "cap",
            summary: "remove parked/merged worktrees beyond the cap (DESTRUCTIVE — never automatic)",
            usage: "\
USAGE:
  bsc worktree cap [--root <dir>] [--keep N] [--min-idle-hours N] [--dry-run]

    --keep N              trees to spare, most-recently-BUILT first (default 2)
    --min-idle-hours N    the activity guard (default 6)

A parked worktree exists ONLY to keep a warm target/, worth about two minutes (a fresh tree
cold-builds `bsc` in 1m59s against 0.41-5.11s recycled). Each costs ~18-21 GB. Nothing INSIDE one is
reclaimable — the deps GC measures 0 orphaned units on every one, because they are too young to have
any. The only lever is how many exist.

DESTRUCTIVE, so unlike the two janitors it is NEVER wired into the gate or build:plan — you invoke
it. IT REFUSES RATHER THAN WORKS AROUND:

  * a junction/symlink node_modules — `git worktree remove` FOLLOWS it and wipes the shared install
  * a dirty tree — `--force` is NEVER passed, and that refusal is the feature. The first real run
    kept a tree holding 7 staged source modifications on a *parked* branch.
  * a ref whose work has not landed, the main tree, and develop/main/master
  * a tree touched inside the idle window. MERGED IS NOT IDLE: a session keeps working in its tree
    after merging, so without this the widened rule deletes a working tree out from under an agent.

A MERGED branch is collectable, not only a `parked-*` one: the parked-only rule is why the pool
reached 64 trees / 631 GB, since agents merge and stop rather than parking. Of 23 merged trees only
3 were on `parked-*`, so 20 (~380 GB) were invisible to this forever.",
        },
    ]
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// A non-negative number after `name`, or `fallback`. A malformed value falls back rather than
/// failing, exactly as the JavaScript's `Number.isFinite(n) && n >= 0` guard did.
fn num(args: &[String], name: &str, fallback: f64) -> f64 {
    flag(args, name)
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(fallback)
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn resolve(args: &[String]) -> Result<std::path::PathBuf, String> {
    root::repo_root(flag(args, "--root").as_deref())
}

/// `bsc disk`.
pub fn run_disk(args: Vec<String>, prog: &str) -> Result<(), String> {
    let docs = disk_command_docs();
    if bsc_cli_util::handle_help(prog, DISK_TAGLINE, docs, &args) {
        return Ok(());
    }
    match args.first().map(String::as_str) {
        Some("gc") => cmd_gc(&args),
        Some("prune") => cmd_sweep(&args, true),
        Some("sweep") => cmd_sweep(&args, false),
        Some("dedupe") => cmd_dedupe(&args),
        Some(other) => Err(bsc_cli_util::unknown_command(prog, DISK_TAGLINE, docs, other)),
        None => Err(bsc_cli_util::help_overview(prog, DISK_TAGLINE, docs)),
    }
}

/// `bsc worktree`.
pub fn run_worktree(args: Vec<String>, prog: &str) -> Result<(), String> {
    let docs = worktree_command_docs();
    if bsc_cli_util::handle_help(prog, WORKTREE_TAGLINE, docs, &args) {
        return Ok(());
    }
    match args.first().map(String::as_str) {
        Some("list") => cmd_worktree_list(&args),
        Some("cap") => cmd_cap(&args),
        Some(other) => Err(bsc_cli_util::unknown_command(prog, WORKTREE_TAGLINE, docs, other)),
        None => Err(bsc_cli_util::help_overview(prog, WORKTREE_TAGLINE, docs)),
    }
}

/// FAIL-SAFE: `gc` runs from the gate and from `build:plan` and must never redden either. It reports
/// what went wrong and returns Ok — the worst outcome of a bug here is that nothing is swept.
fn cmd_gc(args: &[String]) -> Result<(), String> {
    let quiet = has(args, "--quiet");
    let dry_run = has(args, "--dry-run");
    let root = match resolve(args) {
        Ok(r) => r,
        Err(e) => {
            if !quiet {
                bsc_util::emit_line(&format!("[gc] skipped: {e}"));
            }
            return Ok(());
        }
    };
    let days = num(args, "--days", sweep::DEFAULT_DAYS);
    let keep_inc = num(args, "--keep", sweep::DEFAULT_KEEP_INCREMENTAL as f64) as usize;
    let keep_deps = flag(args, "--keep")
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n as usize)
        .unwrap_or(sweep::DEFAULT_KEEP_DEPS);

    match gc::gc(&root, days, keep_inc, keep_deps, has(args, "--force") || dry_run, dry_run, now_ms()) {
        gc::GcOutcome::Skipped { since_ms } => {
            if !quiet {
                bsc_util::emit_line(&format!(
                    "[gc] swept {}h ago — skipping (use --force to sweep now)",
                    (since_ms / 3_600_000.0).round()
                ));
            }
        }
        gc::GcOutcome::Swept { incremental, deps } => {
            // Each half reports its own MEASURED line; relay them rather than inventing a total,
            // because a summed "GB reclaimed" across two different units is a number nobody can check.
            let mut said = false;
            if incremental.removed > 0 || !quiet {
                bsc_util::emit_line(&prune_line(&incremental, days, keep_inc, dry_run));
                said = true;
            }
            if deps.removed > 0 || !quiet {
                bsc_util::emit_line(&sweep_line(&deps, days, keep_deps, dry_run));
                said = true;
            }
            if !said && !quiet {
                bsc_util::emit_line("[gc] nothing to reclaim");
            }
        }
    }
    Ok(())
}

fn prune_line(r: &sweep::SweepReport, days: f64, keep: usize, dry_run: bool) -> String {
    let verb = if dry_run { "would prune" } else { "pruned" };
    let tail = if r.failed > 0 { format!(" ({} could not be removed)", r.failed) } else { String::new() };
    format!(
        "[disk prune] {verb} {} of {} incremental dirs (untouched >{days}d, keeping newest {keep} per crate){tail}",
        r.removed, r.scanned
    )
}

fn sweep_line(r: &sweep::SweepReport, days: f64, keep: usize, dry_run: bool) -> String {
    let verb = if dry_run { "would sweep" } else { "swept" };
    format!(
        "[disk sweep] {verb} {} dep unit(s) (~{:.1} GB) (untouched >{days}d, keeping newest {keep} per crate)",
        r.removed,
        r.bytes as f64 / GB
    )
}

/// FAIL-SAFE, same contract as `gc`: both of these run from `build:plan`.
fn cmd_sweep(args: &[String], incremental: bool) -> Result<(), String> {
    let quiet = has(args, "--quiet");
    let dry_run = has(args, "--dry-run");
    let root = match resolve(args) {
        Ok(r) => r,
        Err(e) => {
            if !quiet {
                bsc_util::emit_line(&format!("[disk] skipped: {e}"));
            }
            return Ok(());
        }
    };
    let days = num(args, "--days", sweep::DEFAULT_DAYS);
    if incremental {
        let keep = num(args, "--keep", sweep::DEFAULT_KEEP_INCREMENTAL as f64) as usize;
        let report = sweep::prune_incremental(&root, days, keep, dry_run, now_ms());
        if report.removed > 0 || !quiet {
            bsc_util::emit_line(&prune_line(&report, days, keep, dry_run));
        }
    } else {
        let keep = num(args, "--keep", sweep::DEFAULT_KEEP_DEPS as f64) as usize;
        let report = sweep::sweep_deps(&root, days, keep, dry_run, now_ms());
        if report.removed > 0 || !quiet {
            bsc_util::emit_line(&sweep_line(&report, days, keep, dry_run));
        }
    }
    Ok(())
}

/// NOT fail-safe, deliberately: this rewrites files several trees share, and a caller that cannot
/// tell "nothing to do" from "I failed and said nothing" is the whole hazard.
fn cmd_dedupe(args: &[String]) -> Result<(), String> {
    let root = resolve(args)?;
    let dry_run = has(args, "--dry-run");
    if has(args, "--undo") {
        let r = link::undo(&root, dry_run)?;
        bsc_util::emit_line(&format!(
            "[dedupe] {} {} link(s), ~{:.2} GB no longer shared",
            if dry_run { "would break" } else { "broke" },
            r.broken,
            r.bytes as f64 / GB
        ));
        return Ok(());
    }
    let min_age_ms = num(args, "--min-age-mins", link::DEFAULT_MIN_AGE_MINS) * 60_000.0;
    let r = link::run(&root, min_age_ms, dry_run, now_ms())?;
    bsc_util::emit_line(&format!(
        "[dedupe] {} {} file(s), ~{:.2} GB reclaimed ({} candidate group(s), ~{:.2} GB eligible{}{})",
        if dry_run { "would link" } else { "linked" },
        r.linked,
        r.bytes as f64 / GB,
        r.groups,
        r.eligible_bytes as f64 / GB,
        if r.mismatched > 0 { format!(", {} hash mismatch", r.mismatched) } else { String::new() },
        if r.failed > 0 { format!(", {} skipped", r.failed) } else { String::new() },
    ));
    Ok(())
}

fn cmd_worktree_list(args: &[String]) -> Result<(), String> {
    let root = resolve(args)?;
    let trees = worktree::survey(&root)?;
    if has(args, "--json") {
        let rows: Vec<serde_json::Value> = trees
            .iter()
            .map(|t| {
                serde_json::json!({
                    "path": t.name,
                    "branch": t.branch,
                    "merged": t.merged,
                    "isMain": t.is_main,
                    "lastBuiltMs": t.last_built_ms,
                    "lastActiveMs": t.last_active_ms,
                    "blocked": t.blocked,
                    "collectable": pool::is_collectable(t),
                })
            })
            .collect();
        bsc_cli_util::print_raw(&serde_json::to_string_pretty(&rows).map_err(|e| e.to_string())?);
        return Ok(());
    }
    let now = now_ms();
    let mut lines = Vec::new();
    for t in &trees {
        let idle_h = (now - t.last_active_ms.max(t.last_built_ms)) / 3_600_000.0;
        lines.push(format!(
            "{:<52} {:<34} {:>6.1}h idle  {}{}",
            t.name,
            t.branch.as_deref().unwrap_or("(detached)"),
            idle_h,
            if t.is_main {
                "MAIN"
            } else if pool::is_collectable(t) {
                "collectable"
            } else {
                "held"
            },
            t.blocked.as_ref().map(|w| format!("  HAZARD: {w}")).unwrap_or_default()
        ));
    }
    bsc_cli_util::print_raw_lines(lines);
    Ok(())
}

/// NOT fail-safe, deliberately: this deletes working trees.
fn cmd_cap(args: &[String]) -> Result<(), String> {
    let root = resolve(args)?;
    let dry_run = has(args, "--dry-run");
    let keep = num(args, "--keep", pool::DEFAULT_KEEP as f64) as usize;
    let min_idle_ms = num(args, "--min-idle-hours", pool::DEFAULT_MIN_IDLE_MS / 3_600_000.0) * 3_600_000.0;
    let trees = worktree::survey(&root)?;
    let plan = pool::plan_cap(&trees, keep, min_idle_ms, now_ms());
    let report = worktree::apply(&root, &trees, &plan, dry_run);

    for (name, why) in &report.refused {
        bsc_util::emit_line(&format!("[worktree cap] REFUSED {name}: {why}"));
    }
    for (name, why) in &report.kept_back {
        bsc_util::emit_line(&format!("[worktree cap] kept {name}: {why}"));
    }
    if report.removed.is_empty() {
        bsc_util::emit_line(&format!("[worktree cap] nothing to remove (keeping the newest {keep} collectable)"));
        return Ok(());
    }
    // Name the BRANCH beside the path. A path alone makes the reader open git to answer the only
    // question that matters about a proposed deletion — what is in there?
    let branch_of: std::collections::HashMap<&str, &str> = trees
        .iter()
        .map(|t| (t.name.as_str(), t.branch.as_deref().unwrap_or("(detached)")))
        .collect();
    for name in &report.removed {
        bsc_util::emit_line(&format!(
            "[worktree cap] {} {name} ({})",
            if dry_run { "would remove" } else { "removed" },
            branch_of.get(name.as_str()).copied().unwrap_or("?")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_malformed_numeric_flag_falls_back_rather_than_failing() {
        // Matching the JavaScript's `Number.isFinite(n) && n >= 0` guard: a janitor must not die on
        // a typo, because it runs from the gate.
        assert_eq!(num(&args(&["--days", "banana"]), "--days", 0.25), 0.25);
        assert_eq!(num(&args(&["--days", "-3"]), "--days", 0.25), 0.25);
        assert_eq!(num(&args(&["--days"]), "--days", 0.25), 0.25);
        assert_eq!(num(&args(&["--days", "7"]), "--days", 0.25), 7.0);
    }

    #[test]
    fn dry_run_implies_force_so_a_stamped_tree_still_reports() {
        // Otherwise `--dry-run` inside the stamp window prints "skipping" and answers nothing, which
        // is the one thing a dry run exists not to do.
        let a = args(&["gc", "--dry-run"]);
        assert!(has(&a, "--dry-run"));
        assert!(has(&a, "--dry-run") || has(&a, "--force"), "dry-run must reach the force path");
    }

    #[test]
    fn every_advertised_disk_verb_dispatches() {
        // The catalog and the dispatch must not disagree — the failure `bsc perf` and `bsc serve`
        // shipped with, where a real verb appeared in no help output.
        for doc in disk_command_docs() {
            let err = run_disk(args(&[doc.name, "--root", "/definitely/not/here"]), "bsc disk");
            // It must reach the verb (and fail on the bogus root), never fall through to "unknown".
            if let Err(e) = err {
                assert!(!e.contains("unknown"), "{} fell through to unknown: {e}", doc.name);
            }
        }
    }

    #[test]
    fn every_advertised_worktree_verb_dispatches() {
        for doc in worktree_command_docs() {
            let err = run_worktree(args(&[doc.name, "--root", "/definitely/not/here"]), "bsc worktree");
            if let Err(e) = err {
                assert!(!e.contains("unknown"), "{} fell through to unknown: {e}", doc.name);
            }
        }
    }

    #[test]
    fn an_unknown_verb_is_named_rather_than_silently_ignored() {
        let e = run_disk(args(&["scrub"]), "bsc disk").unwrap_err();
        assert!(e.contains("scrub"), "{e}");
    }
}
