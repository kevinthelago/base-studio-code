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

use bsc_shot::{default_png_path, is_png, shots_dir, ShotRequest, ShotResult};
use std::path::PathBuf;
use std::time::Duration;

mod crop;

/// How long to wait for `CapturePreview`'s completion handler. Shorter than the CLI's timeout so the
/// caller gets our real error rather than a bare timeout.
const CAPTURE_TIMEOUT: Duration = Duration::from_millis(5_000);

/// Take one capture and write the PNG. `id` names the default output file when the request has no `out`.
pub fn capture(app: &tauri::AppHandle, id: &str, req: &ShotRequest) -> Result<ShotResult, String> {
    let shots = shots_dir()?;
    let out: PathBuf = req.out.as_ref().map(PathBuf::from).unwrap_or_else(|| default_png_path(&shots, id));

    let png = capture_webview_png(app)?;
    if !is_png(&png) {
        return Err(format!("the webview returned {} bytes that are not a PNG", png.len()));
    }
    let (bytes, w, h) = match req.rect {
        Some(rect) => crop::crop_png(&png, rect)?,
        None => {
            let (w, h) = crop::png_dimensions(&png)?;
            (png, w, h)
        }
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(&out, &bytes).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    Ok(ShotResult { path: out.to_string_lossy().into_owned(), w, h })
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
