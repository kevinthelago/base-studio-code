use crate::*;

/// Create (idempotently) a git worktree for one fleet agent: an isolated checkout
/// of `repo` on a branch named after the agent, at
/// `~/.base-studio-code/worktrees/<key>/<repoShort>--<agentSlug>` — OUTSIDE the project
/// hub (see `worktrees_dir`, #844), so the planner spec at `projects/<key>/CLAUDE.md` is
/// not an ancestor of the worker's CWD. Each agent edits and commits in its own
/// worktree+branch, so co-located agents (several in one repo) never share a working
/// tree; the director merges the branches via PRs.
///
/// `scope_md` is this worker's focused context — its owned globs, issues, and
/// dependencies — written as the lead of the worktree's `CLAUDE.local.md` (see
/// `write_worker_context`) instead of the full plan.
///
/// The repo's main clone must already exist (cloned during planning). A worktree or
/// branch left over from a prior run is reused. Returns the worktree's absolute path
/// (native form — mirrors `agentWorktreeCwd` so the launched pane's cwd matches).
#[tauri::command]
pub(crate) async fn ensure_worktree(project_key: String, repo: String, agent_id: String, scope_md: Option<String>) -> Result<String, String> {
    let _perf = PerfSpan::new("ensure_worktree");
    let clone = repo_dir(&project_key, &repo);
    if !clone.join(".git").exists() {
        return Err(format!("ensure_worktree: repo not cloned: {}", clone.display()));
    }
    let slug  = worktree_slug(&agent_id);
    let short = repo.rsplit('/').next().unwrap_or(&repo);
    let wt    = worktrees_dir(&project_key).join(format!("{short}--{slug}"));
    let wt_str = wt.to_string_lossy().into_owned();
    // A worktree's `.git` is a FILE pointing into the main repo; create it only if
    // it isn't there yet (reuse across re-runs).
    if !wt.join(".git").exists() {
        if let Some(parent) = wt.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let clone_str = clone.to_string_lossy().into_owned();
        // Reuse the branch if a prior run already created it; otherwise create it.
        let mut probe = std::process::Command::new("git");
        probe.args(["-C", &clone_str, "rev-parse", "--verify", "--quiet", &format!("refs/heads/{slug}")]);
        let branch_exists = no_window(&mut probe).status().map(|s| s.success()).unwrap_or(false);
        let mut args: Vec<String> = vec!["-C".into(), clone_str, "worktree".into(), "add".into()];
        if branch_exists {
            args.push(wt_str.clone());
            args.push(slug.clone());
        } else {
            args.push("-b".into());
            args.push(slug.clone());
            args.push(wt_str.clone());
        }
        let mut wt_cmd = std::process::Command::new("git");
        wt_cmd.args(&args);
        let status = no_window(&mut wt_cmd).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("ensure_worktree: git worktree add failed for {repo} / {agent_id}"));
        }
        log::info!("ensure_worktree: {repo} agent {agent_id} → {wt_str}");
    }
    // Keep the worktree's build outputs (target/, node_modules/, …) out of git status and mark them
    // app-owned scratch, so the warden never quarantines a worker for an artifact it didn't author
    // and the teardown path can drop them wholesale (#1080). Idempotent — safe on a reused worktree.
    crate::fleet::teardown::exclude_build_artifacts(&wt);
    // Copy the repo's own (tracked) CLAUDE.md only when the worktree lacks one, so a
    // checked-out CLAUDE.md isn't clobbered. (The hub's planner CLAUDE.md is no longer an
    // ancestor — that's the whole point of relocating the worktree — so this is just the
    // repo's real guidance.)
    let claude_md = clone.join("CLAUDE.md");
    if claude_md.is_file() && !wt.join("CLAUDE.md").exists() {
        let _ = std::fs::copy(&claude_md, wt.join("CLAUDE.md"));
    }
    write_worker_context(&wt, &clone, &project_dir(&project_key), scope_md.as_deref());
    Ok(wt_str)
}
/// Assemble a fleet worker's `CLAUDE.local.md` in its worktree (`wt`): its own `scope_md`
/// (owned globs / issues / dependencies) first, then the planner's app-managed per-repo
/// context (`CLAUDE.local.md` in the `clone`, which is git-excluded and so absent from a
/// fresh worktree), then the fleet coordination protocol (#369) and the hub's attached
/// skills (#636). Because the worktree lives outside the hub (`worktrees_dir`, #844), THIS
/// scoped file — not the planner spec — is what Claude Code loads as the worker's context.
///
/// Rewritten on every launch (the per-repo context is untracked and not in a fresh
/// worktree); deterministic, so re-runs converge to identical content. Best-effort writes,
/// matching the rest of the worktree-context setup — a context-file failure must not abort
/// an otherwise-good launch.
pub(crate) fn write_worker_context(
    wt: &std::path::Path,
    clone: &std::path::Path,
    hub: &std::path::Path,
    scope_md: Option<&str>,
) {
    let mut md = String::new();
    if let Some(scope) = scope_md {
        let scope = scope.trim();
        if !scope.is_empty() {
            md.push_str(scope);
            md.push_str("\n\n");
        }
    }
    if let Ok(repo_ctx) = std::fs::read_to_string(clone.join("CLAUDE.local.md")) {
        let repo_ctx = repo_ctx.trim();
        if !repo_ctx.is_empty() {
            md.push_str(repo_ctx);
            md.push('\n');
        }
    }
    let wt_local = wt.join("CLAUDE.local.md");
    let _ = std::fs::write(&wt_local, &md);
    // Coordination protocol (#369): the defer-to-director / never-ask-the-user rules.
    let cur = std::fs::read_to_string(&wt_local).unwrap_or_default();
    if !cur.contains("## Fleet coordination protocol") {
        let _ = std::fs::write(&wt_local, format!("{cur}{FLEET_PROTOCOL_MD}"));
    }
    // Injection-resistance preamble (#1167): untrusted-input rules as authoritative worker context.
    let cur = std::fs::read_to_string(&wt_local).unwrap_or_default();
    if !cur.contains(INJECTION_RESISTANCE_MARKER) {
        let _ = std::fs::write(&wt_local, format!("{cur}{INJECTION_RESISTANCE_MD}"));
    }
    // Inline the blueprint's attached skills (#636) so each worker carries the same skill
    // context the planner had. skills.md lives at the hub (not in the worktree), so the
    // planner's "read skills.md" note doesn't help a worker — inline it instead.
    inject_skills(hub, &wt_local);
}
/// Inline the hub's attached skills (`skills.md`, #636) into a worker's CLAUDE.local.md
/// so the worker auto-loads the same skill context the planner had. Idempotent; a no-op
/// when there are no attached skills (skills.md absent/empty).
pub(crate) fn inject_skills(hub: &std::path::Path, wt_local: &std::path::Path) {
    let skills = std::fs::read_to_string(hub.join("skills.md")).unwrap_or_default();
    let trimmed = skills.trim();
    if trimmed.is_empty() {
        return;
    }
    let cur = std::fs::read_to_string(wt_local).unwrap_or_default();
    if cur.contains("# Attached skills & knowledge") {
        return; // already injected
    }
    let _ = std::fs::write(wt_local, format!("{}\n\n{}\n", cur.trim_end(), trimmed));
}
