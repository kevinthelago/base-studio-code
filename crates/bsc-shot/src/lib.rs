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
///
/// `Default` is derived so a call site names only the fields it means: this
/// struct grows, and a literal that must spell out every field turns each new
/// field into a mechanical edit across every caller — which is how a field ends
/// up copied wrongly rather than defaulted correctly.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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
    /// WHICH webview window to capture. `None` ⇒ `main`.
    ///
    /// The app is not one window. A widget is a separate webview with its own label
    /// (`bsc-widget-<id>`), and while this field did not exist every capture path resolved
    /// `get_webview_window("main")` — so the surfaces most needing to be looked at, the tear-offs, were
    /// the ones this tool structurally could not reach. MEASURED: a spectrum-analyzer widget shipped
    /// with a fully green gate and rendered nothing, and no capture could have shown that.
    ///
    /// `None` rather than a default of `"main"` in the struct, so an older app that does not know the
    /// field behaves exactly as it did rather than failing to deserialize.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
}

/// The window a request names, or `main`.
pub const DEFAULT_WINDOW: &str = "main";

/// The error for a label that names no window, LISTING the labels that do.
///
/// Discovery through the REFUSAL: a caller that guessed wrong is told what exists, so finding a window
/// needs no second request kind and no round trip. Pure over the label set so it is testable on every
/// platform, including the ones with no capture arm at all.
pub fn unknown_window_error(label: &str, available: &[String]) -> String {
    if available.is_empty() {
        return format!(
            "no webview window named {label:?}, and the app reports no windows at all — it may still be starting"
        );
    }
    let mut names: Vec<&str> = available.iter().map(String::as_str).collect();
    names.sort_unstable();
    format!(
        "no webview window named {label:?} — the app has: {}",
        names.join(", ")
    )
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
/// # Sized to clear a burst, because a burst prunes itself
///
/// `bsc shot frame --frames N` writes N PNGs through N SEPARATE captures, so a burst longer than the
/// window eats its own early frames before it finishes — inherent to counting rather than aging, and
/// pinned by a test rather than left to be discovered. 200 clears every realistic burst and every
/// packaged-kit sweep with room over; the first cut of this was 10, which a `--frames 20` run would
/// have silently halved. Baselines do not compete for the window at all — they live in a subdirectory
/// the prune cannot reach — so this budget is spent only on ad-hoc `take`/`preview`/`frame` captures.
///
/// The disk it bounds is small but NOT fixed: a preview crop of sparse UI is ~3 KB, while a full-webview
/// `take` of a dense screen is orders larger, so treat 200 as a bound on COUNT and not on bytes. Raise
/// `$BSC_SHOT_KEEP` above anything bigger than this before running it.
pub const DEFAULT_KEEP: usize = 200;

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

/// Grid resolution for the per-tile pass, matching [`compare::TILES`] so the two surfaces describe a
/// frame the same way.
pub const FRAME_TILES: u32 = 8;

/// How many low bits of each channel the colour census discards.
///
/// Three, so a smooth gradient or an anti-aliased edge does not read as thousands of distinct colours —
/// which would make `colours` a measure of the encoder rather than of the UI. It is the same reasoning
/// behind `compare`'s tile pass: a number is only useful once render noise has been averaged out of it.
const QUANTIZE_BITS: u8 = 3;
const BUCKETS: usize = 1 << (3 * (8 - QUANTIZE_BITS as usize));

/// What a SINGLE capture can be said about locally, with no model and no reference render.
///
/// `compare` answers "did this change", which needs two images. This answers the question that comes
/// FIRST and that a design loop cannot afford to get wrong: did anything render at all? A blank frame
/// diffs clean against another blank frame, so a pipeline that only ever compares reports `unchanged`
/// with total confidence about a component that has been broken the whole time.
///
/// Everything here is a MEASUREMENT rather than a judgement — except `blank`, which is a definition
/// (see below), not a threshold. Deciding that 3% ink is "too empty" needs a number nobody has measured,
/// and this repo's own `compare` docs are explicit that a constant picked here would be "a guess wearing
/// a number's clothes".
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub w: u32,
    pub h: u32,
    /// The frame is ONE colour. A definition, not a tuned threshold: `colours <= 1` after quantization.
    /// This is the render-did-not-happen signal.
    pub blank: bool,
    /// Distinct quantized colours present.
    pub colours: usize,
    /// The most common colour's EXACT RGB — the first pixel found in the modal bucket, not the bucket's
    /// midpoint, so a pure `#000` background reports as `[0,0,0]` rather than a quantization artefact.
    ///
    /// An exact tie resolves to the HIGHEST bucket index. That is arbitrary and deliberately so: a frame
    /// with two equally common colours has no background, and inventing a rule to pick one would dress a
    /// coin flip as a finding. It is pinned only so the output is reproducible.
    pub background: [u8; 3],
    /// Fraction of pixels not in the modal bucket — "how much is drawn on the background", `0.0..=1.0`.
    pub ink: f64,
    /// Tiles (of `tiles`) with NO ink at all. Reported, never judged: a real UI has legitimately empty
    /// regions, so this is only evidence — it is a whole side of the frame going missing that matters,
    /// and that is the caller's call to make against its own subject.
    pub empty_tiles: u32,
    /// Total tiles in the grid, so `empty_tiles` reads without knowing [`FRAME_TILES`].
    pub tiles: u32,
}

/// Census a decoded RGBA8 frame. `rgba` is `w * h * 4`; a short buffer is measured over the pixels it
/// actually has rather than panicking, since a truncated decode is the caller's problem to report.
///
/// Alpha is ignored: a capture is composited output and opaque by construction (both platform arms ask
/// for an opaque background), so an alpha channel here carries no signal.
pub fn analyze_frame(w: u32, h: u32, rgba: &[u8]) -> Frame {
    let px: Vec<[u8; 3]> = rgba.as_chunks::<4>().0.iter().map(|p| [p[0], p[1], p[2]]).collect();
    let total = px.len();
    if total == 0 {
        return Frame { w, h, blank: true, colours: 0, background: [0, 0, 0], ink: 0.0, empty_tiles: 0, tiles: 0 };
    }

    let bucket = |p: [u8; 3]| -> usize {
        let q = |c: u8| (c >> QUANTIZE_BITS) as usize;
        (q(p[0]) << 10) | (q(p[1]) << 5) | q(p[2])
    };

    let mut counts = vec![0u32; BUCKETS];
    for &p in &px {
        counts[bucket(p)] += 1;
    }
    let colours = counts.iter().filter(|&&c| c > 0).count();
    // `max_by_key` returns the LAST maximum, so ties land on the highest bucket index. Stated here
    // rather than inherited silently — see `background` on [`Frame`] for why the rule is arbitrary.
    let (modal, modal_count) = counts
        .iter()
        .enumerate()
        .max_by_key(|(_, &c)| c)
        .map(|(i, &c)| (i, c as usize))
        .unwrap_or((0, 0));

    // The modal bucket's EXACT colour, from the first pixel that lands in it.
    let background = px.iter().find(|&&p| bucket(p) == modal).copied().unwrap_or([0, 0, 0]);
    let ink = (total - modal_count) as f64 / total as f64;

    // Per-tile: a tile is empty when every pixel in it is the background colour. Tiles are derived from
    // the DECLARED w/h, so a truncated buffer simply leaves later tiles unvisited rather than misindexing.
    let mut empty_tiles = 0;
    let mut tiles = 0;
    if w > 0 && h > 0 {
        for ty in 0..FRAME_TILES {
            for tx in 0..FRAME_TILES {
                let (x0, x1) = (w * tx / FRAME_TILES, w * (tx + 1) / FRAME_TILES);
                let (y0, y1) = (h * ty / FRAME_TILES, h * (ty + 1) / FRAME_TILES);
                if x0 >= x1 || y0 >= y1 {
                    continue; // a frame narrower than the grid — no tile, rather than a zero-pixel one
                }
                tiles += 1;
                let mut inked = false;
                'rows: for y in y0..y1 {
                    for x in x0..x1 {
                        let i = (y as usize) * (w as usize) + x as usize;
                        match px.get(i) {
                            Some(&p) if bucket(p) != modal => {
                                inked = true;
                                break 'rows;
                            }
                            Some(_) => {}
                            None => break 'rows, // truncated buffer: stop, do not wrap
                        }
                    }
                }
                if !inked {
                    empty_tiles += 1;
                }
            }
        }
    }

    Frame { w, h, blank: colours <= 1, colours, background, ink, empty_tiles, tiles }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/compare.rs, src/cli.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-shot--<module>.rs
//     bsc graph impl set --id bsc-shot--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-shot--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-shot--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
