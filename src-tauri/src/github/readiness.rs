use crate::*;
use std::collections::HashMap;

/// Ensure the claude session rooted at `cwd` can run shell commands without a
/// permission prompt while blocking dangerous ones, and apply the session's
/// extensions (MCP servers → `.mcp.json`, hooks → settings.json), by merging into
/// `<cwd>/.claude/settings.json` and `<cwd>/.mcp.json`.
/// Markers the GitHub-readiness probe echoes when each check passes (#297). Plain
/// `echo` tokens so parsing is a locale-independent substring match, not coupled to
/// gh/git output formatting.
pub(crate) const GH_PATH_MARK: &str = "BSC_GH_PATH_OK";
pub(crate) const GIT_PATH_MARK: &str = "BSC_GIT_PATH_OK";
pub(crate) const GH_AUTH_MARK: &str = "BSC_GH_AUTH_OK";
/// Prefix the diagnostics preflight (#446) emits, one tab-delimited line per CLI
/// tool: `BSC_PREREQ\t<name>\t<path>\t<version>` (path/version empty when the tool
/// is absent). A distinct prefix keeps parsing a locale-independent substring scan,
/// like the GitHub-readiness markers above.
pub(crate) const PREFLIGHT_MARK: &str = "BSC_PREREQ";
/// Parse the probe shell's stdout into `(gh_on_path, git_on_path, gh_authed)`. Pure.
pub(crate) fn parse_github_probe(stdout: &str) -> (bool, bool, bool) {
    (
        stdout.contains(GH_PATH_MARK),
        stdout.contains(GIT_PATH_MARK),
        stdout.contains(GH_AUTH_MARK),
    )
}
/// Probe whether a session shell can actually reach GitHub (#297): is `git`/`gh`
/// on PATH, and is `gh` authenticated. Fleet agents are told to push branches and
/// open PRs, but a spawned shell can silently lack the tools; this lets the pane
/// warn the user up front. Runs the checks through the SAME resolved shell and
/// caller env (e.g. `GH_TOKEN`) the agent's `bash -c` subshells inherit, via a
/// login shell (`-lc`) so login-profile PATH additions are reflected. Best-effort:
/// returns all-false on spawn failure rather than erroring, so the caller can still
/// surface an actionable warning. Field names match the frontend `GithubProbe`.
#[tauri::command]
pub(crate) async fn github_readiness(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let shell = crate::shell::resolve_shell();
    let script = format!(
        "command -v git >/dev/null 2>&1 && echo {GIT_PATH_MARK}; \
         command -v gh  >/dev/null 2>&1 && echo {GH_PATH_MARK}; \
         gh auth status >/dev/null 2>&1 && echo {GH_AUTH_MARK}",
    );
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-lc").arg(&script);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let env_map = env.unwrap_or_default();
    for (k, v) in crate::pty::session_env(&env_map) {
        cmd.env(k, v);
    }
    let (gh, git, auth) = match no_window(&mut cmd).output() {
        Ok(out) => parse_github_probe(&String::from_utf8_lossy(&out.stdout)),
        Err(e) => {
            log::warn!("github_readiness probe failed to spawn ({shell}): {e}");
            (false, false, false)
        }
    };
    Ok(serde_json::json!({ "ghOnPath": gh, "gitOnPath": git, "ghAuthed": auth }))
}
/// One prerequisite's detected state, reported to the Diagnostics UI (#446). Field
/// names match the frontend `PrereqStatus`.
#[derive(serde::Serialize, PartialEq, Debug)]
pub(crate) struct PrereqStatus {
    /// Display name, e.g. "Git Bash", "claude", "git", "gh", "gh auth".
    pub(crate) name: String,
    /// Whether the tool was located (and, for "gh auth", authenticated).
    pub(crate) found: bool,
    /// First line of `<tool> --version`, when found.
    pub(crate) version: Option<String>,
    /// Resolved on-disk path, when found.
    pub(crate) path: Option<String>,
    /// Actionable install/fix hint — empty when `found`.
    pub(crate) hint: String,
}
/// Git Bash detection outcome handed to [`interpret_preflight`] so the pure
/// interpretation stays testable off-Windows. `NotApplicable` omits the entry
/// (non-Windows, where the session shell IS bash); `Missing`/`Found` map to the
/// Windows console-shell prerequisite.
// Each build constructs only its platform's variants — `NotApplicable` off Windows,
// `Found`/`Missing` on Windows (plus tests exercise all three), so per-platform
// dead-code analysis would flag the unused ones.
#[allow(dead_code)]
#[derive(Clone, PartialEq, Debug)]
pub(crate) enum GitBashProbe {
    NotApplicable,
    Missing,
    Found(String),
}
/// Static install/fix hint for a prerequisite that wasn't found. Empty for unknown
/// names so a present tool never carries a hint.
pub(crate) fn prereq_hint(tool: &str) -> &'static str {
    match tool {
        "claude" => "Install the Claude CLI — see https://docs.claude.com/claude-code",
        "git" => "Install Git — https://git-scm.com/downloads",
        "gh" => "Install the GitHub CLI — https://cli.github.com",
        "gh auth" => "Run `gh auth login` to authenticate the GitHub CLI",
        "Git Bash" => "Install Git for Windows (provides Git Bash) — https://git-scm.com/download/win",
        _ => "",
    }
}
/// Pure: turn the preflight probe's stdout (+ Git Bash detection) into the ordered
/// prerequisite list. No I/O, so it is fully unit-testable. `BSC_PREREQ` lines carry
/// each CLI tool's path/version; `BSC_GH_AUTH_OK` (reused from the GitHub probe)
/// signals `gh` is authenticated. `gh auth` is only reported authenticated when `gh`
/// itself is present, so a stale auth marker can't mask a missing CLI.
pub(crate) fn interpret_preflight(stdout: &str, git_bash: GitBashProbe) -> Vec<PrereqStatus> {
    // name -> (path, version), both trimmed; empty string means absent.
    let mut probed: HashMap<String, (String, String)> = HashMap::new();
    for line in stdout.lines() {
        let mut parts = line.splitn(4, '\t');
        if parts.next() != Some(PREFLIGHT_MARK) { continue; }
        if let Some(name) = parts.next() {
            let path = parts.next().unwrap_or("").trim().to_string();
            let version = parts.next().unwrap_or("").trim().to_string();
            probed.insert(name.to_string(), (path, version));
        }
    }

    let mut out: Vec<PrereqStatus> = Vec::new();

    // Git Bash — the Windows console shell; omitted where bash is the native shell.
    match git_bash {
        GitBashProbe::NotApplicable => {}
        GitBashProbe::Missing => out.push(PrereqStatus {
            name: "Git Bash".into(), found: false, version: None, path: None,
            hint: prereq_hint("Git Bash").into(),
        }),
        GitBashProbe::Found(p) => out.push(PrereqStatus {
            name: "Git Bash".into(), found: true, version: None, path: Some(p),
            hint: String::new(),
        }),
    }

    // CLI tools probed through the shell, in a fixed order (independent of stdout).
    for tool in ["claude", "git", "gh"] {
        let (path, version) = probed.get(tool).cloned().unwrap_or_default();
        let found = !path.is_empty();
        out.push(PrereqStatus {
            name: tool.into(),
            found,
            version: if version.is_empty() { None } else { Some(version) },
            path: if path.is_empty() { None } else { Some(path) },
            hint: if found { String::new() } else { prereq_hint(tool).into() },
        });
    }

    // gh authentication — meaningful only once `gh` itself is present.
    let gh_found = probed.get("gh").map(|(p, _)| !p.is_empty()).unwrap_or(false);
    let authed = gh_found && stdout.contains(GH_AUTH_MARK);
    out.push(PrereqStatus {
        name: "gh auth".into(),
        found: authed,
        version: None,
        path: None,
        hint: if authed { String::new() } else { prereq_hint("gh auth").into() },
    });

    out
}
/// Resolve the Git Bash prerequisite state for the diagnostics preflight: on
/// Windows, whether [`find_git_bash`] located a `bash.exe`; elsewhere bash is the
/// native shell, so Git Bash is not a prerequisite.
pub(crate) fn detect_git_bash() -> GitBashProbe {
    #[cfg(windows)]
    {
        match crate::shell::find_git_bash() {
            Some(p) => GitBashProbe::Found(p),
            None => GitBashProbe::Missing,
        }
    }
    #[cfg(not(windows))]
    {
        GitBashProbe::NotApplicable
    }
}
/// Diagnostics preflight (#446): in one call, report whether each external
/// prerequisite the app needs is present — the Windows console shell (Git Bash),
/// the `claude` CLI that runs agents, and `git`/`gh` (+ `gh` auth). Each result
/// carries presence, version, path, and an install hint so the UI can tell the user
/// exactly what to install. Runs through the SAME resolved shell + caller env as
/// agent subshells (login shell, so profile PATH additions count). Best-effort: a
/// spawn failure reports the CLI tools as missing rather than erroring.
#[tauri::command]
pub(crate) async fn preflight(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<PrereqStatus>, String> {
    let shell = crate::shell::resolve_shell();
    // One tab-delimited line per tool: BSC_PREREQ <name> <path> <version>. `tr` drops
    // CRs/tabs so a Windows version string can't break the field layout.
    let script = format!(
        "for t in claude git gh; do \
           p=\"$(command -v \"$t\" 2>/dev/null)\"; \
           v=\"$(\"$t\" --version 2>/dev/null | head -1 | tr -d '\\r\\t')\"; \
           printf '{PREFLIGHT_MARK}\\t%s\\t%s\\t%s\\n' \"$t\" \"$p\" \"$v\"; \
         done; \
         gh auth status >/dev/null 2>&1 && echo {GH_AUTH_MARK}",
    );
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-lc").arg(&script);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let env_map = env.unwrap_or_default();
    for (k, v) in crate::pty::session_env(&env_map) {
        cmd.env(k, v);
    }
    let stdout = match no_window(&mut cmd).output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).into_owned(),
        Err(e) => {
            log::warn!("preflight probe failed to spawn ({shell}): {e}");
            String::new()
        }
    };
    Ok(interpret_preflight(&stdout, detect_git_bash()))
}
/// Read the persisted console-shell preference (#447) for the Diagnostics selector.
/// Returns the lowercase kind string (`auto`/`bash`/`powershell`/`cmd`).
#[tauri::command]
pub(crate) fn get_preferred_shell() -> String {
    crate::shell::read_shell_pref().as_str().to_string()
}
/// Persist the console-shell preference (#447). Takes the frontend `ShellKind`
/// string; an unrecognized value is normalized to `auto` so the file always holds a
/// valid token. The next session launch reads it via `resolve_interactive_shell`.
#[tauri::command]
pub(crate) fn set_preferred_shell(kind: String) -> Result<(), String> {
    let pref = crate::shell::ShellPref::parse(&kind);
    let base = bsc_base_dir();
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    std::fs::write(crate::shell::shell_pref_path(), pref.as_str()).map_err(|e| e.to_string())
}
