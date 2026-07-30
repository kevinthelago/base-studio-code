use crate::prelude::*;
use std::collections::HashMap;

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
/// Run a best-effort probe `script` through the SAME resolved login shell + caller env
/// (`session_env`, e.g. `GH_TOKEN`) an agent's `bash -c` subshells inherit, returning its
/// stdout. Shared by [`github_readiness`] and the diagnostics preflight — both resolve the
/// shell, run `-lc <script>` in `cwd` under `no_window`, and only differ in the script and how
/// the stdout is parsed. On spawn failure logs a warning tagged `label` and returns an empty
/// string, so callers degrade to an all-missing result rather than erroring.
///
/// The env is built with [`session_env`], so a BUNDLED host toolchain (#1277) is folded into `PATH`
/// exactly as it is for a real session — meaning `command -v gh`/`git` here reflect the SAME tools an
/// agent will resolve, and the readiness/diagnostics surfaces stop warning about a tool we now ship.
fn run_probe_shell(
    label: &str,
    script: &str,
    cwd: &str,
    env: Option<HashMap<String, String>>,
) -> String {
    let shell = crate::platform::shell::resolve_shell();
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-lc").arg(script);
    // #3984: NORMALIZE the cwd, exactly as `pty_create` does. A git-bash-style path (`/c/Users/…`)
    // is not something Windows `current_dir` accepts, so the spawn failed with ERROR_DIRECTORY (267)
    // BEFORE the script ran — `run_probe_shell` then returned "", `interpret_preflight` found no
    // markers, and every tool read as not-found. That is what produced a critical, blocking
    // "install claude / install git" banner on a machine where both were installed and a login shell
    // found them: the probe never started. Same rule the rest of the backend already follows.
    let cwd = crate::to_native_path(cwd);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let env_map = env.unwrap_or_default();
    for (k, v) in crate::console::pty::session_env(&env_map) {
        cmd.env(k, v);
    }
    match no_window(&mut cmd).output() {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            // #3978: the probe reported `claude` + `git` MISSING while both were installed and a login
            // shell found them by hand. A false negative here is a BLOCKING, critical verdict in the
            // UI, so it trains the user to dismiss the one banner meant to stop them before an agent
            // fails mid-task — and it left nothing to diagnose from. Log what the probe actually ran
            // under whenever it comes back empty or short, which is exactly the failing shape:
            // the resolved shell (`resolve_shell` prefers $SHELL, which need not be Git Bash — and
            // `-lc` is meaningless to a non-POSIX shell), the child's PATH, and git's stderr.
            if stdout.trim().is_empty() {
                let path = cmd.get_envs()
                    .find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("PATH"))
                    .and_then(|(_, v)| v.map(|s| s.to_string_lossy().into_owned()))
                    .unwrap_or_else(|| "<inherited>".into());
                log::error!(
                    "{label} probe produced NO output — shell={shell} status={:?} stderr={} PATH={}",
                    out.status.code(),
                    String::from_utf8_lossy(&out.stderr).trim().chars().take(300).collect::<String>(),
                    path.chars().take(600).collect::<String>(),
                );
            }
            stdout
        }
        Err(e) => {
            // #3984: name the DIRECTORY too. #3982 logged the empty-output path but not this one, so
            // a spawn failure said only "invalid" without saying invalid *what* — which left the
            // actual cause (an un-normalized cwd) unnamed through a whole round of hypotheses.
            log::error!("{label} probe failed to spawn ({shell}) in cwd={cwd:?}: {e}");
            String::new()
        }
    }
}
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
pub(crate) fn github_readiness(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let script = format!(
        "command -v git >/dev/null 2>&1 && echo {GIT_PATH_MARK}; \
         command -v gh  >/dev/null 2>&1 && echo {GH_PATH_MARK}; \
         gh auth status >/dev/null 2>&1 && echo {GH_AUTH_MARK}",
    );
    let (gh, git, auth) =
        parse_github_probe(&run_probe_shell("github_readiness", &script, &cwd, env));
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
        // #1277: a BUNDLED PortableGit bash counts as found — the app ships it, so Diagnostics must
        // not warn about a missing Git Bash when we now supply one. Prefer the bundled copy (what
        // `resolve_shell` also picks), then the system Git Bash.
        match crate::platform::shell::bundled_git_bash().or_else(crate::platform::shell::find_git_bash) {
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
/// Async + `spawn_blocking` so the (blocking) shell spawn + `<tool> --version` calls run OFF the main
/// thread — a synchronous command froze the UI while the probe shell ran (#1916 perf).
#[tauri::command]
pub(crate) async fn preflight(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<PrereqStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || preflight_inner(cwd, env))
        .await
        .map_err(|e| format!("preflight task failed: {e}"))?
}

fn preflight_inner(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<PrereqStatus>, String> {
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
    let stdout = run_probe_shell("preflight", &script, &cwd, env);
    Ok(interpret_preflight(&stdout, detect_git_bash()))
}
/// Read the persisted console-shell preference (#447) for the Diagnostics selector.
/// Returns the lowercase kind string (`auto`/`bash`/`powershell`/`cmd`).
#[tauri::command]
pub(crate) fn get_preferred_shell() -> String {
    crate::platform::shell::read_shell_pref().as_str().to_string()
}
/// Persist the console-shell preference (#447). Takes the frontend `ShellKind`
/// string; an unrecognized value is normalized to `auto` so the file always holds a
/// valid token. The next session launch reads it via `resolve_interactive_shell`.
#[tauri::command]
pub(crate) fn set_preferred_shell(kind: String) -> Result<(), String> {
    let pref = crate::platform::shell::ShellPref::parse(&kind);
    let base = bsc_base_dir();
    std::fs::create_dir_all(&base).str_err()?;
    std::fs::write(crate::platform::shell::shell_pref_path(), pref.as_str()).str_err()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_github_probe_detects_each_marker_independently() {
        use {GH_AUTH_MARK, GH_PATH_MARK, GIT_PATH_MARK};
        // All three markers present -> (gh, git, auth) all true.
        let all = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
{GH_AUTH_MARK}
");
        assert_eq!(parse_github_probe(&all), (true, true, true));
        // Empty output (probe found nothing) -> all false.
        assert_eq!(parse_github_probe(""), (false, false, false));
        // git on PATH but gh missing -> gh false, git true, auth false.
        let git_only = format!("{GIT_PATH_MARK}
");
        assert_eq!(parse_github_probe(&git_only), (false, true, false));
        // gh present but unauthenticated -> gh true, git true, auth false.
        let no_auth = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
");
        assert_eq!(parse_github_probe(&no_auth), (true, true, false));
    }

    #[test]
    fn interpret_preflight_reports_each_prerequisite() {
        use {interpret_preflight, GitBashProbe, GH_AUTH_MARK, PREFLIGHT_MARK};
        // Everything present + authed, on Windows with Git Bash found.
        let stdout = format!(
            "{PREFLIGHT_MARK}\tclaude\t/usr/bin/claude\tclaude 1.2.3\n\
             {PREFLIGHT_MARK}\tgit\t/usr/bin/git\tgit version 2.43.0\n\
             {PREFLIGHT_MARK}\tgh\t/usr/bin/gh\tgh version 2.40.0\n\
             {GH_AUTH_MARK}\n"
        );
        let r = interpret_preflight(&stdout, GitBashProbe::Found("C:\\Git\\bin\\bash.exe".into()));
        // Git Bash first (the console shell), then claude, git, gh, gh auth.
        let names: Vec<&str> = r.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Git Bash", "claude", "git", "gh", "gh auth"]);
        assert!(r.iter().all(|p| p.found), "all prerequisites should be found");
        assert!(r.iter().all(|p| p.hint.is_empty()), "found tools carry no hint");
        let git = r.iter().find(|p| p.name == "git").unwrap();
        assert_eq!(git.version.as_deref(), Some("git version 2.43.0"));
        assert_eq!(git.path.as_deref(), Some("/usr/bin/git"));
    }

    #[test]
    fn interpret_preflight_flags_missing_tools_with_hints() {
        use {interpret_preflight, GitBashProbe, PREFLIGHT_MARK};
        // claude + git present; gh missing (empty path), unauthenticated; Git Bash missing.
        let stdout = format!(
            "{PREFLIGHT_MARK}\tclaude\t/usr/bin/claude\tclaude 1.2.3\n\
             {PREFLIGHT_MARK}\tgit\t/usr/bin/git\tgit version 2.43.0\n\
             {PREFLIGHT_MARK}\tgh\t\t\n"
        );
        let r = interpret_preflight(&stdout, GitBashProbe::Missing);
        let gh = r.iter().find(|p| p.name == "gh").unwrap();
        assert!(!gh.found);
        assert!(gh.hint.contains("cli.github.com"));
        let gh_auth = r.iter().find(|p| p.name == "gh auth").unwrap();
        assert!(!gh_auth.found, "gh missing -> auth cannot be reported found");
        assert!(!gh_auth.hint.is_empty());
        let gitbash = r.iter().find(|p| p.name == "Git Bash").unwrap();
        assert!(!gitbash.found);
        assert!(gitbash.hint.contains("git-scm.com"));
        // Present tools still carry their version/path even when others are missing.
        assert!(r.iter().find(|p| p.name == "claude").unwrap().found);
    }

    #[test]
    fn interpret_preflight_omits_git_bash_off_windows() {
        use {interpret_preflight, GitBashProbe};
        let r = interpret_preflight("", GitBashProbe::NotApplicable);
        assert!(!r.iter().any(|p| p.name == "Git Bash"));
        // Empty probe -> every CLI tool reported missing with a hint.
        let names: Vec<&str> = r.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["claude", "git", "gh", "gh auth"]);
        assert!(r.iter().all(|p| !p.found));
        assert!(r.iter().all(|p| !p.hint.is_empty()));
    }

    #[test]
    fn interpret_preflight_gh_auth_requires_gh_present() {
        // A stale GH_AUTH_OK marker must NOT report auth when gh itself is absent.
        use {interpret_preflight, GitBashProbe, GH_AUTH_MARK, PREFLIGHT_MARK};
        let stdout = format!("{PREFLIGHT_MARK}\tgh\t\t\n{GH_AUTH_MARK}\n");
        let r = interpret_preflight(&stdout, GitBashProbe::NotApplicable);
        assert!(!r.iter().find(|p| p.name == "gh auth").unwrap().found);
    }
}
