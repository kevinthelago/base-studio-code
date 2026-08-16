//! The RUNTIME lens for `doctor` (#doctor-reads-the-runtime) — findings the structural pass
//! cannot see.
//!
//! `bsc ui doctor` and `bsc graph doctor` are both purely structural: cycles, orphans, duplicates,
//! dangling `composes`, unbuildable specs, viz typing. Every one of them is a fact about the graph's
//! SHAPE, and none of them can express the most important fact about a record — whether it actually
//! served. A record can be structurally perfect and inert.
//!
//! This module is the pure half: attestations plus the records that exist go in, findings come out. It
//! lives beside the store rather than in either CLI so the two doctors ask the same question of the same
//! data instead of growing two answers that drift.
//!
//! **The empty store is the trap.** With no attestations, "no record ever served" is TRUE and utterly
//! misleading — nothing was measured. Every never-ran judgement here is gated on
//! [`RuntimeReport::sessions`], and the report says so rather than emitting hundreds of confident
//! findings about an app that simply has not run yet.

use crate::{Attestation, Outcome};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// A record as the lens needs it: its id and the hash of the source CURRENTLY in the store.
#[derive(Debug, Clone)]
pub struct RecordRef {
    pub id: String,
    /// `crate::src_hash` of the record's current source. Empty when the record has no source.
    pub src_hash: String,
}

/// One runtime finding. Deliberately NOT the component doctor's `Finding`: this crate must not depend on
/// either CLI's report shape, so each doctor maps these into its own.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuntimeFinding {
    /// `declined` | `fell-back` | `render-threw` | `stale` | `never-ran` | `recompile-loop` | `slow-compile`
    pub category: &'static str,
    /// Higher = more severe, matching the component doctor's ordering.
    pub severity: u8,
    pub record_id: String,
    pub why: String,
    pub suggested_action: String,
}

/// The whole runtime report. `sessions` leads because it is what makes the rest meaningful.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuntimeReport {
    /// Distinct app runs observed. ZERO means nothing was measured — NOT that nothing ran.
    pub sessions: i64,
    /// True when `sessions == 0`; callers surface this instead of the findings.
    pub unmeasured: bool,
    /// True when there are too few sessions to claim NEVER-RAN ({@link NEVER_RAN_MIN_SESSIONS}). The
    /// other findings still stand — they are evidence of something that happened, not of absence.
    pub never_ran_withheld: bool,
    pub findings: Vec<RuntimeFinding>,
}

/// Compile milliseconds above which a record is worth naming. Generous on purpose: the loader's own
/// notes put a healthy page's single compile around 700ms, so this flags the outliers rather than
/// re-reporting the normal cost of the design.
const SLOW_COMPILE_MS: f64 = 1_500.0;

/// Compiles-per-session above which a record is looping. A healthy page compiles ONCE per mount, and a
/// user genuinely revisiting a page a few times a session is ordinary; the observed pathology was three
/// compiles of an identical source inside one second, and 72 compiles across 24 mounts.
const RECOMPILE_PER_SESSION: f64 = 4.0;

/// Sessions required before NEVER-RAN is claimed at all.
///
/// One session cannot exercise the whole app — a user opens a few surfaces and closes it — so calling
/// every unvisited record dead off a single run is over-claiming, and loudly: measured against the real
/// store with one session seeded, it produced 586 findings, which is a report nobody reads twice. Every
/// OTHER finding here is evidence of something that HAPPENED and needs no such threshold; never-ran is
/// the only one inferred from absence, and absence needs more than one look.
const NEVER_RAN_MIN_SESSIONS: i64 = 3;

/// Analyse attestations against the records that exist.
///
/// `records` is every record the graph holds — the denominator for "never ran". Pass only the records
/// the caller's doctor is responsible for (its kit, or its implementations), because a finding about a
/// record the reader cannot act on is noise.
pub fn analyze(attestations: &[Attestation], records: &[RecordRef]) -> RuntimeReport {
    let sessions: i64 = attestations.iter().map(|a| a.session.as_str()).collect::<BTreeSet<_>>().len() as i64;
    if sessions == 0 {
        // Say nothing rather than everything. Hundreds of "never ran" findings on an unmeasured store
        // would be technically accurate and would train a reader to ignore the whole lens.
        return RuntimeReport { sessions: 0, unmeasured: true, never_ran_withheld: true, findings: Vec::new() };
    }

    let mut by_record: BTreeMap<&str, Vec<&Attestation>> = BTreeMap::new();
    for a in attestations {
        if !a.record_id.is_empty() {
            by_record.entry(a.record_id.as_str()).or_default().push(a);
        }
    }

    let mut findings = Vec::new();
    for rec in records {
        let rows = by_record.get(rec.id.as_str()).map(Vec::as_slice).unwrap_or_default();

        // ── NEVER-RAN ────────────────────────────────────────────────────────────────────────────
        // The honest superset of the structural ORPHAN check, which only sees `composes` edges: a
        // record can be composed by something and still never be reached at run time.
        if rows.is_empty() {
            // Absence is only evidence after enough looks — see NEVER_RAN_MIN_SESSIONS.
            if sessions < NEVER_RAN_MIN_SESSIONS {
                continue;
            }
            findings.push(RuntimeFinding {
                category: "never-ran",
                severity: 1,
                record_id: rec.id.clone(),
                why: format!("no attestation across {sessions} recorded session(s) — this record has not served, been linked, or been declined"),
                suggested_action: "confirm something reaches it (a `provides` specifier, a sibling import, or a host); a record nothing mounts is a candidate for retirement".into(),
            });
            continue;
        }

        // ── DECLINED — the record exists and the runtime REFUSED it ───────────────────────────────
        // The single most important finding here, and the one that was invisible: the platform module
        // served, the app looked fine, and the record was inert.
        for a in rows.iter().filter(|a| a.is_declined()) {
            findings.push(RuntimeFinding {
                category: "declined",
                severity: 4,
                record_id: rec.id.clone(),
                why: format!(
                    "the runtime DECLINED this record {}× ({}) and served the bundled platform module instead{}",
                    a.n,
                    a.outcome,
                    a.reason.as_deref().map(|r| format!(" — {r}")).unwrap_or_default(),
                ),
                suggested_action: match a.outcome.as_str() {
                    Outcome::DECLINED_CLOSURE => "the record imports something neither registered nor a record — register it on the platform surface, or author the missing module as a record".into(),
                    Outcome::DECLINED_COMPILE => "the record's source does not compile; `bsc ui get <id>` and fix it, or `bsc ui revert <id>` to the last version that did".into(),
                    _ => "the record threw at module init — usually a build-time-only form (`import.meta.glob`) that esbuild emits verbatim".into(),
                },
            });
        }

        // ── FELL-BACK / RENDER-THREW ─────────────────────────────────────────────────────────────
        for a in rows.iter().filter(|a| a.outcome == Outcome::FELL_BACK) {
            findings.push(RuntimeFinding {
                category: "fell-back",
                severity: 4,
                record_id: rec.id.clone(),
                why: format!("the current version failed {}× and an OLDER version was rendered instead — the app works, this record does not", a.n),
                suggested_action: format!("`bsc ui revert {}` to the version that works, or fix the current one", rec.id),
            });
        }
        for a in rows.iter().filter(|a| a.outcome == Outcome::RENDER_THREW) {
            findings.push(RuntimeFinding {
                category: "render-threw",
                severity: 4,
                record_id: rec.id.clone(),
                why: format!(
                    "mounted and then threw during render {}× — nothing upstream refused it{}",
                    a.n,
                    a.reason.as_deref().map(|r| format!(": {r}")).unwrap_or_default(),
                ),
                suggested_action: "the only failure the loader's decline paths structurally cannot see; reproduce it in the Design Studio preview".into(),
            });
        }

        // ── STALE — the record changed, and the new version has not run ───────────────────────────
        // Only when the record HAS a hash to compare and some version DID serve: a record that has only
        // ever been declined is already reported above, and calling it stale as well is noise.
        let served_hashes: BTreeSet<&str> =
            rows.iter().filter(|a| a.is_serving()).map(|a| a.src_hash.as_str()).collect();
        if !rec.src_hash.is_empty()
            && !served_hashes.is_empty()
            && !served_hashes.contains(rec.src_hash.as_str())
        {
            findings.push(RuntimeFinding {
                category: "stale",
                severity: 2,
                record_id: rec.id.clone(),
                why: "the record's CURRENT source has never run — an earlier version served, this one has not been exercised".into(),
                suggested_action: "open the surface this record backs and confirm the edit works; an unexercised edit is the state a broken record hides in".into(),
            });
        }

        // ── RECOMPILE-LOOP ───────────────────────────────────────────────────────────────────────
        // The loader's own comments record this costing ~2.1s where one compile costs ~700ms, and it
        // had no detector: a climbing per-id compile count is either source churn or a remount storm,
        // and both are bugs.
        let served: i64 = rows.iter().filter(|a| a.outcome == Outcome::SERVED).map(|a| a.n).sum();
        let per_session = served as f64 / sessions as f64;
        if per_session > RECOMPILE_PER_SESSION {
            findings.push(RuntimeFinding {
                category: "recompile-loop",
                severity: 2,
                record_id: rec.id.clone(),
                why: format!("compiled {served}× across {sessions} session(s) — {per_session:.1} per session, where a healthy record compiles once per mount"),
                suggested_action: "either the source is churning (a new value each hydrate) or the host is remounting; a CONSTANT source length across the climb means a remount".into(),
            });
        }

        // ── SLOW-COMPILE ─────────────────────────────────────────────────────────────────────────
        if let Some(slowest) = rows
            .iter()
            .filter(|a| a.outcome == Outcome::SERVED)
            .map(|a| a.ms_max)
            .fold(None::<f64>, |acc, m| Some(acc.map_or(m, |a: f64| a.max(m))))
        {
            if slowest > SLOW_COMPILE_MS {
                findings.push(RuntimeFinding {
                    category: "slow-compile",
                    severity: 1,
                    record_id: rec.id.clone(),
                    why: format!("slowest compile {slowest:.0}ms (budget {SLOW_COMPILE_MS:.0}ms) — this is time before the surface appears"),
                    suggested_action: "a compile vendors its whole sibling closure; a large one usually means the record reaches further than it needs to".into(),
                });
            }
        }
    }

    // Most severe first, then stable by record so two runs over the same data read identically.
    findings.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.record_id.cmp(&b.record_id)).then(a.category.cmp(b.category)));
    RuntimeReport { sessions, unmeasured: false, never_ran_withheld: sessions < NEVER_RAN_MIN_SESSIONS, findings }
}

/// One record's runtime metrics, joined at READ time (#doctor-reads-the-runtime).
///
/// NOT stored on the record, and that is the design decision rather than an omission. Writing these onto
/// a record would (a) make every boot a record write, filling `bsc ui revert` history with timing noise
/// instead of authorship, (b) vendor a second copy of a constantly-changing number — the exact drift
/// #4191 forbids for algorithm bodies — and (c) ship one machine's p95 to another inside a seed or a
/// Studio snapshot, presented as a property of the component.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecordMetrics {
    pub record_id: String,
    /// Distinct app runs this record was observed in.
    pub sessions: i64,
    /// Times it SERVED (mounted), and times it was LINKED into a closure that served.
    pub served: i64,
    pub linked: i64,
    /// Times the runtime refused it and served the bundled platform module instead.
    pub declined: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compile_ms_mean: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compile_ms_max: Option<f64>,
    /// The source versions observed running, newest sighting first.
    pub versions_ran: Vec<String>,
    /// The most recent sighting of any kind (epoch ms), or 0 when never seen.
    pub last_at: i64,
}

/// Summarise one record's attestations. `rows` may be the whole store — it filters — so a caller can read
/// once and summarise many.
pub fn metrics_for(rows: &[Attestation], record_id: &str) -> RecordMetrics {
    let mine: Vec<&Attestation> = rows.iter().filter(|a| a.record_id == record_id).collect();
    let count = |outcome: &str| -> i64 { mine.iter().filter(|a| a.outcome == outcome).map(|a| a.n).sum() };
    let served_rows: Vec<&&Attestation> = mine.iter().filter(|a| a.outcome == Outcome::SERVED).collect();
    let served_n: i64 = served_rows.iter().map(|a| a.n).sum();
    let ms_total: f64 = served_rows.iter().map(|a| a.ms_total).sum();
    let mut versions: Vec<(&str, i64)> = mine
        .iter()
        .filter(|a| a.is_serving() && !a.src_hash.is_empty())
        .map(|a| (a.src_hash.as_str(), a.last_at))
        .collect();
    versions.sort_by_key(|v| std::cmp::Reverse(v.1));
    versions.dedup_by(|a, b| a.0 == b.0);

    RecordMetrics {
        record_id: record_id.to_string(),
        sessions: mine.iter().map(|a| a.session.as_str()).collect::<BTreeSet<_>>().len() as i64,
        served: served_n,
        linked: count(Outcome::LINKED),
        declined: mine.iter().filter(|a| a.is_declined()).map(|a| a.n).sum(),
        // Derived, never stored: a mean that disagreed with its own counters would be worse than none.
        compile_ms_mean: (served_n > 0 && ms_total > 0.0).then(|| ms_total / served_n as f64),
        compile_ms_max: served_rows
            .iter()
            .map(|a| a.ms_max)
            .fold(None::<f64>, |acc, m| Some(acc.map_or(m, |a: f64| a.max(m))))
            .filter(|m| *m > 0.0),
        versions_ran: versions.into_iter().map(|(h, _)| h.to_string()).collect(),
        last_at: mine.iter().map(|a| a.last_at).max().unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Filter, NewAttestation, Store};

    /// Build a store from observations, then read it back — so these test the REAL rows, folded by the
    /// real fold, rather than hand-built structs that could not occur.
    fn report(obs: &[NewAttestation], records: &[(&str, &str)]) -> RuntimeReport {
        let mut store = Store::open_in_memory().unwrap();
        store.fold_batch(obs).unwrap();
        let rows = store.list(&Filter::default()).unwrap();
        let recs: Vec<RecordRef> =
            records.iter().map(|(id, h)| RecordRef { id: (*id).into(), src_hash: (*h).into() }).collect();
        analyze(&rows, &recs)
    }

    fn obs(record: &str, outcome: &str, hash: &str, n: i64) -> NewAttestation {
        NewAttestation {
            specifier: format!("@/{record}"),
            record_id: record.into(),
            src_hash: hash.into(),
            outcome: outcome.into(),
            session: "s1".into(),
            n,
            at: 1,
            ..Default::default()
        }
    }

    /// THE guard rail. An empty store means nothing was MEASURED; reporting every record as never-ran
    /// would be technically true, useless, and would train a reader to ignore the whole lens.
    #[test]
    fn an_unmeasured_store_reports_nothing_rather_than_everything() {
        let r = report(&[], &[("a", "h"), ("b", "h")]);
        assert_eq!(r.sessions, 0);
        assert!(r.unmeasured);
        assert!(r.findings.is_empty(), "no findings at all — not 'never-ran' twice");
    }

    #[test]
    fn a_declined_record_is_the_top_finding_and_names_its_cause() {
        let r = report(
            &[NewAttestation { reason: Some("needs @/missing".into()), ..obs("a", Outcome::DECLINED_CLOSURE, "", 3) }],
            &[("a", "h1")],
        );
        let f = r.findings.iter().find(|f| f.category == "declined").expect("a declined finding");
        assert_eq!(f.severity, 4);
        assert!(f.why.contains("3×"), "the count rides along: {}", f.why);
        assert!(f.why.contains("needs @/missing"), "the cause is named: {}", f.why);
        assert!(f.suggested_action.contains("register"), "and the action is specific: {}", f.suggested_action);
        // A declined record must NOT also be called stale — it is already the more severe finding, and
        // saying both trains the reader to skim.
        assert!(!r.findings.iter().any(|f| f.category == "stale"));
    }

    /// Enough sessions to trust absence.
    fn over_min_sessions(record: &str, hash: &str) -> Vec<NewAttestation> {
        (0..NEVER_RAN_MIN_SESSIONS)
            .map(|i| NewAttestation { session: format!("s{i}"), ..obs(record, Outcome::SERVED, hash, 1) })
            .collect()
    }

    #[test]
    fn a_record_with_no_attestation_is_never_ran_once_enough_was_measured() {
        let r = report(&over_min_sessions("a", "h1"), &[("a", "h1"), ("ghost", "h9")]);
        let never: Vec<_> = r.findings.iter().filter(|f| f.category == "never-ran").collect();
        assert_eq!(never.len(), 1);
        assert_eq!(never[0].record_id, "ghost");
        assert!(!r.never_ran_withheld);
    }

    /// ONE session cannot exercise the whole app. Claiming never-ran off it produced 586 findings against
    /// the real store — a report nobody reads twice — while every record in it might simply not have been
    /// visited yet. The OTHER findings still stand: they are evidence of something that happened.
    #[test]
    fn never_ran_is_withheld_until_there_are_enough_sessions() {
        let r = report(
            &[obs("a", Outcome::SERVED, "h1", 1), obs("bad", Outcome::DECLINED_EVAL, "", 1)],
            &[("a", "h1"), ("bad", "h"), ("ghost", "h9")],
        );
        assert!(r.never_ran_withheld);
        assert!(!r.findings.iter().any(|f| f.category == "never-ran"), "absence is not yet evidence");
        assert!(r.findings.iter().any(|f| f.category == "declined"), "but a decline that HAPPENED still is");
    }

    /// The point of `src_hash`: an edit that has not been exercised is visible, and that is where a
    /// broken record hides.
    #[test]
    fn a_record_whose_current_source_never_ran_is_stale() {
        let r = report(&[obs("a", Outcome::SERVED, "old-hash", 2)], &[("a", "new-hash")]);
        assert!(r.findings.iter().any(|f| f.category == "stale" && f.record_id == "a"));
    }

    #[test]
    fn a_record_serving_its_current_source_is_clean() {
        let r = report(&[obs("a", Outcome::SERVED, "h1", 1)], &[("a", "h1")]);
        assert!(r.findings.is_empty(), "nothing to report: {:?}", r.findings);
    }

    /// A LINKED-only record (the shape an algorithm implementation takes) counts as running — it must
    /// not be reported never-ran just because it never mounted as a component.
    #[test]
    fn a_linked_implementation_counts_as_running() {
        let r = report(&[obs("merge-rs", Outcome::LINKED, "h1", 5)], &[("merge-rs", "h1")]);
        assert!(r.findings.is_empty(), "linkage is running: {:?}", r.findings);
    }

    #[test]
    fn a_fallback_and_a_render_throw_are_each_reported() {
        let r = report(
            &[
                obs("a", Outcome::FELL_BACK, "h1", 1),
                NewAttestation { reason: Some("cannot read x".into()), ..obs("b", Outcome::RENDER_THREW, "h1", 2) },
            ],
            &[("a", "h1"), ("b", "h1")],
        );
        let fell = r.findings.iter().find(|f| f.category == "fell-back").unwrap();
        assert!(fell.suggested_action.contains("revert a"), "{}", fell.suggested_action);
        let threw = r.findings.iter().find(|f| f.category == "render-threw").unwrap();
        assert!(threw.why.contains("cannot read x"), "{}", threw.why);
    }

    /// The loop the loader's own notes describe — ~2.1s for work one compile does in ~700ms — with no
    /// detector until now.
    #[test]
    fn a_recompiling_record_is_flagged_and_an_ordinary_one_is_not() {
        let loud = report(&[obs("a", Outcome::SERVED, "h1", 72)], &[("a", "h1")]);
        let f = loud.findings.iter().find(|f| f.category == "recompile-loop").expect("flagged");
        assert!(f.why.contains("72×"), "{}", f.why);

        let ordinary = report(&[obs("a", Outcome::SERVED, "h1", 3)], &[("a", "h1")]);
        assert!(!ordinary.findings.iter().any(|f| f.category == "recompile-loop"), "3 mounts in a session is normal");
    }

    #[test]
    fn a_slow_compile_is_flagged_from_the_slowest_not_the_mean() {
        // A record that is usually fast and occasionally terrible is still a problem, and a mean hides it.
        let r = report(
            &[NewAttestation { ms_total: 2200.0, ms_max: 2000.0, ..obs("a", Outcome::SERVED, "h1", 10) }],
            &[("a", "h1")],
        );
        assert!(r.findings.iter().any(|f| f.category == "slow-compile"));
        let fast = report(
            &[NewAttestation { ms_total: 700.0, ms_max: 700.0, ..obs("a", Outcome::SERVED, "h1", 1) }],
            &[("a", "h1")],
        );
        assert!(!fast.findings.iter().any(|f| f.category == "slow-compile"));
    }

    #[test]
    fn findings_are_ranked_most_severe_first_and_are_stable() {
        // Enough sessions that NEVER-RAN is claimable, so the ranking is exercised across severities.
        let mut o = over_min_sessions("a", "old");
        o.push(obs("z", Outcome::DECLINED_EVAL, "", 1));
        let r = report(&o, &[("a", "new"), ("z", "h"), ("ghost", "h")]);
        let cats: Vec<_> = r.findings.iter().map(|f| f.category).collect();
        assert_eq!(cats.first(), Some(&"declined"), "severity 4 leads: {cats:?}");
        assert_eq!(cats.last(), Some(&"never-ran"), "severity 1 trails: {cats:?}");
        // Deterministic across runs over the same data.
        let mut o2 = over_min_sessions("a", "old");
        o2.push(obs("z", Outcome::DECLINED_EVAL, "", 1));
        assert_eq!(r, report(&o2, &[("a", "new"), ("z", "h"), ("ghost", "h")]));
    }

    /// A file-served module contributes an EMPTY record id and must never be attributed to a record —
    /// otherwise a record that genuinely never ran reads as healthy.
    #[test]
    fn a_file_served_row_is_not_credited_to_any_record() {
        // Enough sessions for never-ran to be claimable, all of them FILE-served: the record itself is
        // still never-ran, because an empty record id belongs to no record.
        let o: Vec<NewAttestation> = (0..NEVER_RAN_MIN_SESSIONS)
            .map(|i| NewAttestation {
                record_id: String::new(),
                session: format!("s{i}"),
                ..obs("a", Outcome::SERVED, "h1", 1)
            })
            .collect();
        let r = report(&o, &[("a", "h1")]);
        assert!(r.findings.iter().any(|f| f.category == "never-ran" && f.record_id == "a"));
    }

    /// Sessions are the denominator, so the loop threshold must scale with them rather than firing on
    /// any user who opens a page a few times a day.
    #[test]
    fn the_recompile_threshold_is_per_session_not_absolute() {
        let obs_over = |sess: &str, n: i64| NewAttestation { session: sess.into(), ..obs("a", Outcome::SERVED, "h1", n) };
        let spread = report(&[obs_over("s1", 3), obs_over("s2", 3), obs_over("s3", 3)], &[("a", "h1")]);
        assert!(!spread.findings.iter().any(|f| f.category == "recompile-loop"), "9 mounts over 3 sessions is fine");
        let concentrated = report(&[obs_over("s1", 9)], &[("a", "h1")]);
        assert!(concentrated.findings.iter().any(|f| f.category == "recompile-loop"), "9 in ONE session is not");
    }

    #[test]
    fn metrics_summarise_one_records_attestations() {
        let mut store = Store::open_in_memory().unwrap();
        store
            .fold_batch(&[
                NewAttestation { ms_total: 1400.0, ms_max: 800.0, ..obs("a", Outcome::SERVED, "h-old", 2) },
                NewAttestation { ms_total: 600.0, ms_max: 600.0, at: 99, ..obs("a", Outcome::SERVED, "h-new", 1) },
                obs("a", Outcome::LINKED, "h-new", 4),
                NewAttestation { reason: Some("needs x".into()), ..obs("a", Outcome::DECLINED_EVAL, "", 1) },
                obs("other", Outcome::SERVED, "z", 9),
            ])
            .unwrap();
        let rows = store.list(&Filter::default()).unwrap();
        let m = metrics_for(&rows, "a");

        assert_eq!(m.served, 3);
        assert_eq!(m.linked, 4);
        assert_eq!(m.declined, 1);
        // Mean over the SERVED observations only — 2000ms across 3 mounts.
        assert_eq!(m.compile_ms_mean, Some(2000.0 / 3.0));
        assert_eq!(m.compile_ms_max, Some(800.0));
        // Newest sighting first, deduped — the version history the reader actually wants.
        assert_eq!(m.versions_ran, ["h-new", "h-old"]);
        assert_eq!(m.last_at, 99);
        // …and another record's rows never leak in.
        assert_eq!(m.sessions, 1);
    }

    #[test]
    fn metrics_for_an_unseen_record_are_empty_rather_than_absent() {
        // A caller joining this onto `bsc ui get` needs a shape either way; `null` would make every
        // consumer branch, and "zero sessions" is the honest reading of no data.
        let store = Store::open_in_memory().unwrap();
        let m = metrics_for(&store.list(&Filter::default()).unwrap(), "ghost");
        assert_eq!(m.sessions, 0);
        assert_eq!(m.served, 0);
        assert_eq!(m.compile_ms_mean, None);
        assert!(m.versions_ran.is_empty());
        assert_eq!(m.last_at, 0);
    }

    /// A record that only ever LINKED has no compile timing of its own — an implementation is compiled
    /// as part of someone else's closure. Reporting a zero would read as "instant" rather than "not
    /// measured".
    #[test]
    fn a_linked_only_record_reports_no_compile_timing() {
        let mut store = Store::open_in_memory().unwrap();
        store.fold_batch(&[obs("impl", Outcome::LINKED, "h", 3)]).unwrap();
        let m = metrics_for(&store.list(&Filter::default()).unwrap(), "impl");
        assert_eq!(m.linked, 3);
        assert_eq!(m.compile_ms_mean, None);
        assert_eq!(m.compile_ms_max, None);
        assert_eq!(m.versions_ran, ["h"], "linkage still records WHICH version linked");
    }

    /// The `--metrics` CONTRACT both CLIs rely on: nothing measured ⇒ the caller emits `null`, never a
    /// zeroed object. Zeros read as "ran nowhere, cost nothing", which is a claim; null says the store
    /// has nothing to say. Both `bsc ui get --metrics` and `bsc graph impl get --metrics` branch on
    /// exactly this, so it is pinned here rather than twice in two CLIs.
    #[test]
    fn zero_sessions_is_the_signal_callers_use_to_emit_null() {
        let store = Store::open_in_memory().unwrap();
        let m = metrics_for(&store.list(&Filter::default()).unwrap(), "anything");
        assert_eq!(m.sessions, 0, "the field every --metrics caller filters on");
    }

    /// A record that has ONLY been declined must not read as healthy: `served` is zero, `declined` is
    /// not, and `sessions` is non-zero so the caller still emits the object rather than null. That
    /// combination is the whole point — "we measured it, and it did not serve".
    #[test]
    fn a_declined_only_record_reports_measured_but_not_serving() {
        let mut store = Store::open_in_memory().unwrap();
        store.fold_batch(&[obs("a", Outcome::DECLINED_CLOSURE, "", 2)]).unwrap();
        let m = metrics_for(&store.list(&Filter::default()).unwrap(), "a");
        assert_eq!(m.sessions, 1);
        assert_eq!(m.served, 0);
        assert_eq!(m.declined, 2);
        assert!(m.versions_ran.is_empty(), "a decline claims no version");
    }
}
