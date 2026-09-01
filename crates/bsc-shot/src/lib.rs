//! `bsc-shot` (#3261, epic #3260) — ask the RUNNING desktop app for a **webview snapshot**, so an
//! external session (or an agent) can SEE the app instead of inferring what it looks like.
//!
//! ## Why the WEBVIEW, not the DOM and not the screen
//! - **Not `html2canvas`** — it does not screenshot; it re-implements CSS rendering in JS, and it is worst
//!   at exactly what this design system is built from (`color-mix(in oklch, …)`, oklch palettes, `var()`
//!   token indirection, `transform` on `#root`). A design loop whose instrument lies about colour
//!   converges on a hallucination. (It also cannot reach the preview iframe at all — `sandbox="allow-scripts"`,
//!   opaque origin, #2824 — but fidelity is the deciding reason, not the sandbox.)
//! - **Not an OS window grab** — on Windows an occluded/minimized/locked-session capture returns black,
//!   and this exists to run overnight.
//!
//! Verified on the real app (#3261): a capture taken while the window was **minimized** was byte-identical
//! to a visible one, and it renders the sandboxed preview iframe's content — the html2canvas-impossible case.
//!
//! ## Transport
//! The request/response channel is [`bsc_appchan`] — the ONE channel, shared with `bsc navigate` (#3274).
//! This crate owns only the shot's own request/result shapes; the platform capture lives in the desktop app.


use serde::{Deserialize, Serialize};


/// This verb's routing key in the shared channel.
pub const KIND: &str = "shot";

/// A crop region in CSS pixels, relative to the webview's top-left. Absent ⇒ the whole webview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// What `bsc shot take` / `bsc shot preview` ask for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShotRequest {
    /// Crop region; `None` ⇒ the whole webview (or the `target`'s resolved rect).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
    /// Where the PNG should be written. `None` ⇒ the app picks `<shots>/<id>.png`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out: Option<String>,
    /// A NAMED region the app resolves ITSELF from a rect the frontend registered (e.g. `"preview"` →
    /// the Design Studio's component-preview element). `bsc shot preview` sets this so the caller need
    /// not know the pixel coordinates. Ignored when `rect` is set (an explicit rect wins). #3308.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

/// What the app answers with on success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShotResult {
    pub path: String,
    pub w: u32,
    pub h: u32,
    /// The shots dir the APP resolved, from ITS env (#4163). The CLI resolves `out` in the CALLER's env
    /// (honoring the session's `$BSC_SHOT_DIR`); the app process has no such var, so when the two sides
    /// disagree about where a PNG lives, this is the field that says so. Reported only in the read-back
    /// failure — the one place the disagreement becomes visible.
    ///
    /// `None` from an app older than this field, which is itself diagnostic: it dates the running app.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shots_dir: Option<String>,
}

/// `~/.base-studio-code/shots/` — where the PNGs land. Overridable via `BSC_SHOT_DIR`.
///
/// Deliberately NOT the channel dir ([`bsc_appchan::chan_dir`]): this holds ARTIFACTS the caller owns.
/// Mixing them would make "sweep the transport" and "delete my screenshots" the same operation.
pub fn shots_dir() -> Result<std::path::PathBuf, String> {
    if let Ok(d) = std::env::var("BSC_SHOT_DIR") {
        if !d.trim().is_empty() {
            return Ok(std::path::PathBuf::from(d));
        }
    }
    let base = bsc_util::bsc_base_dir().ok_or_else(|| "cannot resolve the ~/.base-studio-code dir".to_string())?;
    Ok(base.join("shots"))
}

/// Default PNG destination for a request that carried no `out` — the app resolves it the same way.
pub fn default_png_path(shots: &std::path::Path, id: &str) -> std::path::PathBuf {
    shots.join(format!("{id}.png"))
}

/// PNG magic — the first 8 bytes of every PNG. Proves a capture wrote a real image.
pub const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Is `bytes` a PNG? A capture that silently wrote something else (or nothing) must not read as success.
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == PNG_MAGIC
}


/// Resolve a capture's PNG destination against `shots` — the ONE rule both processes must apply.
///
/// No `out` ⇒ `<shots>/<id>.png`; a RELATIVE `out` ⇒ inside `shots`; an ABSOLUTE `out` ⇒ as-is.
///
/// It lives here, shared, because the two sides resolving this differently is not hypothetical: the app
/// used to hand a relative `out` straight to `fs::write`, which anchored it at the APP's cwd — and under
/// `tauri dev` that cwd is `src-tauri/`. Ten captures were committed to the repo that way (merge
/// 6b52a96d) before anyone noticed, because a capture that lands somewhere unexpected still reports
/// success. The CLI fixed the caller's half in #3662 and still carries its own private copy of this
/// rule (a record, `bsc-shot--cli.rs`, returning a String) — identical today, and the thing to collapse
/// into a call to this function the next time that record is opened. Until then `ShotResult::shots_dir`
/// (#4163) is what makes a divergence between the two visible rather than silent.
pub fn resolve_out(out: Option<&str>, shots: &std::path::Path, id: &str) -> std::path::PathBuf {
    match out {
        Some(o) if std::path::Path::new(o).is_absolute() => std::path::PathBuf::from(o),
        Some(o) => shots.join(o),
        None => default_png_path(shots, id),
    }
}

/// How long a capture survives in the shots dir before [`sweep_captures`] removes it.
///
/// Seven days, not the `gc` sweeps' three: a capture is small (~3 KB) but a `baseline --kit` run makes
/// one per component, and a burst from `--frames` is a set someone is part-way through reading. The cost
/// of keeping one too long is nothing; the cost of eating the frame someone was about to diff is a
/// re-run of an unattended overnight loop.
pub const DEFAULT_MAX_AGE_SECS: u64 = 7 * 24 * 60 * 60;

/// The retention window, honouring `$BSC_SHOT_MAX_AGE_SECS`. `0` (or an unparseable value) disables the
/// sweep — an operator who sets it to nonsense gets their files KEPT, never deleted on a typo.
pub fn max_age_secs() -> Option<std::time::Duration> {
    let secs = match std::env::var("BSC_SHOT_MAX_AGE_SECS") {
        Ok(v) if !v.trim().is_empty() => v.trim().parse::<u64>().ok()?,
        _ => DEFAULT_MAX_AGE_SECS,
    };
    (secs > 0).then(|| std::time::Duration::from_secs(secs))
}

/// Remove captures in `shots` last modified longer than `max_age` before `now`. Returns how many went.
///
/// # What it will not touch, and why that is structural rather than a list
///
/// It reads ONE directory level and skips everything that is not a regular `.png` file. So
/// `<shots>/baselines/` — the named reference renders `bsc shot diff` compares against — survives
/// because it is a DIRECTORY, not because it is on a deny-list that a later subdir would have to
/// remember to join. A baseline is the one thing under this dir that is not regenerable on demand: eat
/// it and every subsequent diff reports a plausible number about nothing, which is the silent-wrong
/// answer this repo keeps paying for. The same shape protects any future subdir for free.
///
/// # Fail-safe
///
/// A missing dir, an unreadable entry, a file that vanishes mid-sweep or one held open by another
/// process is SKIPPED, never propagated: this runs beside a capture, and a janitor that could fail a
/// capture would be worse than the disk it saves.
pub fn sweep_captures(shots: &std::path::Path, now: std::time::SystemTime, max_age: std::time::Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(shots) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // `file_type` here does not follow symlinks, so a link into a tree of real work is skipped too.
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()).map(|e| !e.eq_ignore_ascii_case("png")).unwrap_or(true) {
            continue;
        }
        let aged = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age > max_age)
            .unwrap_or(false);
        if aged && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that mutate process-global env (see the retention test).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The rule the app used to get wrong. A RELATIVE `out` must land in the shots dir; before this was
    /// shared, the app anchored it at its own cwd (`src-tauri/` under `tauri dev`) and ten captures were
    /// committed to the repo as a result.
    #[test]
    fn a_relative_out_lands_in_the_shots_dir_and_an_absolute_one_is_honored() {
        let shots = std::path::Path::new("/ws/shots");

        assert_eq!(resolve_out(None, shots, "abc"), shots.join("abc.png"), "no --out ⇒ <shots>/<id>.png");
        assert_eq!(resolve_out(Some("flat.png"), shots, "abc"), shots.join("flat.png"), "relative ⇒ inside shots");
        assert_eq!(
            resolve_out(Some("shots/kv-retest.png"), shots, "abc"),
            shots.join("shots/kv-retest.png"),
            "a relative SUBPATH is still anchored at shots — this is the exact pair of names that leaked",
        );

        let abs = if cfg!(windows) { "C:\\elsewhere\\x.png" } else { "/elsewhere/x.png" };
        assert_eq!(resolve_out(Some(abs), shots, "abc"), std::path::PathBuf::from(abs), "absolute ⇒ as-is");
    }

    #[test]
    fn the_sweep_takes_aged_captures_and_leaves_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        let now = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let max_age = std::time::Duration::from_secs(100);

        let write_at = |name: &str, secs_ago: u64| {
            let p = dir.path().join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, PNG_MAGIC).unwrap();
            let t = now - std::time::Duration::from_secs(secs_ago);
            filetime::set_file_mtime(&p, filetime::FileTime::from_system_time(t)).unwrap();
            p
        };

        let aged = write_at("old.png", 500);
        let fresh = write_at("new.png", 10);
        // Exactly at the boundary is KEPT — the comparison is strictly greater-than, so a file is never
        // removed on the same tick it becomes eligible.
        let boundary = write_at("boundary.png", 100);

        assert_eq!(sweep_captures(dir.path(), now, max_age), 1, "only the aged capture goes");
        assert!(!aged.exists(), "the aged capture was removed");
        assert!(fresh.exists() && boundary.exists(), "a fresh capture and the boundary case survive");
    }

    /// The guard that matters most. `<shots>/baselines/` is the named reference set `bsc shot diff`
    /// compares against — the one thing here that is not regenerable on demand. It survives because the
    /// sweep reads a single directory level, so no future subdir has to remember to join a deny-list.
    #[test]
    fn the_sweep_never_descends_into_baselines_however_aged() {
        let dir = tempfile::tempdir().unwrap();
        let now = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
        let ancient = now - std::time::Duration::from_secs(999_999);

        let baseline = dir.path().join("baselines").join("listitemcard.png");
        std::fs::create_dir_all(baseline.parent().unwrap()).unwrap();
        std::fs::write(&baseline, PNG_MAGIC).unwrap();
        filetime::set_file_mtime(&baseline, filetime::FileTime::from_system_time(ancient)).unwrap();

        // …and a non-PNG at the top level is left alone too: the sweep owns captures, not the directory.
        let notes = dir.path().join("notes.txt");
        std::fs::write(&notes, b"keep me").unwrap();
        filetime::set_file_mtime(&notes, filetime::FileTime::from_system_time(ancient)).unwrap();

        assert_eq!(sweep_captures(dir.path(), now, std::time::Duration::from_secs(1)), 0);
        assert!(baseline.exists(), "a baseline is never swept, at any age");
        assert!(notes.exists(), "a non-PNG is never swept");
    }

    #[test]
    fn the_sweep_is_fail_safe_on_a_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("not-here");
        assert_eq!(sweep_captures(&gone, std::time::SystemTime::now(), std::time::Duration::from_secs(1)), 0);
    }

    #[test]
    fn a_zero_or_junk_retention_disables_the_sweep_rather_than_deleting_everything() {
        // Serialized against the other env-touching tests in this crate; nextest also gives each test
        // its own process, but `cargo test` threads them inside one binary.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let restore = std::env::var("BSC_SHOT_MAX_AGE_SECS").ok();

        std::env::set_var("BSC_SHOT_MAX_AGE_SECS", "0");
        assert_eq!(max_age_secs(), None, "0 disables the sweep");

        std::env::set_var("BSC_SHOT_MAX_AGE_SECS", "not-a-number");
        assert_eq!(max_age_secs(), None, "a typo KEEPS files — it must never fall back to deleting");

        std::env::set_var("BSC_SHOT_MAX_AGE_SECS", "3600");
        assert_eq!(max_age_secs(), Some(std::time::Duration::from_secs(3600)));

        std::env::remove_var("BSC_SHOT_MAX_AGE_SECS");
        assert_eq!(max_age_secs(), Some(std::time::Duration::from_secs(DEFAULT_MAX_AGE_SECS)));

        match restore {
            Some(v) => std::env::set_var("BSC_SHOT_MAX_AGE_SECS", v),
            None => std::env::remove_var("BSC_SHOT_MAX_AGE_SECS"),
        }
    }

    #[test]
    fn the_request_round_trips_through_the_shared_envelope() {
        let dir = tempfile::tempdir().unwrap();
        let req = ShotRequest { rect: Some(Rect { x: 1, y: 2, w: 3, h: 4 }), out: Some("C:/x.png".into()), target: None };
        bsc_appchan::write_request(dir.path(), "a", KIND, 1, &req).unwrap();

        let env = bsc_appchan::pending(dir.path()).unwrap().pop().unwrap();
        assert_eq!(env.kind, KIND, "routes to the shot handler");
        assert_eq!(serde_json::from_value::<ShotRequest>(env.payload).unwrap(), req);
    }

    #[test]
    fn the_result_round_trips_and_an_error_wins_over_it() {
        let ok =
            bsc_appchan::Reply::ok("a", &ShotResult { path: "p.png".into(), w: 8, h: 6, shots_dir: None }, 1);
        let got: ShotResult = bsc_appchan::take_payload(ok).unwrap();
        assert_eq!((got.w, got.h), (8, 6));

        let bad = bsc_appchan::Reply::err("a", "unsupported on this platform yet", 1);
        assert_eq!(bsc_appchan::take_payload::<ShotResult>(bad).unwrap_err(), "unsupported on this platform yet");
    }

    #[test]
    fn the_apps_shots_dir_rides_along_and_an_older_app_still_parses() {
        // #4163: the field the read-back failure needs. It must be OPTIONAL on the wire — the CLI is
        // routinely newer than the running app, which is precisely the situation being diagnosed.
        let with = ShotResult { path: "p.png".into(), w: 1, h: 1, shots_dir: Some("C:/ws/shots".into()) };
        let json = serde_json::to_string(&with).unwrap();
        assert!(json.contains("shots_dir"));
        assert_eq!(serde_json::from_str::<ShotResult>(&json).unwrap(), with);

        // An older app's reply (no such key) parses, reporting `None` rather than failing the capture.
        let legacy: ShotResult = serde_json::from_str(r#"{"path":"p.png","w":1,"h":1}"#).unwrap();
        assert_eq!(legacy.shots_dir, None);
        // …and an app that omits it is not made to send `null`.
        assert!(!serde_json::to_string(&legacy).unwrap().contains("shots_dir"));
    }

    #[test]
    fn is_png_accepts_the_magic_and_rejects_a_black_hole() {
        assert!(is_png(&PNG_MAGIC));
        assert!(!is_png(b""), "a capture that wrote nothing must not read as a PNG");
        assert!(!is_png(b"not-an-image"));
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/compare.rs, src/cli.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-shot--<module>.rs
//     bsc graph impl set --id bsc-shot--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-shot--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));