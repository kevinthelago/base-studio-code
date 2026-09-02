//! `bsc fleet warden-sweep` — the half of the warden that can run when the app cannot.
//!
//! # Why this exists, stated narrowly
//!
//! The warden's loop lives in the app, so nothing enforces while the app is gone. That gap is NOT
//! "while the app is down" in general: on a CLEAN exit it is vacuous, because `kill_all_pty_sessions`
//! drops every `PtyJob` and `Drop` does `killpg`, leaving nothing to enforce against. It is real only
//! on an UNCLEAN death — SIGKILL, OOM, panic — where `Drop` never runs and the `setsid()` shells
//! ORPHAN and keep executing unsupervised. `console::ledger` reaps them at the next boot, so the
//! exposure is bounded by unclean-death → next launch: overnight, not indefinitely.
//!
//! # A one-shot, not a daemon
//!
//! A daemon owns the loop and therefore an upgrade problem: replacing it means stopping the thing that
//! must not stop, plus supervision and a story for its own crash. `bsc` is already a fresh process per
//! call and already hot-swaps, so between invocations there is no process to upgrade. Scheduling is
//! not this verb's job — the app calls it on its tick, and a timer calls it when the app is dead.
//!
//! # It REPORTS. It kills only when told to, and that is the load-bearing decision
//!
//! `bsc-audit` records an ATTEMPT; `bsc-deny` BLOCKS one. **A dangerous command in the audit log is
//! therefore either a blocked attempt or an escape, and this sweep cannot tell which** — the log
//! records that the tool was reached for, not what the hook then did about it. Killing on that signal
//! would hard-pause workers whose hook worked correctly, which is the common case. So the default is
//! to report, `--enforce` is explicit, and the report says which reading applies.
//!
//! # Glob-free by construction
//!
//! The check is [`bsc_util::dangerous_match`] — the `agent_substring` half of the floor, matched by
//! substring, global, needing no session context. The `claude_rule` half is a `Bash(<glob>)` pattern
//! and would need the engine that `the-two-write-scope-glob-engines-disagree` has blocked; it is
//! deliberately not used here, and no fourth glob engine is introduced. Per-role denies are also out:
//! they live in each worktree's own settings and would need a pane→worktree resolution.

use serde::{Deserialize, Serialize};

use crate::ledger::LedgerEntry;

/// One pane the sweep considered, with the liveness that decided whether it was scanned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepPane {
    pub pane_id: String,
    pub pid: u32,
    pub live: bool,
}

/// One dangerous command attributed to one pane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub pane_id: String,
    pub pid: u32,
    /// The command as the audit log recorded it.
    pub command: String,
    /// The floor substring it matched — the reason, quotable verbatim.
    pub matched: String,
}

/// What one sweep saw and did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepReport {
    /// Which floor this run enforced. **This is what makes a STALE warden visible** — an old binary
    /// reports an old ruleset id, so "the warden is behind" is a value you can read rather than a
    /// thing you have to infer.
    pub ruleset: String,
    pub panes: Vec<SweepPane>,
    pub findings: Vec<Finding>,
    /// Panes actually quarantined this run. Empty unless `--enforce` was given AND the claim was won.
    pub enforced: Vec<String>,
    /// `report` or `enforce`.
    pub mode: String,
}

/// An identity for the ruleset this binary carries.
///
/// A stale warden is acceptable — missing a NEW rule is the safe direction for a component whose
/// action is to hard-pause a worker — but it must not be SILENT. This id changes whenever the floor's
/// substrings change, so two sweeps enforcing different rules are distinguishable at a glance.
///
/// FNV-1a over the substrings in floor order: order is part of the floor's identity (the entry order
/// reproduces both legacy lists verbatim and a regression test pins it), so a reordering is a
/// different ruleset and should read as one.
pub fn ruleset_id() -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut n = 0usize;
    for s in bsc_util::dangerous::agent_dangerous_substrings() {
        n += 1;
        for b in s.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("floor-{n}-{h:016x}")
}

/// The panes worth scanning: those the ledger recorded whose process is still alive.
///
/// A dead pid cannot be running anything, so scanning it would attribute a historical command to a
/// process that no longer exists. Liveness is probed rather than assumed because the ledger is a
/// record of what was SPAWNED, not of what is still running.
pub fn sweep_panes(entries: &[LedgerEntry], probe: &impl crate::ledger::ProcProbe) -> Vec<SweepPane> {
    entries
        .iter()
        .map(|e| SweepPane { pane_id: e.pane_id.clone(), pid: e.pid, live: probe.alive(e.pid) })
        .collect()
}

/// Every dangerous command a LIVE pane attempted since `since_ms`.
///
/// Pure over its inputs. `since_ms` bounds the window so a sweep does not re-report a command from a
/// prior run forever; `0` means no floor.
pub fn find_dangerous(panes: &[SweepPane], audit_lines: &[String], since_ms: i64) -> Vec<Finding> {
    let mut out = Vec::new();
    for p in panes.iter().filter(|p| p.live) {
        for cmd in crate::warden::parse_audit_commands(audit_lines, &p.pane_id, since_ms) {
            if let Some(matched) = bsc_util::dangerous::dangerous_match(&cmd) {
                out.push(Finding {
                    pane_id: p.pane_id.clone(),
                    pid: p.pid,
                    command: cmd,
                    matched: matched.to_string(),
                });
            }
        }
    }
    out
}

// ── the durable quarantine record ────────────────────────────────────────────────────────────

/// One standing quarantine, on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineRecord {
    pub pane_id: String,
    pub at_ms: u64,
    /// The floor substring that caused it — so a reader knows WHY without re-deriving.
    pub reason: String,
    /// Which ruleset the actor that quarantined it was enforcing. Pairs with [`ruleset_id`].
    pub ruleset: String,
}

fn quarantine_path(base: &std::path::Path) -> std::path::PathBuf {
    base.join("quarantine.json")
}

/// Read the standing quarantines. A missing or corrupt file is EMPTY, never an error — refusing to
/// run because the record is unreadable would mean no enforcement at the moment it is wanted.
pub fn load_quarantine(base: &std::path::Path) -> Vec<QuarantineRecord> {
    match std::fs::read_to_string(quarantine_path(base)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_quarantine(base: &std::path::Path, rows: &[QuarantineRecord]) -> std::io::Result<()> {
    let path = quarantine_path(base);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Write-then-rename, like the ledger: a crash mid-write must not leave a truncated record that
    // reads as "nobody is quarantined".
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(rows).unwrap_or_else(|_| "[]".into()))?;
    std::fs::rename(&tmp, &path)
}

/// What happened when an actor tried to claim a pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// This caller won the claim and should act.
    Won,
    /// Already quarantined — by this actor or another. Do NOT act again.
    AlreadyHeld,
    /// Another actor holds the lock right now. Do NOT act; the next sweep will see it.
    Contended,
}

/// Atomically claim `pane_id` for quarantine.
///
/// **This is what stops two actors double-killing.** The app's loop and a `bsc fleet warden-sweep`
/// can run at the same moment; both would otherwise read "not quarantined", both would kill, and the
/// second kill lands on a pid the first may already have reaped — or, worse, on a recycled one.
///
/// The mutual exclusion is an `O_EXCL` lock file, and CONTENTION FAILS TOWARD INACTION: a caller that
/// cannot take the lock does not act. That is the same direction every other warden failure takes, and
/// it costs only a delay, because the next sweep re-reads the same audit log and sees the same
/// evidence.
pub fn claim_quarantine(
    base: &std::path::Path,
    pane_id: &str,
    reason: &str,
    ruleset: &str,
    now_ms: u64,
) -> Claim {
    let lock = quarantine_path(base).with_extension("lock");
    if let Some(dir) = lock.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let held = match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock) {
        Ok(f) => f,
        Err(_) => return Claim::Contended,
    };
    drop(held);

    let mut rows = load_quarantine(base);
    let outcome = if rows.iter().any(|r| r.pane_id == pane_id) {
        Claim::AlreadyHeld
    } else {
        rows.push(QuarantineRecord {
            pane_id: pane_id.to_string(),
            at_ms: now_ms,
            reason: reason.to_string(),
            ruleset: ruleset.to_string(),
        });
        match save_quarantine(base, &rows) {
            Ok(()) => Claim::Won,
            // The write failed, so nothing is recorded — acting now would kill without a record, and
            // the next sweep would kill again. Treat it as contention.
            Err(_) => Claim::Contended,
        }
    };
    let _ = std::fs::remove_file(&lock);
    outcome
}

/// Lift a standing quarantine. Returns whether one was removed.
pub fn release_quarantine(base: &std::path::Path, pane_id: &str) -> bool {
    let mut rows = load_quarantine(base);
    let before = rows.len();
    rows.retain(|r| r.pane_id != pane_id);
    if rows.len() == before {
        return false;
    }
    save_quarantine(base, &rows).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ProcProbe;

    struct Probe(Vec<u32>);
    impl ProcProbe for Probe {
        fn alive(&self, pid: u32) -> bool {
            self.0.contains(&pid)
        }
        fn start_token(&self, _pid: u32) -> Option<u64> {
            Some(0)
        }
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-sweep-{tag}-{}", bsc_util::now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn entry(pid: u32, pane: &str) -> LedgerEntry {
        LedgerEntry { pid, pane_id: pane.into(), owner_pid: 1, start_token: 0 }
    }

    fn audit(rows: &[(&str, &str, &str)]) -> Vec<String> {
        rows.iter().map(|(ts, pane, cmd)| format!("{ts}\t{pane}\tBash\t{cmd}")).collect()
    }

    /// A dead pid cannot be running anything — scanning it would attribute a historical command to a
    /// process that no longer exists.
    #[test]
    fn only_a_live_pane_is_scanned() {
        let entries = [entry(10, "proj:api"), entry(11, "proj:web")];
        let panes = sweep_panes(&entries, &Probe(vec![10]));
        assert_eq!(panes.len(), 2, "both are REPORTED, so a dead pane is visible rather than omitted");
        assert!(panes[0].live && !panes[1].live);

        let lines = audit(&[
            ("2026-09-02T12:00:00Z", "proj:api", "sudo rm -x"),
            ("2026-09-02T12:00:00Z", "proj:web", "sudo rm -x"),
        ]);
        let f = find_dangerous(&panes, &lines, 0);
        assert_eq!(f.len(), 1, "only the live pane yields a finding: {f:?}");
        assert_eq!(f[0].pane_id, "proj:api");
    }

    /// The check is the floor's substring half — glob-free, and it names what it matched.
    #[test]
    fn a_floor_hit_is_reported_with_the_substring_that_caused_it() {
        let panes = sweep_panes(&[entry(10, "p")], &Probe(vec![10]));
        let lines = audit(&[
            ("2026-09-02T12:00:00Z", "p", "git status"),
            ("2026-09-02T12:00:01Z", "p", "gh auth token"),
            ("2026-09-02T12:00:02Z", "p", "cargo build"),
        ]);
        let f = find_dangerous(&panes, &lines, 0);
        assert_eq!(f.len(), 1, "only the dangerous one: {f:?}");
        assert_eq!(f[0].matched, "gh auth token", "the reason is quotable verbatim");
        assert_eq!(f[0].command, "gh auth token");
    }

    /// An ordinary command must never trip the floor — a false positive here hard-pauses a working
    /// agent, which is the expensive direction.
    #[test]
    fn ordinary_work_produces_nothing() {
        let panes = sweep_panes(&[entry(10, "p")], &Probe(vec![10]));
        let lines = audit(&[
            ("2026-09-02T12:00:00Z", "p", "git commit -m 'sudo is mentioned in this message'"),
            ("2026-09-02T12:00:01Z", "p", "cargo test -p bsc-fleet"),
            ("2026-09-02T12:00:02Z", "p", "bsc plan list"),
        ]);
        // NOTE the first line: the floor matches `sudo ` with a trailing space, so prose mentioning
        // "sudo is" DOES contain it. That is the floor's own coarseness, pinned here so a change to it
        // is visible rather than surprising.
        let f = find_dangerous(&panes, &lines, 0);
        assert_eq!(f.len(), 1, "the floor is a substring match and this is what that costs: {f:?}");
        assert_eq!(f[0].matched, "sudo ");
    }

    /// The window bounds re-reporting: a sweep must not surface the same historical command forever.
    #[test]
    fn the_since_floor_bounds_what_is_reported() {
        let panes = sweep_panes(&[entry(10, "p")], &Probe(vec![10]));
        let lines = audit(&[
            ("2026-09-02T10:00:00Z", "p", "sudo rm -x"),
            ("2026-09-02T14:00:00Z", "p", "gh auth token"),
        ]);
        let since = logs::to_ms("2026-09-02T12:00:00Z").unwrap();
        let f = find_dangerous(&panes, &lines, since);
        assert_eq!(f.len(), 1, "the older attempt is outside the window: {f:?}");
        assert_eq!(f[0].matched, "gh auth token");
        assert_eq!(find_dangerous(&panes, &lines, 0).len(), 2, "and with no floor, both");
    }

    /// TWO ACTORS MUST NOT DOUBLE-KILL. The app's loop and a sweep can run in the same moment.
    #[test]
    fn only_one_actor_can_claim_a_pane() {
        let d = scratch("claim");
        assert_eq!(claim_quarantine(&d, "p:api", "sudo ", "floor-1-x", 100), Claim::Won);
        assert_eq!(
            claim_quarantine(&d, "p:api", "sudo ", "floor-1-x", 200),
            Claim::AlreadyHeld,
            "the second actor is told to stand down, not allowed to kill again"
        );
        let rows = load_quarantine(&d);
        assert_eq!(rows.len(), 1, "and the record holds ONE entry: {rows:?}");
        assert_eq!(rows[0].at_ms, 100, "the first claim's timestamp survives");
        assert_eq!(rows[0].reason, "sudo ");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// CONTENTION FAILS TOWARD INACTION — a caller that cannot take the lock does not act.
    #[test]
    fn a_held_lock_yields_contended_and_records_nothing() {
        let d = scratch("contend");
        let lock = d.join("quarantine.lock");
        std::fs::write(&lock, "").unwrap();
        assert_eq!(
            claim_quarantine(&d, "p:api", "sudo ", "r", 1),
            Claim::Contended,
            "another actor holds it — do not act"
        );
        assert!(load_quarantine(&d).is_empty(), "and nothing was recorded");
        let _ = std::fs::remove_file(&lock);
        assert_eq!(claim_quarantine(&d, "p:api", "sudo ", "r", 1), Claim::Won, "released, so it proceeds");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The record must SURVIVE a restart — that is the whole point of it leaving the process.
    #[test]
    fn the_record_survives_the_process_that_wrote_it() {
        let d = scratch("durable");
        claim_quarantine(&d, "p:api", "gh auth token", "floor-18-abc", 4242);
        // A different "process": nothing in memory carries over, only the file.
        let rows = load_quarantine(&d);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pane_id, "p:api");
        assert_eq!(rows[0].ruleset, "floor-18-abc", "and which ruleset quarantined it is on the record");
        assert!(release_quarantine(&d, "p:api"));
        assert!(load_quarantine(&d).is_empty());
        assert!(!release_quarantine(&d, "p:api"), "releasing twice is not an error, just false");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_missing_or_corrupt_record_is_empty_never_an_error() {
        let d = scratch("corrupt");
        assert!(load_quarantine(&d).is_empty());
        std::fs::write(d.join("quarantine.json"), "{not json").unwrap();
        assert!(load_quarantine(&d).is_empty(), "unreadable degrades to empty, so enforcement continues");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A STALE WARDEN MUST BE VISIBLE. The id changes with the floor's contents, so two sweeps
    /// enforcing different rules are distinguishable.
    #[test]
    fn the_ruleset_id_is_stable_and_names_the_floors_size() {
        let a = ruleset_id();
        assert_eq!(a, ruleset_id(), "stable across calls");
        let n = bsc_util::dangerous::agent_dangerous_substrings().count();
        assert!(a.starts_with(&format!("floor-{n}-")), "carries the floor's size: {a}");
        assert_eq!(a.len(), format!("floor-{n}-").len() + 16, "and a fixed-width digest");
    }
}
