//! WSL2 readiness detection for the OS sandbox (#1916 Layer 4 / #1982).
//!
//! Claude Code's Bash sandbox (the `sandbox` block written by #1980) OS-confines the Bash subprocess
//! tree, but on Windows it engages ONLY inside WSL2 — native Windows is unsupported, so it silently
//! no-ops. This module probes, from the Windows host, whether the sandbox can actually run: is WSL2
//! installed, is there a version-2 distro, and does that distro have the bubblewrap + socat deps the
//! sandbox needs. The detection (`wsl_sandbox_status`) is read-only; `provision_sandbox` (#1988) is the
//! one mutating command here — it imports the sealed `bsc-agent-sandbox` rootfs as a WSL2 distro. The
//! `wsl.exe` spawn rewiring (running the planner/triage sessions INSIDE the distro) is the rest of #1982.
//!
//! Split into three cohesive submodules over the one shared `wsl.exe` kernel below (#2066):
//! - [`readiness`] — the read-only `wsl_sandbox_status` probe + its pure eval helpers.
//! - [`provision`] — the mutating lifecycle: import/remove the sealed distro, disk usage, in-distro exec.
//! - [`bridge`] — host↔distro file I/O + the in-distro clone/worktree relocation kernel.

use crate::StrErr;

mod bridge;
mod provision;
mod readiness;

// Re-export every `#[tauri::command]` at `session::sandbox::*` so the invoke-handler registration in
// `app::run` (and any other caller) keeps its existing paths after the split.
pub(crate) use bridge::*;
pub(crate) use provision::*;
pub(crate) use readiness::*;

/// The sealed agent sandbox distro we import + run sessions inside (#1988). Built from
/// `tooling/wsl-sandbox/` (Debian-slim + the slim Linux `bsc` sidecars + a locked-down `wsl.conf`,
/// so the distro is the cage regardless of which LLM drives the session inside it).
pub(crate) const AGENT_SANDBOX_DISTRO: &str = "bsc-agent-sandbox";

/// The `Err` returned by every distro-touching sandbox command on a non-Windows host — the WSL2 cage
/// is Windows-only. Hoisted to one place so the eight commands can't drift from each other.
const WINDOWS_ONLY: &str = "The WSL2 agent sandbox is Windows-only.";

/// Guard: `Ok(())` on Windows, else `Err(WINDOWS_ONLY)`. Every distro-touching sandbox command
/// short-circuits through this (`require_windows()?`), so the Windows-only contract lives in one place.
fn require_windows() -> Result<(), String> {
    if cfg!(windows) {
        Ok(())
    } else {
        Err(WINDOWS_ONLY.into())
    }
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

/// Run a `wsl.exe` command with `WSL_UTF8=1`, returning its decoded stdout on success or the decoded,
/// trimmed stderr as the `Err` on a non-zero exit / spawn failure. The shared spawn kernel behind the
/// ~7 read/exec `wsl.exe` sites; a caller that ignores exit status (like `probe_deps`) builds its own.
fn wsl_exec(args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(args).env("WSL_UTF8", "1");
    let out = crate::platform::process::run_output(&mut cmd).str_err()?;
    if out.status.success() {
        Ok(decode_wsl(&out.stdout))
    } else {
        Err(decode_wsl(&out.stderr).trim().to_string())
    }
}

/// Run a `wsl.exe` command feeding `content` bytes on stdin (stdout discarded), returning `Ok(())` on a
/// zero exit else the decoded, trimmed stderr. The binary-safe write half of the host↔distro bridge —
/// stdin (not an arg) so raw bytes like `plan.db` traverse the pipe intact.
fn wsl_exec_stdin(args: &[&str], content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = std::process::Command::new("wsl.exe")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("wsl spawn failed: {e}"))?;
    {
        let mut si = child.stdin.take().ok_or("no stdin handle")?;
        si.write_all(content).map_err(|e| format!("write stdin: {e}"))?;
    }
    let out = child.wait_with_output().str_err()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(decode_wsl(&out.stderr).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf16le_and_utf8() {
        // UTF-16LE "Ok" = 4F 00 6B 00; UTF-8 passes through.
        assert_eq!(decode_wsl(&[0x4F, 0x00, 0x6B, 0x00, 0x4F, 0x00, 0x6B, 0x00, 0x4F, 0x00]), "OkOkO");
        assert_eq!(decode_wsl(b"plain utf8"), "plain utf8");
    }

    #[test]
    fn require_windows_matches_the_host() {
        // The guard mirrors `cfg!(windows)` and surfaces the single hoisted message off-Windows.
        assert_eq!(require_windows().is_ok(), cfg!(windows));
        if !cfg!(windows) {
            assert_eq!(require_windows().unwrap_err(), WINDOWS_ONLY);
        }
    }
}
