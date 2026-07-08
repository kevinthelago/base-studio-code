//! Verify-build (#2635) — build + serve a completed project's finished app for the in-graph preview
//! (#2623). Host-first, WEB case: find the app repo (a `package.json` carrying a `build` script under the
//! project hub), run its build, spawn its preview server, and capture the local URL from the server's
//! stdout. The server is kept in managed state and the PRIOR one for a project is killed on a rebuild
//! (no leak). wasm + native targets are separate strategies (later slices of #2623).
//!
//! RUNTIME-UNVERIFIED: process spawning + URL capture + npm-on-PATH are platform-specific and need a
//! live run to trust; this compiles + is structured, but the first real fleet completion is the test.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use crate::platform::paths;
use crate::platform::process::no_window;

/// The PreviewSource the frontend renders — mirrors `shared/lib/preview/previewSource.ts` (web-first).
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum PreviewSource {
    Web { url: String },
}

/// Live preview servers keyed by project (Tauri managed state) — so a rebuild kills the prior server
/// for that project rather than leaking it.
#[derive(Default)]
pub(crate) struct PreviewServers(Mutex<HashMap<String, Child>>);

/// A shell command in `cwd` — via the OS shell so `npm`/`npx` resolve on PATH (and `.cmd` on Windows).
fn shell(cwd: &Path, script: &str) -> Command {
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", script]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-lc", script]);
        c
    };
    c.current_dir(cwd);
    no_window(&mut c);
    c
}

/// The web app under the project hub: the first repo subdir whose `package.json` has a `build` script,
/// plus the serve command (framework `preview` if present, else a static serve of the build output).
fn find_web_app(hub: &Path) -> Option<(PathBuf, String)> {
    for entry in std::fs::read_dir(hub).ok()?.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.starts_with('.') || name == "prompts" {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(dir.join("package.json")) else { continue };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let scripts = json.get("scripts").and_then(|s| s.as_object());
        let has = |k: &str| scripts.map(|s| s.contains_key(k)).unwrap_or(false);
        if has("build") {
            let serve = if has("preview") { "npm run preview" } else { "npx --yes serve -s dist" };
            return Some((dir, serve.to_string()));
        }
    }
    None
}

/// Pull the first local server URL out of a preview server's stdout line (Vite/serve/etc.), stripping
/// trailing slash + ANSI colour. `None` when the line has no local URL.
fn extract_url(line: &str) -> Option<String> {
    for host in ["http://localhost:", "http://127.0.0.1:", "http://[::1]:"] {
        if let Some(i) = line.find(host) {
            let rest = &line[i..];
            let end = rest.find(|c: char| c.is_whitespace() || c == '\u{1b}').unwrap_or(rest.len());
            return Some(rest[..end].trim_end_matches('/').to_string());
        }
    }
    None
}

/// Build + serve a completed project's app for the in-graph preview (#2623). Returns the `PreviewSource`,
/// or `None` when the project isn't a buildable web app here (→ the preview node keeps its placeholder;
/// wasm/native are handled by later strategies). Errors surface to the morph as a build failure.
#[tauri::command]
pub(crate) async fn verify_build(
    project_key: String,
    servers: tauri::State<'_, PreviewServers>,
) -> Result<Option<PreviewSource>, String> {
    let hub = paths::project_dir(&project_key);
    let Some((app_dir, serve_script)) = find_web_app(&hub) else {
        return Ok(None); // not a web app we can build here
    };

    // Build (blocking): install then build. Fail the command so the morph shows the failure.
    let status = shell(&app_dir, "npm ci || npm install")
        .status()
        .and_then(|_| shell(&app_dir, "npm run build").status())
        .map_err(|e| format!("build failed to start: {e}"))?;
    if !status.success() {
        return Err(format!("build exited with {status}"));
    }

    // Kill the prior server for this project before starting a new one (no leak).
    if let Ok(mut map) = servers.0.lock() {
        if let Some(mut prev) = map.remove(&project_key) {
            let _ = prev.kill();
        }
    }

    // Serve: spawn the preview server, read its stdout until it reports a local URL (bounded by a
    // deadline so a server that never prints one doesn't hang the command).
    let mut child = shell(&app_dir, &serve_script)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("preview server failed to start: {e}"))?;
    let stdout = child.stdout.take().ok_or("preview server has no stdout")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = extract_url(&line) {
                let _ = tx.send(url);
                return;
            }
        }
    });
    let url = match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(url) => url,
        Err(_) => {
            let _ = child.kill();
            return Err("preview server did not report a local URL".into());
        }
    };
    if let Ok(mut map) = servers.0.lock() {
        map.insert(project_key, child);
    }
    Ok(Some(PreviewSource::Web { url }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_url_pulls_a_local_url_and_strips_ansi_and_slash() {
        assert_eq!(extract_url("  ➜  Local:   \u{1b}[36mhttp://localhost:4173/\u{1b}[39m"), Some("http://localhost:4173".into()));
        assert_eq!(extract_url("Serving at http://127.0.0.1:3000"), Some("http://127.0.0.1:3000".into()));
        assert_eq!(extract_url("nothing here"), None);
    }
}
