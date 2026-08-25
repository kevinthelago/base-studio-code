//! The dependency gate, CLI side (#the-director-can-see-which-streams-are-held).
//!
//! A director's whole job is deciding what to work next, and `bsc fleet list` could not tell it which
//! of its stopped streams was actually dispatchable: `dependsOn` appears nowhere in that table, so
//! "stopped 0/7" read the same whether the stream was ready to wake or waiting on an upstream that has
//! not landed. The answer existed — `streamGate.ts` — reachable only from the app.
//!
//! ## Why this is a SECOND implementation, and how it is kept honest
//! The launcher is TypeScript (Glance decides what to start) and the reporter is Rust (`bsc fleet
//! list`), so one implementation across both is not available without dragging one runtime into the
//! other. What IS available is one CONTRACT: `src/shared/lib/fleet/streamGate.fixtures.json` is read
//! by the tests on BOTH sides, so a rule changed here and not there fails a gate rather than drifting
//! into two answers to the same question. Same pattern the tunnel and planner wire contracts use.
//!
//! ## What counts as "landed" — three tiers, OR'd
//! Measured on real fleets before `streamGate` was written, and reproduced here verbatim because a
//! reporter that disagrees with the launcher is worse than no reporter:
//!
//!   1. ISSUES DONE   — owns issues and every one is done. Strongest; needs issues.
//!   2. BRANCH MERGED — its branch is an ancestor of the clone's HEAD. The durable floor.
//!   3. SESSION LATCH — its session reported done.
//!
//! An OR, not an AND: requiring all three reproduces the hang the tiers exist to avoid — a fleet with
//! no issues and no coord events would start its root stream and leave every other one dark forever.
//!
//! PURE. No IO, no store: the caller probes the three signals and injects them, which is what makes
//! the whole rule exhaustively testable against the shared fixture.

use std::collections::{BTreeSet, HashMap, HashSet};

/// The slice of a fleet stream the gate reasons about.
#[derive(Debug, Clone, Default)]
pub struct GateStream {
    pub id: String,
    /// Upstream stream ids — planning-time sequencing (#1039), and the launch gate (#3931).
    pub depends_on: Vec<String>,
    /// Issue refs this stream owns.
    pub issues: Vec<String>,
}

/// The three landing signals, probed by the caller.
#[derive(Debug, Clone, Default)]
pub struct LandedEvidence {
    /// Issue refs that are `complete`/`verified`.
    pub done_issues: HashSet<String>,
    /// Stream ids whose branch is merged into its clone's HEAD.
    pub merged_branches: HashSet<String>,
    /// Stream ids whose SESSION reported done.
    pub session_done: HashSet<String>,
}

/// A stream held back by the gate, and what it is waiting for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldStream {
    pub stream_id: String,
    /// The UNLANDED upstreams. Empty only when `deadlocked`.
    pub waiting_on: Vec<String>,
    /// In (or downstream of) a `dependsOn` cycle — it can never become ready on its own.
    pub deadlocked: bool,
}

/// The partition: what may start now, what is already done, and what waits.
#[derive(Debug, Clone, Default)]
pub struct GatePartition {
    pub ready: Vec<String>,
    pub landed: Vec<String>,
    pub held: Vec<HeldStream>,
}

/// Which streams have LANDED — tier 1 OR tier 2 OR tier 3.
///
/// A stream must own at least one issue for its issue set to be evidence: an empty `issues` is NOT
/// vacuous completion, or every stream on a 0-issue fleet would read as finished.
pub fn landed_streams(streams: &[GateStream], ev: &LandedEvidence) -> HashSet<String> {
    let mut out = HashSet::new();
    for s in streams {
        let by_issues = !s.issues.is_empty() && s.issues.iter().all(|r| ev.done_issues.contains(r));
        if by_issues || ev.merged_branches.contains(&s.id) || ev.session_done.contains(&s.id) {
            out.insert(s.id.clone());
        }
    }
    out
}

/// Stream ids that can never become ready — in, or downstream of, a `dependsOn` cycle among UNLANDED
/// streams. A landed stream breaks a cycle, so the search runs over the unlanded subgraph only.
///
/// Iterative peel rather than an SCC pass: repeatedly settle unlanded streams whose deps are all
/// satisfiable; whatever cannot be peeled is in a cycle or downstream of one. Both are equally stuck
/// and equally worth surfacing, so they are reported together.
pub fn deadlocked_streams(streams: &[GateStream], landed: &HashSet<String>) -> HashSet<String> {
    let known: HashSet<&str> = streams.iter().map(|s| s.id.as_str()).collect();
    let mut settled: HashSet<String> = landed.clone();
    let mut remaining: HashMap<String, Vec<String>> = streams
        .iter()
        .filter(|s| !landed.contains(&s.id))
        .map(|s| (s.id.clone(), s.depends_on.clone()))
        .collect();

    let mut progressed = true;
    while progressed {
        progressed = false;
        // A dep OUTSIDE the fleet is not resolvable here — it blocks, but it is not a cycle, so it is
        // skipped for the peel. Treating a plan typo as a deadlock would mislabel it and send the
        // director looking for a loop that does not exist.
        let peelable: Vec<String> = remaining
            .iter()
            .filter(|(_, deps)| deps.iter().all(|d| settled.contains(d) || !known.contains(d.as_str())))
            .map(|(id, _)| id.clone())
            .collect();
        for id in peelable {
            settled.insert(id.clone());
            remaining.remove(&id);
            progressed = true;
        }
    }
    remaining.into_keys().collect()
}

/// Partition a fleet by its dependency graph.
///
/// Readiness does NOT cascade within one pass: a stream is ready only when every dep has actually
/// LANDED, never when a dep is merely about to start. `B` waits for `A` to FINISH. Order is preserved
/// within each bucket, so the caller can render the plan's own sequence.
pub fn partition_by_deps(streams: &[GateStream], ev: &LandedEvidence) -> GatePartition {
    let landed_ids = landed_streams(streams, ev);
    let deadlocked = deadlocked_streams(streams, &landed_ids);
    let mut out = GatePartition::default();
    for s in streams {
        if landed_ids.contains(&s.id) {
            out.landed.push(s.id.clone());
            continue;
        }
        let waiting_on: Vec<String> =
            s.depends_on.iter().filter(|d| !landed_ids.contains(*d)).cloned().collect();
        if waiting_on.is_empty() {
            out.ready.push(s.id.clone());
        } else {
            out.held.push(HeldStream {
                stream_id: s.id.clone(),
                waiting_on,
                deadlocked: deadlocked.contains(&s.id),
            });
        }
    }
    out
}

/// The unlanded upstreams of every stream, keyed by stream id — the `DEPS` column's content.
pub fn waiting_map(p: &GatePartition) -> HashMap<&str, &[String]> {
    p.held.iter().map(|h| (h.stream_id.as_str(), h.waiting_on.as_slice())).collect()
}

/// Every stream id the partition mentions, for a caller that wants to assert nothing was dropped.
pub fn covered(p: &GatePartition) -> BTreeSet<&str> {
    p.ready
        .iter()
        .chain(p.landed.iter())
        .map(String::as_str)
        .chain(p.held.iter().map(|h| h.stream_id.as_str()))
        .collect()
}


// ── the three evidence probes ────────────────────────────────────────────────────────────────────
//
// The rules above are pure and pinned by the shared fixture. THESE read the world, and each one is the
// same source the app's producer reads, so the two sides differ in language and in nothing else.

/// Tier 1 — issue refs that are done, from this project's plan store.
pub fn done_issue_refs(store: &plandb::Store) -> HashSet<String> {
    store
        .list(None, None)
        .unwrap_or_default()
        .into_iter()
        .filter(|i| plandb::is_done_status(&i.status))
        .map(|i| i.r#ref)
        .collect()
}

/// Tier 2 — branch names merged into their clone's HEAD, across every repo in the hub.
///
/// LIFTED from the app's `fleet_landed_streams` (#3931) rather than re-derived, and that command now
/// calls this: the launcher and the reporter must not disagree about what "merged" means.
///
/// The discriminator is the FIRST-PARENT chain. A branch tip sitting on it is a base commit — where the
/// branch was cut, not something the stream produced:
///
///   · tip on the first-parent chain → pristine or a base commit → NOT landed
///   · merged, tip off the chain     → real work, now in HEAD    → LANDED
///   · not merged                    → work in flight            → NOT landed
///
/// A fast-forward merge leaves the tip on the chain and so UNDER-reports. That is the safe direction:
/// under-reporting delays a launch (and tiers 1/3 still cover it); over-reporting breaks the gate.
///
/// Tolerant: a hub that does not exist, a subdir that is not a clone, or a git failure contributes
/// nothing. An empty result means "no evidence of landing" — never "everything is done".
pub fn landed_branches(hub: &std::path::Path) -> BTreeSet<String> {
    let Ok(rd) = std::fs::read_dir(hub) else { return BTreeSet::new() };
    let mut landed = BTreeSet::new();
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let repo = entry.path();
        if !repo.join(".git").exists() {
            continue;
        }
        let base_line: HashSet<String> = git_lines(&repo, &["rev-list", "--first-parent", "HEAD"])
            .into_iter()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        for line in git_lines(
            &repo,
            &["for-each-ref", "--merged", "HEAD", "--format=%(objectname) %(refname:short)", "refs/heads"],
        ) {
            let Some((sha, name)) = line.trim().split_once(' ') else { continue };
            let name = name.trim();
            if name.is_empty() || base_line.contains(sha.trim()) {
                continue; // pristine / base branch — no work of its own
            }
            landed.insert(name.to_string());
        }
    }
    landed
}

fn git_lines(dir: &std::path::Path, args: &[&str]) -> Vec<String> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Tier 3 — streams whose SESSION reported done, from the coord log's `maintain` events.
///
/// `bsc-maintain` is what a worker emits when everything it owns is finished and it parks alive. It is
/// the one per-session completion signal that is actually populated in a real log — `landed`'s payload
/// refs are free text and its emitting session is dropped by the parse.
///
/// Entries are pane ids (`<projectKey>:<streamId>`); only the FIRST separator is consumed, so a triage
/// pane (`<key>:<repo>:triage`) yields `<repo>:triage`, which is not a stream id and never matches a
/// `dependsOn`. Same rule as the app's `sessionDoneStreams`.
pub fn maintaining_streams(log_dir: &std::path::Path, project_key: &str) -> HashSet<String> {
    let prefix = format!("{project_key}:");
    logs::read_stream(log_dir, "coord")
        .into_iter()
        .filter(|e| e.fields.first().map(|k| k.trim()) == Some("maintain"))
        .filter_map(|e| e.session.strip_prefix(&prefix).map(str::to_string))
        .filter(|id| !id.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE CONTRACT. The same fixture `streamGate.fixtures.test.ts` reads, so the launcher's rules and
    /// the reporter's rules are pinned to one document. Resolved from the crate manifest because tests
    /// only ever run inside the repo.
    fn fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/shared/lib/fleet/streamGate.fixtures.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("the shared gate contract is missing at {}: {e}", path.display()));
        serde_json::from_str(&text).expect("the gate contract is valid JSON")
    }

    fn ids(v: &serde_json::Value, key: &str) -> Vec<String> {
        v[key].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn the_rules_match_the_shared_contract_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(!cases.is_empty(), "a contract with no cases proves nothing");
        for c in cases {
            let name = c["name"].as_str().unwrap_or("(unnamed)");
            let streams: Vec<GateStream> = c["streams"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| GateStream {
                    id: s["id"].as_str().unwrap().to_string(),
                    depends_on: s
                        .get("dependsOn")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect())
                        .unwrap_or_default(),
                    issues: s
                        .get("issues")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect())
                        .unwrap_or_default(),
                })
                .collect();
            let ev = LandedEvidence {
                done_issues: ids(&c["evidence"], "doneIssues").into_iter().collect(),
                merged_branches: ids(&c["evidence"], "mergedBranches").into_iter().collect(),
                session_done: ids(&c["evidence"], "sessionDone").into_iter().collect(),
            };
            let got = partition_by_deps(&streams, &ev);
            assert_eq!(got.ready, ids(&c["expect"], "ready"), "[{name}] ready");
            assert_eq!(got.landed, ids(&c["expect"], "landed"), "[{name}] landed");
            let want_held: Vec<HeldStream> = c["expect"]["held"]
                .as_array()
                .unwrap()
                .iter()
                .map(|h| HeldStream {
                    stream_id: h["streamId"].as_str().unwrap().to_string(),
                    waiting_on: ids(h, "waitingOn"),
                    deadlocked: h["deadlocked"].as_bool().unwrap(),
                })
                .collect();
            assert_eq!(got.held, want_held, "[{name}] held");
        }
    }

    #[test]
    fn every_stream_lands_in_exactly_one_bucket() {
        // A partition that drops a stream would hide a worker from its director — the failure mode
        // `bsc fleet list` exists to prevent, one level up.
        let streams = vec![
            GateStream { id: "a".into(), ..Default::default() },
            GateStream { id: "b".into(), depends_on: vec!["a".into()], ..Default::default() },
            GateStream { id: "c".into(), depends_on: vec!["nope".into()], ..Default::default() },
        ];
        let p = partition_by_deps(&streams, &LandedEvidence::default());
        assert_eq!(covered(&p).len(), 3, "every stream is accounted for");
        assert_eq!(p.ready.len() + p.landed.len() + p.held.len(), 3, "and only once");
    }
}
