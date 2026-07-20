//! `bsc metrics <project>` (#3449, epic #3260) — the fleet-wide GENERATION SCOREBOARD.
//!
//! The maintainer's north star is **generate any app in under 1 second for under $0.01**. You cannot
//! chase a metric you cannot read. The per-pane token/cost data already exists ([`crate::cost`]); what
//! was missing is a rollup to the unit that matters — a whole app's generation — and a latency figure.
//! This is that rollup:
//!
//!   $ · tokens (in/out/cache) · cache-hit-rate · wall-clock · completion (issues done/total)
//!
//! Everything here reuses data the platform already records; nothing new is instrumented at the source:
//! - **cost + tokens** — sum [`crate::cost::all_costs`] over the project's panes.
//! - **wall-clock** — the span of the MOST RECENT run of `activity.log` events across the project's
//!   panes ([`latest_run_span_ms`]). `activity.log` accumulates over a project's whole life, so a naive
//!   first→last read spans weeks (observed: 7730 min); splitting on a silence gap fixes that.
//! - **completion** — the project hub's `plan.db` issue statuses.
//!
//! **Known limitation (a follow-up, not this issue):** the wall-clock is a heuristic because no
//! generation start/complete event exists yet, and the `$` is only as populated as `tokens.log` — the
//! `bsc-tokens` hook must have recorded a pane's transcript for its cost to count. A historical build
//! whose fleet panes were never token-logged reports `$0`, honestly (there is no data to price).
//!
//! ## Attribution
//! Fleet pane ids are `<projKey>:<stream>` / `<projKey>:director` / `<projKey>:<repo>:triage`
//! (the `role_of` grammar). A pane belongs to a project iff it starts with `<projKey>:` — the `:`
//! delimiter makes the match exact, so `foo` never captures `foo-bar`'s panes.
//!
//! Pure core ([`rollup`]) + thin IO ([`project_metrics`]) so the math is unit-testable without files.

use crate::cost::{all_costs, Cost};
use crate::read_stream;
use std::path::Path;

/// The scoreboard for one project's generation.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProjectMetrics {
    pub project: String,
    /// How many fleet panes were attributed to it (director + workers + triage).
    pub panes: usize,
    pub input: u64,
    pub output: u64,
    pub cache_creation: u64,
    pub cache_read: u64,
    pub cost_usd: f64,
    /// `cache_read / (input + cache_read)` — the fraction of INPUT served from cache, the dial the
    /// prompt-caching lever moves. `0.0` when there is no input yet.
    pub cache_hit_rate: f64,
    /// Wall-clock of the MOST RECENT generation run, in ms — the span of the last contiguous burst of
    /// activity, split from earlier runs on a silence gap (see [`EPISODE_GAP_MS`]). `0` when there is
    /// nothing to bracket. This is deliberately the *last run*, not first-ever→last-ever: `activity.log`
    /// accumulates across every relaunch over a project's life, so an unsplit span reads as weeks. Until
    /// a real generation start/complete event exists (a follow-up), this is the honest heuristic — and
    /// it is ELAPSED for the last run, FINAL only when `status` is [`BuildStatus::Final`].
    pub wall_clock_ms: u64,
    /// Issues at `complete`/`verified` — `None` when the project has no readable `plan.db`.
    pub issues_done: Option<u64>,
    /// Total issues in the plan — `None` when there is no readable `plan.db`.
    pub issues_total: Option<u64>,
    /// The per-pane cost rows behind the totals (newest pane first), so a caller can see WHERE the
    /// spend went without a second query.
    pub per_pane: Vec<Cost>,
}

/// Whether the build the numbers describe is finished, still running, or of unknown completion — so a
/// `$`/wall-clock for a half-done build is never mistaken for a final one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuildStatus {
    /// Every planned issue is complete/verified — the numbers are the FINAL cost + duration.
    Final,
    /// Issues remain — the numbers are elapsed-so-far, not the total.
    InFlight,
    /// No readable `plan.db` — completion cannot be judged, so treat the numbers as a snapshot.
    Unknown,
}

impl ProjectMetrics {
    pub fn status(&self) -> BuildStatus {
        match (self.issues_done, self.issues_total) {
            (Some(done), Some(total)) if total > 0 && done >= total => BuildStatus::Final,
            (Some(_), Some(total)) if total > 0 => BuildStatus::InFlight,
            _ => BuildStatus::Unknown,
        }
    }
}

/// Does `pane` belong to `project`? A fleet pane is `<projKey>:<...>`; the trailing `:` makes this an
/// exact match on the key segment (never a prefix bleed — `foo` vs `foo-bar`).
pub fn belongs_to(project: &str, pane: &str) -> bool {
    pane.len() > project.len()
        && pane.as_bytes()[project.len()] == b':'
        && pane.starts_with(project)
}

/// The pure rollup: fold the per-pane costs + activity timestamps + optional completion into one
/// [`ProjectMetrics`]. `activity` is `(pane, epoch_ms)` for every activity event (unfiltered — this
/// filters by project itself, so one test drives the whole computation).
pub fn rollup(
    project: &str,
    costs: &[Cost],
    activity: &[(String, i64)],
    completion: Option<(u64, u64)>,
) -> ProjectMetrics {
    let mut m = ProjectMetrics {
        project: project.to_string(),
        panes: 0,
        input: 0,
        output: 0,
        cache_creation: 0,
        cache_read: 0,
        cost_usd: 0.0,
        cache_hit_rate: 0.0,
        wall_clock_ms: 0,
        issues_done: completion.map(|(d, _)| d),
        issues_total: completion.map(|(_, t)| t),
        per_pane: Vec::new(),
    };

    for c in costs.iter().filter(|c| belongs_to(project, &c.session)) {
        m.input += c.input;
        m.output += c.output;
        m.cache_creation += c.cache_creation;
        m.cache_read += c.cache_read;
        m.cost_usd += c.cost_usd;
        m.per_pane.push(c.clone());
    }
    m.panes = m.per_pane.len();

    let cacheable = m.input + m.cache_read;
    if cacheable > 0 {
        m.cache_hit_rate = m.cache_read as f64 / cacheable as f64;
    }

    m.wall_clock_ms = latest_run_span_ms(project, activity);
    m
}

/// A silence longer than this between activity events starts a NEW run — a relaunch, or a build picked
/// back up the next day. 20 minutes: comfortably longer than a worker's think/wait pause, far shorter
/// than the gap between two separate work sessions.
pub const EPISODE_GAP_MS: i64 = 20 * 60 * 1_000;

/// The span of the MOST RECENT contiguous run of the project's activity. `activity.log` accumulates
/// across every relaunch, so first-ever→last-ever spans the project's whole life (observed: weeks);
/// splitting on [`EPISODE_GAP_MS`] and taking the last episode yields "how long the last run took".
/// Non-positive stamps (a malformed line) are dropped so one bad row can't anchor the bracket at the
/// epoch. `0` when the last run has fewer than two events (nothing to span).
fn latest_run_span_ms(project: &str, activity: &[(String, i64)]) -> u64 {
    let mut ts: Vec<i64> =
        activity.iter().filter(|(p, t)| *t > 0 && belongs_to(project, p)).map(|(_, t)| *t).collect();
    if ts.len() < 2 {
        return 0;
    }
    ts.sort_unstable();
    // Walk back from the newest event; the run ends the moment a gap exceeds the threshold.
    let last = *ts.last().unwrap();
    let mut start = last;
    for pair in ts.windows(2).rev() {
        let (earlier, later) = (pair[0], pair[1]);
        if later - earlier > EPISODE_GAP_MS {
            break; // `later` is the first event of the latest run
        }
        start = earlier;
    }
    (last - start) as u64
}

/// Gather the three sources for `project` and roll them up. `log_dir` holds the log files
/// (`tokens.log`, `activity.log`); `base_dir` is `~/.base-studio-code` (for `projects/<key>/plan.db`),
/// or `None` to skip completion (the numbers then report as [`BuildStatus::Unknown`]).
pub fn project_metrics(log_dir: &Path, base_dir: Option<&Path>, project: &str) -> ProjectMetrics {
    let costs = all_costs(log_dir);
    let activity: Vec<(String, i64)> =
        read_stream(log_dir, "activity").into_iter().map(|e| (e.session, e.ts_ms)).collect();
    let completion = base_dir.and_then(|b| plan_completion(b, project));
    rollup(project, &costs, &activity, completion)
}

/// `(done, total)` issue counts from the project hub's `plan.db`, or `None` when it is absent /
/// unreadable. `done` = `complete` + `verified` (the two terminal-success statuses).
fn plan_completion(base_dir: &Path, project: &str) -> Option<(u64, u64)> {
    let db = base_dir.join("projects").join(project).join("plan.db");
    if !db.exists() {
        return None;
    }
    let store = plandb::Store::open(&db).ok()?;
    let issues = store.list_summary(None, None, None, None).ok()?;
    let total = issues.len() as u64;
    let done = issues.iter().filter(|i| i.status == "complete" || i.status == "verified").count() as u64;
    Some((done, total))
}

// ── CLI (`bsc metrics <project>`) ────────────────────────────────────────────────────────────────

/// `bsc metrics <project> [--json|--pretty]` — the generation scoreboard for one project.
///
/// A single-verb tool (no subcommands): the argument IS the project key. Dispatched by the unified
/// `bsc` binary. Default output is a terse one-liner (an agent reads this to steer itself against the
/// cost target); `--json` is the stable shape a loop consumes; `--pretty` is the human breakdown.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let (mut project, mut json, mut pretty) = (None::<String>, false, false);
    for a in args {
        match a.as_str() {
            "help" | "-h" | "--help" => {
                println!("{}", help(prog));
                return Ok(());
            }
            "--json" => json = true,
            "--pretty" => pretty = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => {
                if project.replace(other.to_string()).is_some() {
                    return Err("give exactly one <project> key".into());
                }
            }
        }
    }
    let project = project.ok_or_else(|| format!("usage: {prog} <project> [--json|--pretty]"))?;

    let dir = crate::log_dir();
    let base = bsc_util::bsc_base_dir();
    let m = project_metrics(&dir, base.as_deref(), &project);
    bsc_cli_util::emit(pretty, json, &m, || lean(&m));
    Ok(())
}

fn help(prog: &str) -> String {
    format!(
        "{prog} — the fleet-wide generation scoreboard (#3449)\n\
         \n\
         USAGE:\n  \
         {prog} <project> [--json|--pretty]\n\
         \n\
         Rolls up one project's whole generation from data the platform already records — every fleet\n\
         pane's token cost, the activity-log wall-clock, and the plan.db completion — into the numbers\n\
         the north-star metric (an app in <1s for <$0.01) is chased against:\n\
         \n  \
         cost      total USD across the director + workers + triage\n  \
         tokens    input / output / cache-creation / cache-read\n  \
         cache     cache-hit-rate = cache_read / (input + cache_read) — the prompt-caching dial\n  \
         wall      first→last activity across the project's panes\n  \
         issues    complete+verified / total (from plan.db) — so an in-flight build is not read as final\n\
         \n\
         <project> is the project KEY (the hub dir name), e.g. `bsc project list` shows them.\n\
         Default output is one terse line; --json is a stable shape for a loop; --pretty is a breakdown."
    )
}

/// Compact `12.3k` / `1.2M` token counts — a scoreboard, not an invoice.
fn kfmt(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

/// `2m14s` / `47s` / `—` (nothing to bracket).
fn dur(ms: u64) -> String {
    if ms == 0 {
        return "—".into();
    }
    let s = ms / 1_000;
    if s >= 60 {
        format!("{}m{:02}s", s / 60, s % 60)
    } else {
        format!("{s}s")
    }
}

/// The terse default line — everything the metric cares about in one glance, agent-readable.
fn lean(m: &ProjectMetrics) -> String {
    let status = match m.status() {
        BuildStatus::Final => "final",
        BuildStatus::InFlight => "in-flight",
        BuildStatus::Unknown => "completion unknown",
    };
    let issues = match (m.issues_done, m.issues_total) {
        (Some(d), Some(t)) => format!("{d}/{t} issues · "),
        _ => String::new(),
    };
    format!(
        "{} · ${:.4} · {} in / {} out · cache {:.0}% · {} · {} panes · {}{}",
        m.project,
        m.cost_usd,
        kfmt(m.input),
        kfmt(m.output),
        m.cache_hit_rate * 100.0,
        dur(m.wall_clock_ms),
        m.panes,
        issues,
        status,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cost(pane: &str, input: u64, output: u64, cache_read: u64, usd: f64) -> Cost {
        Cost {
            session: pane.to_string(),
            model: "claude-opus".into(),
            input,
            output,
            cache_creation: 0,
            cache_read,
            cost_usd: usd,
        }
    }

    #[test]
    fn belongs_to_matches_the_key_segment_exactly() {
        assert!(belongs_to("shop", "shop:director"));
        assert!(belongs_to("shop", "shop:api"));
        assert!(belongs_to("shop", "shop:web:triage"));
        // The `:` delimiter prevents a prefix bleed — the classic slug-collision bug.
        assert!(!belongs_to("shop", "shop-admin:director"));
        assert!(!belongs_to("shop", "shop")); // no colon → not a fleet pane
        assert!(!belongs_to("shop", "other:director"));
        assert!(!belongs_to("shop", "planning_shop")); // the planner is a separate session, not fleet
    }

    #[test]
    fn rollup_sums_only_this_projects_panes() {
        let costs = vec![
            cost("shop:director", 100, 50, 0, 0.10),
            cost("shop:api", 200, 80, 40, 0.20),
            cost("other:director", 999, 999, 999, 9.99), // a different project — excluded
        ];
        let m = rollup("shop", &costs, &[], None);
        assert_eq!(m.panes, 2, "only shop's two panes");
        assert_eq!(m.input, 300);
        assert_eq!(m.output, 130);
        assert!((m.cost_usd - 0.30).abs() < 1e-9, "sums shop's cost, not other's: {}", m.cost_usd);
    }

    #[test]
    fn cache_hit_rate_is_cache_read_over_total_input() {
        // 40 of every 140 input tokens came from cache → ~0.2857.
        let costs = vec![cost("shop:api", 100, 0, 40, 0.0)];
        let m = rollup("shop", &costs, &[], None);
        assert!((m.cache_hit_rate - 40.0 / 140.0).abs() < 1e-9, "got {}", m.cache_hit_rate);

        // No input yet ⇒ 0.0, never a divide-by-zero NaN.
        let empty = rollup("shop", &[], &[], None);
        assert_eq!(empty.cache_hit_rate, 0.0);
    }

    #[test]
    fn wall_clock_spans_the_latest_run_across_the_projects_panes() {
        let activity = vec![
            ("shop:director".to_string(), 1_000),
            ("shop:api".to_string(), 5_500),
            ("shop:director".to_string(), 3_000),
            ("other:director".to_string(), 99_000), // not shop → must not stretch the bracket
            ("shop:web:triage".to_string(), 0),      // malformed stamp → ignored
        ];
        let m = rollup("shop", &[], &activity, None);
        assert_eq!(m.wall_clock_ms, 4_500, "5500 − 1000, ignoring the other project + the bad stamp");
    }

    #[test]
    fn wall_clock_reports_only_the_most_recent_run_not_the_whole_history() {
        // THE bug real data caught: activity.log accumulates across relaunches, so an unsplit
        // first→last read as 7730 minutes. Two runs a day apart must yield the LATEST run's span.
        let day = 24 * 60 * 60 * 1_000_i64;
        let activity = vec![
            ("shop:api".to_string(), 1_000),          // ── run 1 (old): 1_000 → 4_000
            ("shop:director".to_string(), 4_000),
            ("shop:api".to_string(), day + 10_000),   // ── run 2 (recent): +10s → +13s
            ("shop:director".to_string(), day + 13_000),
        ];
        let m = rollup("shop", &[], &activity, None);
        assert_eq!(m.wall_clock_ms, 3_000, "the last run's 3s, not the ~24h whole-history span");
    }

    #[test]
    fn a_pause_shorter_than_the_gap_stays_one_run() {
        // A 10-minute quiet stretch (< EPISODE_GAP_MS) is a worker thinking, not a new run.
        let ten_min = 10 * 60 * 1_000;
        let activity = vec![
            ("shop:api".to_string(), 1_000),
            ("shop:api".to_string(), 1_000 + ten_min),
            ("shop:director".to_string(), 1_000 + 2 * ten_min),
        ];
        let m = rollup("shop", &[], &activity, None);
        assert_eq!(m.wall_clock_ms, 2 * ten_min as u64, "one continuous run across the short pauses");
    }

    #[test]
    fn wall_clock_is_zero_when_there_is_nothing_to_bracket() {
        // A single event can't span a duration; the bracket needs two.
        let one = rollup("shop", &[], &[("shop:api".to_string(), 1_000)], None);
        assert_eq!(one.wall_clock_ms, 0);
        assert_eq!(rollup("shop", &[], &[], None).wall_clock_ms, 0);
    }

    #[test]
    fn status_distinguishes_final_from_in_flight_from_unknown() {
        let with = |done, total| rollup("shop", &[], &[], Some((done, total)));
        assert_eq!(with(5, 5).status(), BuildStatus::Final, "all issues done");
        assert_eq!(with(6, 5).status(), BuildStatus::Final, "done can exceed a shrunk plan");
        assert_eq!(with(2, 5).status(), BuildStatus::InFlight, "issues remain");
        assert_eq!(with(0, 0).status(), BuildStatus::Unknown, "an empty plan judges nothing");
        assert_eq!(rollup("shop", &[], &[], None).status(), BuildStatus::Unknown, "no plan.db");
    }

    #[test]
    fn kfmt_and_dur_stay_compact() {
        assert_eq!(kfmt(950), "950");
        assert_eq!(kfmt(12_340), "12.3k");
        assert_eq!(kfmt(2_500_000), "2.5M");
        assert_eq!(dur(0), "—");
        assert_eq!(dur(47_000), "47s");
        assert_eq!(dur(134_000), "2m14s");
    }

    #[test]
    fn the_lean_line_leads_with_cost_and_flags_an_in_flight_build() {
        let m = rollup(
            "shop",
            &[cost("shop:api", 12_340, 4_100, 40, 0.0342)],
            &[("shop:api".to_string(), 1_000), ("shop:api".to_string(), 135_000)],
            Some((8, 12)),
        );
        let line = lean(&m);
        assert!(line.starts_with("shop · $0.0342 "), "cost is up front: {line}");
        assert!(line.contains("12.3k in / 4.1k out"), "token counts are compact: {line}");
        assert!(line.contains("8/12 issues"), "completion is shown: {line}");
        assert!(line.contains("in-flight"), "an unfinished build is flagged, not read as final: {line}");
    }

    #[test]
    fn a_finished_build_reads_as_final() {
        let m = rollup("shop", &[], &[], Some((12, 12)));
        assert!(lean(&m).ends_with("final"), "{}", lean(&m));
    }
}
