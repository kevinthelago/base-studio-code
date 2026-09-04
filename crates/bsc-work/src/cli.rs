//! The `bsc work` subcommand — see the crate doc for why this noun exists.

use crate::gate::{classify, tally, GateResult, Verdict};
use bsc_cli_util::CmdDoc;
use std::path::{Path, PathBuf};

const TAGLINE: &str = "the work loop: run the gate and RECORD what it actually did on the change record";

/// The crate's own verb catalog. `pub` so `bsc surface verbs` can PROJECT it rather than
/// restate it — a generated catalog cannot drift, a second list does.
pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "gate",
        summary: "run the gate and record every leg's real result on this branch's change record",
        usage: "\
USAGE:
  bsc work gate [--full] [--ref <plan-ref>] [--strict] [--dry-run] [--json|--pretty]

Runs the real gate (`npm run gate`), streams its output untouched, then records EACH LEG on the change
record for this branch — from the machine-readable verdict the gate writes, never by scraping its log.

WHY THIS EXISTS. The change record is meant to be EVIDENCE that the gate ran, not a claim that it did.
Recording it by hand made it a claim: measured over five slices in one session, ~25 gate results were
read off a terminal and retyped. Nothing checked them, so a session could record `pass` for a leg that
failed or for one it never ran, and no surface would disagree. That is the same shape as a wake that
kills a pane and reports success — wrong in the safe-looking direction, with no durable trace.

THE REF IS THE BRANCH. This repo is 1:1 — one plan item, one ref, one branch, one worktree — so the
current branch names the change record. `--ref` overrides it; nothing is guessed when the branch is
not a ref, because recording a gate against the wrong item is worse than recording nothing.

A RED LEG IS ALWAYS RECORDED `fail`. A known-red declaration explains a failure; it never launders one
into a pass. What a declaration changes is the EXIT CODE, which follows UNEXPLAINED failures — a
statement about this run rather than a durable record of it. The summary always states the split
(`N red, M known-red -> K unexplained`) so that is never left implicit.

  --full     the unscoped gate — what step 7 runs before anything lands
  --strict   exit non-zero on ANY red, declared or not
  --dry-run  run the gate and print the verdict, recording nothing",
    },
    CmdDoc {
        name: "known-red",
        summary: "gate legs that are red for a reason no branch causes — each naming the item that owns it",
        usage: "\
USAGE:
  bsc work known-red list
  bsc work known-red add <leg-key> --ref <plan-ref> [--note <text>]
  bsc work known-red remove <leg-key>

`develop` can be red at a leg for a reason no branch causes — measured here for days at the repo-store
drift leg, owned by `develop-is-red-the-repo-graph-store-is-behind`. Every agent gating a branch then
meets a red full gate and has to work out from scratch that the red is not theirs. With nowhere to
WRITE that conclusion it is re-derived every time, and the real cost is not the retyping: it is that a
red gate stops meaning anything, which is how a fleet learns to read red as noise.

EVERY DECLARATION MUST NAME AN OWNING PLAN REF. A leg listed here is one nobody looks at again, which
is exactly what makes it dangerous — an unowned entry is how a real failure gets parked forever. The
ref points at the item that will remove it, so this list is a queue rather than a wastebasket.

The leg KEY is the stable id `bsc work gate` prints (`typecheck`, `vitest`, `graph-store`), not the
prose label, which gets reworded without anything being meant by it.",
    },
];

/// Everything the two verbs read off argv.
struct Args {
    json: bool,
    pretty: bool,
    full: bool,
    strict: bool,
    dry_run: bool,
    r#ref: Option<String>,
    note: Option<String>,
    /// `--test <name>`, REPEATABLE — the failures a known-red declaration accounts for. Empty leaves
    /// the declaration leg-level.
    tests: Vec<String>,
    db: Option<String>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args {
        json: false,
        pretty: false,
        full: false,
        strict: false,
        dry_run: false,
        r#ref: None,
        note: None,
        tests: Vec::new(),
        db: None,
        positional: Vec::new(),
    };
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        match flag {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--full" => a.full = true,
            "--strict" => a.strict = true,
            "--dry-run" => a.dry_run = true,
            "--ref" => a.r#ref = Some(v.value("--ref needs a plan ref")?),
            "--note" => a.note = Some(v.value("--note needs text")?),
            // Repeatable: a leg may own more than one known failure, and replacing rather than
            // appending would silently drop the earlier ones.
            "--test" => a.tests.push(v.value("--test needs a test name")?),
            "--db" => a.db = Some(v.value("--db needs a path")?),
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

pub fn run(raw: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(raw)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    match args.positional.first().map(String::as_str).unwrap_or("") {
        "gate" => cmd_gate(&args, prog),
        "known-red" => cmd_known_red(&args, prog),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

// ── shared resolution ────────────────────────────────────────────────────────────────────────────

/// The repo this gate belongs to — the worktree we are standing in.
///
/// `--show-toplevel`, not the process cwd, so running from a subdirectory still finds the gate and the
/// artifact. A worktree has its own toplevel, which is the point: two worktrees gate independently.
fn repo_root() -> Result<PathBuf, String> {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    if !out.status.success() {
        return Err("bsc work: not inside a git worktree, so there is no gate to run".into());
    }
    Ok(PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
}

/// The plan ref this branch is working. See the `gate` help: the branch IS the ref (1:1).
///
/// A detached HEAD or a branch that is not a ref returns `None` rather than a guess. Recording gate
/// evidence against the wrong item is worse than recording none: the wrong change record then claims
/// a gate that was never run for it, which is precisely the untruth this verb exists to remove.
fn branch_ref(root: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    let b = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !b.is_empty() && b != "HEAD").then_some(b)
}

fn open_store(db: Option<&str>) -> Result<plandb::Store, String> {
    let path = match db {
        Some(p) => PathBuf::from(p),
        None => std::env::var_os("BSC_PLAN_DB").map(PathBuf::from).ok_or(
            "bsc work: no plan store — set $BSC_PLAN_DB or pass --db <plan.db>",
        )?,
    };
    if !path.exists() {
        return Err(format!(
            "bsc work: no plan store at {} — `Store::open` would MINT an empty one, and a project \
             invented by a typo is worse than a refusal",
            path.display()
        ));
    }
    plandb::Store::open(&path).map_err(|e| format!("bsc work: cannot open {}: {e}", path.display()))
}

// ── gate ─────────────────────────────────────────────────────────────────────────────────────────

fn cmd_gate(args: &Args, prog: &str) -> Result<(), String> {
    let root = repo_root()?;

    // Resolve the ref BEFORE the gate runs. A two-minute build that then discovers it has nowhere to
    // record is the most expensive possible ordering, and the failure is knowable up front.
    let store = open_store(args.db.as_deref())?;
    let plan_ref = match args.r#ref.clone().or_else(|| branch_ref(&root)) {
        Some(r) => r,
        None => {
            return Err(format!(
                "{prog} gate: HEAD is detached, so there is no branch to read the ref from. \
                 Pass --ref <plan-ref>."
            ))
        }
    };
    if !args.dry_run && store.change_get(&plan_ref).map_err(|e| e.to_string())?.is_none() {
        // Refuse rather than create one. A change record is opened at the START of the work with the
        // title and reasoning that make it worth anything; one minted here would carry neither, and
        // would quietly satisfy the "every slice gets a change record" rule while being empty.
        return Err(format!(
            "{prog} gate: no change record for '{plan_ref}'. Open one first:\n  \
             bsc plan change new {plan_ref} --note \"<title>\" --description \"<what and why>\"\n  \
             (or pass --ref if this branch is not the item's ref, or --dry-run to just see the verdict)"
        ));
    }

    // Run the REAL gate, stdio inherited, so cargo's live progress and colours survive exactly as they
    // do when a person runs `npm run gate`. Wrapping it in a pipe to parse would leave the gate looking
    // frozen through every long compile — the same reason `gate.mjs` inherits stdio for each leg.
    let mut cmd = std::process::Command::new(if cfg!(windows) { "npm.cmd" } else { "npm" });
    cmd.current_dir(&root).arg("run").arg("gate");
    if args.full {
        cmd.arg("--").arg("--full");
    }
    let status = cmd.status().map_err(|e| {
        format!("{prog} gate: cannot run npm: {e} — the gate is an npm script and needs the build tier")
    })?;

    let artifact = root.join("target").join("gate-result.json");
    let text = std::fs::read_to_string(&artifact).map_err(|e| {
        format!(
            "{prog} gate: the gate exited {} but wrote no verdict at {} ({e}).\n  \
             Nothing was recorded — an absent verdict reads as ABSENT, never as a pass.",
            status.code().unwrap_or(-1),
            artifact.display()
        )
    })?;
    let result: GateResult = serde_json::from_str(&text)
        .map_err(|e| format!("{prog} gate: {} is not a gate verdict: {e}", artifact.display()))?;

    let known = store.known_red_list().map_err(|e| e.to_string())?;
    let verdicts = classify(&result, &known);
    let (red, known_red, unexplained) = tally(&verdicts);

    if !args.dry_run {
        record(&store, &plan_ref, &result.mode, &verdicts).map_err(|e| format!("{prog} gate: {e}"))?;
    }

    emit(args, &plan_ref, &result, &verdicts, (red, known_red, unexplained));

    // The exit code follows UNEXPLAINED failures, not red ones — see the help. `--strict` restores
    // "any red fails", for a caller that does not want a declaration to speak for it.
    let failing = if args.strict { red } else { unexplained };
    if failing > 0 {
        return Err(format!(
            "{prog} gate: {failing} {} — recorded on '{plan_ref}'",
            if args.strict { "red leg(s)" } else { "UNEXPLAINED red leg(s)" }
        ));
    }
    Ok(())
}

/// Write the verdict onto the change record — every leg, plus the gate MODE.
///
/// The mode rides along as its own leg because a green SCOPED gate and a green FULL one are different
/// claims, and this repo's recurring failure is a gate that passes while covering less than the reader
/// assumes. Without it the record cannot tell the two apart, and "the gate was green" would mean
/// whichever the reader guessed.
///
/// Separated from [`cmd_gate`] so the recording is testable against a temp store without running a
/// two-minute build.
fn record(store: &plandb::Store, plan_ref: &str, mode: &str, verdicts: &[Verdict]) -> Result<(), String> {
    for v in verdicts {
        store
            .change_set_gate(plan_ref, &v.key, v.recorded_result())
            .map_err(|e| format!("could not record '{}': {e}", v.key))?;
    }
    store
        .change_set_gate(plan_ref, "gate-mode", mode)
        .map_err(|e| format!("could not record the gate mode: {e}"))?;
    Ok(())
}

fn emit(args: &Args, plan_ref: &str, result: &GateResult, verdicts: &[Verdict], t: (usize, usize, usize)) {
    let (red, known_red, unexplained) = t;
    let payload = serde_json::json!({
        "ref": plan_ref,
        "mode": result.mode,
        "reason": result.reason,
        "recorded": !args.dry_run,
        "red": red,
        "knownRed": known_red,
        "unexplained": unexplained,
        "legs": verdicts.iter().map(|v| serde_json::json!({
            "key": v.key,
            "label": v.label,
            "result": v.recorded_result(),
            "seconds": v.seconds,
            "knownRedOwner": v.known_red_owner,
        })).collect::<Vec<_>>(),
    });
    bsc_cli_util::emit(args.pretty, args.json, &payload, || {
        let mut out = String::new();
        out.push_str(&format!("\ngate: {} — {}\n", result.mode.to_uppercase(), result.reason));
        for v in verdicts {
            let owner = match &v.known_red_owner {
                Some(r) => format!("  (known-red, owned by {r})"),
                None => String::new(),
            };
            out.push_str(&format!(
                "  {:<20} {:<5} {:>6.1}s{}\n",
                v.key,
                v.recorded_result().to_uppercase(),
                v.seconds,
                owner
            ));
        }
        // ALWAYS state the split. The exit code does not follow the red count, and a reader who
        // assumed it did would read a zero exit as "nothing was red".
        out.push_str(&format!(
            "\n  {red} red, {known_red} known-red → {unexplained} unexplained\n"
        ));
        out.push_str(&if args.dry_run {
            format!("  --dry-run: nothing recorded on '{plan_ref}'\n")
        } else {
            format!("  recorded {} leg(s) + the gate mode on '{plan_ref}'\n", verdicts.len())
        });
        out
    });
}

// ── known-red ────────────────────────────────────────────────────────────────────────────────────

fn cmd_known_red(args: &Args, prog: &str) -> Result<(), String> {
    let store = open_store(args.db.as_deref())?;
    match args.positional.get(1).map(String::as_str).unwrap_or("list") {
        "list" => {
            let all = store.known_red_list().map_err(|e| e.to_string())?;
            bsc_cli_util::emit(args.pretty, args.json, &all, || {
                if all.is_empty() {
                    return "(no gate leg is declared known-red)\n".to_string();
                }
                all.iter()
                    .map(|(leg, v)| {
                        let owner = v.get("ref").and_then(|x| x.as_str()).unwrap_or("(unowned)");
                        let note = v.get("note").and_then(|x| x.as_str()).unwrap_or("");
                        format!("{leg:<14} {owner}{}", if note.is_empty() { String::new() } else { format!("  — {note}") })
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
                    + "\n"
            });
            Ok(())
        }
        "add" => {
            let leg = args
                .positional
                .get(2)
                .ok_or_else(|| {
                    format!("usage: {prog} known-red add <leg-key> --ref <plan-ref> [--test <name>]… [--note <text>]")
                })?;
            let owner = args.r#ref.as_deref().unwrap_or("");
            // `--test` NARROWS the declaration to the failures it names. Without it the declaration is
            // leg-level and excuses everything in that leg, which is how a freshly broken test rode
            // out behind `0 unexplained`. Not required, because `tsc` and `eslint` genuinely cannot
            // enumerate — but a leg that CAN name its failures should.
            store.known_red_add(leg, owner, args.note.as_deref(), &args.tests)?;
            if !args.json {
                let scope = if args.tests.is_empty() {
                    " (LEG-LEVEL — excuses every failure in this leg; pass --test to narrow it)".to_string()
                } else {
                    format!(" for {}", args.tests.join(", "))
                };
                println!("known-red: {leg} → owned by {owner}{scope}");
            }
            Ok(())
        }
        "remove" => {
            let leg = args
                .positional
                .get(2)
                .ok_or_else(|| format!("usage: {prog} known-red remove <leg-key>"))?;
            let had = store.known_red_remove(leg)?;
            if !args.json {
                // Reporting "removed" for something that was never declared is an act that did not
                // happen — say which it was.
                println!(
                    "{}",
                    if had { format!("known-red: {leg} removed") } else { format!("known-red: {leg} was not declared") }
                );
            }
            Ok(())
        }
        other => Err(format!("unknown known-red command '{other}'\n\n{}", bsc_cli_util::surface::help_for(prog, TAGLINE, COMMANDS, "known-red"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gate::{classify, Leg};
    use serde_json::json;

    fn store(tag: &str) -> (plandb::Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bsc-work-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("proj.db");
        let _ = std::fs::remove_file(&p);
        (plandb::Store::open(&p).unwrap(), p)
    }

    /// The minimum change record, so the recording tests have somewhere to write.
    fn new_change(s: &plandb::Store, r: &str) {
        s.change_upsert(&plandb::changes::Change {
            r#ref: r.into(),
            title: "t".into(),
            body: "b".into(),
            ..Default::default()
        })
        .unwrap();
    }

    fn result(mode: &str, legs: &[(&str, bool)]) -> GateResult {
        GateResult {
            version: 1,
            mode: mode.into(),
            reason: "test".into(),
            passed: legs.iter().all(|(_, ok)| *ok),
            legs: legs
                .iter()
                .map(|(k, ok)| Leg { key: (*k).into(), label: (*k).into(), ok: *ok, seconds: 1.0, failures: Vec::new() })
                .collect(),
        }
    }

    #[test]
    fn every_leg_and_the_gate_mode_land_on_the_change_record() {
        let (s, _p) = store("record");
        new_change(&s, "api-slice");
        let v = classify(&result("full", &[("typecheck", true), ("vitest", false)]), &Default::default());
        record(&s, "api-slice", "full", &v).unwrap();

        let c = s.change_get("api-slice").unwrap().expect("the change exists");
        assert_eq!(c.gates["typecheck"], "pass");
        assert_eq!(c.gates["vitest"], "fail");
        // The MODE is evidence too: a green scoped gate and a green full one are different claims.
        assert_eq!(c.gates["gate-mode"], "full");
    }

    #[test]
    fn a_known_red_leg_is_still_written_as_a_failure() {
        // The invariant restated at the STORE boundary, not only in the pure classifier: whatever the
        // run's exit code does, what lands durably must be what happened.
        let (s, _p) = store("knownred");
        new_change(&s, "api-slice");
        let mut declared = serde_json::Map::new();
        declared.insert("graph-promote-check".into(), json!({ "ref": "owning-item" }));
        let v = classify(&result("full", &[("graph-promote-check", false)]), &declared);
        record(&s, "api-slice", "full", &v).unwrap();

        let c = s.change_get("api-slice").unwrap().unwrap();
        assert_eq!(c.gates["graph-promote-check"], "fail", "a declaration explains, it never launders");
    }

    #[test]
    fn recording_a_second_run_supersedes_the_first_rather_than_appending() {
        // Gate evidence is the LATEST observation, unlike notes, which are append-only. A record that
        // kept "vitest: fail" beside "vitest: pass" could not answer whether the gate is green now.
        let (s, _p) = store("supersede");
        new_change(&s, "api-slice");
        record(&s, "api-slice", "scoped", &classify(&result("scoped", &[("vitest", false)]), &Default::default())).unwrap();
        record(&s, "api-slice", "full", &classify(&result("full", &[("vitest", true)]), &Default::default())).unwrap();
        let c = s.change_get("api-slice").unwrap().unwrap();
        assert_eq!(c.gates["vitest"], "pass");
        assert_eq!(c.gates["gate-mode"], "full");
    }

    #[test]
    fn a_plan_store_that_does_not_exist_is_refused_rather_than_minted() {
        // `Store::open` would happily create one, and a project invented by a typo would then accept
        // gate evidence for a change record nobody can find again.
        let missing = std::env::temp_dir().join(format!("bsc-work-absent-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&missing);
        let err = match open_store(Some(&missing.to_string_lossy())) {
            Ok(_) => panic!("a missing store must be refused, not minted"),
            Err(e) => e,
        };
        assert!(err.contains("MINT"), "the refusal says why: {err}");
        assert!(!missing.exists(), "the probe must not create it");
    }

    #[test]
    fn the_flags_parse_and_an_unknown_one_is_refused() {
        let a = parse_args(vec!["gate".into(), "--full".into(), "--ref".into(), "r1".into(), "--strict".into()]).unwrap();
        assert!(a.full && a.strict);
        assert_eq!(a.r#ref.as_deref(), Some("r1"));
        assert_eq!(a.positional, vec!["gate"]);
        // A silently ignored flag is how a caller believes it asked for something it did not.
        assert!(parse_args(vec!["gate".into(), "--fulll".into()]).is_err());
        // A flag that needs a value and has none must not swallow the next token as one.
        assert!(parse_args(vec!["gate".into(), "--ref".into()]).is_err());
    }
}
