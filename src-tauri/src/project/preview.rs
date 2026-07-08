//! Verify-build (#2635/#2639) — build + run a completed project's finished app for the in-graph preview
//! (#2623). Two host-first cases:
//!   • WEB — an app repo with a `package.json` `build` script: build it, spawn its preview server, and
//!     capture the local URL → `PreviewSource::Web` (rendered as a sandboxed iframe in the node).
//!   • NATIVE — a Cargo binary with no web build (a pure Rust/C++/wgpu desktop app that can't be iframed):
//!     `cargo build --release`, then launch the binary as its OWN desktop window → `PreviewSource::Native`
//!     (the node shows a "running in its own window" state). Host-native by default; a Linux-only GUI would
//!     be passed through WSLg. In-graph frame capture/streaming is a later render surface behind this seam.
//! In every case the running process is kept in managed state keyed by project, so a rebuild kills the
//! PRIOR one for that project (no leak).
//!
//! RUNTIME-UNVERIFIED: process spawning, URL capture, and npm/cargo-on-PATH are platform-specific and need
//! a live run to trust; this compiles + is structured, but the first real fleet completion is the test.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use crate::platform::paths;
use crate::platform::process::no_window;

/// The PreviewSource the frontend renders — mirrors `shared/lib/preview/previewSource.ts`.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum PreviewSource {
    /// A served local preview URL (web app) → rendered as an iframe.
    Web { url: String },
    /// A native binary launched as its own desktop window → the node shows a "running externally" state.
    Native { label: String },
}

/// Live preview processes keyed by project (Tauri managed state) — a web preview server OR a launched
/// native app. A rebuild kills the prior one for that project rather than leaking it.
#[derive(Default)]
pub(crate) struct PreviewServers(Mutex<HashMap<String, Child>>);

impl PreviewServers {
    /// Replace the tracked process for `project`, killing the one it displaces.
    fn replace(&self, project: &str, child: Child) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(mut prev) = map.insert(project.to_string(), child) {
                let _ = prev.kill();
            }
        }
    }
    /// Kill + drop any tracked process for `project` (before a fresh build starts).
    fn kill(&self, project: &str) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(mut prev) = map.remove(project) {
                let _ = prev.kill();
            }
        }
    }
}

/// A shell command in `cwd` — via the OS shell so `npm`/`npx`/`cargo` resolve on PATH (and `.cmd` on Windows).
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
    for dir in repo_dirs(hub) {
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

/// The native app under the project hub: the first repo subdir that is a Cargo binary crate (a `Cargo.toml`
/// with a `[[bin]]` target or a `src/main.rs`), plus the binary name to launch after `cargo build --release`.
fn find_native_app(hub: &Path) -> Option<(PathBuf, String)> {
    for dir in repo_dirs(hub) {
        let Ok(text) = std::fs::read_to_string(dir.join("Cargo.toml")) else { continue };
        let has_bin = text.contains("[[bin]]") || dir.join("src/main.rs").exists();
        if !has_bin {
            continue;
        }
        let name = cargo_package_name(&text)
            .unwrap_or_else(|| dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
        return Some((dir, name));
    }
    None
}

/// Repo subdirs of the project hub (skipping hidden dirs + the planner's `prompts/`).
fn repo_dirs(hub: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(hub) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|dir| dir.is_dir())
        .filter(|dir| {
            let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            !name.starts_with('.') && name != "prompts"
        })
        .collect()
}

/// The `name` from a Cargo.toml `[package]` table (naive line scan — no toml dep). `None` when absent.
fn cargo_package_name(text: &str) -> Option<String> {
    let mut in_package = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_package = t == "[package]";
            continue;
        }
        if in_package {
            if let Some(rest) = t.strip_prefix("name") {
                if let Some(eq) = rest.trim_start().strip_prefix('=') {
                    return Some(eq.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    None
}

/// The built release binary for `name` under `app_dir/target/release` — the named path first, else the
/// first plausible executable in the directory. `None` when the build produced nothing runnable.
fn built_binary(app_dir: &Path, name: &str) -> Option<PathBuf> {
    let release = app_dir.join("target").join("release");
    let named = release.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
    if named.is_file() {
        return Some(named);
    }
    for entry in std::fs::read_dir(&release).ok()?.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let fname = p.file_name()?.to_string_lossy().into_owned();
        let looks_exe = if cfg!(windows) {
            fname.ends_with(".exe")
        } else {
            // no extension + not a build artifact (.d) → a Unix executable
            !fname.contains('.')
        };
        if looks_exe {
            return Some(p);
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

/// Build + run a completed project's app for the in-graph preview (#2623). Returns the `PreviewSource`, or
/// `None` when the project isn't a buildable app here (→ the node keeps its placeholder). Errors surface to
/// the morph as a build failure. Tries the web case first, then the native (Cargo binary) case.
#[tauri::command]
pub(crate) async fn verify_build(
    project_key: String,
    servers: tauri::State<'_, PreviewServers>,
) -> Result<Option<PreviewSource>, String> {
    let hub = paths::project_dir(&project_key);
    if let Some((app_dir, serve_script)) = find_web_app(&hub) {
        return build_and_serve_web(&project_key, &app_dir, &serve_script, &servers).map(Some);
    }
    if let Some((app_dir, bin_name)) = find_native_app(&hub) {
        return build_and_launch_native(&project_key, &app_dir, &bin_name, &servers).map(Some);
    }
    Ok(None) // not an app we can build + run here (wasm rides the web path; other stacks: later slices)
}

/// WEB: install + build, then spawn the preview server and read its stdout until it reports a local URL
/// (deadline-bounded so a server that never prints one can't hang the command).
fn build_and_serve_web(
    project_key: &str,
    app_dir: &Path,
    serve_script: &str,
    servers: &PreviewServers,
) -> Result<PreviewSource, String> {
    let status = shell(app_dir, "npm ci || npm install")
        .status()
        .and_then(|_| shell(app_dir, "npm run build").status())
        .map_err(|e| format!("build failed to start: {e}"))?;
    if !status.success() {
        return Err(format!("build exited with {status}"));
    }
    servers.kill(project_key);

    let mut child = shell(app_dir, serve_script)
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
    match rx.recv_timeout(Duration::from_secs(30)) {
        Ok(url) => {
            servers.replace(project_key, child);
            Ok(PreviewSource::Web { url })
        }
        Err(_) => {
            let _ = child.kill();
            Err("preview server did not report a local URL".into())
        }
    }
}

/// NATIVE: `cargo build --release`, then launch the binary as its own desktop window (it renders on the
/// desktop, not in the node). The child is tracked so a rebuild replaces it.
fn build_and_launch_native(
    project_key: &str,
    app_dir: &Path,
    bin_name: &str,
    servers: &PreviewServers,
) -> Result<PreviewSource, String> {
    let status = shell(app_dir, "cargo build --release")
        .status()
        .map_err(|e| format!("cargo build failed to start: {e}"))?;
    if !status.success() {
        return Err(format!("cargo build exited with {status}"));
    }
    let bin = built_binary(app_dir, bin_name)
        .ok_or_else(|| format!("no runnable binary found in {}/target/release", app_dir.display()))?;

    servers.kill(project_key);
    // Launch detached — the GUI app owns its own window. (No no_window: let it create its window; a
    // console app would show a console, which is acceptable for a preview.)
    let child = Command::new(&bin)
        .current_dir(app_dir)
        .spawn()
        .map_err(|e| format!("failed to launch {}: {e}", bin.display()))?;
    servers.replace(project_key, child);
    Ok(PreviewSource::Native { label: bin_name.to_string() })
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

    #[test]
    fn cargo_package_name_reads_the_package_table_only() {
        let toml = "[package]\nname = \"my-app\"\nversion = \"0.1.0\"\n\n[dependencies]\nname = \"not-this\"\n";
        assert_eq!(cargo_package_name(toml), Some("my-app".into()));
        assert_eq!(cargo_package_name("[dependencies]\nname = \"dep\"\n"), None);
    }
}
