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
pub(crate) fn ensure_worktree(project_key: String, repo: String, agent_id: String, scope_md: Option<String>) -> Result<String, String> {
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
        add_worktree_healing(&clone_str, &wt_str, &slug)
            .map_err(|e| format!("ensure_worktree: {e} for {repo} / {agent_id}"))?;
        log::info!("ensure_worktree: {repo} agent {agent_id} → {wt_str}");
    }
    // Keep the worktree's build outputs (target/, node_modules/, …) out of git status and mark them
    // app-owned scratch, so the warden never quarantines a worker for an artifact it didn't author
    // and the teardown path can drop them wholesale (#1080). Idempotent — safe on a reused worktree.
    crate::fleet::teardown::exclude_build_artifacts(&wt);
    // Union-merge the additive commons (#851): seed `.gitattributes` in the repo CLONE so the
    // line-additive root files (.gitignore, .env.example) carry `merge=union` — git concatenates
    // both sides on merge instead of conflicting, so any residual concurrent append auto-resolves.
    // Seeded into the clone (not the worktree) so the director can commit it as part of the Phase-0
    // commons and the attribute takes effect on develop merges. Idempotent + additive.
    seed_union_merge_gitattributes(&clone);
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

/// Create the git worktree for branch `slug` at `wt_str` in the clone at `clone_str`, capturing
/// git's stderr so a failure is self-describing, and self-healing the two ways a prior aborted run
/// leaves the repo unable to re-launch.
///
/// The add form depends on whether the branch already exists — reuse (`add <path> <branch>`) vs
/// create (`add -b <branch> <path>`) — so the branch is **probed** first. On a failure we:
///   1. `git worktree prune` — clears a **dangling worktree record** (a prior worktree dir removed
///      *outside* `git worktree remove` — crash, manual `rm`, the `node_modules` junction hazard —
///      leaves a record that still claims the path/branch, failing the add with
///      `'<x>' is a missing but already registered worktree` / `already used by worktree at '<gone>'`).
///   2. **Re-probe and rebuild the add form**, then retry once. This is the crucial step: a failed
///      `add -b <branch>` **creates the branch before it fails** on the path, so a blind retry of the
///      same `-b` would hit `fatal: a branch named '<x>' already exists` (#1570). Re-probing detects
///      the now-existing branch and retries with the reuse form instead.
///
/// Both healing actions are idempotent and harmless when nothing is wrong. git's stderr is surfaced
/// verbatim if the retry still fails (#1568).
fn add_worktree_healing(clone_str: &str, wt_str: &str, slug: &str) -> Result<(), String> {
    let branch_ref = format!("refs/heads/{slug}");
    let branch_exists = || {
        let mut p = std::process::Command::new("git");
        p.args(["-C", clone_str, "rev-parse", "--verify", "--quiet", &branch_ref]);
        no_window(&mut p).status().map(|s| s.success()).unwrap_or(false)
    };
    let run_add = |reuse: bool| -> std::io::Result<std::process::Output> {
        let mut c = std::process::Command::new("git");
        c.args(["-C", clone_str, "worktree", "add"]);
        if reuse {
            c.args([wt_str, slug]); // attach the existing branch
        } else {
            c.args(["-b", slug, wt_str]); // create the branch at HEAD
        }
        no_window(&mut c).output()
    };

    let mut out = run_add(branch_exists()).map_err(|e| e.to_string())?;
    if !out.status.success() {
        let mut prune = std::process::Command::new("git");
        prune.args(["-C", clone_str, "worktree", "prune"]);
        let _ = no_window(&mut prune).status();
        // Re-probe: the first attempt may itself have created the branch, so the correct form can
        // have flipped from create to reuse.
        out = run_add(branch_exists()).map_err(|e| e.to_string())?;
    }
    if !out.status.success() {
        return Err(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// The line-additive repo-root commons whose merges use git's `merge=union` driver (#851): files
/// streams only ever APPEND lines to, so concatenating both sides on merge is the correct resolution
/// and any residual concurrent append auto-resolves without a conflict. Mirrors the TS
/// `UNION_MERGE_COMMONS` set (`src/shared/lib/session/commons.ts`). Deliberately NOT the structured
/// commons (package.json/tsconfig/Cargo.toml) — a blind union of those would produce invalid
/// JSON/TOML.
pub(crate) const UNION_MERGE_COMMONS: &[&str] = &[".gitignore", ".env.example"];

/// The exact `.gitattributes` lines this app manages for the union-merge commons (#851), wrapped in
/// a marker block so the seed is idempotent and a hand-edited `.gitattributes` is preserved.
const GITATTR_MARKER_START: &str = "# >>> base-studio-code: union-merge commons (#851)";
const GITATTR_MARKER_END: &str = "# <<< base-studio-code: union-merge commons";

/// Seed (idempotently, additively) a repo's `.gitattributes` with `merge=union` for the additive
/// commons ({@link UNION_MERGE_COMMONS}), so concurrent appends to `.gitignore` / `.env.example`
/// auto-resolve on merge instead of conflicting (#851 step 5). Writes a marked block; if the marked
/// block is already present it's a no-op, otherwise the block is appended (existing content,
/// including any hand-authored attributes, is preserved). Best-effort — a write failure must not
/// abort a launch. `dir` is the repo clone (so the director commits it as part of the commons).
pub(crate) fn seed_union_merge_gitattributes(dir: &std::path::Path) {
    if !dir.join(".git").exists() {
        return; // not a repo — nothing to seed
    }
    let path = dir.join(".gitattributes");
    let cur = std::fs::read_to_string(&path).unwrap_or_default();
    if cur.contains(GITATTR_MARKER_START) {
        return; // already seeded
    }
    let mut block = String::new();
    block.push_str(GITATTR_MARKER_START);
    block.push('\n');
    for f in UNION_MERGE_COMMONS {
        block.push_str(&format!("{f} merge=union\n"));
    }
    block.push_str(GITATTR_MARKER_END);
    block.push('\n');
    let out = if cur.is_empty() {
        block
    } else if cur.ends_with('\n') {
        format!("{cur}{block}")
    } else {
        format!("{cur}\n{block}")
    };
    let _ = std::fs::write(&path, out);
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
    // Assemble the protocol sections in memory and write once (no read-modify-write per section,
    // #1623). The marker checks mirror the prior disk-based appends exactly (the just-built `md`
    // is the file content), so the written file is byte-identical.
    // Coordination protocol (#369): the defer-to-director / never-ask-the-user rules.
    if !md.contains("## Fleet coordination protocol") {
        md.push_str(FLEET_PROTOCOL_MD);
    }
    // Injection-resistance preamble (#1167): untrusted-input rules as authoritative worker context.
    if !md.contains(INJECTION_RESISTANCE_MARKER) {
        md.push_str(INJECTION_RESISTANCE_MD);
    }
    let wt_local = wt.join("CLAUDE.local.md");
    let _ = std::fs::write(&wt_local, &md);
    // Inline the blueprint's attached skills (#636) so each worker carries the same skill
    // context the planner had. skills.md lives at the hub (not in the worktree), so the
    // planner's "read skills.md" note doesn't help a worker — inline it instead.
    inject_skills(hub, &wt_local);
    // Point UI workers at the user's dropped Claude Design (#1373) — the agent self-selects relevance.
    inject_design_context(hub, &wt_local);
}

/// Marker for the dropped-design section, used to keep `inject_design_context` idempotent.
const DESIGN_CONTEXT_MARKER: &str = "## UI design (dropped by the user)";

/// Append a CLAUDE.local.md section pointing a worker at the user's dropped Claude Design (#1373):
/// given the screen/component file names, tell the worker to build the REAL components from them.
/// Pure (file names → markdown), `None` when there's no dropped design.
pub(crate) fn design_context_block(screens: &[String]) -> Option<String> {
    if screens.is_empty() {
        return None;
    }
    let list = screens.iter().map(|s| format!("- `{s}`")).collect::<Vec<_>>().join("\n");
    Some(format!(
        "\n{DESIGN_CONTEXT_MARKER}\n\nThe user provided a Claude Design for this project. Its screens / \
         components live in the project hub's `design/` (raw exports) and `.ui-skeleton/` (the \
         render-preview's copy):\n\n{list}\n\nIf your stream owns UI / screen work, BUILD THE REAL \
         components from these — match the provided design rather than inventing your own; treat the \
         skeleton as the source of truth for the layout and structure.\n"
    ))
}

/// Inline a dropped-design reference into a worker's CLAUDE.local.md (#1373): reads the hub's
/// `.ui-skeleton/` (populated from `design/`) for the screen names and appends `design_context_block`.
/// Idempotent; a no-op when there's no dropped design.
pub(crate) fn inject_design_context(hub: &std::path::Path, wt_local: &std::path::Path) {
    let screens: Vec<String> = crate::project::inspect::read_skeleton_dir(&hub.join(".ui-skeleton"))
        .into_iter()
        .map(|(rel, _)| rel)
        .collect();
    let Some(block) = design_context_block(&screens) else { return };
    let cur = std::fs::read_to_string(wt_local).unwrap_or_default();
    if cur.contains(DESIGN_CONTEXT_MARKER) {
        return; // already injected
    }
    let _ = std::fs::write(wt_local, format!("{}\n{}", cur.trim_end(), block));
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn unique_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("bsc-wt-{tag}-{}-{nanos}", std::process::id()))
    }

    /// Stand up a real git repo so `seed_union_merge_gitattributes` (which gates on `.git`) runs.
    fn init_repo(dir: &std::path::Path) {
        fs::create_dir_all(dir).unwrap();
        let mut c = std::process::Command::new("git");
        c.args(["-C", &dir.to_string_lossy(), "init", "-q", "-b", "main"]);
        assert!(no_window(&mut c).status().unwrap().success());
    }

    /// Run a git subcommand in `dir`, asserting success.
    fn git_in(dir: &std::path::Path, args: &[&str]) {
        let mut c = std::process::Command::new("git");
        c.args(["-C", &dir.to_string_lossy()]).args(args);
        assert!(no_window(&mut c).status().unwrap().success(), "git {args:?} failed");
    }

    /// A repo with one commit, so branches and worktrees can be created.
    fn init_repo_with_commit(dir: &std::path::Path) {
        init_repo(dir);
        git_in(dir, &["config", "user.email", "t@t.t"]);
        git_in(dir, &["config", "user.name", "t"]);
        fs::write(dir.join("README.md"), "x").unwrap();
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-q", "-m", "init"]);
    }

    /// #1568: a worktree dir removed *outside* `git worktree remove` leaves a dangling record that
    /// still claims the branch, so a plain reuse-add fails (`'<branch>' is already used by worktree
    /// at '<gone>'`). `add_worktree_healing` prunes that stale record and retries, so the launch
    /// recovers instead of erroring.
    #[test]
    fn add_worktree_heals_a_dangling_record() {
        let base = unique_dir("heal");
        let clone = base.join("clone");
        init_repo_with_commit(&clone);
        // Create branch `feat` + a worktree on it, then delete the dir without telling git.
        let gone = base.join("gone");
        git_in(&clone, &["worktree", "add", "-b", "feat", &gone.to_string_lossy()]);
        fs::remove_dir_all(&gone).unwrap();
        // Sanity: a plain reuse-add to a NEW path is blocked by the dangling record.
        let mut plain = std::process::Command::new("git");
        plain.args(["-C", &clone.to_string_lossy(), "worktree", "add", &base.join("fresh").to_string_lossy(), "feat"]);
        assert!(!no_window(&mut plain).output().unwrap().status.success(), "dangling record should block a plain add");
        // The healing helper prunes the stale record and succeeds (probes `feat`, reuses it).
        let target = base.join("target");
        add_worktree_healing(&clone.to_string_lossy(), &target.to_string_lossy(), "feat").unwrap();
        assert!(target.join(".git").exists(), "worktree created after self-heal");
        let _ = fs::remove_dir_all(&base);
    }

    /// #1570: a failed `worktree add -b <branch>` CREATES the branch before it fails on the path, so
    /// a blind retry of the same `-b` would hit "a branch named '<x>' already exists". The helper
    /// re-probes after pruning and switches to the reuse form. Reproduces the STEM `ui-modes` launch.
    #[test]
    fn add_worktree_reprobes_after_a_failed_create() {
        let base = unique_dir("reprobe");
        let clone = base.join("clone");
        init_repo_with_commit(&clone);
        // Occupy the TARGET path with a dangling record (a worktree on a different branch, dir
        // removed without prune). The target branch `ui-modes` does not exist yet.
        let target = base.join("wt");
        git_in(&clone, &["worktree", "add", "-b", "decoy", &target.to_string_lossy()]);
        fs::remove_dir_all(&target).unwrap();
        // First `-b ui-modes <target>` fails on the dangling path but creates the branch; prune
        // clears the record; re-probe finds ui-modes; the reuse form succeeds.
        add_worktree_healing(&clone.to_string_lossy(), &target.to_string_lossy(), "ui-modes").unwrap();
        assert!(target.join(".git").exists(), "worktree created after re-probe + reuse");
        let mut head = std::process::Command::new("git");
        head.args(["-C", &target.to_string_lossy(), "rev-parse", "--abbrev-ref", "HEAD"]);
        let branch = String::from_utf8_lossy(&no_window(&mut head).output().unwrap().stdout).trim().to_string();
        assert_eq!(branch, "ui-modes", "reused the branch the failed -b created");
        let _ = fs::remove_dir_all(&base);
    }

    /// #1568: a genuine failure surfaces git's actual stderr (not a bare "failed"), so a launch
    /// failure is debuggable from the message alone.
    #[test]
    fn add_worktree_surfaces_git_stderr() {
        let base = unique_dir("stderr");
        // A clone path that is not a git repo → every git call errors; the message must reach the
        // caller (and the prune+retry can't paper over it).
        let bogus = base.join("not-a-repo");
        fs::create_dir_all(&bogus).unwrap();
        let err = add_worktree_healing(&bogus.to_string_lossy(), &base.join("wt").to_string_lossy(), "x")
            .unwrap_err();
        assert!(err.starts_with("git worktree add failed:"), "carries the helper prefix: {err}");
        assert!(err.trim_end().len() > "git worktree add failed:".len(), "carries git's actual stderr: {err}");
        let _ = fs::remove_dir_all(&base);
    }

    /// #851: seeds `.gitignore`/`.env.example` with merge=union so concurrent appends auto-resolve.
    #[test]
    fn seeds_union_merge_for_the_additive_commons() {
        let dir = unique_dir("seed");
        init_repo(&dir);
        seed_union_merge_gitattributes(&dir);
        let attrs = fs::read_to_string(dir.join(".gitattributes")).unwrap();
        for f in UNION_MERGE_COMMONS {
            assert!(attrs.contains(&format!("{f} merge=union")), "missing union line for {f}: {attrs}");
        }
        // Only the additive subset — NOT the structured manifests (a blind union breaks JSON/TOML).
        assert!(!attrs.contains("package.json merge=union"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// #1373: the dropped-design block lists the screens + points at design/ & .ui-skeleton/.
    #[test]
    fn design_context_block_lists_screens_or_returns_none() {
        assert!(design_context_block(&[]).is_none(), "no dropped design ⇒ no block");
        let block = design_context_block(&["Login.jsx".into(), "components/Button.tsx".into()]).unwrap();
        assert!(block.contains(DESIGN_CONTEXT_MARKER));
        assert!(block.contains("Login.jsx") && block.contains("components/Button.tsx"));
        assert!(block.contains(".ui-skeleton"));
    }

    /// #1373: inject reads the hub's .ui-skeleton/ for screen names and appends the block once.
    #[test]
    fn inject_design_context_appends_once_from_the_skeleton() {
        let dir = unique_dir("design-ctx");
        let hub = dir.join("hub");
        fs::create_dir_all(hub.join(".ui-skeleton")).unwrap();
        fs::write(hub.join(".ui-skeleton").join("Login.jsx"), "export default () => null").unwrap();
        let wt_local = dir.join("CLAUDE.local.md");
        fs::write(&wt_local, "# worker scope\n").unwrap();

        inject_design_context(&hub, &wt_local);
        let after = fs::read_to_string(&wt_local).unwrap();
        assert!(after.contains(DESIGN_CONTEXT_MARKER) && after.contains("Login.jsx"));

        inject_design_context(&hub, &wt_local); // idempotent
        assert_eq!(fs::read_to_string(&wt_local).unwrap().matches(DESIGN_CONTEXT_MARKER).count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// #1373: no dropped design (empty/absent .ui-skeleton/) ⇒ no block, no churn.
    #[test]
    fn inject_design_context_is_a_noop_without_dropped_design() {
        let dir = unique_dir("no-design");
        let hub = dir.join("hub");
        fs::create_dir_all(&hub).unwrap();
        let wt_local = dir.join("CLAUDE.local.md");
        fs::write(&wt_local, "# worker scope\n").unwrap();
        inject_design_context(&hub, &wt_local);
        assert!(!fs::read_to_string(&wt_local).unwrap().contains(DESIGN_CONTEXT_MARKER));
        let _ = fs::remove_dir_all(&dir);
    }

    /// Idempotent + additive: re-running writes nothing new and preserves hand-authored attributes.
    #[test]
    fn seed_is_idempotent_and_preserves_existing_content() {
        let dir = unique_dir("idem");
        init_repo(&dir);
        fs::write(dir.join(".gitattributes"), "*.png binary\n").unwrap();
        seed_union_merge_gitattributes(&dir);
        let after_first = fs::read_to_string(dir.join(".gitattributes")).unwrap();
        seed_union_merge_gitattributes(&dir); // second run is a no-op
        let after_second = fs::read_to_string(dir.join(".gitattributes")).unwrap();
        assert_eq!(after_first, after_second, "second seed must be a no-op");
        assert!(after_second.contains("*.png binary"), "existing content preserved");
        assert!(after_second.contains(".gitignore merge=union"));
        // The marker appears exactly once.
        assert_eq!(after_second.matches("union-merge commons (#851)").count(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A non-repo directory is skipped (best-effort; nothing to seed without a `.git`).
    #[test]
    fn seed_skips_a_non_repo_dir() {
        let dir = unique_dir("norepo");
        fs::create_dir_all(&dir).unwrap();
        seed_union_merge_gitattributes(&dir);
        assert!(!dir.join(".gitattributes").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
