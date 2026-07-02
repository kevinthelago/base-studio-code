//! Host ↔ distro file I/O + in-distro clone/worktree (#1988, the relocation bridge).
//!
//! The `\\wsl$` 9P share is unavailable on some Windows installs ("network name cannot be found"), so
//! host↔distro file ops go through `wsl` exec with the path EMBEDDED (shell-escaped) in the script —
//! the mechanism verified to work. This is the foundation for relocating the planner/triage hub onto
//! the distro's ext4: a session sees `/home/agent/...`; the host writes/reads it via these helpers.

use super::{require_windows, wsl_exec, wsl_exec_stdin, AGENT_SANDBOX_DISTRO};

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

/// Write `content` bytes to `linux_path` inside the sandbox distro, creating parent dirs — via `wsl`
/// exec (content on stdin; the path is embedded + escaped in the script, since `\\wsl$` is unreliable).
/// Bytes (not text) so binary files like `plan.db` copy intact.
fn sandbox_write(linux_path: &str, content: &[u8]) -> Result<(), String> {
    let dir = linux_path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
    let script = format!("mkdir -p {} && cat > {}", sh_squote(dir), sh_squote(linux_path));
    wsl_exec_stdin(&["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()], content)
}

/// Read a file from inside the sandbox distro via `wsl` exec.
fn sandbox_read(linux_path: &str) -> Result<String, String> {
    wsl_exec(&["-d", AGENT_SANDBOX_DISTRO, "--", "cat", linux_path])
}

/// Recursively copy a host directory tree INTO the sandbox distro (each file's bytes piped through
/// `wsl` exec). Skips `.git` internals and any **linked-repo** subdir (one containing a `.git`) — a
/// repo is git-cloned in the distro later, not file-copied (copying a full clone over `wsl` exec would
/// be impractically slow). Binary-safe, so `plan.db` copies intact.
fn copy_dir_to_sandbox(host_dir: &std::path::Path, distro_dir: &str) -> Result<(), String> {
    let entries = std::fs::read_dir(host_dir).map_err(|e| format!("read {}: {e}", host_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let child_distro = format!("{distro_dir}/{name}");
        if ft.is_dir() {
            if name == ".git" || entry.path().join(".git").exists() {
                continue;
            }
            copy_dir_to_sandbox(&entry.path(), &child_distro)?;
        } else if ft.is_file() {
            let bytes = std::fs::read(entry.path()).map_err(|e| format!("read {}: {e}", entry.path().display()))?;
            sandbox_write(&child_distro, &bytes)?;
        }
    }
    Ok(())
}

/// Replicate a project's host hub (`projects/<key>/` — CLAUDE.md, plan section files, plan.db, …) INTO
/// the sandbox distro (#1988), returning the hub's distro-native path — the cwd a sandboxed
/// planner/triage session launches at (`pty_create`'s `wsl_distro`). The relocation kernel: the host
/// builds the hub as usual (`setup_workspaces`), then this mirrors it onto the distro's ext4 so the
/// sealed session has its real files. Call AFTER `setup_workspaces`. Linked repos are skipped (cloned
/// in-distro separately — a follow-on); a greenfield hub has none, so it copies whole.
#[tauri::command]
pub(crate) fn setup_sandbox_hub(key: String) -> Result<String, String> {
    require_windows()?;
    let host_hub = crate::platform::paths::project_dir(&key);
    let distro_hub = sandbox_project_path(&key);
    copy_dir_to_sandbox(&host_hub, &distro_hub)?;
    Ok(distro_hub)
}

/// Read a file from the sandbox distro (#1988) — e.g. a relocated hub's plan section, for the UI.
#[tauri::command]
pub(crate) fn sandbox_read_file(path: String) -> Result<String, String> {
    require_windows()?;
    sandbox_read(&path)
}

/// Workspace CONTROL files the plan-section sweep excludes — mirrors the private list in
/// `ingest_section_files` (platform/fsx.rs), so the sandbox reader can't drift from the host reader.
const SECTION_CONTROL_FILES: &[&str] = &["CLAUDE.md", "automations.md", "extensions.md", "github_context.md", "fleet.json"];

/// Parse the NUL-delimited `<path>\n<content>` dump from [`read_sandbox_plan_sections`]' wsl script
/// into the `{stem: content}` map, applying the SAME rules as `ingest_section_files`: skip control
/// files, key by file stem, trim, drop empties. Root records precede `discovery/` ones so a discovery
/// section overrides a stale root copy (last write wins). Pure — unit-tested against a live dump.
fn parse_section_dump(dump: &str) -> std::collections::HashMap<String, String> {
    let mut sections = std::collections::HashMap::new();
    for rec in dump.split('\0') {
        let Some((path, content)) = rec.split_once('\n') else { continue };
        let name = path.rsplit('/').next().unwrap_or(path);
        if SECTION_CONTROL_FILES.contains(&name) { continue; }
        let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        let content = content.trim();
        if !stem.is_empty() && !content.is_empty() {
            sections.insert(stem.to_string(), content.to_string());
        }
    }
    sections
}

/// Read a sandboxed project's plan sections from the DISTRO hub (#1988) — the sandbox-side mirror of
/// `read_plan_sections`, so the planner's right pane reflects the sections a sandboxed planner writes
/// INSIDE the cage. One `wsl` exec dumps every `.md`/`.json` under the hub root + `discovery/`; the
/// control-file / stem / trim / discovery-wins semantics match `ingest_section_files` (via
/// [`parse_section_dump`]). Empty map on a not-yet-relocated hub (the glob simply matches nothing).
#[tauri::command]
pub(crate) fn read_sandbox_plan_sections(key: String) -> Result<std::collections::HashMap<String, String>, String> {
    require_windows()?;
    let hub = sh_squote(&sandbox_project_path(&key));
    // Root globs first, then discovery/ — later records win (matches read_plan_sections' ingest order).
    let script = format!(
        "for f in {hub}/*.md {hub}/*.json {hub}/discovery/*.md {hub}/discovery/*.json; do [ -f \"$f\" ] || continue; printf '%s\\n' \"$f\"; cat \"$f\"; printf '\\0'; done"
    );
    let out = wsl_exec(&["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()])?;
    Ok(parse_section_dump(&out))
}

/// Read a file's raw bytes from the sandbox distro (#1988) — binary-safe, for the SQLite `plan.db`.
/// The distro `base64`-encodes the file so the transfer over the `wsl` pipe is pure ASCII (raw binary
/// stdout gets mangled by the Windows console layer — verified); we keep only the base64 alphabet
/// (stripping any wrapping/CR wsl adds) and decode. Round-trip verified byte-exact against the distro.
fn sandbox_read_bytes(linux_path: &str) -> Result<Vec<u8>, String> {
    let script = format!("base64 -w0 {}", sh_squote(linux_path));
    let out = wsl_exec(&["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()])?;
    let b64: String = out
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='))
        .collect();
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()).map_err(|e| format!("base64 decode: {e}"))
}

/// Mirror a sandboxed project's `plan.db` from the distro hub back to the HOST hub (#1988), so every
/// host-side plan.db reader (`plan_list_issues`/`plan_get_fleet`/… the poll uses, plus publish + fleet
/// launch) reflects what the in-cage planner wrote. Called each poll tick while a planner runs
/// sandboxed. A no-op — `Ok(false)` — when there's no in-distro db yet or its bytes are unchanged
/// (so an identical db never churns the file or its readers); `Ok(true)` when it copied.
#[tauri::command]
pub(crate) fn sync_sandbox_plan_db(key: String) -> Result<bool, String> {
    require_windows()?;
    let distro_db = format!("{}/plan.db", sandbox_project_path(&key));
    let bytes = match sandbox_read_bytes(&distro_db) {
        Ok(b) if !b.is_empty() => b,
        _ => return Ok(false), // the sandboxed planner hasn't written a plan.db yet — nothing to sync
    };
    let host_db = crate::platform::paths::project_dir(&key).join("plan.db");
    if std::fs::read(&host_db).map(|h| h == bytes).unwrap_or(false) {
        return Ok(false); // unchanged
    }
    if let Some(parent) = host_db.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&host_db, &bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

/// The https clone URL for a `owner/name` repo, with a GitHub PAT injected for private repos (empty
/// token → a plain public URL). Pure — kept out of [`sandbox_clone_repo`] so it can be unit-tested
/// without leaking the token into a test that shells out.
fn clone_url(repo: &str, token: &str) -> String {
    if token.is_empty() {
        format!("https://github.com/{repo}.git")
    } else {
        format!("https://{token}@github.com/{repo}.git")
    }
}

/// Clone a linked repo (`owner/name`) INTO the sandbox distro's project hub (#1988) — the foundation
/// for running triage/fleet inside the cage: repos are git-CLONED in-distro (not file-copied over the
/// wsl pipe, which `copy_dir_to_sandbox` skips). The sealed distro has git + network + ca-certs
/// (verified — a plain https clone succeeds), so this just runs `git clone` there; `token` authorizes
/// a private repo. Idempotent (a re-clone of an existing checkout is skipped). Returns the distro
/// clone path. Any token echoed in git's error output is redacted.
#[tauri::command]
pub(crate) fn sandbox_clone_repo(key: String, repo: String, token: String) -> Result<String, String> {
    require_windows()?;
    let short = crate::platform::paths::repo_short(&repo);
    let dest = format!("{}/{}", sandbox_project_path(&key), short);
    let script = format!(
        "test -d {dest}/.git && exit 0; rm -rf {dest}; git clone {url} {dest}",
        dest = sh_squote(&dest), url = sh_squote(&clone_url(&repo, &token)),
    );
    match wsl_exec(&["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()]) {
        Ok(_) => Ok(dest),
        Err(mut err) => {
            if !token.is_empty() { err = err.replace(&token, "***"); }
            Err(err)
        }
    }
}

/// The distro-native path of a fleet worker's worktree (#1988) — mirrors the host `worktrees_dir`
/// layout (`~/.base-studio-code/worktrees/<key>/<repoShort>--<slug>`), but on the distro's ext4 and
/// OUTSIDE the hub (so the planner spec isn't an ancestor, #844). Pure — the branch/dir names match
/// the frontend's `worktreeSlug(streamId)` so the launched pane's cwd + branch line up.
fn sandbox_worktree_path(key: &str, repo: &str, agent_id: &str) -> String {
    format!(
        "/home/agent/.base-studio-code/worktrees/{}/{}",
        crate::platform::fsx::sanitize_project_key(key),
        crate::platform::paths::worktree_dir_name(repo, agent_id),
    )
}

/// The sealed-distro analogue of [`crate::fleet::worktree::ensure_worktree`] (#1988): ensure `repo`
/// is git-cloned in the distro hub, then create (idempotently) a git worktree for one fleet agent on
/// a branch named after its stream — all on the distro's ext4, so a sandboxed worker never touches
/// the Windows host. Returns the worktree's distro-native path (the pane's `cwd`).
///
/// The clone + worktree run as ONE in-distro shell script that self-heals the two ways a prior
/// aborted run blocks a re-add (a dangling worktree record; a branch the failed `-b` half-created) —
/// the same prune + re-probe dance as the host `add_worktree_healing`, expressed in `sh`. After the
/// tree exists, the worker's `CLAUDE.local.md` (its `scope_md` + the fleet coordination protocol +
/// the injection-resistance preamble) is written in, mirroring `write_worker_context`. `token`
/// authorizes a private clone and is redacted from any surfaced error.
#[tauri::command]
pub(crate) fn ensure_sandbox_worktree(
    project_key: String,
    repo: String,
    agent_id: String,
    scope_md: Option<String>,
    token: String,
) -> Result<String, String> {
    require_windows()?;
    let short = crate::platform::paths::repo_short(&repo).to_string();
    let clone = format!("{}/{short}", sandbox_project_path(&project_key));
    let wt = sandbox_worktree_path(&project_key, &repo, &agent_id);
    let slug = crate::platform::fsx::worktree_slug(&agent_id);
    // One idempotent, self-healing script: clone-if-absent, then worktree-add with the reuse-vs-create
    // probe + prune/re-probe retry (the `sh` twin of `add_worktree_healing`).
    let script = format!(
        r#"set -e
clone={clone}; wt={wt}; slug={slug}; url={url}
[ -d "$clone/.git" ] || {{ rm -rf "$clone"; git clone "$url" "$clone"; }}
if [ ! -e "$wt/.git" ]; then
  mkdir -p "$(dirname "$wt")"
  add() {{
    if git -C "$clone" rev-parse --verify --quiet "refs/heads/$slug" >/dev/null 2>&1; then
      git -C "$clone" worktree add "$wt" "$slug"
    else
      git -C "$clone" worktree add -b "$slug" "$wt"
    fi
  }}
  add || {{ git -C "$clone" worktree prune; add; }}
fi"#,
        clone = sh_squote(&clone),
        wt = sh_squote(&wt),
        slug = sh_squote(&slug),
        url = sh_squote(&clone_url(&repo, &token)),
    );
    if let Err(mut err) = wsl_exec(&["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()]) {
        if !token.is_empty() { err = err.replace(&token, "***"); }
        return Err(err);
    }
    // Seed the worker context in-distro (scope + protocol + injection resistance), matching the host
    // `write_worker_context` lead order. Best-effort beyond the tree itself — a context write failure
    // must not fail an otherwise-good launch.
    let mut md = String::new();
    if let Some(scope) = scope_md.as_deref() {
        let scope = scope.trim();
        if !scope.is_empty() {
            md.push_str(scope);
            md.push_str("\n\n");
        }
    }
    md.push_str(&crate::fleet::protocols::fleet_protocol_md());
    md.push_str(&crate::fleet::protocols::injection_resistance_md());
    let _ = sandbox_write(&format!("{wt}/CLAUDE.local.md"), md.as_bytes());
    Ok(wt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sandbox_worktree_path_mirrors_host_layout_native_and_sanitized() {
        assert_eq!(
            sandbox_worktree_path("proj", "octocat/Hello-World", "api-stream"),
            "/home/agent/.base-studio-code/worktrees/proj/Hello-World--api-stream",
        );
        // Key sanitized (no traversal); a repo with no slash keeps its whole name.
        assert!(!sandbox_worktree_path("../etc", "r", "s").contains(".."));
    }

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
    fn parse_section_dump_matches_ingest_semantics() {
        // The live wsl dump shape (verified against the distro): `<path>\n<content>`, records
        // NUL-separated, root globs before discovery/. Control files skipped, empties dropped, keyed
        // by stem, and a discovery/ section overrides a same-stem root copy (last write wins, #1988).
        let dump = "/h/goal.md\nroot goal\n\0/h/CLAUDE.md\nspec\n\0/h/empty.md\n\0/h/discovery/goal.md\ndiscovery goal\n\0/h/discovery/scope.md\nthe scope\n\0";
        let s = parse_section_dump(dump);
        assert_eq!(s.get("goal").map(String::as_str), Some("discovery goal"), "discovery overrides root");
        assert_eq!(s.get("scope").map(String::as_str), Some("the scope"));
        assert!(!s.contains_key("CLAUDE"), "control files excluded");
        assert!(!s.contains_key("empty"), "empty sections dropped");
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn clone_url_injects_token_for_private_repos_only() {
        assert_eq!(clone_url("octocat/Hello-World", ""), "https://github.com/octocat/Hello-World.git");
        assert_eq!(clone_url("acme/private", "ghp_secret"), "https://ghp_secret@github.com/acme/private.git");
    }
}
