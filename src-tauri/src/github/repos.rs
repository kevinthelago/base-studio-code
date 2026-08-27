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
    // ONE COPY of the clone (#the-director-can-clone-its-projects-repos). This used to be the only
    // thing in the app that could clone a linked repo — which made it the only door, and a director is
    // a shell session that cannot reach it. The act moved to `bsc-project` (Tauri-free) so
    // `bsc fleet clone` performs the identical clone, with the identical excludes and the identical
    // URL. Two doors onto one function cannot drift; two implementations would.
    let (path, _outcome) = bsc_project::ensure_clone(&project, &full_name, "", None)?;
    Ok(path.to_string_lossy().into_owned())
}
