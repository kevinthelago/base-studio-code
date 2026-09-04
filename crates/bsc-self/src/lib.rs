//! `bsc self` — IS THIS `bsc` USABLE? Asked from outside a binary, about a binary.
//!
//! ## The mechanism, measured rather than assumed
//!
//! ```text
//! : > fake ; chmod +x fake
//! ./fake some args      ->  EXIT 0, no output
//! printf 'x' > bad      ->  `bad: line 1: x: command not found`, EXIT 127
//! ```
//!
//! A shell cannot exec a file with no valid header, so it falls back to running it as a SHELL SCRIPT. A
//! non-empty invalid file becomes a script that errors loudly. An **empty** one becomes an EMPTY SCRIPT,
//! which succeeds silently — so a zero-length binary, what a broken or interrupted link leaves behind, is
//! indistinguishable from every command passing. That happened: a 0-byte `target/debug/bsc` produced
//! three confident, entirely wrong conclusions about fresh-clone behaviour before `ls -l` caught it.
//!
//! ## Why this is NOT circular, though it looks it
//!
//! The JS this replaces argued the check "cannot live in the binary", and that argument is right about
//! exactly one thing: asking a BROKEN binary about ITSELF returns the same silent success as asking it
//! anything else. It is not an argument against a DIFFERENT, known-good binary doing the inspecting — the
//! staged `~/.base-studio-code/bin/bsc` can inspect `target/debug/bsc` perfectly well, and `bsc-hook`
//! already exists as a separate binary for the same shape of reason.
//!
//! What genuinely remains outside Rust is one path choice: something must name which binary RUNS the
//! check. That is a line in `package.json`, not logic.

use std::path::{Path, PathBuf};

pub const EXE: &str = if cfg!(windows) { "bsc.exe" } else { "bsc" };

/// Where a built or staged `bsc` may live, MOST-LOCAL FIRST — a local build is what you are iterating on,
/// so it must win over the staged copy even when the staged one is newer.
pub fn candidate_paths(root: &Path, home: &Path) -> Vec<PathBuf> {
    vec![
        root.join("target").join("debug").join(EXE),
        root.join("target").join("release").join(EXE),
        home.join(".base-studio-code").join("bin").join(EXE),
    ]
}

/// What one candidate is.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum State {
    /// No file at this path.
    Absent,
    /// Zero bytes — the silent-success case above. NEVER executed.
    ZeroByte,
    /// It ran, but did not identify itself: an incoherent build.
    NoHandshake,
    /// It ran and said `bsc …`.
    Usable,
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    pub state: State,
    pub size: Option<u64>,
    pub detail: String,
    /// The first line of `<bsc> version`, when it handshook.
    pub version: Option<String>,
}

impl Candidate {
    pub fn ok(&self) -> bool {
        self.state == State::Usable
    }
}

/// Classify one candidate. `run` must return `(exit_code, stdout)` for `<path> version`.
///
/// THE ORDER IS DELIBERATE: size FIRST, because a zero-length file must never be executed — executing it
/// is the thing that produces the misleading success.
pub fn inspect(
    path: &Path,
    size_of: &dyn Fn(&Path) -> Option<u64>,
    run: &dyn Fn(&Path) -> (i32, String),
) -> Candidate {
    let mk = |state: State, size: Option<u64>, detail: &str| Candidate {
        path: path.to_path_buf(),
        state,
        size,
        detail: detail.to_string(),
        version: None,
    };
    let Some(size) = size_of(path) else {
        return mk(State::Absent, None, "no file at this path");
    };
    if size == 0 {
        return mk(
            State::ZeroByte,
            Some(0),
            "ZERO BYTES — a broken link. Through a shell this exits 0 printing nothing, which is \
             indistinguishable from every command passing. Rebuild: cargo build -p bsc --bin bsc",
        );
    }
    let (status, stdout) = run(path);
    let line = stdout.trim().to_string();
    let identifies = line.starts_with("bsc") && line[3..].starts_with(char::is_whitespace);
    if status != 0 || !identifies {
        let seen = if line.is_empty() {
            "no stdout".to_string()
        } else {
            format!("stdout {:?}", line.chars().take(60).collect::<String>())
        };
        return mk(
            State::NoHandshake,
            Some(size),
            &format!(
                "ran but did not identify itself (exit {status}, {seen}) — an incoherent build. \
                 Rebuild: cargo build -p bsc --bin bsc"
            ),
        );
    }
    Candidate {
        path: path.to_path_buf(),
        state: State::Usable,
        size: Some(size),
        detail: String::new(),
        version: line.lines().next().map(|l| l.trim().to_string()),
    }
}

/// Is `binary_mtime` behind the newest source change?
///
/// The practical form of "which build am I?". `bsc version`'s `built …` line comes from the exe's own
/// MTIME, not a compile-time stamp — so a COPY reports when it was copied, and a month-old binary staged
/// today looks fresh. Comparing against the TREE sidesteps that and costs no build change.
#[derive(Debug, PartialEq, Eq)]
pub enum Freshness {
    /// Either side unknown — this DECLINES TO GUESS rather than reporting "fresh".
    Unknown,
    Fresh,
    Stale { behind_ms: i64 },
}

pub fn freshness(binary_mtime: Option<i64>, newest_source_mtime: Option<i64>) -> Freshness {
    let (Some(b), Some(s)) = (binary_mtime, newest_source_mtime) else { return Freshness::Unknown };
    let behind = s - b;
    if behind > 0 {
        Freshness::Stale { behind_ms: behind }
    } else {
        Freshness::Fresh
    }
}

/// `1m 12s` / `3d 4h` — a duration a reader can act on, rather than a millisecond count.
pub fn humanize_ms(ms: i64) -> String {
    let s = (ms.abs() as f64 / 1000.0).round() as i64;
    if s < 60 {
        return format!("{s}s");
    }
    let m = s / 60;
    if m < 60 {
        return format!("{m}m {}s", s % 60);
    }
    let h = m / 60;
    if h < 24 {
        return format!("{h}h {}m", m % 60);
    }
    format!("{}d {}h", h / 24, h % 24)
}

/// The first USABLE candidate, or `None`.
///
/// EXISTENCE IS NOT ENOUGH and never was — that is the whole lesson of the zero-byte case.
pub fn pick_usable(
    paths: &[PathBuf],
    size_of: &dyn Fn(&Path) -> Option<u64>,
    run: &dyn Fn(&Path) -> (i32, String),
) -> Option<Candidate> {
    paths.iter().map(|p| inspect(p, size_of, run)).find(Candidate::ok)
}

/// The newest mtime under the Rust source roots — what a binary must be newer than to be current.
///
/// An ABSENT root is not an error: this runs in worktrees with different shapes.
pub fn newest_source_mtime(roots: &[PathBuf]) -> Option<i64> {
    fn walk(dir: &Path, newest: &mut Option<i64>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let p = e.path();
            if p.is_dir() {
                if name == "target" || name == "node_modules" || name == ".git" {
                    continue;
                }
                walk(&p, newest);
            } else if name.ends_with(".rs") {
                if let Some(m) = mtime_ms(&p) {
                    if newest.is_none_or(|n| m > n) {
                        *newest = Some(m);
                    }
                }
            }
        }
    }
    let mut newest = None;
    for r in roots {
        walk(r, &mut newest);
    }
    newest
}

/// A path's mtime in epoch milliseconds.
pub fn mtime_ms(p: &Path) -> Option<i64> {
    let m = std::fs::metadata(p).ok()?.modified().ok()?;
    let d = m.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as i64)
}


#[cfg(test)]
mod tests {
    use super::*;

    /// Every assertion below is migrated from `scripts/lib/bscBinary.test.ts`, which dies with the
    /// script. Each one is a failure mode that cost real time, not a hypothetical.
    fn sizes(pairs: &[(&str, u64)]) -> impl Fn(&Path) -> Option<u64> {
        let owned: Vec<(String, u64)> =
            pairs.iter().map(|(p, s)| ((*p).to_string(), *s)).collect();
        move |p: &Path| {
            let k = p.to_string_lossy().replace('\\', "/");
            owned.iter().find(|(n, _)| k.ends_with(n.as_str())).map(|(_, s)| *s)
        }
    }
    fn says(out: &'static str) -> impl Fn(&Path) -> (i32, String) {
        move |_: &Path| (0, out.to_string())
    }

    #[test]
    fn candidate_paths_prefer_a_local_build_over_the_staged_one() {
        let got = candidate_paths(Path::new("/repo"), Path::new("/home/me"));
        let s: Vec<String> = got.iter().map(|p| p.to_string_lossy().replace('\\', "/")).collect();
        assert!(s[0].contains("/repo/target/debug"), "{s:?}");
        assert!(s[1].contains("/repo/target/release"), "{s:?}");
        assert!(s[2].contains("/home/me/.base-studio-code/bin"), "{s:?}");
    }

    /// THE ZERO-BYTE CASE, and the assertion that matters most: it is NEVER EXECUTED. Running it is the
    /// thing that produces the misleading silent success.
    #[test]
    fn a_zero_byte_binary_is_named_and_never_executed() {
        let ran = std::cell::Cell::new(false);
        let run = |_: &Path| {
            ran.set(true);
            (0, String::new())
        };
        let c = inspect(Path::new("/x/bsc"), &sizes(&[("/x/bsc", 0)]), &run);
        assert_eq!(c.state, State::ZeroByte);
        assert!(!c.ok());
        assert!(!ran.get(), "a zero-length file must never be executed");
        assert!(c.detail.contains("ZERO BYTES"), "{}", c.detail);
    }

    #[test]
    fn absent_is_distinguished_from_broken() {
        let c = inspect(Path::new("/nope/bsc"), &sizes(&[]), &says("bsc 0.1.0"));
        assert_eq!(c.state, State::Absent);
        assert!(c.size.is_none(), "an absent file has no size to report");
    }

    #[test]
    fn a_binary_that_runs_without_identifying_itself_is_rejected() {
        let c = inspect(Path::new("/x/bsc"), &sizes(&[("/x/bsc", 100)]), &|_| (0, String::new()));
        assert_eq!(c.state, State::NoHandshake);
        assert!(c.detail.contains("no stdout"), "{}", c.detail);
    }

    /// SUCCESS IS NOT IDENTITY. An exit 0 with the wrong output is the incoherent-build case.
    #[test]
    fn output_that_is_not_a_bsc_identity_is_rejected_however_successful_the_exit() {
        for out in ["hello", "bscarbon 1.0", "not bsc at all"] {
            let c = inspect(Path::new("/x/bsc"), &sizes(&[("/x/bsc", 100)]), &says(out));
            assert_eq!(c.state, State::NoHandshake, "{out:?} must not read as an identity");
        }
        // ...and a NON-ZERO exit is rejected even when the line looks right.
        let c = inspect(Path::new("/x/bsc"), &sizes(&[("/x/bsc", 100)]), &|_| (1, "bsc 0.1.0".into()));
        assert_eq!(c.state, State::NoHandshake);
    }

    #[test]
    fn a_real_handshake_is_accepted_and_the_version_line_reported() {
        let c = inspect(
            Path::new("/x/bsc"),
            &sizes(&[("/x/bsc", 12_345)]),
            &says("bsc 0.1.0 (built 2026-09-02)\nextra line"),
        );
        assert_eq!(c.state, State::Usable);
        assert!(c.ok());
        assert_eq!(c.version.as_deref(), Some("bsc 0.1.0 (built 2026-09-02)"), "FIRST line only");
        assert_eq!(c.size, Some(12_345));
    }

    #[test]
    fn freshness_reports_stale_fresh_and_declines_to_guess() {
        assert_eq!(freshness(Some(100), Some(500)), Freshness::Stale { behind_ms: 400 });
        assert_eq!(freshness(Some(900), Some(500)), Freshness::Fresh);
        // DECLINES rather than reporting fresh — an unknown side is not evidence of currency.
        assert_eq!(freshness(None, Some(500)), Freshness::Unknown);
        assert_eq!(freshness(Some(100), None), Freshness::Unknown);
    }

    #[test]
    fn humanize_scales_the_unit_so_the_number_is_actionable() {
        assert_eq!(humanize_ms(45_000), "45s");
        assert_eq!(humanize_ms(72_000), "1m 12s");
        assert_eq!(humanize_ms(3 * 3_600_000 + 4 * 60_000), "3h 4m");
        assert_eq!(humanize_ms(3 * 86_400_000 + 4 * 3_600_000), "3d 4h");
    }

    /// EXISTENCE IS NOT ENOUGH: the picker skips a present-but-broken candidate.
    #[test]
    fn pick_usable_skips_a_zero_byte_candidate_and_takes_the_next_real_one() {
        let paths = vec![PathBuf::from("/a/bsc"), PathBuf::from("/b/bsc")];
        let got = pick_usable(
            &paths,
            &sizes(&[("/a/bsc", 0), ("/b/bsc", 500)]),
            &says("bsc 0.1.0"),
        );
        assert_eq!(got.map(|c| c.path), Some(PathBuf::from("/b/bsc")));
    }

    /// ...and reports NOTHING rather than failing, so a caller can decide.
    #[test]
    fn pick_usable_returns_none_when_nothing_is_usable() {
        let paths = vec![PathBuf::from("/a/bsc")];
        assert!(pick_usable(&paths, &sizes(&[("/a/bsc", 0)]), &says("bsc 0.1.0")).is_none());
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-self--<module>.rs
//     bsc graph impl set --id bsc-self--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-self--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));