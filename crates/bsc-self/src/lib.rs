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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-self--<module>.rs
//     bsc graph impl set --id bsc-self--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-self--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-self--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));