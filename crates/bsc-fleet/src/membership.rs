//! Who the fleet IS, as distinct from who is running right now.
//!
//! ## Why this is a separate question
//! `bsc fleet list` used to take the SET of panes it reports from the hub's `fleet.roster.tsv`, and —
//! when there was no roster — from the app's live PTY session map. Both answer "who is running", so a
//! worker that had stopped produced no row at all. On `network-monitor` that meant a director looking
//! at a 38-stream fleet saw ONE row: itself. Every worker was invisible, and the `live: false` state
//! the director protocol documents as the wake case was unreachable in practice.
//!
//! The roster made it worse than merely incomplete: `publishFleetRoster` rewrites the whole file with
//! whatever the latest launch produced, so a director-only relaunch CLOBBERS the worker rows — the
//! command was reading a launch side-effect and calling it the roster.
//!
//! ## The split this module draws
//! **plan.db owns MEMBERSHIP** — the fleet-session ledger (`fleet_sessions`, every agent this project
//! has launched, persisted across a clean quit) unioned with the planned streams (`fleet_streams`).
//! **The app owns LIVENESS** — whether a PTY session exists and whether anything is running in it, a
//! fact no file on disk holds. Asking the app for both is what lost the stopped workers.

use serde::Serialize;

/// The ledger fields this module needs. Mirrors `plandb::FleetSession` but is declared here so the
/// membership rules stay testable without a database — the join is the part that goes wrong, and it
/// should be exercised with a table of rows, not a fixture db.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LedgerRow {
    pub pane_id: String,
    pub stream_id: String,
    pub role: String,
    pub launched_at: i64,
    pub last_seen: i64,
    pub status: String,
}

/// One expected member of a project's fleet, before liveness is asked for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub pane_id: String,
    /// The owning stream id. Blank for the director and for triage panes, which are not streams.
    pub stream: String,
    pub role: String,
    /// Named by the fleet PLAN — this stream is supposed to exist, whether or not it ever launched.
    pub planned: bool,
    /// Present in the session ledger — this pane was launched at some point. The distinction between
    /// this and `planned` is what separates "stopped" from "never launched", and they are different
    /// problems: one is a wake, the other is a launch that never happened.
    pub launched: bool,
    /// The ledger's own last-written status. Reported as PROVENANCE, never as liveness: it is only as
    /// fresh as the last heartbeat, and the whole point of this command is that the app is the
    /// authority on what is running.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub ledger_status: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub launched_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub last_seen: i64,
    /// This stream's issue tally. Zeroed for the director and for triage panes, which own no stream.
    #[serde(rename = "issues")]
    pub progress: Progress,
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

/// What a director should DO about this pane. Each variant maps to exactly one move, which is the
/// reason it is computed here rather than left to the reader to infer from two booleans — the middle
/// two are the ones that were previously invisible or indistinguishable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// A session exists and something is running in it. Leave it alone.
    Running,
    /// The shell is up but its agent has exited. Looks alive, does nothing — a wake case.
    Idle,
    /// Launched at some point, no session now (parked or reclaimed). A wake case.
    Stopped,
    /// The plan names this stream and nothing ever launched it. Not a wake — a launch.
    NeverLaunched,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Running => "running",
            State::Idle => "idle",
            State::Stopped => "stopped",
            State::NeverLaunched => "never-launched",
        }
    }

    /// Classify one member against the app's answer. `None` means the app is not tracking this pane
    /// at all, which is the ordinary state of a stopped worker — NOT an anomaly, and the reason a
    /// missing pane must produce a row rather than be dropped.
    ///
    /// The second element is whether an AGENT is running, NOT whether the shell is busy
    /// (#fleet-list-reports-whether-the-agent-is-running). `busy` means "something is in flight", which
    /// is the right question for Resume and the wrong one here: a sandboxed pane is busy at a bare
    /// prompt, because its own `bwrap` plumbing and the shell inside it are descendants, so it could
    /// never report `idle` — the state that tells a director to wake it.
    pub fn classify(m: &Member, live: Option<(bool, bool)>) -> State {
        match live {
            Some((true, true)) => State::Running,
            Some((true, false)) => State::Idle,
            // A tracked pane whose session is gone reads exactly like an untracked one; both are the
            // absence of a session, so they must not classify differently.
            Some((false, _)) | None => {
                if m.launched {
                    State::Stopped
                } else {
                    State::NeverLaunched
                }
            }
        }
    }
}

/// A stream's issue tally — what the worker has actually ACHIEVED, as against whether it is breathing.
///
/// Liveness and progress answer different questions and a director needs both: 38 stopped workers is
/// one report, but "34 of them stopped having finished and 4 stopped at issue one" is the report that
/// says which to wake. Both come out of the same plan.db read, so carrying the tally costs one query.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub total: usize,
    /// `complete` + `verified` — plandb's `DONE_STATUSES`.
    pub done: usize,
    pub open: usize,
    pub in_progress: usize,
    pub blocked: usize,
    pub failed: usize,
}

impl Progress {
    /// Tally one stream's issue statuses. An UNKNOWN status counts toward `total` and nothing else:
    /// silently binning it as `open` would invent work, and dropping it from `total` would inflate the
    /// completion ratio — which is the number a director decides on.
    pub fn tally<'a>(statuses: impl IntoIterator<Item = &'a str>) -> Progress {
        let mut p = Progress::default();
        for s in statuses {
            p.total += 1;
            match s {
                "complete" | "verified" => p.done += 1,
                "open" => p.open += 1,
                "in_progress" => p.in_progress += 1,
                "blocked" => p.blocked += 1,
                "failed" => p.failed += 1,
                _ => {}
            }
        }
        p
    }

    /// `done/total`, or `-` for a stream that owns no issues. Deliberately terse: it sits in a column
    /// beside 38 sibling rows, and the exceptions (blocked/failed) are called out under the table
    /// where they will be read rather than widened into every row.
    pub fn cell(&self) -> String {
        if self.total == 0 {
            "-".to_string()
        } else {
            format!("{}/{}", self.done, self.total)
        }
    }

    /// Work that is stuck rather than merely unstarted — the part a director must route.
    pub fn stuck(&self) -> usize {
        self.blocked + self.failed
    }
}

/// The DIRECTOR pane-id suffix — `<projectKey>:director`, the one spelling create / list / brief share.
pub const DIRECTOR_SUFFIX: &str = ":director";

/// The project key in front of a pane id (`<key>:<stream>`, `<key>:<repo>:triage`). Project keys are
/// slugs and carry no colon, so the first segment is the key.
pub fn project_key_of(pane_id: &str) -> &str {
    pane_id.split(':').next().unwrap_or(pane_id)
}

/// A worker's pane id — the one grammar `fleetPaneId` uses, so a member id is the id a director types
/// into `bsc fleet wake` / `bsc-answer` / `bsc-assign`.
pub fn worker_pane_id(project_key: &str, stream_id: &str) -> String {
    format!("{project_key}:{stream_id}")
}

/// Build the expected fleet from plan.db's two records.
///
/// Order is DELIBERATE and stable: the director first (it is the reader), then the planned streams in
/// plan order (which is dependency order, so the top of the list is the work that unblocks the rest),
/// then anything the ledger knows that the plan does not — a stream since removed from the plan still
/// has a launched session somewhere, and dropping it would hide a running agent nobody owns.
///
/// `planned_streams` is the plan's stream ids in plan order; `director` is whether the plan enables one.
pub fn build(
    project_key: &str,
    ledger: &[LedgerRow],
    planned_streams: &[String],
    director: bool,
) -> Vec<Member> {
    // Names first, rows second. The two passes exist because the ledger sweep must know which panes
    // the plan already claimed, and a single closure that both reads and appends cannot be borrowed
    // twice.
    let director_pane = format!("{project_key}{DIRECTOR_SUFFIX}");
    let mut names: Vec<(String, String, &str, bool)> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    if director || ledger.iter().any(|r| r.pane_id == director_pane) {
        seen.insert(director_pane.clone());
        names.push((director_pane, String::new(), "director", director));
    }
    for id in planned_streams {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        let pane = worker_pane_id(project_key, id);
        if seen.insert(pane.clone()) {
            names.push((pane, id.to_string(), "worker", true));
        }
    }
    // Ledger-only rows, in a stable order so two runs of the command agree.
    let mut extra: Vec<&LedgerRow> = ledger.iter().filter(|r| !seen.contains(&r.pane_id)).collect();
    extra.sort_by(|a, b| a.pane_id.cmp(&b.pane_id));
    for r in extra {
        if seen.insert(r.pane_id.clone()) {
            names.push((r.pane_id.clone(), r.stream_id.clone(), "worker", false));
        }
    }

    names
        .into_iter()
        .map(|(pane_id, stream, role, planned)| {
            let row = ledger.iter().find(|r| r.pane_id == pane_id);
            Member {
                stream: row
                    .map(|r| r.stream_id.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(stream),
                role: row
                    .map(|r| r.role.clone())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| role.to_string()),
                planned,
                launched: row.is_some(),
                ledger_status: row.map(|r| r.status.clone()).unwrap_or_default(),
                launched_at: row.map(|r| r.launched_at).unwrap_or(0),
                last_seen: row.map(|r| r.last_seen).unwrap_or(0),
                progress: Progress::default(),
                pane_id,
            }
        })
        .collect()
}

/// Attach each member's stream progress. Separate from [`build`] because membership is answerable
/// from two records and progress from a third — folding the issue read into the builder would make
/// every membership test carry an issue table it does not use.
///
/// Keyed by STREAM, not by pane: a pane id is `<key>:<stream>` for a worker, but the director and a
/// triage pane own no stream, and giving them the tally of a stream whose id happened to match would
/// report someone else's work as theirs.
pub fn attach_progress(
    members: &mut [Member],
    by_stream: &std::collections::HashMap<String, Progress>,
) {
    for m in members.iter_mut() {
        if m.stream.is_empty() {
            continue;
        }
        if let Some(p) = by_stream.get(&m.stream) {
            m.progress = *p;
        }
    }
}

/// One project's director, before liveness is asked for — the architect's tier read.
///
/// Deliberately NOT a [`Member`]: a director row is keyed by PROJECT and carries that project's whole
/// issue tally, where a member is keyed by stream and carries its own. Reusing one struct would mean
/// a `stream` field that is always blank and a `planned` flag that means something different.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorMember {
    pub project_key: String,
    pub pane_id: String,
    /// The plan's fleet meta enables a director for this project.
    pub planned: bool,
    /// A ledger row exists — this director was actually launched at some point.
    pub launched: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub ledger_status: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub launched_at: i64,
    #[serde(skip_serializing_if = "is_zero")]
    pub last_seen: i64,
    /// The PROJECT's issue tally, not one stream's — what this director is accountable for.
    #[serde(rename = "issues")]
    pub progress: Progress,
}

impl DirectorMember {
    /// The liveness question this row answers, in [`Member`] terms, so both tiers classify through
    /// one function rather than growing a second copy of the state rules that could drift.
    fn as_member(&self) -> Member {
        Member { launched: self.launched, ..Default::default() }
    }

    /// This director's state against the app's answer.
    pub fn state(&self, live: Option<(bool, bool)>) -> State {
        State::classify(&self.as_member(), live)
    }
}

/// Fold app-tracked `:director` panes that no plan store accounts for. Same reason as
/// [`absorb_tracked`]: a director the app is running is the architect's business whether or not a
/// plan store on this machine knows about it.
pub fn absorb_tracked_directors(rows: &mut Vec<DirectorMember>, tracked: &[String]) {
    let known: std::collections::HashSet<&str> =
        rows.iter().map(|r| r.pane_id.as_str()).collect();
    let mut add: Vec<String> = tracked
        .iter()
        .filter(|id| id.ends_with(DIRECTOR_SUFFIX) && !known.contains(id.as_str()))
        .cloned()
        .collect();
    add.sort();
    add.dedup();
    for pane_id in add {
        rows.push(DirectorMember {
            project_key: project_key_of(&pane_id).to_string(),
            pane_id,
            ..Default::default()
        });
    }
}

/// Order the tier for reading: projects whose director is NOT running first (they are the ones an
/// architect must act on), then alphabetically inside each group so two runs agree.
pub fn sort_directors(rows: &mut [DirectorMember], state_of: impl Fn(&DirectorMember) -> State) {
    rows.sort_by(|a, b| {
        let rank = |r: &DirectorMember| match state_of(r) {
            State::Running => 1,
            _ => 0,
        };
        rank(a).cmp(&rank(b)).then_with(|| a.project_key.cmp(&b.project_key))
    });
}

/// Fold panes the APP is tracking for this project that membership does not name. Without this, a
/// session running outside the plan (a hand-opened pane, a stream deleted from the plan while its
/// worker still runs) would be silently dropped by the join — the same class of omission this whole
/// module exists to remove, just from the other side.
pub fn absorb_tracked(members: &mut Vec<Member>, project_key: &str, tracked: &[String]) {
    let known: std::collections::HashSet<&str> =
        members.iter().map(|m| m.pane_id.as_str()).collect();
    let mut add: Vec<String> = tracked
        .iter()
        .filter(|id| project_key_of(id) == project_key && !known.contains(id.as_str()))
        .cloned()
        .collect();
    add.sort();
    add.dedup();
    for pane_id in add {
        let role = if pane_id.ends_with(DIRECTOR_SUFFIX) { "director" } else { "" };
        members.push(Member {
            stream: String::new(),
            role: role.to_string(),
            planned: false,
            launched: false,
            ledger_status: String::new(),
            launched_at: 0,
            last_seen: 0,
            progress: Progress::default(),
            pane_id,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pane: &str, stream: &str, role: &str) -> LedgerRow {
        LedgerRow {
            pane_id: pane.into(),
            stream_id: stream.into(),
            role: role.into(),
            launched_at: 100,
            last_seen: 200,
            status: "running".into(),
        }
    }

    /// THE BUG, as a test. network-monitor's ledger holds 39 launched agents and its plan 38 streams;
    /// the app tracks exactly one of them. Membership must still be 39 rows — the report the director
    /// actually needs is "38 of your workers are stopped", and the old path printed one row.
    #[test]
    fn a_stopped_worker_is_still_a_member() {
        let streams: Vec<String> = (0..38).map(|i| format!("stream-{i}")).collect();
        let mut ledger = vec![row("nm:director", "", "director")];
        ledger.extend(streams.iter().map(|s| row(&format!("nm:{s}"), s, "worker")));

        let members = build("nm", &ledger, &streams, true);
        assert_eq!(members.len(), 39, "every launched agent is a member, running or not");
        assert_eq!(members[0].pane_id, "nm:director", "the director reads its own row first");
        assert!(members.iter().all(|m| m.launched), "all 39 are in the ledger");

        // Only the director is tracked by the app — exactly the measured state.
        let tracked = |m: &Member| {
            if m.pane_id == "nm:director" { Some((true, true)) } else { None }
        };
        let states: Vec<State> = members.iter().map(|m| State::classify(m, tracked(m))).collect();
        assert_eq!(states[0], State::Running);
        assert_eq!(states.iter().filter(|s| **s == State::Stopped).count(), 38);
    }

    /// The two ways a pane can have no work happening in it are DIFFERENT moves, and the middle one
    /// is the one that hides: a live shell whose agent exited looks alive in every other view.
    #[test]
    fn the_four_states_separate_the_moves() {
        let launched = Member { launched: true, ..Default::default() };
        let never = Member { launched: false, ..Default::default() };

        assert_eq!(State::classify(&launched, Some((true, true))), State::Running);
        assert_eq!(State::classify(&launched, Some((true, false))), State::Idle);
        assert_eq!(State::classify(&launched, None), State::Stopped);
        assert_eq!(State::classify(&never, None), State::NeverLaunched);
        // A pane the app tracks but reports dead is the same absence as one it does not track — the
        // director's move is identical, so the classification must be too.
        assert_eq!(State::classify(&launched, Some((false, false))), State::Stopped);
        assert_eq!(State::classify(&never, Some((false, false))), State::NeverLaunched);
    }

    /// A planned stream that never launched is not a wake — it is a launch that never happened, and
    /// reporting it as `stopped` would send a director to `bsc fleet wake` for a pane that has no
    /// worktree behind it.
    #[test]
    fn planned_but_never_launched_is_its_own_state() {
        let members = build("nm", &[], &["api".into(), "ui".into()], false);
        assert_eq!(members.len(), 2);
        assert!(members.iter().all(|m| m.planned && !m.launched));
        assert_eq!(State::classify(&members[0], None), State::NeverLaunched);
        assert_eq!(members[0].role, "worker", "an unlaunched stream still reads as a worker");
    }

    /// A stream dropped from the plan whose worker still has a ledger row must not vanish: a running
    /// agent nobody owns is precisely what a director needs told.
    #[test]
    fn a_ledger_row_the_plan_no_longer_names_survives() {
        let ledger = vec![row("nm:api", "api", "worker"), row("nm:retired", "retired", "worker")];
        let members = build("nm", &ledger, &["api".into()], false);
        assert_eq!(members.len(), 2);
        let retired = members.iter().find(|m| m.pane_id == "nm:retired").unwrap();
        assert!(retired.launched && !retired.planned, "launched, but no longer planned");
    }

    /// The director row appears when the PLAN enables one and also when only the ledger knows it —
    /// a director created by `bsc fleet director new` on a plan whose meta never set `director`.
    #[test]
    fn the_director_appears_from_either_source_and_only_once() {
        assert_eq!(build("nm", &[], &[], true)[0].pane_id, "nm:director");
        let from_ledger = build("nm", &[row("nm:director", "", "director")], &[], false);
        assert_eq!(from_ledger.len(), 1, "not duplicated by the ledger sweep");
        assert_eq!(from_ledger[0].role, "director");
        assert!(build("nm", &[], &[], false).is_empty(), "no director, none invented");
    }

    /// Plan order is dependency order, so it is the order a director wants to read. A HashSet-backed
    /// dedup must not leak its iteration order into the output.
    #[test]
    fn planned_streams_keep_plan_order() {
        let streams: Vec<String> = vec!["zeta".into(), "alpha".into(), "mid".into()];
        let members = build("nm", &[], &streams, true);
        let ids: Vec<&str> = members.iter().map(|m| m.pane_id.as_str()).collect();
        assert_eq!(ids, vec!["nm:director", "nm:zeta", "nm:alpha", "nm:mid"]);
    }

    /// A pane the app is running that the plan store has never heard of is still the director's
    /// problem, so the join folds it in rather than dropping it — and only for THIS project.
    #[test]
    fn a_tracked_pane_the_plan_does_not_know_is_folded_in() {
        let mut members = build("nm", &[], &["api".into()], false);
        absorb_tracked(
            &mut members,
            "nm",
            &["nm:api".into(), "nm:mystery".into(), "other:worker".into(), "nm:director".into()],
        );
        let ids: Vec<&str> = members.iter().map(|m| m.pane_id.as_str()).collect();
        assert_eq!(ids, vec!["nm:api", "nm:director", "nm:mystery"]);
        assert!(!ids.contains(&"other:worker"), "another project's pane is not this fleet");
        // It is folded in as an unplanned, unlaunched member — so it classifies off the app's answer
        // alone rather than claiming a ledger provenance it does not have.
        let mystery = members.iter().find(|m| m.pane_id == "nm:mystery").unwrap();
        assert!(!mystery.planned && !mystery.launched);
        assert_eq!(State::classify(mystery, Some((true, true))), State::Running);
        // The suffix still names the role even when nothing else does.
        assert_eq!(members.iter().find(|m| m.pane_id == "nm:director").unwrap().role, "director");
    }

    /// Pane ids are the argument to wake/answer/assign, so the key must come back out of one exactly.
    /// A triage pane carries a second colon and must not truncate the key.
    #[test]
    fn the_project_key_reads_back_out_of_every_pane_id_shape() {
        assert_eq!(project_key_of("network-monitor:director"), "network-monitor");
        assert_eq!(project_key_of("network-monitor:api"), "network-monitor");
        assert_eq!(project_key_of("network-monitor:repo:triage"), "network-monitor");
        assert_eq!(project_key_of("bare"), "bare");
        assert_eq!(worker_pane_id("nm", "api"), "nm:api");
    }

    /// The ledger's own columns win over the ones derived from the plan, because they record what
    /// actually launched. A blank ledger column falls back rather than blanking the row.
    #[test]
    fn ledger_columns_win_but_a_blank_one_does_not_erase_the_derived_value() {
        let mut r = row("nm:api", "", "");
        r.status = "dormant".into();
        let members = build("nm", &[r], &["api".into()], false);
        assert_eq!(members[0].stream, "api", "a blank ledger stream falls back to the plan's id");
        assert_eq!(members[0].role, "worker");
        assert_eq!(members[0].ledger_status, "dormant");
        assert_eq!((members[0].launched_at, members[0].last_seen), (100, 200));
    }

    /// A director sees "38 stopped" and still cannot act: stopped-having-finished and
    /// stopped-at-issue-one are different problems. The tally is what separates them.
    #[test]
    fn progress_tallies_a_streams_issues_by_status() {
        let p = Progress::tally(vec![
            "complete", "verified", "open", "in_progress", "blocked", "failed",
        ]);
        assert_eq!(p.total, 6);
        assert_eq!(p.done, 2, "complete + verified are both done");
        assert_eq!((p.open, p.in_progress, p.blocked, p.failed), (1, 1, 1, 1));
        assert_eq!(p.stuck(), 2, "blocked + failed is the part that needs routing");
        assert_eq!(p.cell(), "2/6");

        // A stream with no issues renders as `-`, never `0/0` — the latter reads as "nothing done"
        // when the truth is "nothing assigned".
        assert_eq!(Progress::default().cell(), "-");
        assert_eq!(Progress::default().stuck(), 0);
    }

    /// An unknown status must not be silently binned. Counting it as `open` invents work; dropping it
    /// from `total` inflates the completion ratio, which is the number the director decides on.
    #[test]
    fn an_unknown_status_counts_toward_the_total_and_nothing_else() {
        let p = Progress::tally(vec!["complete", "wat"]);
        assert_eq!(p.total, 2);
        assert_eq!(p.done, 1);
        assert_eq!(p.open + p.in_progress + p.blocked + p.failed, 0);
        assert_eq!(p.cell(), "1/2", "the ratio stays honest about work it cannot classify");
    }

    /// Progress is keyed by STREAM. The director and triage panes own no stream, so they must get no
    /// tally — handing them a same-named stream's numbers would report someone else's work as theirs.
    #[test]
    fn progress_attaches_by_stream_and_skips_the_streamless() {
        let ledger = vec![row("nm:director", "", "director"), row("nm:api", "api", "worker")];
        let mut members = build("nm", &ledger, &["api".into(), "ui".into()], true);
        let tallies = std::collections::HashMap::from([
            ("api".to_string(), Progress::tally(vec!["complete", "open"])),
            ("director".to_string(), Progress::tally(vec!["open", "open", "open"])),
        ]);
        attach_progress(&mut members, &tallies);

        let get = |pane: &str| members.iter().find(|m| m.pane_id == pane).unwrap().progress;
        assert_eq!(get("nm:api").cell(), "1/2");
        assert_eq!(get("nm:director"), Progress::default(), "the director owns no stream");
        assert_eq!(get("nm:ui"), Progress::default(), "a stream with no issues stays empty");
    }

    fn dir(key: &str, planned: bool, launched: bool) -> DirectorMember {
        DirectorMember {
            project_key: key.into(),
            pane_id: format!("{key}:director"),
            planned,
            launched,
            ..Default::default()
        }
    }

    /// THE ARCHITECT'S HALF OF THE BUG. A director that stopped must be distinguishable from a
    /// project that never created one — that difference is the entire question the verb answers,
    /// since it exists to say whether `bsc plan brief <key>:director` will reach anything.
    #[test]
    fn a_stopped_director_is_distinguishable_from_one_that_never_existed() {
        let stopped = dir("alpha", true, true);
        let never = dir("beta", true, false);
        assert_eq!(stopped.state(None), State::Stopped);
        assert_eq!(never.state(None), State::NeverLaunched);
        assert_ne!(stopped.state(None), never.state(None));
    }

    /// Both tiers classify through ONE function. A second copy of the state rules is how the two
    /// views would drift into disagreeing about what `idle` means.
    #[test]
    fn a_director_classifies_through_the_same_four_states_a_worker_does() {
        let d = dir("alpha", true, true);
        assert_eq!(d.state(Some((true, true))), State::Running);
        assert_eq!(d.state(Some((true, false))), State::Idle, "shell up, agent exited");
        assert_eq!(d.state(Some((false, false))), State::Stopped);
        assert_eq!(d.state(None), State::Stopped);
    }

    /// A director the app is RUNNING whose plan store is missing (moved, deleted, another machine's
    /// project) is still the architect's business. Dropping it would repeat the omission one tier up.
    #[test]
    fn a_tracked_director_no_plan_store_accounts_for_is_folded_in() {
        let mut rows = vec![dir("alpha", true, true)];
        absorb_tracked_directors(
            &mut rows,
            &["alpha:director".into(), "ghost:director".into(), "alpha:api".into()],
        );
        let keys: Vec<&str> = rows.iter().map(|r| r.project_key.as_str()).collect();
        assert_eq!(keys, vec!["alpha", "ghost"]);
        // A WORKER pane must never enter the director tier — that boundary is the verb's whole point.
        assert!(!rows.iter().any(|r| r.pane_id == "alpha:api"));
        let ghost = rows.iter().find(|r| r.project_key == "ghost").unwrap();
        assert!(!ghost.planned && !ghost.launched, "no plan store backs it");
        assert_eq!(ghost.state(Some((true, true))), State::Running);
    }

    /// The rows an architect must ACT on come first. A running director needs nothing; the reason to
    /// read this table is finding the ones that will silently swallow a brief.
    #[test]
    fn directors_sort_the_unreachable_to_the_top() {
        let mut rows = vec![dir("zulu", true, true), dir("alpha", true, true), dir("mike", true, true)];
        // Only `alpha` is up.
        sort_directors(&mut rows, |r| {
            if r.project_key == "alpha" { State::Running } else { State::Stopped }
        });
        let keys: Vec<&str> = rows.iter().map(|r| r.project_key.as_str()).collect();
        assert_eq!(keys, vec!["mike", "zulu", "alpha"], "stopped first, then alphabetical");
    }

    /// A blank / whitespace stream id in the plan cannot become the pane id `nm:` — that id resolves
    /// to nothing and would sit in the list as a permanently unwakeable row.
    #[test]
    fn a_blank_planned_stream_is_skipped() {
        let members = build("nm", &[], &["".into(), "  ".into(), "api".into()], false);
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].pane_id, "nm:api");
    }
}
