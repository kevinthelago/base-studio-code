// Console shell selection (#447), extracted from lib.rs (#758).
//
// Resolves which shell the interactive PTY launches under (bash/Git Bash by
// default; PowerShell/cmd as a degraded opt-in). resolve_shell stays the POSIX
// bash resolver the preflight/GitHub probes and bsc-* rc rely on.

use crate::bsc_base_dir;

/// Resolve the shell to spawn for a session. The injected bash helpers
/// (OSC7/OSC100, the `claude()` wrapper, `PROMPT_COMMAND`) need a real bash.
///
/// On Windows a bare `"bash"` on PATH resolves to `C:\Windows\System32\bash.exe`
/// — the WSL launcher — which fails with `execvpe(/bin/bash)` when there's no WSL
/// distro (the production-build failure). So we honor an explicit `$SHELL`, then
/// locate Git Bash explicitly, and only then fall back to bare `"bash"`.
pub(crate) fn resolve_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && std::path::Path::new(&s).exists() {
            return s;
        }
    }
    #[cfg(windows)]
    if let Some(b) = find_git_bash() {
        return b;
    }
    "bash".to_string()
}

/// Locate Git Bash's `bash.exe` (never WSL's System32 stub) from known install
/// roots plus any Git dir derived from `git.exe` on PATH.
#[cfg(windows)]
pub(crate) fn find_git_bash() -> Option<String> {
    use std::path::PathBuf;
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Ok(p) = std::env::var(var) {
            roots.push(PathBuf::from(p).join("Git"));
        }
    }
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(p).join("Programs").join("Git"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\Git"));
    // git.exe on PATH lives in <Git>\cmd or <Git>\bin — its parent is the Git root.
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join("git.exe").exists() {
                if let Some(root) = dir.parent() {
                    roots.push(root.to_path_buf());
                }
            }
        }
    }
    bash_in_roots(&roots, &|p| p.exists())
}

/// First existing `bash.exe` under any root (checking `bin\` then `usr\bin\`).
/// The `exists` predicate is injected so the path logic is testable without a
/// real Git install.
#[cfg(windows)]
fn bash_in_roots(roots: &[std::path::PathBuf], exists: &dyn Fn(&std::path::Path) -> bool) -> Option<String> {
    for root in roots {
        let bin = root.join("bin").join("bash.exe");
        if exists(&bin) {
            return Some(bin.to_string_lossy().into_owned());
        }
        let usr = root.join("usr").join("bin").join("bash.exe");
        if exists(&usr) {
            return Some(usr.to_string_lossy().into_owned());
        }
    }
    None
}

// ── Console shell selection (#447) ──────────────────────────────────────────
//
// The session shell was always bash (Git Bash on Windows). Users can now pick
// PowerShell or cmd. `resolve_shell` above stays the POSIX/bash resolver — the
// preflight/GitHub probes emit POSIX scripts and the bsc-* rc is bash, so they
// must keep bash semantics regardless of the user's interactive choice. Only the
// interactive PTY (`pty_create`) honors the selection, via `resolve_interactive_shell`.

/// A concrete console shell the interactive session runs under. `Bash` keeps the
/// full bsc-* helper experience; `PowerShell`/`Cmd` are Windows-native shells where
/// the bash-only helpers are explicitly degraded with a visible notice — never
/// silently broken (#447).
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum ShellKind {
    Bash,
    PowerShell,
    Cmd,
}

/// The persisted console-shell preference (`<base>/shell.pref`). `Auto` defers to
/// the platform default (Git Bash on Windows, login `$SHELL` elsewhere); the
/// explicit kinds force a shell, with a sensible fallback when it's unavailable.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum ShellPref {
    Auto,
    Bash,
    PowerShell,
    Cmd,
}

impl ShellPref {
    /// Parse the frontend `ShellKind` string (see `src/lib/diagnostics.ts`). Unknown
    /// values map to `Auto` so a corrupt pref file never wedges session launches.
    pub(crate) fn parse(s: &str) -> ShellPref {
        match s.trim() {
            "bash" => ShellPref::Bash,
            "powershell" => ShellPref::PowerShell,
            "cmd" => ShellPref::Cmd,
            _ => ShellPref::Auto,
        }
    }
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ShellPref::Auto => "auto",
            ShellPref::Bash => "bash",
            ShellPref::PowerShell => "powershell",
            ShellPref::Cmd => "cmd",
        }
    }
}

/// A resolved interactive shell: the kind (drives init syntax + helper degradation)
/// and the program to spawn.
#[derive(Clone, PartialEq, Debug)]
pub(crate) struct ResolvedShell {
    pub(crate) kind: ShellKind,
    pub(crate) program: String,
}

/// Pure shell selection (#447): turn a preference + the available shell candidates
/// into the concrete shell to launch. A selected-but-unavailable shell falls back to
/// bash (the universal floor) rather than failing the launch. Candidates are injected
/// so the logic is unit-testable off-Windows.
fn select_shell(
    pref: ShellPref,
    env_shell: Option<String>,
    git_bash: Option<String>,
    powershell: Option<String>,
    cmd: Option<String>,
) -> ResolvedShell {
    // The bash floor mirrors `resolve_shell`: honor $SHELL, then Git Bash, then bare bash.
    let bash = ResolvedShell {
        kind: ShellKind::Bash,
        program: env_shell
            .or(git_bash)
            .unwrap_or_else(|| "bash".to_string()),
    };
    match pref {
        ShellPref::PowerShell => match powershell {
            Some(p) => ResolvedShell { kind: ShellKind::PowerShell, program: p },
            None => bash,
        },
        ShellPref::Cmd => match cmd {
            Some(p) => ResolvedShell { kind: ShellKind::Cmd, program: p },
            None => bash,
        },
        ShellPref::Bash | ShellPref::Auto => bash,
    }
}

/// Locate PowerShell on Windows: PowerShell 7+ (`pwsh.exe`) on PATH first, then the
/// always-present Windows PowerShell under `System32`.
#[cfg(windows)]
fn locate_powershell() -> Option<String> {
    if let Some(path) = std::env::var_os("PATH") {
        for name in ["pwsh.exe", "powershell.exe"] {
            for dir in std::env::split_paths(&path) {
                let p = dir.join(name);
                if p.exists() {
                    return Some(p.to_string_lossy().into_owned());
                }
            }
        }
    }
    if let Ok(sysroot) = std::env::var("SystemRoot") {
        let p = std::path::PathBuf::from(sysroot)
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

/// Locate `cmd.exe` on Windows (always present at `System32\cmd.exe`; bare name as
/// a last resort so PATH resolves it).
#[cfg(windows)]
fn locate_cmd() -> Option<String> {
    if let Ok(sysroot) = std::env::var("SystemRoot") {
        let p = std::path::PathBuf::from(sysroot).join(r"System32\cmd.exe");
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    Some("cmd.exe".to_string())
}

/// On-disk path of the persisted shell preference.
pub(crate) fn shell_pref_path() -> std::path::PathBuf {
    bsc_base_dir().join("shell.pref")
}

/// Read the persisted console-shell preference, defaulting to `Auto` when unset or
/// unreadable.
pub(crate) fn read_shell_pref() -> ShellPref {
    std::fs::read_to_string(shell_pref_path())
        .ok()
        .map(|s| ShellPref::parse(&s))
        .unwrap_or(ShellPref::Auto)
}

/// Resolve the shell the interactive PTY should launch under, honoring the user's
/// persisted selection (#447) with a bash fallback. Non-Windows builds only ever
/// resolve to bash/login `$SHELL` (PowerShell/cmd aren't standard there), so a
/// stray PowerShell/cmd preference degrades to bash.
pub(crate) fn resolve_interactive_shell() -> ResolvedShell {
    let pref = read_shell_pref();
    let env_shell = std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty() && std::path::Path::new(s).exists());
    #[cfg(windows)]
    {
        select_shell(pref, env_shell, find_git_bash(), locate_powershell(), locate_cmd())
    }
    #[cfg(not(windows))]
    {
        select_shell(pref, env_shell, None, None, None)
    }
}

/// Build the interactive init line for a non-bash shell (#447). The bsc-* helpers
/// and startup-prompt baking are bash-only, so under PowerShell/cmd we cd into the
/// project, clear the screen, and print a VISIBLE notice that those helpers are
/// unavailable in this session (explicit degradation, never silent), optionally
/// launching `claude` so the session is still usable. Pure (no I/O) for testing.
pub(crate) fn non_bash_init(
    kind: ShellKind,
    cwd: &str,
    cwd_missing: bool,
    effective_cwd: &str,
    launch_claude: bool,
    model: Option<&str>,
) -> String {
    // `--model <alias>` for the auto-launched claude when a model is set; the alias
    // is a fixed literal from claude_model_flag, so this is injection-safe.
    let model_arg = model.map(|m| format!(" --model {m}")).unwrap_or_default();
    // The directory to land in: the nearest existing ancestor when the configured
    // cwd is gone, else the cwd itself (native paths — pwsh/cmd, not bash, syntax).
    let dir = if cwd.is_empty() {
        ""
    } else if cwd_missing {
        effective_cwd
    } else {
        cwd
    };
    const NOTICE: &str =
        "the bsc-* helpers and startup-prompt injection are bash-only and unavailable in this session";
    match kind {
        ShellKind::PowerShell => {
            let mut s = String::new();
            if !dir.is_empty() {
                // Single-quote-escape for PowerShell literal strings (' -> '').
                s.push_str(&format!("Set-Location -LiteralPath '{}'; ", dir.replace('\'', "''")));
            }
            if cwd_missing {
                s.push_str(&format!(
                    "Write-Host '[bsc] WARNING: configured directory {} does not exist; this session did NOT start in its project directory.' -ForegroundColor Red; ",
                    cwd.replace('\'', "''"),
                ));
            }
            s.push_str("Clear-Host; ");
            s.push_str(&format!(
                "Write-Host '[bsc] Running under PowerShell -- {NOTICE}.' -ForegroundColor Yellow; "
            ));
            if launch_claude {
                s.push_str(&format!("claude{model_arg}; "));
            }
            s.push('\n');
            s
        }
        ShellKind::Cmd => {
            let mut s = String::new();
            if !dir.is_empty() {
                s.push_str(&format!("cd /d \"{dir}\" & "));
            }
            if cwd_missing {
                s.push_str(&format!(
                    "echo [bsc] WARNING: configured directory {cwd} does not exist; this session did NOT start in its project directory. & "
                ));
            }
            s.push_str("cls & ");
            s.push_str(&format!("echo [bsc] Running under cmd.exe -- {NOTICE}. & "));
            if launch_claude {
                s.push_str(&format!("claude{model_arg} & "));
            }
            s.push_str("echo.\n");
            s
        }
        // Bash uses the dedicated rich init path in `pty_create`, not this builder.
        ShellKind::Bash => String::new(),
    }
}

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
mod tests {

    #[test]
    fn wsl_invocation_builds_distro_exec_recipe() {
        use super::wsl_invocation;
        let (p, a) = wsl_invocation("bsc-agent-sandbox", "/home/agent", "bsc --help");
        assert_eq!(p, "wsl.exe");
        assert_eq!(
            a,
            vec!["-d", "bsc-agent-sandbox", "--cd", "/home/agent", "--", "bash", "-lc", "bsc --help"],
        );
        // Empty cwd ⇒ no --cd (runs at the distro default ~).
        let (_, a2) = wsl_invocation("d", "", "pwd");
        assert_eq!(a2, vec!["-d", "d", "--", "bash", "-lc", "pwd"]);
    }

    #[cfg(windows)]
    #[test]
    fn bash_in_roots_checks_bin_then_usr_bin() {
        use std::path::PathBuf;
        let roots = vec![PathBuf::from(r"C:\Program Files\Git")];
        let bin = r"C:\Program Files\Git\bin\bash.exe";
        let usr = r"C:\Program Files\Git\usr\bin\bash.exe";
        // bin\bash.exe wins when present.
        assert_eq!(super::bash_in_roots(&roots, &|p| p.to_string_lossy() == bin).as_deref(), Some(bin));
        // falls through to usr\bin\bash.exe.
        assert_eq!(super::bash_in_roots(&roots, &|p| p.to_string_lossy() == usr).as_deref(), Some(usr));
        // nothing found.
        assert_eq!(super::bash_in_roots(&roots, &|_| false), None);
    }

    #[test]
    fn shell_pref_parse_round_trips_known_kinds_and_defaults_unknown() {
        use super::ShellPref;
        for (s, expect) in [
            ("auto", ShellPref::Auto),
            ("bash", ShellPref::Bash),
            ("powershell", ShellPref::PowerShell),
            ("cmd", ShellPref::Cmd),
            ("  bash\n", ShellPref::Bash), // trimmed
        ] {
            assert_eq!(ShellPref::parse(s), expect);
            assert_eq!(ShellPref::parse(expect.as_str()), expect);
        }
        // Unknown / empty -> Auto, so a corrupt pref file never wedges launches.
        assert_eq!(ShellPref::parse("fish"), ShellPref::Auto);
        assert_eq!(ShellPref::parse(""), ShellPref::Auto);
    }

    #[test]
    fn select_shell_auto_and_bash_resolve_to_the_bash_floor() {
        use super::{select_shell, ShellKind, ShellPref};
        // Auto honors $SHELL first, then Git Bash, then bare bash.
        let r = select_shell(ShellPref::Auto, Some("/usr/bin/zsh".into()), Some("C:/Git/bash.exe".into()), None, None);
        assert_eq!(r.kind, ShellKind::Bash);
        assert_eq!(r.program, "/usr/bin/zsh");
        let r = select_shell(ShellPref::Bash, None, Some("C:/Git/bash.exe".into()), None, None);
        assert_eq!(r.kind, ShellKind::Bash);
        assert_eq!(r.program, "C:/Git/bash.exe");
        let r = select_shell(ShellPref::Auto, None, None, None, None);
        assert_eq!(r.program, "bash");
    }

    #[test]
    fn select_shell_honors_explicit_selection_when_available() {
        use super::{select_shell, ShellKind, ShellPref};
        let r = select_shell(ShellPref::PowerShell, None, Some("bash".into()), Some("C:/pwsh.exe".into()), Some("cmd.exe".into()));
        assert_eq!(r.kind, ShellKind::PowerShell);
        assert_eq!(r.program, "C:/pwsh.exe");
        let r = select_shell(ShellPref::Cmd, None, Some("bash".into()), Some("C:/pwsh.exe".into()), Some("C:/cmd.exe".into()));
        assert_eq!(r.kind, ShellKind::Cmd);
        assert_eq!(r.program, "C:/cmd.exe");
    }

    #[test]
    fn select_shell_falls_back_to_bash_when_chosen_shell_unavailable() {
        use super::{select_shell, ShellKind, ShellPref};
        // PowerShell selected but none found (e.g. non-Windows) -> bash floor, not a failure.
        let r = select_shell(ShellPref::PowerShell, Some("/bin/bash".into()), None, None, None);
        assert_eq!(r.kind, ShellKind::Bash);
        assert_eq!(r.program, "/bin/bash");
        let r = select_shell(ShellPref::Cmd, None, None, None, None);
        assert_eq!(r.kind, ShellKind::Bash);
        assert_eq!(r.program, "bash");
    }

    #[test]
    fn non_bash_init_is_visibly_degraded_and_shell_shaped() {
        use super::{non_bash_init, ShellKind};
        // PowerShell: cd's, clears, prints the degraded notice in yellow, launches claude.
        let ps = non_bash_init(ShellKind::PowerShell, "C:/repo", false, "C:/repo", true, None);
        assert!(ps.contains("Set-Location -LiteralPath 'C:/repo'"));
        assert!(ps.contains("Clear-Host"));
        assert!(ps.contains("-ForegroundColor Yellow"));
        assert!(ps.contains("bash-only and unavailable"), "must visibly state the degradation");
        assert!(ps.contains("claude"));
        assert!(ps.ends_with('\n'));
        // No bash-only constructs leak into the PowerShell init.
        assert!(!ps.contains("$'"));
        assert!(!ps.contains("source \""));
        assert!(!ps.contains("PROMPT_COMMAND"));

        // cmd: uses `&` separators, cls, echo notice; no claude when not launching.
        let cmd = non_bash_init(ShellKind::Cmd, "C:\\repo", false, "C:\\repo", false, None);
        assert!(cmd.contains("cd /d \"C:\\repo\""));
        assert!(cmd.contains("cls"));
        assert!(cmd.contains("bash-only and unavailable"));
        assert!(!cmd.contains("claude"));
        assert!(cmd.ends_with('\n'));
    }

    #[test]
    fn non_bash_init_warns_loudly_when_cwd_is_missing() {
        use super::{non_bash_init, ShellKind};
        let ps = non_bash_init(ShellKind::PowerShell, "C:/gone", true, "C:/", false, None);
        // Lands in the existing ancestor, not the missing dir, and shouts about it.
        assert!(ps.contains("Set-Location -LiteralPath 'C:/'"));
        assert!(ps.contains("does not exist"));
        assert!(ps.contains("-ForegroundColor Red"));
    }

    #[test]
    fn claude_model_flag_maps_known_ids_only() {
        use crate::claude_model_flag;
        assert_eq!(claude_model_flag("haiku-4.5"), Some("haiku"));
        assert_eq!(claude_model_flag("sonnet-4.5"), Some("sonnet"));
        assert_eq!(claude_model_flag("opus-4.5"), Some("opus"));
        // Anything unrecognized falls back to Claude Code's own default (no flag).
        assert_eq!(claude_model_flag("gpt-4"), None);
        assert_eq!(claude_model_flag(""), None);
    }

    #[test]
    fn non_bash_init_injects_the_model_flag_into_the_claude_launch() {
        use super::{non_bash_init, ShellKind};
        // With a model, the auto-launched claude carries --model <alias>.
        let ps = non_bash_init(ShellKind::PowerShell, "C:/repo", false, "C:/repo", true, Some("opus"));
        assert!(ps.contains("claude --model opus"));
        let cmd = non_bash_init(ShellKind::Cmd, "C:\\repo", false, "C:\\repo", true, Some("haiku"));
        assert!(cmd.contains("claude --model haiku"));
        // Without a model, no flag is added.
        let ps_none = non_bash_init(ShellKind::PowerShell, "C:/repo", false, "C:/repo", true, None);
        assert!(ps_none.contains("claude"));
        assert!(!ps_none.contains("--model"));
    }
}


#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::prelude::*;
    use crate::project::{hub::*, plan_files::*, plan_db::*, blueprints::*, dead_code::*, ui_skeleton::*, files::*};
    use crate::fleet::{worktree::*, director::*, inspect::*};
    use crate::extensions::{mcp::*, cfg::*};
    use crate::testutil::{ENV_LOCK, temp_home, write_file};

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
