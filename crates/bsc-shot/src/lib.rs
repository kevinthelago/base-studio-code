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

pub mod cli;

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

#[cfg(test)]
mod tests {
    use super::*;

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
