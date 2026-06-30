//! WSL2 readiness detection for the OS sandbox (#1916 Layer 4 / #1982).
//!
//! Claude Code's Bash sandbox (the `sandbox` block written by #1980) OS-confines the Bash subprocess
//! tree, but on Windows it engages ONLY inside WSL2 — native Windows is unsupported, so it silently
//! no-ops. This module probes, from the Windows host, whether the sandbox can actually run: is WSL2
//! installed, is there a version-2 distro, and does that distro have the bubblewrap + socat deps the
//! sandbox needs. The detection (`wsl_sandbox_status`) is read-only; `provision_sandbox` (#1988) is the
//! one mutating command here — it imports the sealed `bsc-agent-sandbox` rootfs as a WSL2 distro. The
//! `wsl.exe` spawn rewiring (running the planner/triage sessions INSIDE the distro) is the rest of #1982.

use serde::Serialize;
use tauri::Emitter;

/// The sealed agent sandbox distro we import + run sessions inside (#1988). Built from
/// `tooling/wsl-sandbox/` (Debian-slim + the slim Linux `bsc` sidecars + a locked-down `wsl.conf`,
/// so the distro is the cage regardless of which LLM drives the session inside it).
pub(crate) const AGENT_SANDBOX_DISTRO: &str = "bsc-agent-sandbox";

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslDistro {
    pub name: String,
    pub version: u32,
    pub default: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxReadiness {
    /// "windows" | "macos" | "linux".
    pub platform: String,
    /// Windows needs WSL2 for the Bash sandbox; macOS/Linux confine natively.
    pub needs_wsl: bool,
    pub wsl_installed: bool,
    pub distros: Vec<WslDistro>,
    /// The v2 distro the sandbox would run in (default-first), if any.
    pub sandbox_distro: Option<String>,
    pub bubblewrap: bool,
    pub socat: bool,
    /// Whether our sealed `bsc-agent-sandbox` distro (#1988) is already imported.
    pub agent_sandbox_installed: bool,
    /// Whether the app can install the missing piece itself — Linux: a detected package manager for
    /// bubblewrap/socat; Windows: importing the sealed rootfs. Drives the one-click "Install" button.
    pub auto_installable: bool,
    /// Can the OS sandbox actually engage for a bypass session right now?
    pub ready: bool,
    /// One-line human explanation (+ the next action when not ready).
    pub detail: String,
}

/// Decode `wsl.exe` output. With `WSL_UTF8=1` (set on the command) modern WSL emits UTF-8; older WSL
/// still emits UTF-16LE. Detect interleaved NULs in the head and decode accordingly.
pub(crate) fn decode_wsl(bytes: &[u8]) -> String {
    let sample = bytes.len().min(64);
    let nuls = bytes[..sample].iter().filter(|&&b| b == 0).count();
    if sample >= 8 && nuls * 3 >= sample {
        let u16s: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Parse `wsl -l -v` into distros. Header row is `NAME STATE VERSION`; the default distro is marked
/// with a leading `*`. The VERSION is the trailing numeric column.
pub(crate) fn parse_wsl_distros(out: &str) -> Vec<WslDistro> {
    let mut distros = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("NAME") {
            continue;
        }
        let default = t.starts_with('*');
        let rest = t.trim_start_matches('*').trim();
        let toks: Vec<&str> = rest.split_whitespace().collect();
        // [name, state, version] — drop anything that doesn't carry at least a name + a column.
        if toks.len() < 2 {
            continue;
        }
        let name = toks[0].to_string();
        let version = toks.last().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
        distros.push(WslDistro { name, version, default });
    }
    distros
}

/// Pick the distro the sandbox would run in: a v2 distro, preferring the default.
pub(crate) fn pick_sandbox_distro(distros: &[WslDistro]) -> Option<String> {
    distros
        .iter()
        .find(|d| d.version == 2 && d.default)
        .or_else(|| distros.iter().find(|d| d.version == 2))
        .map(|d| d.name.clone())
}

/// Combine the probes into a readiness verdict + a human detail line with the next action.
pub(crate) fn evaluate(
    wsl_installed: bool,
    distros: &[WslDistro],
    sandbox_distro: &Option<String>,
    bubblewrap: bool,
    socat: bool,
) -> (bool, String) {
    if !wsl_installed {
        return (false, "WSL2 is not installed — run `wsl --install`, then a Linux distro, so the Bash sandbox can engage. Sessions run unsandboxed until then.".into());
    }
    if distros.is_empty() {
        return (false, "WSL2 is present but has no Linux distribution — install one with `wsl --install -d Ubuntu`.".into());
    }
    let Some(distro) = sandbox_distro.as_deref() else {
        return (false, "No WSL2 (version 2) distribution found — the sandbox needs a v2 distro. Convert one with `wsl --set-version <name> 2`.".into());
    };
    match (bubblewrap, socat) {
        (true, true) => (true, format!("Ready — the Bash sandbox can run in `{distro}` (bubblewrap + socat present).")),
        (false, _) => (false, format!("`{distro}` is missing bubblewrap — run `sudo apt-get install -y bubblewrap socat` inside it.")),
        (true, false) => (false, format!("`{distro}` has bubblewrap but not socat (needed for network isolation) — run `sudo apt-get install -y socat`.")),
    }
}

/// A Linux host package manager the app can drive non-interactively (via `pkexec`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum LinuxPm {
    Apt,
    Dnf,
    Pacman,
    Zypper,
}

/// The non-interactive install command (sans elevation) that adds bubblewrap + socat for a PM. Pure.
pub(crate) fn linux_install_command(pm: LinuxPm) -> &'static str {
    match pm {
        LinuxPm::Apt => "apt-get install -y bubblewrap socat",
        LinuxPm::Dnf => "dnf install -y bubblewrap socat",
        LinuxPm::Pacman => "pacman -S --needed --noconfirm bubblewrap socat",
        LinuxPm::Zypper => "zypper install -y bubblewrap socat",
    }
}

/// Map a package-manager binary name to its [`LinuxPm`] (the pure half of `detect_linux_pm`).
pub(crate) fn pm_for_bin(bin: &str) -> Option<LinuxPm> {
    match bin {
        "apt-get" => Some(LinuxPm::Apt),
        "dnf" => Some(LinuxPm::Dnf),
        "pacman" => Some(LinuxPm::Pacman),
        "zypper" => Some(LinuxPm::Zypper),
        _ => None,
    }
}

/// The readiness verdict + detail line for a Linux host, given bubblewrap/socat presence + a detected
/// package manager. Pure — the I/O probe (`host_has`) feeds it. Mirrors `evaluate` for the WSL path.
pub(crate) fn evaluate_linux(bubblewrap: bool, socat: bool, pm: Option<LinuxPm>) -> (bool, String) {
    if bubblewrap && socat {
        return (true, "Ready — the native bubblewrap sandbox can confine Bash.".into());
    }
    let missing = match (bubblewrap, socat) {
        (false, false) => "bubblewrap + socat are",
        (false, true) => "bubblewrap is",
        (true, false) => "socat (needed for network isolation) is",
        (true, true) => unreachable!("ready case handled above"),
    };
    let fix = match pm {
        Some(pm) => format!("install with `sudo {}`, or click Install.", linux_install_command(pm)),
        None => "install bubblewrap + socat with your distro's package manager.".into(),
    };
    (false, format!("{missing} not installed — {fix} Sessions run unsandboxed until then."))
}

/// Whether a command resolves on the host `PATH` (`command -v`). Best-effort — false on any error or
/// (on Windows) where the POSIX shell is absent; only ever called on the macOS/Linux branches.
fn host_has(cmd: &str) -> bool {
    std::process::Command::new("sh")
        .args(["-c", &format!("command -v {cmd} >/dev/null 2>&1")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Detect the host's package manager by probing for its binary, in preference order.
fn detect_linux_pm() -> Option<LinuxPm> {
    ["apt-get", "dnf", "pacman", "zypper"]
        .into_iter()
        .find(|b| host_has(b))
        .and_then(pm_for_bin)
}

/// Probe whether the OS sandbox can engage. On Windows this queries WSL2; elsewhere the OS confines
/// natively (macOS Seatbelt / Linux bubblewrap). Read-only — no provisioning.
#[tauri::command]
pub(crate) fn wsl_sandbox_status() -> SandboxReadiness {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    if cfg!(target_os = "macos") {
        // Seatbelt (`sandbox-exec`) is built into macOS — confirm it's actually present.
        let ready = host_has("sandbox-exec");
        return SandboxReadiness {
            platform: platform.into(),
            needs_wsl: false,
            wsl_installed: false,
            distros: vec![],
            sandbox_distro: None,
            bubblewrap: false,
            socat: false,
            agent_sandbox_installed: false,
            auto_installable: false,
            ready,
            detail: if ready {
                "Native macOS sandbox (Seatbelt) — no setup needed.".into()
            } else {
                "`sandbox-exec` not found — macOS sandboxing is unavailable on this system.".into()
            },
        };
    }
    if !cfg!(windows) {
        // Linux: the native bubblewrap sandbox confines Bash, but `bwrap` + `socat` must be installed
        // on the host. (This branch used to report `ready: true` unconditionally — a false positive
        // that told un-provisioned Linux users they were sandboxed when they weren't.)
        let bubblewrap = host_has("bwrap");
        let socat = host_has("socat");
        let pm = detect_linux_pm();
        let (ready, detail) = evaluate_linux(bubblewrap, socat, pm);
        return SandboxReadiness {
            platform: platform.into(),
            needs_wsl: false,
            wsl_installed: false,
            distros: vec![],
            sandbox_distro: None,
            bubblewrap,
            socat,
            agent_sandbox_installed: false,
            auto_installable: !ready && pm.is_some(),
            ready,
            detail,
        };
    }
    let list = run_wsl(&["-l", "-v"]);
    let wsl_installed = list.is_some();
    let distros = list.map(|s| parse_wsl_distros(&s)).unwrap_or_default();
    let sandbox_distro = pick_sandbox_distro(&distros);
    let (bubblewrap, socat) = match &sandbox_distro {
        Some(d) => probe_deps(d),
        None => (false, false),
    };
    let agent_sandbox_installed = distros.iter().any(|d| d.name == AGENT_SANDBOX_DISTRO);
    let (ready, detail) = evaluate(wsl_installed, &distros, &sandbox_distro, bubblewrap, socat);
    SandboxReadiness {
        platform: platform.into(),
        needs_wsl: true,
        wsl_installed,
        distros,
        sandbox_distro,
        bubblewrap,
        socat,
        agent_sandbox_installed,
        // WSL is present but the sandbox isn't ready → the app can import the sealed rootfs (#1988).
        auto_installable: wsl_installed && !ready,
        ready,
        detail,
    }
}

/// Run a `wsl.exe` meta-command with `WSL_UTF8=1`; `None` if `wsl.exe` is absent or exits non-zero.
fn run_wsl(args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(args).env("WSL_UTF8", "1");
    let out = crate::platform::process::run_output(&mut cmd).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(decode_wsl(&out.stdout))
}

/// Check bubblewrap + socat inside a distro via `command -v` (returns `(bwrap, socat)`).
fn probe_deps(distro: &str) -> (bool, bool) {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args([
        "-d",
        distro,
        "--",
        "sh",
        "-lc",
        "command -v bwrap >/dev/null && echo BWRAP; command -v socat >/dev/null && echo SOCAT",
    ])
    .env("WSL_UTF8", "1");
    match crate::platform::process::run_output(&mut cmd) {
        Ok(out) => {
            let s = decode_wsl(&out.stdout);
            (s.contains("BWRAP"), s.contains("SOCAT"))
        }
        Err(_) => (false, false),
    }
}

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
    let out = crate::platform::process::run_output(&mut cmd)
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
    if !cfg!(windows) {
        return Err("The WSL2 agent sandbox is Windows-only.".into());
    }
    let (program, args) = crate::platform::shell::wsl_invocation(AGENT_SANDBOX_DISTRO, &cwd, &command);
    let mut cmd = std::process::Command::new(program);
    cmd.args(&args).env("WSL_UTF8", "1");
    let out = crate::platform::process::run_output(&mut cmd)
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
/// `~/.base-studio-code/wsl/`), so Settings → General → Storage can surface + reclaim it (#1988).
#[tauri::command]
pub(crate) fn sandbox_disk_usage() -> SandboxDisk {
    let install_dir = sandbox_install_dir();
    SandboxDisk {
        installed: install_dir.exists(),
        distro_bytes: crate::fleet::teardown::dir_size(&install_dir),
        tarball_bytes: std::fs::metadata(sandbox_rootfs_tarball()).map(|m| m.len()).unwrap_or(0),
    }
}

/// Remove the WSL2 agent sandbox entirely — unregister the distro and delete its on-disk image + the
/// cached tarball — returning the bytes freed (#1988). Re-provisionable afterward via Settings →
/// Security. The wsl.exe calls are best-effort (a no-op if the distro isn't registered).
#[tauri::command]
pub(crate) fn remove_sandbox() -> Result<u64, String> {
    if !cfg!(windows) {
        return Err("The WSL2 agent sandbox is Windows-only.".into());
    }
    let install_dir = sandbox_install_dir();
    let tarball = sandbox_rootfs_tarball();
    let freed = crate::fleet::teardown::dir_size(&install_dir)
        + std::fs::metadata(&tarball).map(|m| m.len()).unwrap_or(0);
    for args in [["--terminate", AGENT_SANDBOX_DISTRO], ["--unregister", AGENT_SANDBOX_DISTRO]] {
        let mut cmd = std::process::Command::new("wsl.exe");
        cmd.args(args);
        let _ = crate::platform::process::run_output(&mut cmd);
    }
    let _ = std::fs::remove_dir_all(&install_dir);
    let _ = std::fs::remove_file(&tarball);
    Ok(freed)
}

// --- Host ↔ distro file I/O (#1988, the relocation bridge) -----------------------------------------
// The `\\wsl$` 9P share is unavailable on some Windows installs ("network name cannot be found"), so
// host↔distro file ops go through `wsl` exec with the path EMBEDDED (shell-escaped) in the script —
// the mechanism verified to work. This is the foundation for relocating the planner/triage hub onto
// the distro's ext4: a session sees `/home/agent/...`; the host writes/reads it via these helpers.

/// The project hub's distro-native path for `key` (the in-distro analogue of `project_dir`).
fn sandbox_project_path(key: &str) -> String {
    format!(
        "/home/agent/.base-studio-code/projects/{}",
        crate::platform::fsx::sanitize_project_key(key)
    )
}

/// Single-quote a string as one safe POSIX-shell token.
fn sh_squote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Write `content` to `linux_path` inside the sandbox distro, creating parent dirs — via `wsl` exec
/// (content on stdin; the path is embedded + escaped in the script, since `\\wsl$` is unreliable).
fn sandbox_write(linux_path: &str, content: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;
    let dir = linux_path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
    let script = format!("mkdir -p {} && cat > {}", sh_squote(dir), sh_squote(linux_path));
    let mut child = std::process::Command::new("wsl.exe")
        .args(["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("wsl spawn failed: {e}"))?;
    {
        let mut si = child.stdin.take().ok_or("no stdin handle")?;
        si.write_all(content.as_bytes()).map_err(|e| format!("write stdin: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(decode_wsl(&out.stderr).trim().to_string())
    }
}

/// Read a file from inside the sandbox distro via `wsl` exec.
fn sandbox_read(linux_path: &str) -> Result<String, String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-d", AGENT_SANDBOX_DISTRO, "--", "cat", linux_path]).env("WSL_UTF8", "1");
    let out = crate::platform::process::run_output(&mut cmd).map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(decode_wsl(&out.stdout))
    } else {
        Err(decode_wsl(&out.stderr).trim().to_string())
    }
}

/// Create a project hub INSIDE the sandbox distro (#1988) and seed its `CLAUDE.md`, returning the
/// hub's distro-native path — the cwd a sandboxed planner/triage session launches at (`pty_create`'s
/// `wsl_distro`). The relocation kernel; the launch + plan-file wiring builds on it.
#[tauri::command]
pub(crate) fn setup_sandbox_hub(key: String, claude_md: String) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("The WSL2 agent sandbox is Windows-only.".into());
    }
    let hub = sandbox_project_path(&key);
    sandbox_write(&format!("{hub}/CLAUDE.md"), &claude_md)?;
    Ok(hub)
}

/// Read a file from the sandbox distro (#1988) — e.g. a relocated hub's plan section, for the UI.
#[tauri::command]
pub(crate) fn sandbox_read_file(path: String) -> Result<String, String> {
    if !cfg!(windows) {
        return Err("The WSL2 agent sandbox is Windows-only.".into());
    }
    sandbox_read(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_project_path_is_distro_native_and_sanitized() {
        assert_eq!(sandbox_project_path("my-proj"), "/home/agent/.base-studio-code/projects/my-proj");
        // The key is sanitized the same way as the host hub (no path traversal into the distro).
        assert!(!sandbox_project_path("../etc").contains(".."));
    }

    #[test]
    fn sh_squote_wraps_and_escapes() {
        assert_eq!(sh_squote("/home/agent/x"), "'/home/agent/x'");
        assert_eq!(sh_squote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn linux_install_command_per_pm_adds_both_deps() {
        for pm in [LinuxPm::Apt, LinuxPm::Dnf, LinuxPm::Pacman, LinuxPm::Zypper] {
            let c = linux_install_command(pm);
            assert!(c.contains("bubblewrap") && c.contains("socat"), "{c}");
        }
        assert!(linux_install_command(LinuxPm::Apt).starts_with("apt-get install"));
        assert!(linux_install_command(LinuxPm::Pacman).starts_with("pacman -S"));
    }

    #[test]
    fn pm_for_bin_maps_known_managers_only() {
        assert_eq!(pm_for_bin("apt-get"), Some(LinuxPm::Apt));
        assert_eq!(pm_for_bin("dnf"), Some(LinuxPm::Dnf));
        assert_eq!(pm_for_bin("zypper"), Some(LinuxPm::Zypper));
        assert_eq!(pm_for_bin("brew"), None);
    }

    #[test]
    fn evaluate_linux_flags_each_gap_and_points_at_the_pm() {
        assert!(evaluate_linux(true, true, None).0); // both present → ready
        assert!(!evaluate_linux(false, false, Some(LinuxPm::Apt)).0); // both missing
        assert!(!evaluate_linux(true, false, Some(LinuxPm::Apt)).0); // socat missing
        // a detected PM surfaces its concrete install command
        assert!(evaluate_linux(false, true, Some(LinuxPm::Apt)).1.contains("apt-get install"));
        // no PM → generic guidance, no command
        assert!(evaluate_linux(false, false, None).1.contains("package manager"));
    }

    #[test]
    fn import_args_builds_wsl_import_invocation() {
        let a = import_args("bsc-agent-sandbox", "C:/x/wsl/d", "C:/x/d.tar");
        assert_eq!(
            a,
            vec!["--import", "bsc-agent-sandbox", "C:/x/wsl/d", "C:/x/d.tar", "--version", "2"],
        );
    }

    #[test]
    fn parses_wsl_l_v_output() {
        // Real `wsl -l -v` shape (WSL_UTF8=1): header + a default-marked v2 row + a v1 row.
        let out = "  NAME              STATE           VERSION\n* docker-desktop    Stopped         2\n  Legacy            Running         1\n";
        let d = parse_wsl_distros(out);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], WslDistro { name: "docker-desktop".into(), version: 2, default: true });
        assert_eq!(d[1], WslDistro { name: "Legacy".into(), version: 1, default: false });
    }

    #[test]
    fn decodes_utf16le_and_utf8() {
        // UTF-16LE "Ok" = 4F 00 6B 00; UTF-8 passes through.
        assert_eq!(decode_wsl(&[0x4F, 0x00, 0x6B, 0x00, 0x4F, 0x00, 0x6B, 0x00, 0x4F, 0x00]), "OkOkO");
        assert_eq!(decode_wsl(b"plain utf8"), "plain utf8");
    }

    #[test]
    fn picks_default_v2_distro_then_any_v2() {
        let mixed = vec![
            WslDistro { name: "v1only".into(), version: 1, default: true },
            WslDistro { name: "ubuntu".into(), version: 2, default: false },
        ];
        assert_eq!(pick_sandbox_distro(&mixed), Some("ubuntu".into())); // default is v1 → fall to any v2
        let none_v2 = vec![WslDistro { name: "old".into(), version: 1, default: true }];
        assert_eq!(pick_sandbox_distro(&none_v2), None);
    }

    #[test]
    fn evaluate_covers_each_gap() {
        let v2 = vec![WslDistro { name: "ubuntu".into(), version: 2, default: true }];
        let distro = Some("ubuntu".to_string());
        assert!(!evaluate(false, &[], &None, false, false).0); // not installed
        assert!(!evaluate(true, &[], &None, false, false).0); // no distro
        assert!(!evaluate(true, &v2, &distro, false, false).0); // missing bwrap
        assert!(!evaluate(true, &v2, &distro, true, false).0); // missing socat
        assert!(evaluate(true, &v2, &distro, true, true).0); // ready
    }
}
