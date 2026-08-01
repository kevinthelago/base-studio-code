//! `shot` (#3261, epic #3260) — the **webview capture**, so an external session (or an agent) can SEE
//! the running app instead of inferring what it looks like.
//!
//! The watcher that dispatches requests here lives in [`crate::appchan`] — one channel, one watcher,
//! routed by kind (#3274). This module is only the capture itself.
//!
//! ## Why the webview and not the screen
//! `CapturePreview` (and its mac/linux siblings) render the webview's COMPOSITED output — pixel-identical
//! to what the user sees, *including* the sandboxed preview iframe (`sandbox="allow-scripts"`, opaque
//! origin, #2824), and a render rather than a screen grab. An OS window grab of an occluded/minimized/
//! locked-session window returns black on Windows; this exists to run overnight (#3260), so that failure
//! mode is disqualifying. Verified on the real app: a MINIMIZED capture is byte-identical to a visible one.
//!
//! ## Threading
//! `with_webview` hands the closure to the WEBVIEW thread, and `CapturePreview` is asynchronous — its
//! completion handler fires later on that same thread. So the closure must only START the capture and
//! hand the bytes back through a channel; the WAIT happens on the caller's thread. Blocking inside the
//! closure would stall the message pump that has to deliver the very completion being waited on.

use bsc_shot::{default_png_path, is_png, shots_dir, Rect, ShotRequest, ShotResult};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

mod crop;

/// On-screen rects the frontend registers for NAMED shot targets — e.g. `"preview"` → the Design Studio's
/// component-preview element. `bsc shot preview` names a target and the app crops the webview to its
/// registered rect, so the caller never needs pixel coordinates (#3308). Managed Tauri state; the frontend
/// keeps it fresh (mount / resize) and clears it on unmount.
#[derive(Default)]
pub struct ShotTargets(pub Mutex<HashMap<String, Rect>>);

/// Register (or clear, when `rect` is `None`) a named shot target's on-screen rect. A best-effort frontend
/// call — a stale/missing rect only degrades a `preview` shot to a clear error, never a crash.
#[tauri::command]
pub(crate) fn set_shot_target_rect(target: String, rect: Option<Rect>, targets: tauri::State<'_, ShotTargets>) {
    let mut map = targets.0.lock().unwrap_or_else(|e| e.into_inner());
    match rect {
        Some(r) => {
            map.insert(target, r);
        }
        None => {
            map.remove(&target);
        }
    }
}

/// The rect the frontend registered for `target`, or a STATED error naming what to do — never a silent
/// fall-through to a whole-screen capture. Pure over the map so it's testable without a Tauri app.
fn resolve_from(map: &HashMap<String, Rect>, target: &str) -> Result<Rect, String> {
    map.get(target).copied().ok_or_else(|| {
        format!(
            "no '{target}' shot target is registered — the Design Studio isn't showing a component. \
             Run `bsc navigate component <kit> <component>` first, then retry."
        )
    })
}

/// Routes a target to a mounted preview FRAME by component id, instead of to the frontend-registered
/// rect map (#3469). `frame:Heatmap` ⇒ "the preview showing Heatmap", wherever it happens to sit.
pub(crate) const FRAME_PREFIX: &str = "frame:";

fn resolve_target(app: &tauri::AppHandle, id: &str, target: &str) -> Result<Rect, String> {
    if let Some(component) = target.strip_prefix(FRAME_PREFIX) {
        return rect_of_frame(app, id, component);
    }
    use tauri::Manager;
    let targets = app.state::<ShotTargets>();
    let guard = targets.0.lock().unwrap_or_else(|e| e.into_inner());
    resolve_from(&guard, target)
}

/// The on-screen rect of the mounted preview frame rendering `component` (#3469).
///
/// Reuses the `bsc debug frames` round-trip VERBATIM rather than adding a second geometry channel:
/// `FrameInfo.element.rect` is already a `getBoundingClientRect()` in CSS px — the exact units [`Rect`]
/// documents — so "photograph component X" is a CROP, not a second capture path.
///
/// Resolving app-side is also what keeps this reachable from a RESTRICTED session: the caller runs one
/// allow-listed `bsc shot frame <id>` and never needs `bsc debug` in its own command surface.
fn rect_of_frame(app: &tauri::AppHandle, id: &str, component: &str) -> Result<Rect, String> {
    let res = crate::debug::inspect(app, id, &bsc_debug::DebugRequest::Frames)?;
    let bsc_debug::DebugResult::Frames { frames } = res else {
        return Err("the frames inspection answered with the wrong result kind".into());
    };
    let found = frames.iter().find(|f| f.component == component).ok_or_else(|| {
        // Name what IS mounted — "not found" with the alternatives beats "not found" alone, and a
        // silent whole-page shot would be worse than either.
        let mounted: Vec<&str> = frames.iter().map(|f| f.component.as_str()).collect();
        if mounted.is_empty() {
            format!(
                "no component preview is mounted, so '{component}' cannot be photographed — run \
                 `bsc navigate component <kit> {component}` first, then retry"
            )
        } else {
            format!("no preview for '{component}' is mounted; currently showing: {}", mounted.join(", "))
        }
    })?;
    rect_from_css(found.element.rect, component)
}

/// A `getBoundingClientRect()` (CSS px, possibly fractional or negative) as the integer crop [`Rect`].
///
/// Floors the origin and ceils the size so a fractional box never loses a pixel it partially covers —
/// the same rounding the frontend applies when registering the `preview` rect. A negative origin (a
/// frame scrolled above/left of the viewport) clamps to 0 rather than wrapping through `as u32`.
fn rect_from_css([x, y, w, h]: [f64; 4], component: &str) -> Result<Rect, String> {
    // `is_finite` FIRST so a NaN dimension errors rather than slipping through a `<=` comparison
    // (every comparison against NaN is false, so a bare `w <= 0.0` would treat NaN as a valid size).
    if !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
        return Err(format!(
            "'{component}' reports a zero-size rect ({w}x{h}) — it is mounted but not laid out yet"
        ));
    }
    Ok(Rect {
        x: x.max(0.0).floor() as u32,
        y: y.max(0.0).floor() as u32,
        w: w.ceil() as u32,
        h: h.ceil() as u32,
    })
}

/// How long to wait for `CapturePreview`'s completion handler. Shorter than the CLI's timeout so the
/// caller gets our real error rather than a bare timeout.
const CAPTURE_TIMEOUT: Duration = Duration::from_millis(5_000);

/// The capture's device-pixels-per-CSS-pixel ratio (#3467).
///
/// Every crop rect arrives in CSS pixels (`getBoundingClientRect()`), while `CapturePreview` emits
/// device pixels — so on a HiDPI display the two disagree by this factor. It is derived from the
/// capture and the live window rather than trusted from a caller: `img_w / css_viewport_w`, where the
/// CSS width is the window's physical inner width over the OS scale factor. That self-corrects if the
/// captured surface is not exactly the window, and reduces to the plain scale factor when it is.
///
/// Falls back to 1.0 on anything implausible (no window, a failed query, a ratio outside a sane
/// range). A wrong-but-sane crop beats failing a capture mid-loop, and 1.0 is exactly today's
/// behaviour — so the fallback can never be worse than the bug this fixes.
fn capture_scale(app: &tauri::AppHandle, img_w: u32) -> f64 {
    use tauri::Manager;
    let Some(win) = app.get_webview_window("main") else { return 1.0 };
    let size = match win.inner_size() {
        Ok(s) => s,
        Err(_) => return 1.0,
    };
    let sf = match win.scale_factor() {
        Ok(s) => s,
        Err(_) => return 1.0,
    };
    if size.width == 0 || !sf.is_finite() || sf <= 0.0 {
        return 1.0;
    }
    let css_w = size.width as f64 / sf;
    if css_w <= 0.0 {
        return 1.0;
    }
    let scale = img_w as f64 / css_w;
    // A real display is 1.0–4.0; anything outside a generous band means a query we misread.
    if !scale.is_finite() || !(0.25..=8.0).contains(&scale) {
        return 1.0;
    }
    scale
}

/// Take one capture and write the PNG. `id` names the default output file when the request has no `out`.
pub fn capture(app: &tauri::AppHandle, id: &str, req: &ShotRequest) -> Result<ShotResult, String> {
    let shots = shots_dir()?;
    let out: PathBuf = req.out.as_ref().map(PathBuf::from).unwrap_or_else(|| default_png_path(&shots, id));

    // Resolve the crop rect BEFORE capturing, so an unregistered target fails fast (no wasted snapshot):
    // an explicit rect wins; else a named target (e.g. "preview") resolves to the frontend-registered
    // rect; else the whole webview.
    let rect = match (req.rect, req.target.as_deref()) {
        (Some(r), _) => Some(r),
        (None, Some(t)) => Some(resolve_target(app, id, t)?),
        (None, None) => None,
    };

    let png = capture_webview_png(app)?;
    if !is_png(&png) {
        return Err(format!("the webview returned {} bytes that are not a PNG", png.len()));
    }
    let (bytes, w, h) = match rect {
        Some(rect) => {
            // The rect is CSS px; the capture is DEVICE px. Derive the ratio from the capture itself
            // (never from the caller) so every crop path is corrected in one place (#3467).
            let (img_w, _) = crop::png_dimensions(&png)?;
            crop::crop_png(&png, rect, capture_scale(app, img_w))?
        }
        None => {
            let (w, h) = crop::png_dimensions(&png)?;
            (png, w, h)
        }
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(&out, &bytes).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    // Report the dir THIS process resolved (#4163). The caller resolved `out` in its own env; when a
    // capture then cannot be read back, the two dirs side by side name the divergence directly instead
    // of leaving a bare `os error 2` to be guessed at.
    Ok(ShotResult {
        path: out.to_string_lossy().into_owned(),
        w,
        h,
        shots_dir: Some(shots.to_string_lossy().into_owned()),
    })
}

/// Snapshot the main window's webview as PNG bytes.
///
/// Windows only for now (the maintainer's platform). mac/linux return a STATED error rather than a
/// silent black PNG — the whole point of this surface is that a capture which didn't happen must not
/// read as one that did. Their siblings (`WKWebView.takeSnapshot`, `webkit_web_view_get_snapshot`) are
/// the same shape when needed.
#[cfg(windows)]
fn capture_webview_png(app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    use tauri::Manager;
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::IStream;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    let window = app.get_webview_window("main").ok_or("no `main` webview window — cannot capture")?;

    // The capture completes on the WEBVIEW thread; we wait here. Blocking inside `with_webview` would
    // stall the pump that delivers the completion.
    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<u8>, String>>();
    let tx_fail = tx.clone();

    window
        .with_webview(move |webview| {
            let send_fail = |r: Result<Vec<u8>, String>| {
                let _ = tx_fail.send(r);
            };
            unsafe {
                let core = match webview.controller().CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => return send_fail(Err(format!("no CoreWebView2: {e}"))),
                };
                // An HGLOBAL-backed stream (auto-growing, freed with the stream): CapturePreview writes
                // the PNG into it, then the handler rewinds + drains it.
                let stream: IStream = match CreateStreamOnHGlobal(HGLOBAL::default(), true) {
                    Ok(s) => s,
                    Err(e) => return send_fail(Err(format!("cannot create the capture stream: {e}"))),
                };
                let sink = stream.clone();
                let tx_done = tx.clone();
                // The closure receives `windows::core::Result<()>` (webview2-com maps HRESULT through
                // ClosureArg), NOT a raw HRESULT — so propagate it, don't try to `.ok()` it.
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |res: windows::core::Result<()>| {
                    let out = res
                        .map_err(|e| format!("CapturePreview failed: {e}"))
                        .and_then(|()| read_stream(&sink));
                    let _ = tx_done.send(out);
                    Ok(())
                }));
                if let Err(e) = core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) {
                    send_fail(Err(format!("CapturePreview call failed: {e}")));
                }
            }
        })
        .map_err(|e| format!("cannot reach the webview: {e}"))?;

    let bytes = match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(r) => r?,
        Err(_) => {
            return Err(format!(
                "the webview did not complete a capture within {}ms",
                CAPTURE_TIMEOUT.as_millis()
            ))
        }
    };
    if bytes.is_empty() {
        // Distinct from a COM error: an empty read means the stream was never rewound or the capture
        // produced nothing. Either way it must not reach the caller as a "successful" zero-byte PNG.
        return Err("the webview returned an empty capture".into());
    }
    Ok(bytes)
}

/// Drain an `IStream` the capture wrote into. Rewinds first — `CapturePreview` leaves the cursor at the
/// end, so reading without a seek yields zero bytes (which would look exactly like a black/empty capture).
#[cfg(windows)]
fn read_stream(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    unsafe {
        stream.Seek(0, STREAM_SEEK_SET, None).map_err(|e| format!("cannot rewind the capture stream: {e}"))?;
        let mut out: Vec<u8> = vec![];
        let mut buf = [0u8; 64 * 1024];
        loop {
            let mut read: u32 = 0;
            stream
                .Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read as *mut u32))
                .ok()
                .map_err(|e| format!("cannot read the capture stream: {e}"))?;
            if read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..read as usize]);
        }
        Ok(out)
    }
}

#[cfg(not(windows))]
fn capture_webview_png(_app: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    // Stated, not silent. A black PNG that reads as success is worse than no capture: the loop would
    // reason confidently about nothing.
    Err("bsc shot is Windows-only for now (#3261) — no capture was taken".into())
}

// Clamping lives in `crop::crop_png` (where the image's real dimensions are known) and is tested there.
// Nothing here duplicates it: a second clamp would be a second source of truth for the same rule.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_named_target_registers_resolves_and_clears() {
        // The command + resolver are thin wrappers over this map — prove the register→resolve→clear
        // contract (and that an unregistered target is a STATED error) without a Tauri app.
        let targets = ShotTargets::default();
        let rect = Rect { x: 10, y: 20, w: 300, h: 200 };

        // Unregistered ⇒ a clear error, not a whole-screen fallback.
        assert!(resolve_from(&targets.0.lock().unwrap(), "preview").is_err());

        // Register (what set_shot_target_rect(Some) does) ⇒ resolves to the rect.
        targets.0.lock().unwrap().insert("preview".into(), rect);
        assert_eq!(resolve_from(&targets.0.lock().unwrap(), "preview").unwrap(), rect);

        // Clear (set_shot_target_rect(None)) ⇒ back to the error.
        targets.0.lock().unwrap().remove("preview");
        assert!(resolve_from(&targets.0.lock().unwrap(), "preview").is_err());
    }

    // ── `frame:<component>` targeting (#3469) ─────────────────────────────────────────────────────

    #[test]
    fn a_frame_target_is_routed_away_from_the_registered_rect_map() {
        // The prefix is the whole routing rule: `frame:X` must NEVER be looked up in the named-rect
        // map (it would miss and report "navigate first" for a component that IS mounted), and a plain
        // target must never be mistaken for a frame request.
        assert_eq!("frame:Heatmap".strip_prefix(FRAME_PREFIX), Some("Heatmap"));
        assert_eq!("preview".strip_prefix(FRAME_PREFIX), None);
        // A component whose NAME contains the prefix word is still addressed by its own id.
        assert_eq!("frame:frame".strip_prefix(FRAME_PREFIX), Some("frame"));
    }

    #[test]
    fn a_css_rect_becomes_an_integer_crop_without_losing_a_partial_pixel() {
        // getBoundingClientRect() is fractional; the crop grid is integral. Floor the origin and ceil
        // the size — the same rounding the frontend applies registering `preview` — so a box that
        // partially covers a pixel keeps it.
        let r = rect_from_css([10.4, 20.6, 300.2, 199.1], "Heatmap").unwrap();
        assert_eq!(r, Rect { x: 10, y: 20, w: 301, h: 200 });
        // Exact integers pass through untouched.
        assert_eq!(rect_from_css([0.0, 0.0, 8.0, 6.0], "X").unwrap(), Rect { x: 0, y: 0, w: 8, h: 6 });
    }

    #[test]
    fn a_negative_origin_clamps_instead_of_wrapping_through_u32() {
        // A frame scrolled above/left of the viewport reports negatives. `-4.0 as u32` is 0 on this
        // path only because we clamp FIRST — without it the cast saturates/wraps and the crop lands
        // somewhere absurd, which the downstream clamp would then quietly absorb.
        let r = rect_from_css([-4.0, -12.5, 50.0, 40.0], "Offscreen").unwrap();
        assert_eq!(r, Rect { x: 0, y: 0, w: 50, h: 40 });
    }

    #[test]
    fn a_zero_size_frame_is_a_stated_error_not_a_zero_pixel_crop() {
        // Mounted but not laid out yet. Saying so beats handing back an empty PNG that reads as a
        // successful capture of nothing.
        for bad in [[0.0, 0.0, 0.0, 10.0], [0.0, 0.0, 10.0, 0.0], [0.0, 0.0, -5.0, 10.0]] {
            let err = rect_from_css(bad, "Unlaid").unwrap_err();
            assert!(err.contains("zero-size"), "{err}");
            assert!(err.contains("Unlaid"), "names the component: {err}");
        }
        // NaN must error too — every comparison against NaN is false, so a bare `<=` check would
        // have waved it through and produced a garbage crop.
        assert!(rect_from_css([0.0, 0.0, f64::NAN, 10.0], "Unlaid").is_err());
        assert!(rect_from_css([0.0, 0.0, 10.0, f64::INFINITY], "Unlaid").is_err());
    }
}
