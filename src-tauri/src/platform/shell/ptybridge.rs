// ── PTY byte handling + native↔bash path conversion + ANSI-C quoting (#1300) ──
// These string/path utilities sit with the shell module because they exist to bridge the PTY
// session and bash: chunking PTY output on UTF-8 boundaries, translating native↔Git-Bash paths,
// and ANSI-C-quoting a value for a `claude <token>` launch. Extracted verbatim from `lib.rs`.

/// Splits `bytes` at the last complete UTF-8 character boundary.
/// Returns `(valid_string, leftover_bytes)` where `leftover_bytes` is any
/// trailing incomplete multi-byte sequence to prepend to the next read.
pub(crate) fn split_utf8_at_boundary(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if e.error_len().is_none() {
                // Incomplete sequence at end of buffer — hold the trailing
                // bytes for the next read rather than replacing with U+FFFD.
                let text = unsafe { std::str::from_utf8_unchecked(&bytes[..valid_up_to]) }.to_string();
                (text, bytes[valid_up_to..].to_vec())
            } else {
                // Genuinely invalid bytes mid-stream — keep going with lossy.
                (String::from_utf8_lossy(bytes).into_owned(), Vec::new())
            }
        }
    }
}

/// Converts a native OS path to a bash-compatible POSIX path.
/// On Windows (Git Bash): `C:\Users\foo` → `/c/Users/foo`.
/// On Unix: returns the path unchanged.
pub(crate) fn to_bash_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let s = p.replace('\\', "/");
        if s.len() >= 2 && s.as_bytes()[1] == b':' {
            let drive = s[..1].to_lowercase();
            return format!("/{}{}", drive, &s[2..]);
        }
        s
    }
    #[cfg(not(windows))]
    p.to_string()
}

/// Inverse of [`to_bash_path`]: a git-bash drive path (`/c/Users/...`, as reported by a
/// bash shell's OSC-7 cwd and then persisted) back to a native `C:/Users/...` path, so
/// Windows fs/process APIs (`Path::is_dir`, `Command::cwd`) can resolve it. Without this a
/// restored pane whose worktree/dir genuinely EXISTS reads as "missing" and fails to launch
/// (#979). Already-native and non-drive paths pass through unchanged; no-op off Windows.
pub(crate) fn to_native_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let b = p.as_bytes();
        if b.len() >= 3 && b[0] == b'/' && b[2] == b'/' && (b[1] as char).is_ascii_alphabetic() {
            let drive = (b[1] as char).to_ascii_uppercase();
            return format!("{drive}:/{}", &p[3..]);
        }
        p.to_string()
    }
    #[cfg(not(windows))]
    p.to_string()
}

/// Build the `wsl.exe` invocation that runs `command` inside a WSL2 distro at a distro-native `cwd`
/// (#1988 — the spawn recipe for the sealed agent sandbox). Returns `(program, args)` for a
/// `Command`/`CommandBuilder`. An empty `cwd` runs at the distro's default (the user's `~`); the
/// command is run under a login `bash -lc` so `/etc/profile` + PATH are set. Paths here are
/// **distro-native** (e.g. `/home/agent/...`), never translated `/mnt/c` — the sealed distro has no
/// Windows mount. (When the host is git-bash, callers must spawn this directly, not via MSYS, or the
/// leading-`/` args get path-mangled.)
pub(crate) fn wsl_invocation(distro: &str, cwd: &str, command: &str) -> (String, Vec<String>) {
    let mut args = vec!["-d".to_string(), distro.to_string()];
    if !cwd.is_empty() {
        args.push("--cd".to_string());
        args.push(cwd.to_string());
    }
    args.push("--".to_string());
    args.push("bash".to_string());
    args.push("-lc".to_string());
    args.push(command.to_string());
    ("wsl.exe".to_string(), args)
}

/// The interactive-shell init line for a session running INSIDE the sealed WSL2 distro (#1988).
/// Mirrors the host bash init (cwd + OSC7/state markers + screen clear + optional launch). The host env
/// does NOT traverse the wsl boundary, so this exports `env` (the session env — e.g. bsc-agent's
/// provider/model/key + `GH_TOKEN`) INTO the distro shell, then bakes the distro's own `bsc`/`bsc-agent`
/// paths over the top. Sources no host rc. `cwd` is distro-native (`/home/agent/...`); `launch` (e.g. a
/// `bsc-agent …` command) is appended to start the agent. (In-distro bsc-* helper rc is a follow-up.)
pub(crate) fn sandbox_init_line(
    cwd: &str,
    launch: Option<&str>,
    env: &std::collections::HashMap<String, String>,
) -> String {
    let cd = if cwd.is_empty() {
        String::new()
    } else {
        format!("cd \"{cwd}\" 2>/dev/null; ")
    };
    // Cross the session env in. Only valid shell identifiers; the distro's own BSC_BIN/BSC_AGENT_BIN
    // below override any crossed value, so the distro's sidecars always win.
    let mut env_exports = String::new();
    for (k, v) in env {
        if !k.is_empty() && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            env_exports.push_str(&format!("export {k}={}; ", bash_ansi_c_quote(v)));
        }
    }
    let launch_suffix = launch.map(|s| format!("; {s}")).unwrap_or_default();
    format!(
        "{env_exports}export BSC_BIN=/usr/local/bin/bsc BSC_AGENT_BIN=/usr/local/bin/bsc-agent; \
         {cd}__bsc_osc7() {{ printf $'\\033]7;file://localhost%s\\a' \"$(pwd)\"; }}; \
         __bsc_state() {{ printf $'\\033]100;%s\\a' \"$1\"; }}; \
         PROMPT_COMMAND=\"${{PROMPT_COMMAND:+$PROMPT_COMMAND; }}__bsc_osc7; __bsc_state idle\"; \
         __bsc_osc7; __bsc_state idle; printf '\\033[2J\\033[H'{launch_suffix}\n"
    )
}

/// Quote an arbitrary string as a single bash ANSI-C token (`$'...'`).
///
/// Used to bake a startup prompt into `claude <token>` safely: ANSI-C quoting
/// keeps the whole value on one physical line (newlines become `\n`) and `$`,
/// backticks, and double quotes are literal — so no shell expansion, no PS2
/// continuation, and any prompt content survives intact.
pub(crate) fn bash_ansi_c_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    out.push_str("$'");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    #[test]
    fn osc7_path_strip_removes_scheme_and_host() {
        // Mirrors what TerminalView.tsx does in the browser:
        // data.replace(/^file:\/\/[^/]*/, "")
        let input = "file://localhost/c/Users/Kevin/project";
        let stripped = input.trim_start_matches("file://").split_once('/')
            .map(|(_, rest)| format!("/{}", rest))
            .unwrap_or_default();
        assert_eq!(stripped, "/c/Users/Kevin/project");
    }
    #[test]
    fn to_native_path_resolves_git_bash_drive_paths_on_windows() {
        // The OSC-7 cwd a bash shell reports (and the app persists) — must round back to a native
        // path so pty_create's is_dir/Command::cwd resolve an EXISTING worktree on restore (#979).
        let bash = "/c/Users/Kevin/.base-studio-code/worktrees/studio-code/base-studio-code--source-experience";
        let got = to_native_path(bash);
        if cfg!(windows) {
            assert_eq!(got, "C:/Users/Kevin/.base-studio-code/worktrees/studio-code/base-studio-code--source-experience");
        } else {
            assert_eq!(got, bash); // no-op off Windows
        }
        // Non-drive POSIX paths and already-native paths pass through unchanged everywhere.
        assert_eq!(to_native_path("/usr/local/bin"), "/usr/local/bin");
        assert_eq!(to_native_path("C:/already/native"), "C:/already/native");
    }
    #[test]
    fn ansi_c_quote_wraps_plain_text() {
        assert_eq!(bash_ansi_c_quote("triage the issues"), "$'triage the issues'");
    }
    #[test]
    fn ansi_c_quote_escapes_newlines_quotes_and_backslashes() {
        // Newlines collapse to \n so the whole token stays on one physical line;
        // single quotes and backslashes are escaped. $ and backticks pass through
        // literally (ANSI-C quoting does not expand them).
        assert_eq!(
            bash_ansi_c_quote("line1\nit's $HOME `cmd` \\x"),
            "$'line1\\nit\\'s $HOME `cmd` \\\\x'"
        );
    }
}
