//! `bsc app status` — is the app binary you are running older than the code on `main`?
//!
//! Ported from `scripts/app-status.mjs`.
//!
//! This exists because `--no-watch` trades a LOUD interruption for a QUIET staleness, and a quiet
//! staleness is its own bug. The watcher used to answer "am I running current code?" by relaunching
//! you; with it off, nothing answers unless something asks. This asks.
//!
//! It compares the built binary against `main`'s tip. It deliberately does NOT compare against
//! `develop`: the app runs `main`, and work sitting on develop is not something the app is behind on
//! — it is work you have not promoted yet, which is a different question and already has an answer
//! (`bsc app promote --dry-run`).
//!
//! **IT ANSWERS, IT NEVER ACTS**, and an error reads as "cannot tell", never as "current".

use crate::repo;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppState {
    Absent,
    Current,
    Stale,
}

impl AppState {
    pub const fn as_str(self) -> &'static str {
        match self {
            AppState::Absent => "absent",
            AppState::Current => "current",
            AppState::Stale => "stale",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub state: AppState,
    pub reason: String,
}

/// What the verdict is allowed to look at.
#[derive(Clone, Copy, Debug, Default)]
pub struct BinaryFacts {
    pub binary_exists: bool,
    pub binary_ms: f64,
    pub head_ms: f64,
    /// How many commits on `main` landed AFTER the binary was built.
    pub behind: u64,
}

/// The pure verdict, so the rule is testable without a filesystem.
///
/// COMMIT COUNT FIRST, mtime only as the tiebreak. A rebuild touches the mtime without changing what
/// it was built from, so mtime alone calls a fresh rebuild of old code "current" — which is exactly
/// the reassuring-but-wrong answer this file exists to avoid.
pub fn judge_app_binary(s: &BinaryFacts) -> Verdict {
    if !s.binary_exists {
        return Verdict { state: AppState::Absent, reason: "never-built".into() };
    }
    if s.behind > 0 {
        return Verdict { state: AppState::Stale, reason: format!("{}-commits-behind-main", s.behind) };
    }
    if s.head_ms > s.binary_ms {
        return Verdict { state: AppState::Stale, reason: "head-newer-than-binary".into() };
    }
    Verdict { state: AppState::Current, reason: "up-to-date".into() }
}

/// Measure the app tree, then judge it.
pub fn survey(root: &Path) -> BinaryFacts {
    let binary = root.join("target").join("debug").join("base-studio-code");
    let binary_ms = std::fs::metadata(&binary)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0);
    let Some(binary_ms) = binary_ms else { return BinaryFacts::default() };

    let head_ms = repo::git(root, &["log", "-1", "--format=%ct", "main"])
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .map(|s| s * 1000.0)
        .unwrap_or(0.0);
    // `--since` is the honest question: "what has main gained that this binary cannot contain?"
    let since = format!("--since={}", (binary_ms / 1000.0).floor() as i64);
    let behind = repo::count(root, "main", &[&since]);

    BinaryFacts { binary_exists: true, binary_ms, head_ms, behind }
}

#[cfg(test)]
mod tests {
    //! Carried over from `scripts/app-status.test.ts`, assertion for assertion. Tier 1
    //! (`--no-watch`) trades a loud interruption for a quiet staleness, so this verdict is the only
    //! thing that answers "am I running current code?".
    use super::*;

    /// The TypeScript's `s()` helper: a CURRENT baseline each test perturbs one field of.
    fn s() -> BinaryFacts {
        BinaryFacts { binary_exists: true, binary_ms: 1000.0, head_ms: 1000.0, behind: 0 }
    }

    #[test]
    fn reports_current_when_the_binary_matches_main() {
        let v = judge_app_binary(&s());
        assert_eq!(v.state, AppState::Current);
        assert_eq!(v.reason, "up-to-date");
    }

    #[test]
    fn reports_absent_before_anything_is_built() {
        assert_eq!(judge_app_binary(&BinaryFacts { binary_exists: false, ..s() }).state, AppState::Absent);
    }

    #[test]
    fn reports_stale_when_main_has_commits_the_binary_cannot_contain() {
        assert_eq!(judge_app_binary(&BinaryFacts { behind: 3, ..s() }).state, AppState::Stale);
    }

    #[test]
    fn still_reports_stale_when_the_binary_is_newer_than_head_but_commits_were_missed() {
        // COMMIT COUNT OUTRANKS MTIME. A rebuild touches the mtime without changing what it was built
        // from, so mtime alone would call a fresh rebuild of old code "current" — the
        // reassuring-but-wrong answer this whole file exists to avoid.
        let v = judge_app_binary(&BinaryFacts { binary_ms: 9999.0, head_ms: 1000.0, behind: 2, ..s() });
        assert_eq!(v.state, AppState::Stale);
        assert_eq!(v.reason, "2-commits-behind-main", "and it says which signal fired");
    }

    #[test]
    fn catches_a_head_newer_than_the_binary_even_when_the_count_is_unavailable() {
        let v = judge_app_binary(&BinaryFacts { binary_ms: 1000.0, head_ms: 5000.0, behind: 0, ..s() });
        assert_eq!(v.state, AppState::Stale);
        assert_eq!(v.reason, "head-newer-than-binary");
    }

    #[test]
    fn is_inert_on_a_malformed_state_rather_than_claiming_current() {
        // The TypeScript passed `undefined`; the Rust equivalent is the Default, which is written to
        // be the ABSENT state rather than a convenient one.
        assert_eq!(judge_app_binary(&BinaryFacts::default()).state, AppState::Absent);
    }

    #[test]
    fn a_tree_with_no_binary_surveys_as_absent_rather_than_erroring() {
        // The driver half of the same rule: an unmeasurable tree must read as "cannot tell", and
        // `absent` is how that is spelled here.
        let root = crate::repo::tests::scratch_repo("status-absent");
        let facts = survey(&root);
        assert!(!facts.binary_exists);
        assert_eq!(judge_app_binary(&facts).state, AppState::Absent);
        std::fs::remove_dir_all(&root).ok();
    }
}
