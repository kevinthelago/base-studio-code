//! Detached-window creation (#1870). Tab/section tear-off opens a console tab — or a page section —
//! in its own OS window. These windows MUST be built from Rust, not from the JS `new WebviewWindow()`
//! API, for two reasons:
//!
//! 1. **WebView2 browser args (Windows).** Every webview sharing one user-data directory has to launch
//!    with the SAME additional browser arguments, or the new webview fails to initialize and the window
//!    crashes. The main window sets custom args in `tauri.conf.json` (`--no-proxy-server`, disabled
//!    SmartScreen, …); the JS `WebviewOptions` API has no `additionalBrowserArgs` field, so a JS-created
//!    window gets wry's DEFAULT args — a different value — and crashes. Building here lets us apply
//!    `WebviewWindowBuilder::additional_browser_args` with the SAME string, from the one constant below
//!    (guarded by a test against `tauri.conf.json`).
//!
//! 2. **Load the SAME page the main window loads, and pass the marker out-of-band.** The detached window
//!    must load plain `index.html` via `WebviewUrl::App` — byte-identical to the main window — so the
//!    bundle loads and React mounts exactly as it does there. Encoding the detach target in the URL query
//!    instead (`index.html?detachTab=…`, or an absolute `External` URL) does NOT load reliably: Tauri
//!    rewrites/strips the URL for dev-proxied + custom-protocol app pages, so the page failed to mount and
//!    the window came up blank white. The detach target is delivered via an **initialization script** that
//!    sets `window.__BSC_DETACH__` before any page script runs — the frontend reads that, never the URL.

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

/// The WebView2 browser args every window in this app must share. Byte-identical to the main window's
/// `app.windows[0].additionalBrowserArgs` in `tauri.conf.json` — the drift guard test asserts the match.
/// `additional_browser_args` is a no-op off Windows, so passing it unconditionally is safe everywhere.
pub(crate) const WEBVIEW_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --no-proxy-server";

/// Build the document-start init script that hands the detached window its target. `marker` is the
/// caller's JSON object (e.g. `{"kind":"tab","tabId":"…"}`); it's re-serialized through serde so only
/// valid JSON is ever injected (no script-injection via a malformed marker). Pure, so it's unit-tested.
fn detach_init_script(marker: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(marker).map_err(|e| e.to_string())?;
    let normalized = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    Ok(format!("window.__BSC_DETACH__ = {normalized};"))
}

/// Open a detached window (tab/section tear-off). It loads plain `index.html` — the exact page and
/// `WebviewUrl::App` the main window uses, so the bundle loads and React mounts identically — with the
/// same WebView2 browser args (the same-data-dir/same-args constraint on Windows). The detach target is
/// injected as `window.__BSC_DETACH__` via an init script that runs before page scripts, so the new
/// window never depends on a URL query the webview layer might rewrite or strip (#1870).
///
/// `label` is the unique Tauri window label (must match a `windows` entry in a capability — `tab-*`).
/// `marker` is a JSON object describing what to render. Best-effort from the caller's view: a malformed
/// marker or a build failure returns an `Err` string the frontend logs.
#[tauri::command]
pub fn open_detached_window(
    app: AppHandle,
    label: String,
    marker: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let init = detach_init_script(&marker)?;
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(&title)
        .inner_size(width, height)
        .decorations(false) // use the app's custom titlebar, not the native OS frame
        .additional_browser_args(WEBVIEW_BROWSER_ARGS)
        .initialization_script(init)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{detach_init_script, WEBVIEW_BROWSER_ARGS};

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

    #[test]
    fn init_script_injects_normalized_marker() {
        let s = detach_init_script(r#"{"kind":"tab","tabId":"tab_abc"}"#).unwrap();
        assert!(s.starts_with("window.__BSC_DETACH__ = "));
        assert!(s.ends_with(';'));
        // Re-serialized through serde, so the embedded JSON parses back to the same object.
        let json = s
            .trim_start_matches("window.__BSC_DETACH__ = ")
            .trim_end_matches(';');
        let v: serde_json::Value = serde_json::from_str(json).expect("embedded JSON parses");
        assert_eq!(v["kind"], "tab");
        assert_eq!(v["tabId"], "tab_abc");
    }

    #[test]
    fn init_script_rejects_malformed_marker() {
        assert!(detach_init_script("not json").is_err());
    }
}
