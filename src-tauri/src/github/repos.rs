use crate::prelude::*;

/// Clones `full_name` (an `owner/name` GitHub slug) into the project hub at
/// `projects/<sanitize(project)>/<short-repo-name>` and returns the clone path.
/// Idempotent: if the destination is already a git clone it is returned as-is.
/// After cloning, `CLAUDE.local.md` is appended to the clone's
/// `.git/info/exclude` so the planner-generated per-repo context file stays out
/// of `git status`.
#[tauri::command]
pub(crate) async fn clone_repo(project: String, full_name: String) -> Result<String, String> {
    let _perf = PerfSpan::new("clone_repo");
    let dest = repo_dir(&project, &full_name);
    if dest.is_dir() && dest.join(".git").exists() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).str_err()?;
    }
    let url = format!("https://github.com/{}.git", full_name);
    let mut cmd = std::process::Command::new("git");
    cmd.args(["clone", &url, &dest.to_string_lossy()]);
    let status = run_status(&mut cmd).str_err()?;
    if !status.success() {
        log::warn!("clone_repo: git clone failed for {full_name}");
        return Err(format!("git clone failed for {}", full_name));
    }
    // Keep app-managed files (per-repo CLAUDE.local.md, the .claude/ session
    // settings) out of the clone's `git status`.
    git_exclude(&dest, "CLAUDE.local.md");
    git_exclude(&dest, ".claude/");
    // The fleet assume-and-log journal (bsc-note) lives in the repo root; keep it out
    // of the clone's `git status`.
    git_exclude(&dest, "DECISIONS.md");
    log::info!("clone_repo: cloned {full_name} → {}", dest.display());
    Ok(dest.to_string_lossy().into_owned())
}
