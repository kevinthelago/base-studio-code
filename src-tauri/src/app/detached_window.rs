//! Detached-window creation (#1870). Tab/section tear-off opens a console tab — or a page section —
//! in its own OS window. These windows MUST be built from Rust, not from the JS `new WebviewWindow()`
//! API, because of a Windows WebView2 constraint: every webview sharing one user-data directory has to
//! launch with the SAME additional browser arguments, or the new webview fails to initialize and the
//! window comes up blank (no JS runs, so even the pure-DOM fatal overlay can't surface it).
//!
//! The main window sets custom args in `tauri.conf.json` (`--no-proxy-server`, disabled SmartScreen,
//! …). The JS `WebviewOptions` API has no `additionalBrowserArgs` field, so a JS-created window gets
//! wry's DEFAULT args — a different value — and crashes. Building here lets us apply
//! `WebviewWindowBuilder::additional_browser_args` with the SAME string, sourced from the one constant
//! below so the two can never drift (guarded by a test against `tauri.conf.json`).

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// The WebView2 browser args every window in this app must share. Byte-identical to the main window's
/// `app.windows[0].additionalBrowserArgs` in `tauri.conf.json` — the drift guard test asserts the match.
/// `additional_browser_args` is a no-op off Windows, so passing it unconditionally is safe everywhere.
pub(crate) const WEBVIEW_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --no-proxy-server";

/// Open a detached window (tab/section tear-off) loading `url`, with the same browser args as the main
/// window so its WebView2 process doesn't fail the same-data-dir/same-args constraint on Windows.
///
/// `label` is the unique Tauri window label (must match a `windows` entry in a capability — `tab-*`).
/// Best-effort from the caller's view: a build failure returns an `Err` string the frontend logs.
#[tauri::command]
pub fn open_detached_window(
    app: AppHandle,
    label: String,
    url: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(&title)
        .inner_size(width, height)
        .decorations(false) // use the app's custom titlebar, not the native OS frame
        .additional_browser_args(WEBVIEW_BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::WEBVIEW_BROWSER_ARGS;

    /// Drift guard: the detached-window args MUST equal the main window's `additionalBrowserArgs` in
    /// `tauri.conf.json`. If they diverge, a torn-off window's WebView2 fails to init on Windows and
    /// the window crashes (#1870) — the exact bug this module fixes.
    #[test]
    fn detached_args_match_main_window_config() {
        let conf = include_str!("../../tauri.conf.json");
        let json: serde_json::Value = serde_json::from_str(conf).expect("tauri.conf.json parses");
        let main_args = json["app"]["windows"][0]["additionalBrowserArgs"]
            .as_str()
            .expect("main window declares additionalBrowserArgs");
        assert_eq!(
            main_args, WEBVIEW_BROWSER_ARGS,
            "detached-window browser args drifted from the main window's tauri.conf.json args; \
             a mismatch crashes torn-off windows on Windows (#1870)"
        );
    }
}
