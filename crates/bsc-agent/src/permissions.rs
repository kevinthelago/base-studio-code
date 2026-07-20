//! Native permission enforcement (epic #1078, P2c). `bsc-agent` renders the generic
//! role model itself — deny whole tools, deny `bash` commands by pattern, and restrict
//! `write_file`/`edit_file` to a set of path globs — instead of relying on a harness
//! config file (`.claude/settings.json`). Loaded from `$BSC_AGENT_PERMS` (a JSON file
//! path or inline JSON); anything unset/empty/unparseable yields the permissive
//! default — allow everything EXCEPT the always-on dangerous-command floor (the shared
//! `bsc_util::dangerous` registry, #1844) — so an unconfigured session is permissive but never able to
//! run the catastrophic invocations the Claude harness also blocks.

use serde::Deserialize;
use serde_json::Value;

// The always-on dangerous-bash floor — catastrophic invocations denied for EVERY `bsc-agent` session,
// independent of the env-supplied [`Permissions`]. It now comes from the SHARED `bsc_util::dangerous`
// registry (#1844): the same canonical list the Claude harness renders as `Bash(<glob>)` deny rules
// renders here as substrings (`agent_dangerous_substrings`) — so neither harness can be talked into a
// `sudo` / `rm -rf /` / force-push by an empty or missing permission doc, and the two floors can't
// drift. Substring-matched (coarser than Claude's prefix rules) + deliberately conservative; the
// user's `deniedCommands` and the `bsc-taint` hook (#1167) cover the longer tail (curl|sh exfil, etc.).

/// The session's permission set. All-empty (the [`Default`]) is permissive.
#[derive(Debug, Default, Clone, Deserialize)]
pub struct Permissions {
    /// Tool names that may never run (e.g. `["bash"]` for a read-only role).
    #[serde(default)]
    pub deny_tools: Vec<String>,
    /// Substrings that, if present in a `bash` command, deny it (e.g. `["rm -rf", "git push"]`).
    #[serde(default)]
    pub deny_bash: Vec<String>,
    /// When non-empty, `write_file`/`edit_file` are allowed ONLY for paths matching one
    /// of these globs (e.g. `["src/**", "*.md"]`). Empty ⇒ no write-path restriction.
    #[serde(default)]
    pub write_globs: Vec<String>,
    /// The session's repo root (`$BSC_REPO_ROOT`). When non-empty, the file tools
    /// (`read_file`/`write_file`/`edit_file`) are confined to this subtree — the `bsc-agent`
    /// equivalent of the Claude `bsc-confine` PreToolUse hook (#158/#1916), mirroring
    /// `isPathConfined` in `src/shared/lib/session/fsConfine.ts` so both runtimes confine
    /// identically. Set from the environment in [`Permissions::from_env`], NOT from the perms
    /// JSON (`#[serde(skip)]`). Empty ⇒ no confinement (a bare CLI run where `$BSC_REPO_ROOT`
    /// is unset), preserving the permissive default.
    #[serde(skip)]
    pub repo_root: String,
}

impl Permissions {
    /// Load from `$BSC_AGENT_PERMS`: if it names an existing file, parse that file as
    /// JSON; otherwise parse the value itself as inline JSON. Unset / empty / unparseable
    /// ⇒ the permissive default.
    pub fn from_env() -> Permissions {
        let mut perms = match std::env::var("BSC_AGENT_PERMS") {
            Ok(v) if !v.trim().is_empty() => {
                // A path to a readable file wins; otherwise treat the value as inline JSON.
                let json = std::fs::read_to_string(&v).unwrap_or(v);
                serde_json::from_str(&json).unwrap_or_default()
            }
            _ => Permissions::default(),
        };
        // The confinement root is independent of the perms doc — read it from the env ALWAYS, so even
        // an unconfigured session (no `$BSC_AGENT_PERMS`) is still confined to its worktree (#1916).
        perms.repo_root = std::env::var("BSC_REPO_ROOT").unwrap_or_default();
        perms
    }

    /// Whether `tool_name` (with the model-supplied `args`) is permitted. `Err(reason)`
    /// is fed back to the model as the tool result so it can adapt — it is not a crash.
    /// Pure: no env / filesystem access.
    pub fn check(&self, tool_name: &str, args: &Value) -> Result<(), String> {
        if self.deny_tools.iter().any(|t| t == tool_name) {
            return Err(format!("permission denied: tool '{tool_name}' is not allowed"));
        }
        // FS confinement (#158/#1916): when a repo root is set, the file tools must stay within it —
        // mirrors the Claude `bsc-confine` hook + `fsConfine.ts` so the two runtimes confine identically.
        // Covers `read_file`/`write_file`/`edit_file` (the same tool set the Claude hook matches); `bash`
        // is the OS sandbox's job (a pure path check can't follow a subprocess), not gated here.
        if !self.repo_root.is_empty()
            && matches!(tool_name, "read_file" | "write_file" | "edit_file")
        {
            let path = args["path"].as_str().unwrap_or("");
            if !path_confined(&self.repo_root, path) {
                return Err(format!(
                    "permission denied: '{path}' is outside the session's repo root ({}) — #158 FS confinement",
                    self.repo_root
                ));
            }
        }
        match tool_name {
            "bash" => {
                let cmd = args["command"].as_str().unwrap_or("");
                // The always-on floor first — denied for every session regardless of `deny_bash`.
                if bsc_util::dangerous::agent_dangerous_substrings().any(|p| cmd.contains(p)) {
                    return Err("permission denied: command matches the built-in dangerous-command denylist".into());
                }
                // #3483: program-name patterns match the PROGRAM token, not any substring of the
                // command — see `bsc_util::deny`. The floor above keeps `contains` on purpose.
                if self.deny_bash.iter().any(|p| bsc_util::deny::deny_matches(cmd, p.as_str())) {
                    return Err("permission denied: bash command matches a denied pattern".into());
                }
            }
            "write_file" | "edit_file" if !self.write_globs.is_empty() => {
                let path = args["path"].as_str().unwrap_or("");
                let allowed = self.write_globs.iter().any(|g| {
                    glob::Pattern::new(g).map(|pat| pat.matches(path)).unwrap_or(false)
                });
                if !allowed {
                    return Err(format!(
                        "permission denied: '{path}' is outside the allowed write paths"
                    ));
                }
            }
            _ => {}
        }
        Ok(())
    }
}

/// Whether a file-tool `target` stays within `root` — mirrors `isPathConfined` in
/// `src/shared/lib/session/fsConfine.ts` (#158) so the `bsc-agent` runtime and the Claude
/// `bsc-confine` hook confine identically: empty → confined; any `..` segment → NOT confined
/// (rejected conservatively, even within-repo); absolute path → confined only if under `root`;
/// plain relative → confined (resolved against the repo-root cwd). String-based, no realpath,
/// portable across OSes.
fn path_confined(root: &str, target: &str) -> bool {
    if target.is_empty() {
        return true;
    }
    let norm = target.replace('\\', "/");
    if norm.split('/').any(|seg| seg == "..") {
        return false;
    }
    if is_absolute(target) {
        let r = root.replace('\\', "/");
        let r = r.trim_end_matches('/');
        return norm == r || norm.starts_with(&format!("{r}/"));
    }
    true
}

/// Absolute paths: POSIX (`/…`), home (`~…`), Windows drive (`C:…`), or UNC (`\\…`).
/// Mirrors `isAbsolute` in `fsConfine.ts`.
fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
        || p.starts_with('~')
        || p.starts_with("\\\\")
        || (p.len() >= 2 && p.as_bytes()[0].is_ascii_alphabetic() && p.as_bytes()[1] == b':')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn permissive_default_allows_ordinary_work() {
        // The default is permissive for everything EXCEPT the dangerous floor (asserted below):
        // ordinary commands, writes, and reads all pass with no configured permissions.
        let p = Permissions::default();
        assert!(p.check("bash", &json!({ "command": "cargo build" })).is_ok());
        assert!(p.check("write_file", &json!({ "path": "/etc/passwd" })).is_ok());
        assert!(p.check("read_file", &json!({ "path": "/anything" })).is_ok());
    }

    #[test]
    fn base_dangerous_floor_is_enforced_even_under_the_permissive_default() {
        // Parity with the Claude harness's always-on DEFAULT_DENY: an unconfigured session
        // (empty perms) still cannot run the catastrophic invocations.
        let p = Permissions::default();
        for cmd in [
            "sudo rm -rf /tmp/x",
            "rm -rf /",
            "rm -rf ~/work",
            "mkfs.ext4 /dev/sda",
            "git push --force origin main",
            "git push -f origin main",
        ] {
            assert!(p.check("bash", &json!({ "command": cmd })).is_err(), "should deny: {cmd}");
        }
        // Ordinary build/clean commands are unaffected (no false-positive on the floor).
        assert!(p.check("bash", &json!({ "command": "rm -rf target" })).is_ok());
        assert!(p.check("bash", &json!({ "command": "git push origin feat" })).is_ok());
    }

    #[test]
    fn deny_tools_blocks_the_named_tool() {
        let p = Permissions { deny_tools: vec!["bash".into()], ..Default::default() };
        assert!(p.check("bash", &json!({ "command": "ls" })).is_err());
        assert!(p.check("read_file", &json!({ "path": "x" })).is_ok());
    }

    #[test]
    fn deny_bash_matches_substring() {
        let p = Permissions { deny_bash: vec!["rm -rf".into(), "git push".into()], ..Default::default() };
        assert!(p.check("bash", &json!({ "command": "sudo rm -rf /tmp" })).is_err());
        assert!(p.check("bash", &json!({ "command": "git push origin main" })).is_err());
        assert!(p.check("bash", &json!({ "command": "ls -la" })).is_ok());
    }

    #[test]
    fn deny_bash_program_names_match_the_program_not_a_path_substring() {
        // #3483: a bare deny entry is a PROGRAM name. Substring-matching it denied `ed` inside
        // `shared/ui` and `vi` inside `Kevin` — every absolute path on some machines — which left a
        // confined session unable to run its own tooling.
        let p = Permissions {
            deny_bash: vec!["ed".into(), "vi".into(), "tee".into()],
            ..Default::default()
        };
        assert!(p.check("bash", &json!({ "command": "bsc ui harvest src/shared/ui" })).is_ok());
        assert!(p.check("bash", &json!({ "command": "ls C:/Users/Kevin/p" })).is_ok());
        assert!(p.check("bash", &json!({ "command": "vi notes.txt" })).is_err());
        assert!(p.check("bash", &json!({ "command": "cat a | tee b" })).is_err());
        assert!(p.check("bash", &json!({ "command": "sh -c \"tee out\"" })).is_err(), "no -c bypass");
    }

    #[test]
    fn write_globs_restrict_paths_when_set() {
        let p = Permissions { write_globs: vec!["src/**".into(), "*.md".into()], ..Default::default() };
        assert!(p.check("write_file", &json!({ "path": "src/lib.rs" })).is_ok());
        assert!(p.check("edit_file", &json!({ "path": "README.md" })).is_ok());
        assert!(p.check("write_file", &json!({ "path": "/etc/hosts" })).is_err());
        // read_file is never write-restricted.
        assert!(p.check("read_file", &json!({ "path": "/etc/hosts" })).is_ok());
    }

    #[test]
    fn empty_write_globs_means_no_write_restriction() {
        let p = Permissions::default();
        assert!(p.check("write_file", &json!({ "path": "/anywhere/x" })).is_ok());
    }

    #[test]
    fn repo_root_confines_the_file_tools() {
        // The bsc-agent mirror of the Claude `bsc-confine` hook (#158/#1916): file tools must stay
        // within $BSC_REPO_ROOT. In-repo relative + absolute-under-root pass...
        let p = Permissions { repo_root: "/work/repo".into(), ..Default::default() };
        assert!(p.check("read_file", &json!({ "path": "src/lib.rs" })).is_ok());
        assert!(p.check("write_file", &json!({ "path": "/work/repo/src/x.rs" })).is_ok());
        assert!(p.check("edit_file", &json!({ "path": "/work/repo" })).is_ok());
        // ...escapes are denied: `..` traversal, absolute outside the root, a sibling repo sharing a
        // path prefix, and home-relative paths.
        assert!(p.check("read_file", &json!({ "path": "../other/secret" })).is_err());
        assert!(p.check("write_file", &json!({ "path": "/etc/passwd" })).is_err());
        assert!(p.check("read_file", &json!({ "path": "/work/repo-sibling/x" })).is_err());
        assert!(p.check("edit_file", &json!({ "path": "~/.ssh/id_rsa" })).is_err());
        // a `..` anywhere is rejected even if it would resolve back inside the root.
        assert!(p.check("write_file", &json!({ "path": "src/../../escape" })).is_err());
        // bash is NOT path-confined here (the OS sandbox's job, not a pure check).
        assert!(p.check("bash", &json!({ "command": "cat ../other/secret" })).is_ok());
    }

    #[test]
    fn no_repo_root_means_no_confinement() {
        // A bare CLI run (no $BSC_REPO_ROOT ⇒ empty repo_root) stays permissive.
        let p = Permissions::default();
        assert!(p.check("read_file", &json!({ "path": "/etc/passwd" })).is_ok());
        assert!(p.check("write_file", &json!({ "path": "../anywhere" })).is_ok());
    }

    #[test]
    fn confinement_composes_with_write_globs() {
        // Both gates apply (deny wins): inside the root AND matching a glob passes; inside the root
        // but outside the globs is denied by the glob check; outside the root is denied by confinement.
        let p = Permissions {
            repo_root: "/work/repo".into(),
            write_globs: vec!["src/**".into()],
            ..Default::default()
        };
        assert!(p.check("write_file", &json!({ "path": "src/a.rs" })).is_ok());
        assert!(p.check("write_file", &json!({ "path": "docs/a.md" })).is_err()); // glob
        assert!(p.check("write_file", &json!({ "path": "/etc/x" })).is_err());     // confinement
    }
}
