//! Read-only OS-sandbox readiness probe (#1916 Layer 4 / #1982): can the Bash sandbox actually engage
//! on this host? On Windows this queries WSL2 + the distro's bubblewrap/socat deps; on macOS/Linux the
//! OS confines natively. The verdict-building helpers (`evaluate*`, `parse_wsl_distros`, …) are pure so
//! they unit-test without WSL present; the I/O probes feed them.

use super::{decode_wsl, wsl_exec, AGENT_SANDBOX_DISTRO};
use crate::platform::process::run_output;
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WslDistro {
    pub name: String,
    pub version: u32,
    pub default: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
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
    /// Which agent runtimes the imported sealed distro actually carries (#4260). `None` when it isn't
    /// imported at all. A distro built before #4260 has `bsc`/`bsc-agent` but NOT `claude` or `gh` —
    /// so it can only host the non-default harness, and a session launched into it would find no
    /// `claude` to run and no `gh` for the director. Surfacing this is the precondition for ever
    /// making the sandbox mandatory; an unreported gap is the "silent skip" failure shape.
    pub agent_sandbox_runtimes: Option<SandboxRuntimes>,
    /// One-line gap description when the imported distro is missing runtimes, else `None`.
    pub agent_sandbox_gap: Option<String>,
    /// Whether the app can install the missing piece itself — Linux: a detected package manager for
    /// bubblewrap/socat; Windows: importing the sealed rootfs. Drives the one-click "Install" button.
    pub auto_installable: bool,
    /// Can the OS sandbox actually engage for a bypass session right now?
    pub ready: bool,
    /// One-line human explanation (+ the next action when not ready).
    pub detail: String,
}

/// The agent runtimes present inside the sealed distro (#4260). The cage has to host EVERY harness,
/// not just the one it was originally built for: `claude` is the default harness and `gh` is the
/// director's whole GitHub surface, so a distro missing either can host only part of the fleet.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxRuntimes {
    /// Claude Code — the DEFAULT harness (`fleetHarness ?? "claude"`).
    pub claude: bool,
    /// The model-agnostic agent runtime.
    pub bsc_agent: bool,
    /// The GitHub CLI — the director's writes + every session's readiness probe (#297 S1).
    pub gh: bool,
    /// git — worktrees.
    pub git: bool,
}

/// Describe what an imported distro is missing, or `None` when it can host the whole fleet. Pure, so
/// the wording + the "which gaps matter" judgement unit-test without a live distro.
///
/// Phrased as the ACTION, not just the diagnosis: the fix is rebuilding the rootfs from the current
/// `tooling/wsl-sandbox/`, because a distro imported before #4260 predates the baked-in runtimes.
pub(crate) fn evaluate_runtimes(r: &SandboxRuntimes) -> Option<String> {
    let mut missing = Vec::new();
    if !r.claude { missing.push("Claude Code (the default harness)"); }
    if !r.gh { missing.push("`gh` (the director's GitHub surface)"); }
    if !r.bsc_agent { missing.push("`bsc-agent`"); }
    if !r.git { missing.push("`git`"); }
    if missing.is_empty() {
        return None;
    }
    Some(format!(
        "The imported `{AGENT_SANDBOX_DISTRO}` distro is missing {} — it predates the baked-in agent \
         runtimes (#4260), so sessions launched into it can't run that half of the fleet. Rebuild the \
         rootfs from tooling/wsl-sandbox/ and re-import it.",
        missing.join(", "),
    ))
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
pub(super) fn host_has(cmd: &str) -> bool {
    std::process::Command::new("sh")
        .args(["-c", &format!("command -v {cmd} >/dev/null 2>&1")])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Detect the host's package manager by probing for its binary, in preference order.
pub(super) fn detect_linux_pm() -> Option<LinuxPm> {
    ["apt-get", "dnf", "pacman", "zypper"]
        .into_iter()
        .find(|b| host_has(b))
        .and_then(pm_for_bin)
}

/// Probe whether the OS sandbox can engage. On Windows this queries WSL2; elsewhere the OS confines
/// natively (macOS Seatbelt / Linux bubblewrap). Read-only — no provisioning.
///
/// Async + `spawn_blocking` so the (blocking) `wsl.exe` / host probe runs OFF the main thread: as a
/// synchronous command it ran on the UI thread and froze the window for the seconds a cold `wsl.exe`
/// takes to spin up — felt as a slow Settings page (#1916 perf).
#[tauri::command]
pub(crate) async fn wsl_sandbox_status() -> SandboxReadiness {
    tauri::async_runtime::spawn_blocking(wsl_sandbox_status_inner)
        .await
        .unwrap_or_else(|_| wsl_sandbox_status_inner())
}

fn wsl_sandbox_status_inner() -> SandboxReadiness {
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
            ready,
            detail: if ready {
                "Native macOS sandbox (Seatbelt) — no setup needed.".into()
            } else {
                "`sandbox-exec` not found — macOS sandboxing is unavailable on this system.".into()
            },
            ..Default::default()
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
            bubblewrap,
            socat,
            auto_installable: !ready && pm.is_some(),
            ready,
            detail,
            ..Default::default()
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
    // #4260: only probe the sealed distro's runtimes when it's actually imported — the probe is a wsl
    // spawn, and asking an absent distro would cost one on every status poll for nothing.
    let agent_sandbox_runtimes = agent_sandbox_installed.then(|| probe_runtimes(AGENT_SANDBOX_DISTRO));
    let agent_sandbox_gap = agent_sandbox_runtimes.as_ref().and_then(evaluate_runtimes);
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
        agent_sandbox_runtimes,
        agent_sandbox_gap,
        // WSL is present but the sandbox isn't ready → the app can import the sealed rootfs (#1988).
        auto_installable: wsl_installed && !ready,
        ready,
        detail,
    }
}

/// Run a `wsl.exe` meta-command with `WSL_UTF8=1`; `None` if `wsl.exe` is absent or exits non-zero
/// (the exit-status-and-absence-fold over the shared [`wsl_exec`] kernel).
pub(super) fn run_wsl(args: &[&str]) -> Option<String> {
    wsl_exec(args).ok()
}

/// Check bubblewrap + socat inside a distro via `command -v` (returns `(bwrap, socat)`). Ignores the
/// exit status on purpose — `sh -lc` exits non-zero when the *last* probe misses, yet the earlier
/// `echo` still tells us which dep is present — so it can't ride the exit-status-gated [`wsl_exec`].
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
    match run_output(&mut cmd) {
        Ok(out) => {
            let s = decode_wsl(&out.stdout);
            (s.contains("BWRAP"), s.contains("SOCAT"))
        }
        Err(_) => (false, false),
    }
}

/// Probe which agent runtimes the sealed distro carries (#4260). Like [`probe_deps`] it ignores the
/// exit status — `sh -lc` exits non-zero when the LAST probe misses, while the earlier `echo`s still
/// report what IS present, so a single missing runtime must not blank the whole verdict.
fn probe_runtimes(distro: &str) -> SandboxRuntimes {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args([
        "-d",
        distro,
        "--",
        "sh",
        "-lc",
        "command -v claude >/dev/null && echo CLAUDE; \
         command -v bsc-agent >/dev/null && echo BSCAGENT; \
         command -v gh >/dev/null && echo GH; \
         command -v git >/dev/null && echo GIT",
    ])
    .env("WSL_UTF8", "1");
    match run_output(&mut cmd) {
        Ok(out) => {
            let s = decode_wsl(&out.stdout);
            SandboxRuntimes {
                claude: s.contains("CLAUDE"),
                bsc_agent: s.contains("BSCAGENT"),
                gh: s.contains("GH"),
                git: s.contains("GIT"),
            }
        }
        // A distro that won't start reports nothing present, rather than silently claiming it's fine.
        Err(_) => SandboxRuntimes::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_complete_distro_reports_no_gap() {
        let full = SandboxRuntimes { claude: true, bsc_agent: true, gh: true, git: true };
        assert_eq!(evaluate_runtimes(&full), None);
    }

    #[test]
    fn a_pre_4260_distro_names_the_default_harness_and_gh() {
        // Exactly the shape of a distro built before #4260 — the sidecars are there, the harness the
        // fleet actually defaults to is not.
        let old = SandboxRuntimes { claude: false, bsc_agent: true, gh: false, git: true };
        let gap = evaluate_runtimes(&old).expect("a distro without claude/gh must report a gap");
        assert!(gap.contains("Claude Code"), "{gap}");
        assert!(gap.contains("gh"), "{gap}");
        // It names the fix, not just the diagnosis.
        assert!(gap.contains("tooling/wsl-sandbox"), "{gap}");
        // And it doesn't accuse the distro of missing what it has.
        assert!(!gap.contains("`bsc-agent`"), "{gap}");
        assert!(!gap.contains("`git`"), "{gap}");
    }

    #[test]
    fn an_unreachable_distro_reports_everything_missing_not_everything_fine() {
        // The silent-skip failure shape: a probe that can't see anything must not read as "no gaps".
        assert!(evaluate_runtimes(&SandboxRuntimes::default()).is_some());
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
    fn parses_wsl_l_v_output() {
        // Real `wsl -l -v` shape (WSL_UTF8=1): header + a default-marked v2 row + a v1 row.
        let out = "  NAME              STATE           VERSION\n* docker-desktop    Stopped         2\n  Legacy            Running         1\n";
        let d = parse_wsl_distros(out);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0], WslDistro { name: "docker-desktop".into(), version: 2, default: true });
        assert_eq!(d[1], WslDistro { name: "Legacy".into(), version: 1, default: false });
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
