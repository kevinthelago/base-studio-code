//! Runtime fault → routed fix loop, derived in Rust
//! (`epic-frontend-logic-over-backend-resources-belongs-in-rust`).
//!
//! The pure core that turns a project's unresolved runtime faults — read from the errordb store —
//! into a bounded, deduped set of fix DISPATCHES the director routes via `bsc-issue` then
//! `bsc-assign`, clearing each with `bsc errors resolve <fingerprint>`.
//!
//! ## Why it moved
//!
//! The faults live in `error.db`, which Rust owns; the router is the director, a backend-owned
//! session; only the DECISION was in the renderer. That includes the rate limit which stops a fault
//! storm becoming a worker storm — so a dead or wedged webview meant no triage at all, silently.
//!
//! ## Three guarantees, each a real failure mode
//!
//! - **GATE** — auto-triage off means surface-only: dispatch nothing. It still PRUNES, because a
//!   fingerprint that has since resolved should not keep occupying an in-flight slot when the gate
//!   is turned back on.
//! - **DEDUP** — never dispatch the same fingerprint twice while it stays open.
//! - **RATE-LIMIT** — `max_in_flight` minus what is genuinely in flight, clamped to `max_per_cycle`.
//!
//! ## Ordering is part of the contract
//!
//! Candidates sort by level rank, then count, then fingerprint lexicographically. A port that gets
//! the tiebreak wrong dispatches a DIFFERENT fault under load — which is exactly when it matters —
//! so the order is pinned by the shared fixture rather than left to a stable-sort accident.
//!
//! Proved equal to the live TypeScript by `faultTriage.fixtures.json`, generated from it. Nothing
//! calls this yet; flipping the caller is its own slice.
#![allow(dead_code)] // wired by its own slice — see the module doc

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FaultLevel {
    Warn,
    Error,
    Fatal,
}

impl FaultLevel {
    /// Severity order. `warn` 1, `error` 2, `fatal` 3 — matching `LEVEL_RANK`.
    fn rank(self) -> u8 {
        match self {
            FaultLevel::Warn => 1,
            FaultLevel::Error => 2,
            FaultLevel::Fatal => 3,
        }
    }
}

/// The minimal fault shape the decision reads — a projection of the errordb row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaultLite {
    pub fingerprint: String,
    pub level: FaultLevel,
    pub title: String,
    pub count: u64,
    /// `None` (or JSON null) means OPEN. Any timestamp means resolved.
    #[serde(default)]
    pub resolved_at: Option<i64>,
}

impl FaultLite {
    fn is_open(&self) -> bool {
        self.resolved_at.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaultTriageConfig {
    pub enabled: bool,
    pub threshold: u64,
    pub min_level: FaultLevel,
    pub max_in_flight: usize,
    pub max_per_cycle: usize,
}

/// The packaged defaults, minus `enabled` which is a per-project decision.
pub const DEFAULT_THRESHOLD: u64 = 1;
pub const DEFAULT_MIN_LEVEL: FaultLevel = FaultLevel::Error;
pub const DEFAULT_MAX_IN_FLIGHT: usize = 3;
pub const DEFAULT_MAX_PER_CYCLE: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaultDispatch {
    pub fingerprint: String,
    pub level: FaultLevel,
    pub title: String,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaultTriagePlan {
    pub dispatch: Vec<FaultDispatch>,
    pub next_dispatched: Vec<String>,
}

/// The dispatch order: severity, then volume, then a stable fingerprint tiebreak.
fn worse_first(a: &FaultLite, b: &FaultLite) -> std::cmp::Ordering {
    b.level
        .rank()
        .cmp(&a.level.rank())
        .then(b.count.cmp(&a.count))
        .then(a.fingerprint.cmp(&b.fingerprint))
}

/// Plan this cycle's dispatches.
///
/// `dispatched` is what the caller believes is already in flight. It is PRUNED first against the
/// open set: a fingerprint that has since resolved must not keep holding a slot, and that pruning
/// happens even when the gate is off.
pub fn plan_fault_dispatch(
    faults: &[FaultLite],
    dispatched: &[String],
    cfg: &FaultTriageConfig,
) -> FaultTriagePlan {
    let open: Vec<&FaultLite> = faults.iter().filter(|f| f.is_open()).collect();
    let open_fps: std::collections::HashSet<&str> =
        open.iter().map(|f| f.fingerprint.as_str()).collect();

    // Dedup the caller's list while preserving order, then keep only what is still open.
    let mut seen = std::collections::HashSet::new();
    let pruned: Vec<String> = dispatched
        .iter()
        .filter(|fp| seen.insert(fp.as_str()))
        .filter(|fp| open_fps.contains(fp.as_str()))
        .cloned()
        .collect();

    if !cfg.enabled {
        return FaultTriagePlan { dispatch: Vec::new(), next_dispatched: pruned };
    }

    let slots = cfg.max_in_flight.saturating_sub(pruned.len()).min(cfg.max_per_cycle);
    if slots == 0 {
        return FaultTriagePlan { dispatch: Vec::new(), next_dispatched: pruned };
    }

    let already: std::collections::HashSet<&str> = pruned.iter().map(String::as_str).collect();
    let mut candidates: Vec<&FaultLite> = open
        .into_iter()
        .filter(|f| {
            !already.contains(f.fingerprint.as_str())
                && f.count >= cfg.threshold
                && f.level.rank() >= cfg.min_level.rank()
        })
        .collect();
    candidates.sort_by(|a, b| worse_first(a, b));

    let chosen: Vec<&FaultLite> = candidates.into_iter().take(slots).collect();
    let mut next_dispatched = pruned;
    next_dispatched.extend(chosen.iter().map(|f| f.fingerprint.clone()));
    FaultTriagePlan {
        dispatch: chosen
            .into_iter()
            .map(|f| FaultDispatch {
                fingerprint: f.fingerprint.clone(),
                level: f.level,
                title: f.title.clone(),
                count: f.count,
            })
            .collect(),
        next_dispatched,
    }
}

/// How many faults are unresolved — the number the inspector shows.
pub fn unresolved_count(faults: &[FaultLite]) -> usize {
    faults.iter().filter(|f| f.is_open()).count()
}

/// The single worst OPEN fault, or `None` when nothing is open. Drives the health dot.
pub fn worst_fault(faults: &[FaultLite]) -> Option<&FaultLite> {
    let mut open: Vec<&FaultLite> = faults.iter().filter(|f| f.is_open()).collect();
    open.sort_by(|a, b| worse_first(a, b));
    open.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE PORT IS PROVED EQUAL, NOT INSPECTED.
    ///
    /// `faultTriage.fixtures.json` is GENERATED from the live TypeScript
    /// (`faultTriage.fixtures.gen.test.ts`) across every guarantee: the gate off, dedup of an
    /// already-dispatched fingerprint, the rate limit under a storm, the level/count/fingerprint
    /// tiebreak, and pruning a fingerprint that has since resolved.
    ///
    /// Resolved by FILENAME under `src/`, the same rule the tunnel contract uses — so moving a
    /// feature slice does not break this, but RENAMING the fixture means updating this in lockstep.
    #[test]
    fn rust_plans_the_same_dispatches_as_the_typescript() {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str())
                    == Some("faultTriage.fixtures.json")
                {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one faultTriage.fixtures.json, got {found:?}");
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap();

        // The packaged defaults must not drift from the TypeScript's.
        let d = &doc["defaults"];
        assert_eq!(d["threshold"].as_u64().unwrap(), DEFAULT_THRESHOLD, "default threshold");
        assert_eq!(d["maxInFlight"].as_u64().unwrap() as usize, DEFAULT_MAX_IN_FLIGHT);
        assert_eq!(d["maxPerCycle"].as_u64().unwrap() as usize, DEFAULT_MAX_PER_CYCLE);
        assert_eq!(
            serde_json::from_value::<FaultLevel>(d["minLevel"].clone()).unwrap(),
            DEFAULT_MIN_LEVEL
        );

        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 12, "the fixture must cover the guarantees: {}", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let faults: Vec<FaultLite> = serde_json::from_value(c["faults"].clone())
                .unwrap_or_else(|e| panic!("faults for `{name}`: {e}"));
            let dispatched: Vec<String> = serde_json::from_value(c["dispatched"].clone()).unwrap();
            let cfg: FaultTriageConfig = serde_json::from_value(c["cfg"].clone())
                .unwrap_or_else(|e| panic!("cfg for `{name}`: {e}"));

            let got = plan_fault_dispatch(&faults, &dispatched, &cfg);
            let want: FaultTriagePlan = serde_json::from_value(c["plan"].clone())
                .unwrap_or_else(|e| panic!("plan for `{name}`: {e}"));
            assert_eq!(got, want, "plan differs for `{name}`");

            assert_eq!(
                unresolved_count(&faults),
                c["unresolvedCount"].as_u64().unwrap() as usize,
                "unresolvedCount differs for `{name}`"
            );
            let want_worst: Option<FaultLite> =
                serde_json::from_value(c["worstFault"].clone()).unwrap();
            assert_eq!(
                worst_fault(&faults).cloned(),
                want_worst,
                "worstFault differs for `{name}`"
            );
        }
    }

    /// The gate must still PRUNE. A fingerprint that resolved while triage was off would otherwise
    /// hold an in-flight slot for ever once it is turned back on.
    #[test]
    fn the_gate_being_off_still_prunes_a_resolved_fingerprint() {
        let faults = vec![FaultLite {
            fingerprint: "aa".into(),
            level: FaultLevel::Fatal,
            title: "t".into(),
            count: 9,
            resolved_at: Some(1000),
        }];
        let cfg = FaultTriageConfig {
            enabled: false,
            threshold: DEFAULT_THRESHOLD,
            min_level: DEFAULT_MIN_LEVEL,
            max_in_flight: DEFAULT_MAX_IN_FLIGHT,
            max_per_cycle: DEFAULT_MAX_PER_CYCLE,
        };
        let p = plan_fault_dispatch(&faults, &["aa".to_string()], &cfg);
        assert!(p.dispatch.is_empty(), "the gate is off");
        assert!(p.next_dispatched.is_empty(), "and the resolved fingerprint stopped holding a slot");
    }
}
