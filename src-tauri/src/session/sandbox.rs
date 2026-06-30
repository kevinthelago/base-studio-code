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

/// Probe whether the OS sandbox can engage. On Windows this queries WSL2; elsewhere the OS confines
/// natively. Read-only — no provisioning.
#[tauri::command]
pub(crate) fn wsl_sandbox_status() -> SandboxReadiness {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    if !cfg!(windows) {
        // macOS Seatbelt / Linux bubblewrap engage the #1980 sandbox config directly — no WSL.
        return SandboxReadiness {
            platform: platform.into(),
            needs_wsl: false,
            wsl_installed: false,
            distros: vec![],
            sandbox_distro: None,
            bubblewrap: false,
            socat: false,
            agent_sandbox_installed: false,
            ready: true,
            detail: "Native OS sandbox (macOS Seatbelt / Linux bubblewrap) — no WSL2 needed.".into(),
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

/// Import the sealed `bsc-agent-sandbox` rootfs as a WSL2 distro (#1988). A no-op success if it is
/// already installed. The rootfs tarball must be staged first (built by
/// `tooling/wsl-sandbox/build-rootfs.sh`); returns a clear error if it is missing.
#[tauri::command]
pub(crate) fn provision_sandbox() -> Result<String, String> {
    if !cfg!(windows) {
        return Err("The WSL2 agent sandbox is a Windows-only feature.".into());
    }
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
        Ok(format!("Imported {AGENT_SANDBOX_DISTRO}."))
    } else {
        Err(decode_wsl(&out.stderr))
    }
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
