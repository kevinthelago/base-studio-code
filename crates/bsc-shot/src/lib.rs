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

/// How many captures the shots dir keeps. Each new capture prunes back to this, newest first.
///
/// A WINDOW rather than an age: it bounds the directory by the only thing anyone can predict from
/// outside it. An age policy leaves the size depending on how busy you were — an idle week keeps
/// nothing, a `baseline --kit` afternoon keeps hundreds — so "how much disk is this" has no answer
/// until you look.
///
/// # The one interaction to know about: a burst larger than the window eats its own early frames
///
/// `bsc shot frame --frames N` writes N PNGs through N separate captures, so with `--frames 20` and a
/// window of 10, frames 1–10 are pruned by the time frame 20 lands. That is inherent to counting rather
/// than aging, and it is pinned by a test rather than left to be discovered. Raise `$BSC_SHOT_KEEP`
/// above the burst before running one.
pub const DEFAULT_KEEP: usize = 10;

/// The window, honouring `$BSC_SHOT_KEEP`. `0` (or an unparseable value) disables pruning — an operator
/// who sets it to nonsense gets their files KEPT, never a directory emptied on a typo.
pub fn keep_count() -> Option<usize> {
    let keep = match std::env::var("BSC_SHOT_KEEP") {
        Ok(v) if !v.trim().is_empty() => v.trim().parse::<usize>().ok()?,
        _ => DEFAULT_KEEP,
    };
    (keep > 0).then_some(keep)
}

/// Keep the newest `keep` captures in `shots` and remove the rest. Returns how many went.
///
/// # What it will not touch, and why that is structural rather than a list
///
/// It reads ONE directory level and considers only regular `.png` files. So `<shots>/baselines/` — the
/// named reference renders `bsc shot diff` compares against — survives because it is a DIRECTORY, not
/// because it is on a deny-list that a later subdir would have to remember to join. A baseline is the
/// one thing under this dir that is not regenerable on demand: eat it and every subsequent diff reports
/// a plausible number about nothing, which is the silent-wrong answer this repo keeps paying for. The
/// same shape protects any future subdir for free.
///
/// # Ordering is total, so the kept set is not luck
///
/// Newest first by mtime, ties broken by filename DESCENDING. Ties are not hypothetical: a `--frames`
/// burst can land several PNGs inside one filesystem timestamp tick, and its names are zero-padded and
/// ascending (`-01`, `-02`, …), so the larger name is the later frame. Without the tiebreak, which
/// frames survived a burst would vary run to run.
///
/// # Fail-safe
///
/// A missing dir, or an entry whose metadata cannot be read, is SKIPPED — an unreadable file is never
/// deleted and never counts toward the window, because the safe reading of "I cannot tell how old this
/// is" is to leave it alone. A file that vanishes mid-prune, or is held open elsewhere, is likewise not
/// an error: this runs beside a capture, and a janitor that could fail the capture it rides along with
/// would cost more than the disk it reclaims.
/// One capture the prune is weighing: when it was written, what it is called, where it is.
type Capture = (std::time::SystemTime, std::ffi::OsString, std::path::PathBuf);

/// Order captures newest-first, ties inside one filesystem timestamp tick broken by filename DESCENDING.
///
/// Split out of [`prune_captures`] because it is the half that can be WRONG SILENTLY and cannot be
/// probed through the directory: `read_dir` yields in filesystem order, so a test driving the whole
/// prune cannot tell a real tiebreak from a stable sort that happened to see the files in a convenient
/// order. Given a deliberately shuffled slice, this can.
fn newest_first(captures: &mut [Capture]) {
    captures.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
}

pub fn prune_captures(shots: &std::path::Path, keep: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(shots) else { return 0 };

    let mut captures: Vec<Capture> = entries
        .flatten()
        .filter(|e| {
            // `file_type` does not follow symlinks, so a link into a tree of real work is skipped too.
            e.file_type().map(|t| t.is_file()).unwrap_or(false)
                && e.path().extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("png"))
        })
        .filter_map(|e| {
            let modified = e.metadata().and_then(|m| m.modified()).ok()?;
            Some((modified, e.file_name(), e.path()))
        })
        .collect();

    if captures.len() <= keep {
        return 0;
    }

    newest_first(&mut captures);

    captures[keep..].iter().filter(|(_, _, path)| std::fs::remove_file(path).is_ok()).count()
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

    /// A helper writing a capture with a chosen mtime, so the window is tested against a KNOWN order
    /// rather than whatever the filesystem clock did during the test.
    #[cfg(test)]
    fn write_capture(dir: &std::path::Path, name: &str, tick: u64) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, PNG_MAGIC).unwrap();
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000 + tick);
        filetime::set_file_mtime(&p, filetime::FileTime::from_system_time(t)).unwrap();
        p
    }

    #[test]
    fn the_window_keeps_the_newest_and_drops_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let files: Vec<_> = (0..15).map(|n| write_capture(dir.path(), &format!("shot-{n:02}.png"), n)).collect();

        assert_eq!(prune_captures(dir.path(), 10), 5, "15 captures, window 10 ⇒ the oldest 5 go");
        for (n, f) in files.iter().enumerate() {
            assert_eq!(f.exists(), n >= 5, "shot-{n:02}.png: kept iff it is in the newest 10");
        }

        // Idempotent: at the window, a second prune is a no-op rather than eating another slice.
        assert_eq!(prune_captures(dir.path(), 10), 0);
    }

    #[test]
    fn a_directory_under_the_window_is_left_entirely_alone() {
        let dir = tempfile::tempdir().unwrap();
        let files: Vec<_> = (0..3).map(|n| write_capture(dir.path(), &format!("s-{n}.png"), n)).collect();
        assert_eq!(prune_captures(dir.path(), 10), 0, "3 captures, window 10 ⇒ nothing to do");
        assert!(files.iter().all(|f| f.exists()));
    }

    /// The ordering, driven directly — see [`newest_first`] for why this cannot go through the
    /// directory. The input is deliberately SHUFFLED relative to both keys, so a sort missing either
    /// half lands in the wrong order rather than being carried by luck.
    #[test]
    fn the_order_is_newest_first_then_filename_descending() {
        let at = |t: u64| std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(t);
        let cap = |t: u64, n: &str| (at(t), std::ffi::OsString::from(n), std::path::PathBuf::from(n));

        // Three share tick 100; the fourth is older. Presented oldest-first and name-ascending — the
        // exact reverse of the answer — so neither key can be satisfied by leaving the input alone.
        let mut caps = vec![cap(50, "old.png"), cap(100, "burst-01.png"), cap(100, "burst-02.png"), cap(100, "burst-03.png")];
        newest_first(&mut caps);

        let order: Vec<_> = caps.iter().map(|(_, n, _)| n.to_str().unwrap()).collect();
        assert_eq!(order, ["burst-03.png", "burst-02.png", "burst-01.png", "old.png"]);
    }

    /// A `--frames` burst can land several PNGs inside one filesystem timestamp tick, and its names are
    /// zero-padded and ascending, so the later frames must be the ones that survive.
    #[test]
    fn captures_sharing_a_timestamp_keep_the_later_frames() {
        let dir = tempfile::tempdir().unwrap();
        let names = ["burst-01.png", "burst-02.png", "burst-03.png", "burst-04.png"];
        let files: Vec<_> = names.iter().map(|n| write_capture(dir.path(), n, 0)).collect();

        assert_eq!(prune_captures(dir.path(), 2), 2);
        assert!(!files[0].exists() && !files[1].exists(), "the earlier frames go");
        assert!(files[2].exists() && files[3].exists(), "the later frames stay");
    }

    /// THE CONSEQUENCE OF COUNTING RATHER THAN AGING, pinned so it is documented behaviour and not a
    /// surprise: a `--frames N` burst larger than the window prunes its OWN early frames as it runs,
    /// because each frame is a separate capture. Raise `$BSC_SHOT_KEEP` above the burst first.
    #[test]
    fn a_burst_longer_than_the_window_loses_its_own_early_frames() {
        let dir = tempfile::tempdir().unwrap();
        let keep = 10;
        let mut frames = Vec::new();
        for n in 0..20u64 {
            frames.push(write_capture(dir.path(), &format!("burst-{n:02}.png"), n));
            prune_captures(dir.path(), keep); // what capture() does after each write
        }
        assert_eq!(frames.iter().filter(|f| f.exists()).count(), keep);
        assert!(!frames[0].exists(), "frame 00 did not survive a 20-frame burst through a 10 window");
        assert!(frames[19].exists(), "the most recent frame always survives");
    }

    /// The guard that matters most. `<shots>/baselines/` is the named reference set `bsc shot diff`
    /// compares against — the one thing here that is not regenerable on demand. It survives because the
    /// prune reads a single directory level, so no future subdir has to remember to join a deny-list.
    #[test]
    fn the_window_never_descends_into_baselines_however_full_the_dir() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..15 {
            write_capture(dir.path(), &format!("shot-{n:02}.png"), n as u64);
        }
        // Baselines are the OLDEST things here — an age sweep or a flat walk would take them first.
        let baseline = write_capture(dir.path(), "baselines/listitemcard.png", 0);
        let other = write_capture(dir.path(), "baselines/api-builder.png", 0);

        // …and a non-PNG at the top level: the prune owns captures, not the directory.
        let notes = dir.path().join("notes.txt");
        std::fs::write(&notes, b"keep me").unwrap();

        assert_eq!(prune_captures(dir.path(), 10), 5, "only top-level captures are counted and pruned");
        assert!(baseline.exists() && other.exists(), "a baseline is never pruned, however full the dir");
        assert!(notes.exists(), "a non-PNG is never pruned");
    }

    #[test]
    fn the_prune_is_fail_safe_on_a_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(prune_captures(&dir.path().join("not-here"), 1), 0);
    }

    #[test]
    fn a_zero_or_junk_window_disables_pruning_rather_than_emptying_the_dir() {
        // Serialized against the other env-touching tests in this crate; nextest also gives each test
        // its own process, but `cargo test` threads them inside one binary.
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let restore = std::env::var("BSC_SHOT_KEEP").ok();

        std::env::set_var("BSC_SHOT_KEEP", "0");
        assert_eq!(keep_count(), None, "0 disables pruning — it does NOT mean keep nothing");

        std::env::set_var("BSC_SHOT_KEEP", "not-a-number");
        assert_eq!(keep_count(), None, "a typo KEEPS files — it must never fall back to deleting");

        std::env::set_var("BSC_SHOT_KEEP", "50");
        assert_eq!(keep_count(), Some(50), "raised above a burst, as the docs tell you to");

        std::env::remove_var("BSC_SHOT_KEEP");
        assert_eq!(keep_count(), Some(DEFAULT_KEEP));

        match restore {
            Some(v) => std::env::set_var("BSC_SHOT_KEEP", v),
            None => std::env::remove_var("BSC_SHOT_KEEP"),
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