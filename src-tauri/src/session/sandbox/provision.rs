//! The mutating sandbox lifecycle (#1988): import the sealed `bsc-agent-sandbox` WSL2 rootfs (or the
//! native Linux deps), remove it, report its disk footprint, and run a one-shot command inside it. The
//! read-only readiness probe lives in [`super::readiness`]; the host↔distro file bridge in [`super::bridge`].

use super::readiness::{detect_linux_pm, host_has, linux_install_command, parse_wsl_distros, run_wsl};
use super::{decode_wsl, require_windows, AGENT_SANDBOX_DISTRO};
use crate::platform::process::run_output;
use serde::Serialize;
use tauri::Emitter;

/// Where the sealed agent distro is imported on the Windows host (its ext4 vhdx lives here).
fn sandbox_install_dir() -> std::path::PathBuf {
    crate::platform::paths::bsc_base_dir().join("wsl").join(AGENT_SANDBOX_DISTRO)
}

/// The bundled rootfs tarball the app imports. Built by `tooling/wsl-sandbox/build-rootfs.sh` and
/// staged here (installer bundling is a packaging follow-up).
fn sandbox_rootfs_tarball() -> std::path::PathBuf {
    crate::platform::paths::bsc_base_dir().join("wsl").join("bsc-agent-sandbox.tar")
}

/// The `wsl --import <distro> <dir> <tarball> --version 2` argument vector. Pure, so it can be
/// unit-tested without WSL present.
fn import_args(distro: &str, install_dir: &str, tarball: &str) -> Vec<String> {
    vec![
        "--import".into(),
        distro.into(),
        install_dir.into(),
        tarball.into(),
        "--version".into(),
        "2".into(),
    ]
}

/// Emit one `sandbox-install` progress event to the frontend (phases: `start` · `log` · `done`), so
/// the install surface shows exactly what's happening live.
fn emit_install(app: &tauri::AppHandle, phase: &str, line: &str) {
    let _ = app.emit("sandbox-install", serde_json::json!({ "phase": phase, "line": line }));
}

/// Spawn `cmd` and stream each output line to the frontend as a `sandbox-install` log event (stderr is
/// merged by the caller via `2>&1`), so the user watches the install happen. Returns exit success.
fn stream_lines(app: &tauri::AppHandle, cmd: &mut std::process::Command) -> Result<bool, String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("failed to start: {e}"))?;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            emit_install(app, "log", &line);
        }
    }
    let status = child.wait().map_err(|e| format!("process error: {e}"))?;
    Ok(status.success())
}

/// Install the OS-sandbox prerequisites for this host, one-click, emitting `sandbox-install` progress
/// events throughout so the UI shows exactly what's being installed. On **Windows**, import the sealed
/// `bsc-agent-sandbox` rootfs as a WSL2 distro (#1988; no-op success if already installed — the rootfs
/// tarball must be staged first by `tooling/wsl-sandbox/build-rootfs.sh`). On **Linux**, install
/// bubblewrap + socat via the detected package manager, elevated through `pkexec`. On **macOS** there
/// is nothing to install (Seatbelt is built in).
#[tauri::command]
pub(crate) fn provision_sandbox(app: tauri::AppHandle) -> Result<String, String> {
    emit_install(&app, "start", "Setting up the agent sandbox…");
    let result = if !cfg!(windows) {
        provision_native_deps(&app)
    } else {
        provision_windows_rootfs(&app)
    };
    let (ok, line) = match &result {
        Ok(m) => (true, m.clone()),
        Err(m) => (false, m.clone()),
    };
    let _ = app.emit(
        "sandbox-install",
        serde_json::json!({ "phase": "done", "ok": ok, "line": line }),
    );
    result
}

/// Windows: import the sealed `bsc-agent-sandbox` WSL2 rootfs (#1988). The import is quick and quiet,
/// so we emit a status line + the result rather than streaming (its output is also UTF-16-prone).
fn provision_windows_rootfs(app: &tauri::AppHandle) -> Result<String, String> {
    if let Some(out) = run_wsl(&["-l", "-v"]) {
        if parse_wsl_distros(&out).iter().any(|d| d.name == AGENT_SANDBOX_DISTRO) {
            return Ok(format!("{AGENT_SANDBOX_DISTRO} is already installed."));
        }
    }
    let tarball = sandbox_rootfs_tarball();
    if !tarball.exists() {
        return Err(format!(
            "Sandbox rootfs not found at {}. Build it with tooling/wsl-sandbox/build-rootfs.sh and stage it there.",
            tarball.display()
        ));
    }
    let install_dir = sandbox_install_dir();
    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("Could not create {}: {e}", install_dir.display()))?;
    emit_install(app, "log", &format!("Importing the sealed {AGENT_SANDBOX_DISTRO} distro…"));
    let args = import_args(
        AGENT_SANDBOX_DISTRO,
        &install_dir.to_string_lossy(),
        &tarball.to_string_lossy(),
    );
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(&args).env("WSL_UTF8", "1");
    let out = run_output(&mut cmd)
        .map_err(|e| format!("wsl --import failed to start: {e}"))?;
    if out.status.success() {
        Ok(format!("Imported {AGENT_SANDBOX_DISTRO} — the sandbox is ready."))
    } else {
        let err = decode_wsl(&out.stderr);
        let err = err.trim();
        emit_install(app, "log", err);
        Err(if err.is_empty() { "wsl --import failed.".into() } else { err.to_string() })
    }
}

/// Install the native Linux sandbox deps (bubblewrap + socat) via the detected package manager,
/// elevated through `pkexec` (graphical sudo). macOS needs nothing — Seatbelt is built in. Returns a
/// copy-pasteable manual command when no package manager or no `pkexec` is found, rather than failing
/// opaquely.
fn provision_native_deps(app: &tauri::AppHandle) -> Result<String, String> {
    if cfg!(target_os = "macos") {
        return Ok("macOS uses the built-in Seatbelt sandbox — nothing to install.".into());
    }
    let Some(pm) = detect_linux_pm() else {
        return Err("No supported package manager found (apt/dnf/pacman/zypper) — install `bubblewrap` and `socat` manually.".into());
    };
    let install = linux_install_command(pm);
    if !host_has("pkexec") {
        return Err(format!("`pkexec` (graphical sudo) not found — run `sudo {install}` in a terminal."));
    }
    emit_install(app, "log", "Requesting administrator access (you may be prompted for your password)…");
    // Merge stderr into stdout so the streamed log carries the package manager's progress + warnings.
    let mut cmd = std::process::Command::new("pkexec");
    cmd.args(["sh", "-c", &format!("{install} 2>&1")]);
    if stream_lines(app, &mut cmd)? {
        Ok("Installed bubblewrap + socat — the native sandbox is ready.".into())
    } else {
        Err(format!("Install failed — try `sudo {install}` manually."))
    }
}

/// Run a one-shot `command` inside the sealed `bsc-agent-sandbox` distro (#1988) at distro-native
/// `cwd` (empty ⇒ the agent's `~`) and return its stdout. This is the exact spawn recipe
/// (`wsl.exe -d <distro> --cd … -- bash -lc`) the PTY session launch will use (Phase 2) — landed first
/// as a verifiable command so the recipe is proven before it's threaded through the central PTY path.
#[tauri::command]
pub(crate) fn sandbox_run(cwd: String, command: String) -> Result<String, String> {
    require_windows()?;
    let (program, args) = crate::platform::shell::wsl_invocation(AGENT_SANDBOX_DISTRO, &cwd, &command);
    let mut cmd = std::process::Command::new(program);
    cmd.args(&args).env("WSL_UTF8", "1");
    let out = run_output(&mut cmd)
        .map_err(|e| format!("wsl exec failed to start: {e}"))?;
    let stdout = decode_wsl(&out.stdout);
    if out.status.success() {
        Ok(stdout)
    } else {
        let stderr = decode_wsl(&out.stderr);
        Err(format!("exit {}: {}", out.status.code().unwrap_or(-1), stderr.trim()))
    }
}

/// The disk footprint of the WSL2 agent sandbox (#1988) — invisible to the worktree-only Storage scan,
/// so Storage surfaces it separately.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxDisk {
    /// Whether the distro's on-disk image exists.
    pub installed: bool,
    /// The imported distro's ext4 image (`~/.base-studio-code/wsl/<distro>/`); grows as it's used.
    pub distro_bytes: u64,
    /// The staged rootfs tarball — a cache, only needed to (re)import; reclaimable on its own.
    pub tarball_bytes: u64,
}

/// Report the WSL2 agent sandbox's disk usage (the distro image + the cached rootfs tarball under
/// `~/.base-studio-code/wsl/`), so Settings → Planner → Storage can surface + reclaim it (#1988).
/// Async + `spawn_blocking` so the distro-image size walk runs OFF the main thread (#1916 perf).
#[tauri::command]
pub(crate) async fn sandbox_disk_usage() -> SandboxDisk {
    tauri::async_runtime::spawn_blocking(sandbox_disk_usage_inner)
        .await
        .unwrap_or(SandboxDisk { installed: false, distro_bytes: 0, tarball_bytes: 0 })
}

fn sandbox_disk_usage_inner() -> SandboxDisk {
    let install_dir = sandbox_install_dir();
    SandboxDisk {
        installed: install_dir.exists(),
        distro_bytes: crate::fleet::disk::dir_size(&install_dir),
        tarball_bytes: std::fs::metadata(sandbox_rootfs_tarball()).map(|m| m.len()).unwrap_or(0),
    }
}

/// Remove the WSL2 agent sandbox entirely — unregister the distro and delete its on-disk image + the
/// cached tarball — returning the bytes freed (#1988). Re-provisionable afterward via Settings →
/// Security. The wsl.exe calls are best-effort (a no-op if the distro isn't registered).
#[tauri::command]
pub(crate) fn remove_sandbox() -> Result<u64, String> {
    require_windows()?;
    let install_dir = sandbox_install_dir();
    let tarball = sandbox_rootfs_tarball();
    let freed = crate::fleet::disk::dir_size(&install_dir)
        + std::fs::metadata(&tarball).map(|m| m.len()).unwrap_or(0);
    for args in [["--terminate", AGENT_SANDBOX_DISTRO], ["--unregister", AGENT_SANDBOX_DISTRO]] {
        let mut cmd = std::process::Command::new("wsl.exe");
        cmd.args(args);
        let _ = run_output(&mut cmd);
    }
    let _ = std::fs::remove_dir_all(&install_dir);
    let _ = std::fs::remove_file(&tarball);
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_args_builds_wsl_import_invocation() {
        let a = import_args("bsc-agent-sandbox", "C:/x/wsl/d", "C:/x/d.tar");
        assert_eq!(
            a,
            vec!["--import", "bsc-agent-sandbox", "C:/x/wsl/d", "C:/x/d.tar", "--version", "2"],
        );
    }
}
