//! Host ↔ distro file I/O + in-distro clone/worktree (#1988, the relocation bridge).
//!
//! The `\\wsl$` 9P share is unavailable on some Windows installs ("network name cannot be found"), so
//! host↔distro file ops go through `wsl` exec with the path EMBEDDED (shell-escaped) in the script —
//! the mechanism verified to work. This is the foundation for relocating the planner/triage hub onto
//! the distro's ext4: a session sees `/home/agent/...`; the host writes/reads it via these helpers.

use crate::StrErr;
use super::{
    agent_worktrees_dir, ensure_sandbox_user, require_windows, wsl_exec, wsl_exec_as, wsl_exec_stdin,
    AGENT_GROUP, AGENT_SANDBOX_DISTRO, SHARED_BASE,
};

/// The project hub's distro-native path for `key` (the in-distro analogue of `project_dir`).
///
/// Lives in the group-shared [`SHARED_BASE`] (#4260), not in one user's home: the hub is what the
/// director, every worker, and the planner all have to agree on — `plan.db`, the section files, the
/// kickoffs, `coord.log`. Per-agent isolation covers the worktrees ([`sandbox_worktree_path`]), which
/// is where an agent's own edits live.
fn sandbox_project_path(key: &str) -> String {
    format!("{SHARED_BASE}/projects/{}", crate::platform::fsx::sanitize_project_key(key))
}

/// Single-quote a string as one safe POSIX-shell token.
fn sh_squote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Write `content` bytes to `linux_path` inside the sandbox distro, creating parent dirs — via `wsl`
/// exec (content on stdin; the path is embedded + escaped in the script, since `\\wsl$` is unreliable).
/// Bytes (not text) so binary files like `plan.db` copy intact.
///
/// `user` performs the write as that per-agent Linux user (#4260) — required for anything landing in
/// an agent's private `700` home, which no other user can write. `umask 002` so files written into the
/// group-shared base stay group-WRITABLE: a worker running `bsc plan …` has to update the same
/// `plan.db` the planner seeded, and a default `022` umask would leave it read-only to everyone else.
fn sandbox_write_as(user: Option<&str>, linux_path: &str, content: &[u8]) -> Result<(), String> {
    let dir = linux_path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
    let script = format!("umask 002; mkdir -p {} && cat > {}", sh_squote(dir), sh_squote(linux_path));
    wsl_exec_stdin(user, &["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()], content)
}

/// [`sandbox_write_as`] as the distro's shared default user — the host-side hub replication path.
fn sandbox_write(linux_path: &str, content: &[u8]) -> Result<(), String> {
    sandbox_write_as(None, linux_path, content)
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
        let entry = entry.str_err()?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ft = entry.file_type().str_err()?;
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
    // Source the hub from the planner's ACTUAL cwd (#2997): a never-materialized greenfield draft
    // plans in the ephemeral `planning/<key>` workspace, a materialized / repo-linked project in
    // `projects/<key>`. `planning_cwd` resolves whichever exists, so the replication mirrors the real
    // files instead of an empty `project_dir`.
    let host_hub = crate::platform::paths::planning_cwd(&key);
    let distro_hub = sandbox_project_path(&key);
    copy_dir_to_sandbox(&host_hub, &distro_hub)?;
    // plan.db now lives OUTSIDE the hub (central `plans/<key>.db`, #2996) — replicate it INTO the cage
    // hub as `plan.db` so a sandboxed planner resumes its existing plan and `sync_sandbox_plan_db`
    // mirrors it back to the central store. Absent (a brand-new project) → nothing to seed.
    if let Ok(bytes) = std::fs::read(crate::platform::paths::plan_db_path(&key)) {
        sandbox_write(&format!("{distro_hub}/plan.db"), &bytes)?;
    }
    Ok(distro_hub)
}

/// Read a file from the sandbox distro (#1988) — e.g. a relocated hub's plan section, for the UI.
#[tauri::command]
pub(crate) fn sandbox_read_file(path: String) -> Result<String, String> {
    require_windows()?;
    sandbox_read(&path)
}

/// Workspace CONTROL files the plan-section sweep excludes — mirrors the private list in
/// `ingest_stage_files` (platform/fsx.rs), so the sandbox reader can't drift from the host reader.
const SECTION_CONTROL_FILES: &[&str] = &["CLAUDE.md", "automations.md", "extensions.md", "github_context.md", "fleet.json"];

/// Parse the NUL-delimited `<path>\n<content>` dump from [`read_sandbox_plan_stages`]' wsl script
/// into the `{stem: content}` map, applying the SAME rules as `ingest_stage_files`: skip control
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
/// `read_plan_stages`, so the planner's right pane reflects the sections a sandboxed planner writes
/// INSIDE the cage. One `wsl` exec dumps every `.md`/`.json` under the hub root + `discovery/`; the
/// control-file / stem / trim / discovery-wins semantics match `ingest_stage_files` (via
/// [`parse_section_dump`]). Empty map on a not-yet-relocated hub (the glob simply matches nothing).
#[tauri::command]
pub(crate) fn read_sandbox_plan_stages(key: String) -> Result<std::collections::HashMap<String, String>, String> {
    require_windows()?;
    let hub = sh_squote(&sandbox_project_path(&key));
    // Root globs first, then discovery/ — later records win (matches read_plan_stages' ingest order).
    let script = format!(
        "for f in {hub}/*.md {hub}/*.json {hub}/discovery/*.md {hub}/discovery/*.json; do [ -f \"$f\" ] || continue; printf '%s\\n' \"$f\"; cat \"$f\"; printf '\\0'; done"
    );
    let out = wsl_exec(&["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()])?;
    let mut sections = parse_section_dump(&out);
    // plan.db `section` artifacts (#2997 A2) — a sandboxed planner's plan.db is mirrored to the HOST
    // (`sync_sandbox_plan_db`), so the DB-backed sections read from the host store; they win over files.
    for (name, content) in crate::project::plan_db::artifacts_of_kind(&key, "section") {
        let c = content.trim();
        if !c.is_empty() {
            sections.insert(name, c.to_string());
        }
    }
    Ok(sections)
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
    let host_db = crate::platform::paths::plan_db_path(&key);
    if std::fs::read(&host_db).map(|h| h == bytes).unwrap_or(false) {
        return Ok(false); // unchanged
    }
    if let Some(parent) = host_db.parent() {
        std::fs::create_dir_all(parent).str_err()?;
    }
    std::fs::write(&host_db, &bytes).str_err()?;
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
    // The SAME shared-object-store preparation `ensure_sandbox_worktree` uses (#4260) — a clone that
    // isn't group-writable is one no isolated agent can add a worktree against, so the two clone paths
    // must not drift. Root, because it chgrp/chmods and writes the system `safe.directory`.
    let script = shared_clone_script(&dest, &clone_url(&repo, &token));
    match wsl_exec_as(Some("root"), &["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", script.as_str()]) {
        Ok(_) => Ok(dest),
        Err(mut err) => {
            if !token.is_empty() { err = err.replace(&token, "***"); }
            Err(err)
        }
    }
}

/// The distro-native path of a fleet worker's worktree (#1988) — mirrors the host `worktrees_dir`
/// layout (`<root>/worktrees/<key>/<repoShort>--<slug>`), on the distro's ext4 and OUTSIDE the hub
/// (so the planner spec isn't an ancestor, #844). Pure — the branch/dir names match the frontend's
/// `worktreeSlug(streamId)` so the launched pane's cwd + branch line up.
///
/// The root is the OWNING AGENT's private home (#4260, [`agent_worktrees_dir`]) — the whole point of
/// per-agent isolation is that this tree is unreadable to every other agent. It used to sit under the
/// default `agent` user's `700` home, where its own owner got `Permission denied`.
fn sandbox_worktree_path(user: &str, key: &str, repo: &str, agent_id: &str) -> String {
    format!(
        "{}/{}/{}",
        agent_worktrees_dir(user),
        crate::platform::fsx::sanitize_project_key(key),
        crate::platform::paths::worktree_dir_name(repo, agent_id),
    )
}

/// The in-distro shell script that prepares the SHARED git object store for `clone` (#4260), run as
/// **root**. One clone per repo serves every agent's worktree — so N workers cost one fetch — which
/// only works if agents running as different Linux users can all write its `.git`:
///
/// - `core.sharedRepository=group` makes git create group-writable objects/refs from here on.
/// - `chgrp -R` + `chmod -R g+rw` + setgid on directories fixes up what the clone itself wrote and
///   makes new files inherit [`AGENT_GROUP`].
/// - `safe.directory` stops git refusing to operate on a repo whose owner is not the calling agent —
///   without it every `git worktree add` fails with "detected dubious ownership".
///
/// The hub directories ABOVE the clone (`projects/` and `projects/<key>/`) are made group-writable +
/// setgid here too. They are otherwise created by whichever step runs first — and when that was root's
/// `mkdir` at the default `022` umask, the hub came out root-owned and read-only to every agent, so a
/// worker could read `plan.db` but never write one back (observed on a live distro).
///
/// Pure (returns the script) so the ownership contract is unit-testable without a live distro.
fn shared_clone_script(clone: &str, url: &str) -> String {
    format!(
        r#"set -e
umask 002
clone={clone}; url={url}; grp={grp}
projdir="$(dirname "$clone")"; projects="$(dirname "$projdir")"
mkdir -p "$projdir"
chgrp "$grp" "$projects" "$projdir" 2>/dev/null || true
chmod 2775 "$projects" "$projdir" 2>/dev/null || true
[ -d "$clone/.git" ] || {{ rm -rf "$clone"; git clone "$url" "$clone"; }}
git -C "$clone" config core.sharedRepository group
chgrp -R "$grp" "$clone"
chmod -R g+rw "$clone"
find "$clone" -type d -exec chmod g+s {{}} +
git config --system --get-all safe.directory 2>/dev/null | grep -qxF "$clone" \
  || git config --system --add safe.directory "$clone""#,
        clone = sh_squote(clone),
        url = sh_squote(url),
        grp = AGENT_GROUP,
    )
}

/// The in-distro shell script that adds ONE agent's worktree off the shared clone (#4260), run as
/// **that agent's** Linux user so every file lands owned by the agent inside its own `700` home.
///
/// Idempotent + self-healing in the two ways a prior aborted run blocks a re-add (a dangling worktree
/// record; a branch the failed `-b` half-created) — the `sh` twin of the host `add_worktree_healing`.
/// Pure, so the healing dance is unit-testable without a live distro.
///
/// `umask 002` because `worktree add` also writes a registration under the SHARED clone's
/// `.git/worktrees/`. At the default `022` the first agent to register would create that directory
/// group-read-only and the SECOND agent's add would fail — N-worker fleets would break on worker two.
fn worktree_add_script(clone: &str, wt: &str, slug: &str) -> String {
    format!(
        r#"set -e
umask 002
clone={clone}; wt={wt}; slug={slug}
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
        clone = sh_squote(clone),
        wt = sh_squote(wt),
        slug = sh_squote(slug),
    )
}

/// The sealed-distro analogue of [`crate::fleet::worktree::ensure_worktree`] (#1988): ensure `repo`
/// is git-cloned in the distro hub, then create (idempotently) a git worktree for one fleet agent on
/// a branch named after its stream — all on the distro's ext4, so a sandboxed worker never touches
/// the Windows host. Returns the worktree's distro-native path (the pane's `cwd`).
///
/// The split that makes per-agent isolation real (#4260): the **clone** is shared and prepared as root
/// ([`shared_clone_script`]), the **worktree** is added by the agent's own Linux user inside its own
/// `700` home ([`worktree_add_script`]). Doing both as one root script — as this did — left the tree
/// owned by a user the session isn't, and the session then could not read its own cwd.
///
/// The per-agent user is derived from `<project_key>:<agent_id>`, which IS the worker's `fleetPaneId`,
/// so `TerminalView`'s `sandboxUserIdentity` → `ensure_sandbox_user` re-derives this exact user at
/// launch and the session lands in the home its worktree was built in. Provisioning is idempotent, so
/// deriving it here (rather than threading it from the frontend) cannot drift from the launch.
///
/// After the tree exists, the worker's `CLAUDE.local.md` (its `scope_md` + the fleet coordination
/// protocol + the injection-resistance preamble) is written in AS that user, mirroring
/// `write_worker_context`. `token` authorizes a private clone and is redacted from any surfaced error.
#[tauri::command]
pub(crate) fn ensure_sandbox_worktree(
    project_key: String,
    repo: String,
    agent_id: String,
    scope_md: Option<String>,
    token: String,
) -> Result<String, String> {
    require_windows()?;
    let user = ensure_sandbox_user(format!("{project_key}:{agent_id}"))?;
    let short = crate::platform::paths::repo_short(&repo).to_string();
    let clone = format!("{}/{short}", sandbox_project_path(&project_key));
    let wt = sandbox_worktree_path(&user, &project_key, &repo, &agent_id);
    let slug = crate::platform::fsx::worktree_slug(&agent_id);
    // 1) The shared object store, as root — one clone per repo, group-writable to every agent.
    let clone_script = shared_clone_script(&clone, &clone_url(&repo, &token));
    if let Err(mut err) = wsl_exec_as(
        Some("root"), &["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", clone_script.as_str()],
    ) {
        if !token.is_empty() { err = err.replace(&token, "***"); }
        return Err(err);
    }
    // 2) This agent's private checkout, as the agent itself.
    let wt_script = worktree_add_script(&clone, &wt, &slug);
    if let Err(mut err) = wsl_exec_as(
        Some(&user), &["-d", AGENT_SANDBOX_DISTRO, "--", "sh", "-c", wt_script.as_str()],
    ) {
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
    let _ = sandbox_write_as(Some(&user), &format!("{wt}/CLAUDE.local.md"), md.as_bytes());
    Ok(wt)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the tests derive a username directly — production code goes through `ensure_sandbox_user`,
    // which provisions as well as derives.
    use super::super::agent_user_name;

    #[test]
    fn sandbox_worktree_path_lives_in_its_own_agents_home() {
        let user = agent_user_name("proj:api-stream");
        assert_eq!(
            sandbox_worktree_path(&user, "proj", "octocat/Hello-World", "api-stream"),
            format!("/home/{user}/worktrees/proj/Hello-World--api-stream"),
        );
        // Key sanitized (no traversal); a repo with no slash keeps its whole name.
        assert!(!sandbox_worktree_path(&user, "../etc", "r", "s").contains(".."));
    }

    #[test]
    fn two_workers_get_worktrees_in_different_homes() {
        // #4260 — the isolation property, asserted at the path layer: two streams of the SAME project
        // resolve to different Linux users, so their trees cannot share a (700) parent. When both sat
        // under /home/agent, this was one directory and the isolation was nominal.
        let a = agent_user_name("proj:api-stream");
        let b = agent_user_name("proj:web-stream");
        let pa = sandbox_worktree_path(&a, "proj", "octocat/Hello-World", "api-stream");
        let pb = sandbox_worktree_path(&b, "proj", "octocat/Hello-World", "web-stream");
        assert_ne!(a, b);
        assert!(pa.starts_with(&format!("/home/{a}/")) && pb.starts_with(&format!("/home/{b}/")));
        // And neither lands in the shared base, which every agent can read.
        assert!(!pa.starts_with(SHARED_BASE) && !pb.starts_with(SHARED_BASE));
    }

    #[test]
    fn sandbox_project_path_is_shared_and_sanitized() {
        // The hub is COMMON ground (#4260) — director, workers and planner all read it — so it lives
        // in the group-shared base, not in any one agent's private home.
        assert_eq!(sandbox_project_path("my-proj"), format!("{SHARED_BASE}/projects/my-proj"));
        // The key is sanitized the same way as the host hub (no path traversal into the distro).
        assert!(!sandbox_project_path("../etc").contains(".."));
    }

    #[test]
    fn shared_clone_script_makes_the_object_store_writable_by_every_agent() {
        let s = shared_clone_script("/srv/bsc-shared/base/projects/p/repo", "https://github.com/o/r.git");
        // Idempotent: an existing checkout is not re-cloned.
        assert!(s.contains(r#"[ -d "$clone/.git" ] ||"#));
        // Group-shared object store: git itself creates group-writable objects/refs from here on…
        assert!(s.contains("config core.sharedRepository group"));
        // …and what the clone already wrote is fixed up, with setgid so new dirs inherit the group.
        assert!(s.contains(r#"chgrp -R "$grp" "$clone""#));
        assert!(s.contains(r#"chmod -R g+rw "$clone""#));
        assert!(s.contains("find \"$clone\" -type d -exec chmod g+s"));
        // Without safe.directory, a clone owned by root fails EVERY worktree add from an agent user
        // with "detected dubious ownership" — the failure mode that makes a shared store unusable.
        assert!(s.contains("safe.directory"));
        assert!(s.contains("--system --add safe.directory \"$clone\""));
        // The hub dirs ABOVE the clone are group-writable + setgid too, or an agent can read plan.db
        // but never write one back (observed on a live distro).
        assert!(s.contains("umask 002"));
        assert!(s.contains(r#"chmod 2775 "$projects" "$projdir""#));
        assert!(s.contains(r#"chgrp "$grp" "$projects" "$projdir""#));
        assert!(s.starts_with("set -e\n"));
    }

    #[test]
    fn worktree_add_script_reuses_or_creates_the_branch_and_self_heals() {
        let s = worktree_add_script("/srv/bsc-shared/base/projects/p/repo", "/home/bsc-x/worktrees/p/repo--api", "api");
        // Idempotent — an existing tree is left alone.
        assert!(s.contains(r#"if [ ! -e "$wt/.git" ]; then"#));
        // Reuse an existing branch, else create it (the host `add_worktree_healing` probe).
        assert!(s.contains(r#"rev-parse --verify --quiet "refs/heads/$slug""#));
        assert!(s.contains(r#"worktree add "$wt" "$slug""#));
        assert!(s.contains(r#"worktree add -b "$slug" "$wt""#));
        // …and the prune/retry that recovers a half-finished prior run.
        assert!(s.contains("worktree prune"));
        // It does NOT clone: the object store is prepared separately, as root, because this half runs
        // as the unprivileged agent (#4260).
        assert!(!s.contains("git clone"));
        // Group-writable registration under the shared clone's .git/worktrees — without this the
        // SECOND worker of a fleet cannot register (verified on a live distro).
        assert!(s.contains("umask 002"));
        assert!(s.starts_with("set -e\n"));
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
