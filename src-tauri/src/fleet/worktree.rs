use crate::prelude::*;

/// The default integration branch when a project's plan declares no environment ladder (#3963).
pub(crate) const DEFAULT_INTEGRATION_BRANCH: &str = "develop";

/// The branch worker branches are cut from, derived from the plan's environment ladder (#3963).
///
/// `deploy.environments` is an ordered ladder — `[dev → feature/*, staging → develop, prod → main]`.
/// The integration branch is the last CONCRETE branch before the final (production) rung:
///
///   [feature/*, develop, main]  →  develop     (globs are patterns, not branches)
///   [develop, main]             →  develop
///   [main]                      →  None        (a single rung has nothing to integrate INTO)
///
/// Globs are skipped because `feature/*` names a pattern workers match, not a branch anything can be
/// cut from. Returns None when the ladder is missing or degenerate, and the caller falls back to
/// [`DEFAULT_INTEGRATION_BRANCH`] — a default is right here, since every documented flow in this repo
/// is `feature → develop → main` and a project that declares nothing still means that.
///
/// Pure (no db/fs) so the whole rule is unit-testable against a literal blob.
pub(crate) fn integration_branch_from_deploy(deploy: &serde_json::Value) -> Option<String> {
    let envs = deploy.get("environments")?.as_array()?;
    let concrete: Vec<&str> = envs
        .iter()
        .filter_map(|e| e.get("branch").and_then(|b| b.as_str()))
        .map(str::trim)
        .filter(|b| !b.is_empty() && !b.contains('*'))
        .collect();
    // The last rung is production; the one before it is where work integrates.
    (concrete.len() >= 2).then(|| concrete[concrete.len() - 2].to_string())
}

/// The integration branch for `project_key`, from its plan (falling back to the default).
fn integration_branch(project_key: &str) -> String {
    crate::project::plan_db::deploy_for(project_key)
        .as_ref()
        .and_then(integration_branch_from_deploy)
        .unwrap_or_else(|| DEFAULT_INTEGRATION_BRANCH.to_string())
}

/// Ensure `branch` exists in `clone`, creating it at the clone's HEAD when absent (#3963).
///
/// Nothing in the pipeline created the integration branch: publish doesn't, the repo clone doesn't,
/// `setup_workspaces` doesn't — and the director protocol merely ASSUMES it ("merge it into develop",
/// "watch develop's CI"). So a fresh project had none, and every worker branch was cut from `main`,
/// collapsing the `feature → develop → main` flow the plan defines into a single tier.
///
/// Idempotent and non-destructive: a repo that already has the branch is left exactly as it is —
/// this never moves, resets, or checks it out. Returns whether the branch is usable as a base.
fn ensure_integration_branch(clone_str: &str, branch: &str) -> bool {
    let exists = |r: &str| git_ok(clone_str, &["rev-parse", "--verify", "--quiet", r]);
    if exists(&format!("refs/heads/{branch}")) {
        return true;
    }
    // Prefer the remote's copy when the branch exists upstream but was never fetched locally, so a
    // second machine doesn't fork a divergent `develop` from its own HEAD.
    let remote = format!("refs/remotes/origin/{branch}");
    let created = if exists(&remote) {
        git_ok(clone_str, &["branch", branch, &format!("origin/{branch}")])
    } else {
        git_ok(clone_str, &["branch", branch, "HEAD"])
    };
    if created {
        log::info!("ensure_worktree: created integration branch `{branch}` in {clone_str}");
    } else {
        log::warn!("ensure_worktree: could not create integration branch `{branch}` in {clone_str} — worker branches will be cut from HEAD");
    }
    created
}


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
    let wt    = worktrees_dir(&project_key).join(worktree_dir_name(&repo, &agent_id));
    let wt_str = wt.to_string_lossy().into_owned();
    // #3963: guarantee the integration branch BEFORE any worktree exists, and cut worker branches from
    // it. Ordering is the whole point — workers get their worktrees at fleet launch, concurrently with
    // the director starting, so a branch created later cannot retroactively rebase 38 workers that are
    // already sitting on `main`. Doing it here (rather than in the director's prose) makes it a code
    // guarantee that runs exactly once per worktree creation, whoever triggers it.
    let clone_str_pre = clone.to_string_lossy().into_owned();
    let integration = integration_branch(&project_key);
    let base = ensure_integration_branch(&clone_str_pre, &integration).then_some(integration);
    // A worktree's `.git` is a FILE pointing into the main repo; create it only if
    // it isn't there yet (reuse across re-runs).
    if !wt.join(".git").exists() {
        if let Some(parent) = wt.parent() {
            std::fs::create_dir_all(parent).str_err()?;
        }
        let clone_str = clone.to_string_lossy().into_owned();
        add_worktree_healing(&clone_str, &wt_str, &slug, base.as_deref())
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
    write_worker_context(&wt, &clone, &project_dir(&project_key), scope_md.as_deref(), &slug);
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
fn add_worktree_healing(clone_str: &str, wt_str: &str, slug: &str, base: Option<&str>) -> Result<(), String> {
    let branch_ref = format!("refs/heads/{slug}");
    let branch_exists = || git_ok(clone_str, &["rev-parse", "--verify", "--quiet", &branch_ref]);
    let run_add = |reuse: bool| -> std::io::Result<std::process::Output> {
        let mut c = std::process::Command::new("git");
        c.args(["-C", clone_str, "worktree", "add"]);
        if reuse {
            c.args([wt_str, slug]); // attach the existing branch
        } else {
            // Cut from the INTEGRATION branch, not HEAD (#3963). HEAD is `main`, so every worker
            // used to branch from production — which is why all 39 network-monitor branches sat on
            // one commit and every PR would have targeted the wrong base.
            match base {
                Some(b) => c.args(["-b", slug, wt_str, b]),
                None => c.args(["-b", slug, wt_str]),
            };
        }
        run_output(&mut c)
    };

    let mut out = run_add(branch_exists()).str_err()?;
    if !out.status.success() {
        let _ = git_ok(clone_str, &["worktree", "prune"]);
        // Re-probe: the first attempt may itself have created the branch, so the correct form can
        // have flipped from create to reuse.
        out = run_add(branch_exists()).str_err()?;
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
    let mut block = String::new();
    block.push_str(GITATTR_MARKER_START);
    block.push('\n');
    for f in UNION_MERGE_COMMONS {
        block.push_str(&format!("{f} merge=union\n"));
    }
    block.push_str(GITATTR_MARKER_END);
    block.push('\n');
    // Idempotent additive append via the shared helper: any hand-authored attributes are kept, the
    // block is joined after a single newline (existing content is normalized to one trailing newline).
    let _ = append_block_once(&path, |cur| cur.contains(GITATTR_MARKER_START), "\n", &block);
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
    // The worktree BRANCH = the stream id = the feature slug (#4082) — the key the required-algorithm
    // lookup uses. Empty for a caller with no stream (nothing is injected).
    stream: &str,
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
        md.push_str(&fleet_protocol_md());
    }
    // Injection-resistance preamble (#1167): untrusted-input rules as authoritative worker context.
    if !md.contains(INJECTION_RESISTANCE_MARKER) {
        md.push_str(&injection_resistance_md());
    }
    let wt_local = wt.join("CLAUDE.local.md");
    let _ = std::fs::write(&wt_local, &md);
    // #3965: exclude AT THE PLANT SITE. `clone_repo` already excludes this path, but that is a
    // single write at clone time with nothing re-applying it — on a live clone two of its three
    // entries were simply absent, so every worker in that repo quarantined on launch for
    // "edited out-of-lane CLAUDE.local.md". This is #1102 (`.mcp.json`) a second time: the app
    // plants an untracked file, `read_worktree_changes` counts untracked files as the worker's
    // work, and the file sits outside every stream's owned globs. Repos that gitignore the path
    // themselves masked it; nothing else did. Excluding here — beside the write, on a path that
    // is rewritten every launch — keeps the two from drifting and self-heals existing clones.
    git_exclude(wt, "CLAUDE.local.md");
    // Inline the blueprint's attached skills (#636) so each worker carries the same skill
    // context the planner had. skills.md lives at the hub (not in the worktree), so the
    // planner's "read skills.md" note doesn't help a worker — inline it instead.
    inject_skills(hub, &wt_local);
    // Point UI workers at the user's dropped Claude Design (#1373) — the agent self-selects relevance.
    inject_design_context(hub, &wt_local);
    // Inline the reference implementations this feature declared it requires (#4082/#4080), so the
    // worker reuses the library instead of re-deriving the same algorithm. Last, so it reads after the
    // scope + protocol context rather than displacing them.
    if !stream.trim().is_empty() {
        inject_required_algorithms(hub, &wt_local, stream.trim());
    }
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
    let screens: Vec<String> = crate::project::ui_skeleton::read_skeleton_dir(&hub.join(".ui-skeleton"))
        .into_iter()
        .map(|(rel, _)| rel)
        .collect();
    let Some(block) = design_context_block(&screens) else { return };
    // `block` already opens with its own leading newline; the shared helper trims the existing
    // content and joins with a single "\n", reproducing the prior `format!("{}\n{}", trim_end, block)`.
    let _ = append_block_once(wt_local, |cur| cur.contains(DESIGN_CONTEXT_MARKER), "\n", &block);
}
/// Inline the hub's attached skills (`skills.md`, #636) into a worker's CLAUDE.local.md
/// so the worker auto-loads the same skill context the planner had. Idempotent; a no-op
/// when there are no attached skills (skills.md absent/empty).
/// Marker for the required-algorithms section, keeping [`inject_required_algorithms`] idempotent.
const ALGO_REFS_MARKER: &str = "## Reference implementations (required by this feature)";

/// One resolved entry for the block: the id, plus the impl fields when the library actually has it.
/// A `None` impl is a DANGLING id — surfaced, never silently dropped (#4080 deliberately does not
/// validate ids at plan-write time, so this is the first place a typo becomes visible).
pub(crate) struct AlgoRef {
    pub id: String,
    pub name: Option<String>,
    pub tech: Option<String>,
    pub summary: Option<String>,
    pub code: Option<String>,
}

/// Render the worker's reference-implementation block (#4082). Pure — resolved refs → markdown — so the
/// prose is testable without a store, a graph, or a worktree.
///
/// The worker CANNOT reach the library itself: the `worker` role's restricted surface has no
/// `bsc graph`. Inlining is what makes the reference reachable at all — the same reasoning that put
/// skills inline rather than leaving a "read skills.md" note a worker cannot follow (#636).
///
/// `None` for an empty list: most features require nothing, and an empty heading is noise.
pub(crate) fn algo_refs_block(refs: &[AlgoRef]) -> Option<String> {
    if refs.is_empty() {
        return None;
    }
    let mut md = String::from(ALGO_REFS_MARKER);
    md.push_str(
        "\n\nThe plan says this feature needs the implementations below. They are the REFERENCE — use \
         them rather than writing your own version of the same thing. Adapt names/types to fit this \
         codebase, but do not re-derive the algorithm. If one genuinely does not fit the problem, say so \
         and implement what does — a forced fit is worse than an honest re-implementation.\n",
    );
    for r in refs {
        match (&r.name, &r.code) {
            // Resolved WITH code — the useful case.
            (Some(name), Some(code)) if !code.trim().is_empty() => {
                md.push_str(&format!("\n### {name} (`{}`)\n", r.id));
                if let Some(s) = r.summary.as_deref().filter(|s| !s.trim().is_empty()) {
                    md.push_str(&format!("{}\n", s.trim()));
                }
                let lang = r.tech.as_deref().unwrap_or("");
                md.push_str(&format!("\n```{lang}\n{}\n```\n", code.trim_end()));
            }
            // In the library but carrying no code (a primitive is DESCRIBED via `--ref`, not re-coded).
            (Some(name), _) => {
                md.push_str(&format!("\n### {name} (`{}`)\n", r.id));
                let s = r.summary.as_deref().unwrap_or("no summary recorded").trim();
                md.push_str(&format!("{s}\n_No stored code — this is a language primitive; use the platform's own._\n"));
            }
            // Not in the library at all.
            (None, _) => {
                md.push_str(&format!(
                    "\n### `{}` — NOT FOUND in the algorithms library\n\
                     The plan requires this id but nothing matches it. Implement the capability yourself \
                     and mention the unresolved reference in your checkpoint, so the plan can be corrected.\n",
                    r.id,
                ));
            }
        }
    }
    Some(md)
}

/// Resolve a stream's required algorithms and inline them into its `CLAUDE.local.md` (#4082).
///
/// A feature IS a stream (`stream` defaults to the feature slug) and the worktree BRANCH is the stream
/// id, so the branch slug is the lookup key. Both stores are read IN-PROCESS — `plandb` and `bsc-graph`
/// are linked deps of this crate (the latter since #4078, precisely so a reader need not spawn a
/// subprocess).
///
/// Best-effort at every step, like the injections around it: an unreachable plan.db, an unreadable
/// graph, or a stream with no matching feature adds nothing and never aborts a launch.
pub(crate) fn inject_required_algorithms(hub: &std::path::Path, wt_local: &std::path::Path, stream: &str) {
    let Ok(store) = plandb::Store::open(&hub.join("plan.db")) else { return };
    let Ok(Some(feature)) = store.feature_get(stream) else { return };
    if feature.requires.is_empty() {
        return;
    }
    let graph = bsc_graph::load();
    let impls = bsc_graph::implementations_of(&graph);
    let field = |v: &serde_json::Value, k: &str| {
        v.get(k).and_then(serde_json::Value::as_str).map(str::to_string).filter(|s| !s.trim().is_empty())
    };
    let refs: Vec<AlgoRef> = feature
        .requires
        .iter()
        .map(|id| {
            let found = impls.iter().find(|im| im.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str()));
            match found {
                Some(im) => AlgoRef {
                    id: id.clone(),
                    name: field(im, "name").or_else(|| Some(id.clone())),
                    tech: field(im, "tech"),
                    summary: field(im, "summary"),
                    code: field(im, "code"),
                },
                None => AlgoRef { id: id.clone(), name: None, tech: None, summary: None, code: None },
            }
        })
        .collect();
    let Some(block) = algo_refs_block(&refs) else { return };
    let _ = append_block_once(wt_local, |cur| cur.contains(ALGO_REFS_MARKER), "\n\n", &format!("{block}\n"));
}

pub(crate) fn inject_skills(hub: &std::path::Path, wt_local: &std::path::Path) {
    let skills = std::fs::read_to_string(hub.join("skills.md")).unwrap_or_default();
    let trimmed = skills.trim();
    if trimmed.is_empty() {
        return;
    }
    // Blank line between the plan and the inlined skills; the block carries its own trailing newline.
    // Reproduces the prior `format!("{}\n\n{}\n", cur.trim_end(), trimmed)`.
    let _ = append_block_once(
        wt_local,
        |cur| cur.contains("# Attached skills & knowledge"),
        "\n\n",
        &format!("{trimmed}\n"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::unique_dir;
    use std::fs;

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
        let base = unique_dir("bsc-wt", "heal");
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
        add_worktree_healing(&clone.to_string_lossy(), &target.to_string_lossy(), "feat", None).unwrap();
        assert!(target.join(".git").exists(), "worktree created after self-heal");
        let _ = fs::remove_dir_all(&base);
    }

    /// #1570: a failed `worktree add -b <branch>` CREATES the branch before it fails on the path, so
    /// a blind retry of the same `-b` would hit "a branch named '<x>' already exists". The helper
    /// re-probes after pruning and switches to the reuse form. Reproduces the STEM `ui-modes` launch.
    #[test]
    fn add_worktree_reprobes_after_a_failed_create() {
        let base = unique_dir("bsc-wt", "reprobe");
        let clone = base.join("clone");
        init_repo_with_commit(&clone);
        // Occupy the TARGET path with a dangling record (a worktree on a different branch, dir
        // removed without prune). The target branch `ui-modes` does not exist yet.
        let target = base.join("wt");
        git_in(&clone, &["worktree", "add", "-b", "decoy", &target.to_string_lossy()]);
        fs::remove_dir_all(&target).unwrap();
        // First `-b ui-modes <target>` fails on the dangling path but creates the branch; prune
        // clears the record; re-probe finds ui-modes; the reuse form succeeds.
        add_worktree_healing(&clone.to_string_lossy(), &target.to_string_lossy(), "ui-modes", None).unwrap();
        assert!(target.join(".git").exists(), "worktree created after re-probe + reuse");
        let mut head = std::process::Command::new("git");
        head.args(["-C", &target.to_string_lossy(), "rev-parse", "--abbrev-ref", "HEAD"]);
        let branch = String::from_utf8_lossy(&no_window(&mut head).output().unwrap().stdout).trim().to_string();
        assert_eq!(branch, "ui-modes", "reused the branch the failed -b created");
        let _ = fs::remove_dir_all(&base);
    }

    /// Stress/reliability (#worktree-disk): the fleet launches N workers at once, so N
    /// `add_worktree_healing` calls race on ONE clone — git's worktree admin is the weakest spot
    /// (it locks `.git/worktrees`). All adds must still succeed (the prune+retry heals contention),
    /// each worktree is then removed, and the clone is left with NO dangling records or leaked dirs.
    #[test]
    fn concurrent_worktree_adds_and_removes_are_reliable() {
        use std::sync::{Arc, Barrier};
        let base = unique_dir("bsc-wt", "stress");
        let clone = base.join("clone");
        init_repo_with_commit(&clone);
        let clone_str = clone.to_string_lossy().into_owned();
        const N: usize = 6;
        let barrier = Arc::new(Barrier::new(N));
        let mut handles = Vec::new();
        for i in 0..N {
            let clone_str = clone_str.clone();
            let base = base.clone();
            let clone_pb = clone.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                let slug = format!("stream-{i}");
                let wt = base.join(format!("wt-{i}"));
                let wt_str = wt.to_string_lossy().into_owned();
                barrier.wait(); // release all threads into `git worktree add` simultaneously
                add_worktree_healing(&clone_str, &wt_str, &slug, None).expect("add under contention");
                assert!(wt.join(".git").exists(), "worktree {i} created");
                std::fs::write(wt.join("work.txt"), "x").unwrap();
                crate::fleet::teardown::remove_worktree_at(&clone_pb, &wt).expect("remove");
                assert!(!wt.exists(), "worktree {i} removed");
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        // Only the main clone remains registered — no dangling worktree records.
        let mut list = std::process::Command::new("git");
        list.args(["-C", &clone_str, "worktree", "list"]);
        let out = no_window(&mut list).output().unwrap();
        let lines = String::from_utf8_lossy(&out.stdout).lines().count();
        assert_eq!(lines, 1, "only the clone remains; no leaked worktree records");
        let _ = fs::remove_dir_all(&base);
    }

    /// #1568: a genuine failure surfaces git's actual stderr (not a bare "failed"), so a launch
    /// failure is debuggable from the message alone.
    #[test]
    fn add_worktree_surfaces_git_stderr() {
        let base = unique_dir("bsc-wt", "stderr");
        // A clone path that is not a git repo → every git call errors; the message must reach the
        // caller (and the prune+retry can't paper over it).
        let bogus = base.join("not-a-repo");
        fs::create_dir_all(&bogus).unwrap();
        let err = add_worktree_healing(&bogus.to_string_lossy(), &base.join("wt").to_string_lossy(), "x", None)
            .unwrap_err();
        assert!(err.starts_with("git worktree add failed:"), "carries the helper prefix: {err}");
        assert!(err.trim_end().len() > "git worktree add failed:".len(), "carries git's actual stderr: {err}");
        let _ = fs::remove_dir_all(&base);
    }

    /// #851: seeds `.gitignore`/`.env.example` with merge=union so concurrent appends auto-resolve.
    #[test]
    fn seeds_union_merge_for_the_additive_commons() {
        let dir = unique_dir("bsc-wt", "seed");
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
        let dir = unique_dir("bsc-wt", "design-ctx");
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
        let dir = unique_dir("bsc-wt", "no-design");
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
        let dir = unique_dir("bsc-wt", "idem");
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
        let dir = unique_dir("bsc-wt", "norepo");
        fs::create_dir_all(&dir).unwrap();
        seed_union_merge_gitattributes(&dir);
        assert!(!dir.join(".gitattributes").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    // ── #3963: the integration branch ───────────────────────────────────────────────────────────
    //
    // Nothing in the pipeline created it — publish doesn't, the clone doesn't, setup_workspaces
    // doesn't — and the director protocol merely ASSUMES it ("merge it into develop"). So a fresh
    // project had none and every worker branch was cut from `main`, collapsing feature → develop →
    // main into a single tier. Both live plans DO declare the ladder; nothing read it.

    fn deploy(envs: &[(&str, &str)]) -> serde_json::Value {
        serde_json::json!({
            "environments": envs.iter().map(|(n, b)| serde_json::json!({"name": n, "branch": b})).collect::<Vec<_>>()
        })
    }

    #[test]
    fn the_ladders_last_concrete_rung_before_prod_is_the_integration_branch() {
        // network-monitor's real ladder — the glob is a PATTERN workers match, not a branch.
        let nm = deploy(&[("dev", "feature/*"), ("staging", "develop"), ("prod", "main")]);
        assert_eq!(integration_branch_from_deploy(&nm).as_deref(), Some("develop"));
        // cli-typer's real ladder — two rungs, no glob.
        let ct = deploy(&[("dev", "develop"), ("release", "main")]);
        assert_eq!(integration_branch_from_deploy(&ct).as_deref(), Some("develop"));
    }

    #[test]
    fn a_non_develop_ladder_is_honoured_rather_than_hardcoded() {
        // The whole point of reading the plan: the name is the project's to choose.
        let d = deploy(&[("dev", "feature/*"), ("qa", "integration"), ("prod", "release")]);
        assert_eq!(integration_branch_from_deploy(&d).as_deref(), Some("integration"));
    }

    #[test]
    fn a_degenerate_ladder_yields_none_so_the_caller_falls_back() {
        // One rung has nothing to integrate INTO; all-globs has no branch at all.
        assert_eq!(integration_branch_from_deploy(&deploy(&[("prod", "main")])), None);
        assert_eq!(integration_branch_from_deploy(&deploy(&[("dev", "feature/*")])), None);
        assert_eq!(integration_branch_from_deploy(&serde_json::json!({})), None);
        assert_eq!(integration_branch_from_deploy(&deploy(&[])), None);
    }

    #[test]
    fn blank_branches_are_skipped_not_treated_as_a_rung() {
        let d = deploy(&[("dev", "  "), ("staging", "develop"), ("prod", "main")]);
        assert_eq!(integration_branch_from_deploy(&d).as_deref(), Some("develop"));
    }

    #[test]
    fn the_integration_branch_is_created_once_and_never_disturbed() {
        let base = unique_dir("bsc-wt", "integ");
        let clone = base.join("web");
        init_repo_with_commit(&clone);
        let cs = clone.to_string_lossy().into_owned();
        let head_before = crate::git_run(&cs, &["rev-parse", "HEAD"]).unwrap();

        assert!(ensure_integration_branch(&cs, "develop"), "created when absent");
        assert!(crate::git_ok(&cs, &["rev-parse", "--verify", "--quiet", "refs/heads/develop"]));

        // Advance develop, then re-run: an existing branch must never be moved or reset.
        crate::git_ok(&cs, &["branch", "-f", "develop", "HEAD"]);
        let develop_sha = crate::git_run(&cs, &["rev-parse", "develop"]).unwrap();
        assert!(ensure_integration_branch(&cs, "develop"), "idempotent when present");
        assert_eq!(crate::git_run(&cs, &["rev-parse", "develop"]).unwrap(), develop_sha, "not moved");
        // And it never checks anything out — HEAD is where it was.
        assert_eq!(crate::git_run(&cs, &["rev-parse", "HEAD"]).unwrap(), head_before);
    }

    #[test]
    fn a_worker_branch_is_cut_from_the_integration_branch_not_head() {
        // The defect this fixes: `-b <slug> <wt>` created the branch at HEAD (= main), so every
        // worker built on production and every PR would have targeted the wrong base.
        let base = unique_dir("bsc-wt", "cutfrom");
        let clone = base.join("web");
        init_repo_with_commit(&clone);
        let cs = clone.to_string_lossy().into_owned();
        assert!(ensure_integration_branch(&cs, "develop"));
        // Move main FORWARD so main != develop and the base is observable.
        std::fs::write(clone.join("only-on-main.txt"), "x").unwrap();
        crate::git_ok(&cs, &["add", "."]);
        crate::git_ok(&cs, &["commit", "-q", "-m", "main moves on"]);

        let wt = base.join("wt");
        add_worktree_healing(&cs, &wt.to_string_lossy(), "feat", Some("develop")).unwrap();
        // The worker branch must descend from develop, and must NOT carry main's extra commit.
        assert!(crate::git_ok(&cs, &["merge-base", "--is-ancestor", "develop", "feat"]), "cut from develop");
        assert!(!wt.join("only-on-main.txt").exists(), "does not contain main-only work");
    }
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    /// Regression (#1102): in a linked worktree `.git` is a FILE, so the old
    /// `repo_root/.git/info/exclude` write silently failed and `.mcp.json` leaked into the worker's
    /// diff — quarantining every fleet worker for an "out-of-lane" edit it never made. git_exclude
    /// must resolve the real (common-dir) exclude so the app-managed file is hidden from git, and
    /// thus from read_worktree_changes (the warden's trusted signal).
    #[test]
    fn git_exclude_hides_mcp_json_in_a_worktree() {
        // Needs the git binary; skip gracefully where it's absent rather than failing the suite.
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let base = std::env::temp_dir().join(format!("bsc-gx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| {
            std::process::Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap()
        };
        git(&main, &["init", "-q"]);
        git(&main, &["config", "user.email", "t@t.t"]);
        git(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("README.md"), "x").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-qm", "init"]);

        // A linked worktree: its `.git` is a FILE, the layout that broke the old exclude.
        let wt = base.join("wt");
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);
        assert!(wt.join(".git").is_file(), "worktree .git should be a file, not a dir");

        // App writes the session's MCP config + asks git to exclude it (mirrors the launch path).
        std::fs::write(wt.join(".mcp.json"), "{}").unwrap();
        git_exclude(&wt, ".mcp.json");

        // The warden's signal must NOT see it — pre-fix this listed ".mcp.json" and tripped a trip.
        let changes = read_worktree_changes(wt.to_string_lossy().into_owned());
        assert!(
            !changes.iter().any(|f| f == ".mcp.json"),
            "worktree .mcp.json must be git-excluded, but read_worktree_changes returned {changes:?}",
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Regression (#3965): #1102 was fixed for `.mcp.json` ONLY, and this test asserted only that
    /// one path — so when `CLAUDE.local.md` hit the identical failure it sailed through green. The
    /// app plants several untracked files in a worker's worktree; `read_worktree_changes` counts
    /// untracked files as the worker's own work, and they sit outside every stream's owned globs,
    /// so ANY of them that git can still see quarantines the worker for an edit it never made.
    /// Live blast radius when `CLAUDE.local.md` was the one that leaked: 19 of 19 workers in the
    /// affected repo, within the same second. Assert the whole planted set, not one member.
    #[test]
    fn launch_path_git_excludes_the_claude_local_it_plants() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let base = std::env::temp_dir().join(format!("bsc-gx-all-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let main = base.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| {
            std::process::Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap()
        };
        git(&main, &["init", "-q"]);
        git(&main, &["config", "user.email", "t@t.t"]);
        git(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("README.md"), "x").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-qm", "init"]);

        let wt = base.join("wt");
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap()]);

        // Drive the REAL launch path, not a hand-rolled write + exclude. The #1102 test above calls
        // `git_exclude` itself, so it only ever proved that `git_exclude` works — it could not
        // notice that the production path never called it for this file. Going through
        // `write_worker_context` is what makes this a regression test rather than a restatement.
        let hub = base.join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        write_worker_context(&wt, &main, &hub, Some("owns: src/**"), "");
        assert!(wt.join("CLAUDE.local.md").exists(), "launch path should have planted the file");

        // The warden's trusted signal must not attribute the app's own file to the worker. Without
        // the exclude at the plant site this lists "CLAUDE.local.md", it falls outside every stream's
        // owned globs, and `checkConformance` trips `out-of-glob` → the pane is hard-paused.
        let changes = read_worktree_changes(wt.to_string_lossy().into_owned());
        assert!(
            !changes.iter().any(|f| f == "CLAUDE.local.md"),
            "app-planted CLAUDE.local.md must be git-excluded by the launch path — it quarantined \
             19 of 19 workers when it was not — but read_worktree_changes returned {changes:?}",
        );

        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn inject_skills_inlines_hub_skills_idempotently() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("injectskills");
        let hub = home.join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        let wt_local = home.join("CLAUDE.local.md");
        std::fs::write(&wt_local, "# repo plan\n").unwrap();

        // No skills.md ⇒ no-op.
        inject_skills(&hub, &wt_local);
        assert_eq!(std::fs::read_to_string(&wt_local).unwrap(), "# repo plan\n");

        // With skills.md ⇒ inlined under its heading.
        std::fs::write(hub.join("skills.md"), "# Attached skills & knowledge\n\n### Auth\nUse OAuth.\n").unwrap();
        inject_skills(&hub, &wt_local);
        let after = std::fs::read_to_string(&wt_local).unwrap();
        assert!(after.contains("# repo plan"), "keeps the plan");
        assert!(after.contains("Use OAuth."), "inlines the skills");

        // Second call ⇒ idempotent (not appended twice).
        inject_skills(&hub, &wt_local);
        assert_eq!(after, std::fs::read_to_string(&wt_local).unwrap());

        std::fs::remove_dir_all(&home).ok();
    }
    #[test]
    fn worker_context_appends_injection_resistance_idempotently() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("injresist");
        let wt = home.join("wt");
        let clone = home.join("clone");
        let hub = home.join("hub");
        for d in [&wt, &clone, &hub] { std::fs::create_dir_all(d).unwrap(); }

        write_worker_context(&wt, &clone, &hub, Some("# scope: owns src/api/**"), "");
        let md = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();
        assert!(md.contains("# scope: owns src/api/**"), "keeps the worker scope");
        assert!(md.contains(INJECTION_RESISTANCE_MARKER), "appends the injection-resistance preamble");
        assert!(md.contains("untrusted data"), "carries the untrusted-input rule");

        // Re-running converges (the preamble isn't appended twice).
        write_worker_context(&wt, &clone, &hub, Some("# scope: owns src/api/**"), "");
        let again = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();
        assert_eq!(again.matches(INJECTION_RESISTANCE_MARKER).count(), 1, "preamble appears once");

        std::fs::remove_dir_all(&home).ok();
    }
    #[test]
    fn write_worker_context_leads_with_scope_then_repo_ctx_protocol_skills() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("workerctx");
        let wt = home.join("wt");
        let clone = home.join("clone");
        let hub = home.join("hub");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::create_dir_all(&clone).unwrap();
        std::fs::create_dir_all(&hub).unwrap();
        // Per-repo app-managed context (untracked in the clone) + attached skills at the hub.
        std::fs::write(clone.join("CLAUDE.local.md"), "# repo notes\nUse the shared client.\n").unwrap();
        std::fs::write(hub.join("skills.md"), "# Attached skills & knowledge\n\n### Auth\nUse OAuth.\n").unwrap();

        let scope = "# Your scope\n\nYou own `src/auth/**`. Issues: #12, #13.";
        write_worker_context(&wt, &clone, &hub, Some(scope), "");
        let out = std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap();

        // Scope leads, then per-repo context, then protocol, then skills — in that order.
        let i_scope = out.find("You own `src/auth/**`").expect("scope present");
        let i_repo = out.find("Use the shared client").expect("repo ctx present");
        let i_proto = out.find("## Fleet coordination protocol").expect("protocol present");
        let i_skills = out.find("Use OAuth.").expect("skills inlined");
        assert!(i_scope < i_repo, "scope must lead the per-repo context");
        assert!(i_repo < i_proto, "per-repo context must precede the protocol");
        assert!(i_proto < i_skills, "protocol must precede the skills");
        // The full planner spec is NOT here — only the worker's scope.
        assert!(!out.contains("Project Planner"), "must not carry the planner spec");

        // Idempotent: a second launch converges to identical content (protocol/skills not doubled).
        write_worker_context(&wt, &clone, &hub, Some(scope), "");
        assert_eq!(out, std::fs::read_to_string(wt.join("CLAUDE.local.md")).unwrap());
        assert_eq!(out.matches("## Fleet coordination protocol").count(), 1);

        std::fs::remove_dir_all(&home).ok();
    }
}

#[cfg(test)]
mod algo_ref_tests {
    use super::*;
    use crate::testutil::{temp_home, ENV_LOCK};

    fn r(id: &str, name: Option<&str>, tech: Option<&str>, summary: Option<&str>, code: Option<&str>) -> AlgoRef {
        AlgoRef {
            id: id.into(),
            name: name.map(str::to_string),
            tech: tech.map(str::to_string),
            summary: summary.map(str::to_string),
            code: code.map(str::to_string),
        }
    }

    /// Most features require nothing — an empty heading would be pure noise in every worker's context.
    #[test]
    fn no_refs_yields_no_block() {
        assert!(algo_refs_block(&[]).is_none());
    }

    /// The useful case: the agent gets the actual code, fenced with the impl's tech so it highlights,
    /// plus an instruction to USE it rather than re-derive it — that instruction IS the feature.
    #[test]
    fn a_resolved_ref_carries_its_code_and_the_reuse_instruction() {
        let md = algo_refs_block(&[r(
            "merge.rs",
            Some("merge"),
            Some("rust"),
            Some("Interleave two sorted slices."),
            Some("pub fn merge<T: Ord>(a: &[T], b: &[T]) -> Vec<T> { todo!() }"),
        )])
        .expect("a block");
        assert!(md.contains("## Reference implementations (required by this feature)"));
        assert!(md.contains("### merge (`merge.rs`)"));
        assert!(md.contains("Interleave two sorted slices."), "the summary rides along");
        assert!(md.contains("```rust"), "fenced with the impl's tech so it highlights");
        assert!(md.contains("pub fn merge"), "THE CODE is what makes this worth doing");
        assert!(md.contains("use them rather than writing your own"), "the reuse instruction");
        // …and an escape hatch, so a bad match doesn't force a wrong implementation.
        assert!(md.contains("does not fit"), "a forced fit is worse than an honest re-implementation");
    }

    /// A PRIMITIVE is described, never re-coded (`--ref` to the std path), so it has no stored code.
    /// It should still appear — knowing the library considers it a primitive is the useful signal.
    #[test]
    fn a_ref_without_code_is_named_as_a_primitive_rather_than_dropped() {
        let md = algo_refs_block(&[r("rust.vec", Some("Vec"), Some("rust"), Some("The growable array."), None)])
            .expect("a block");
        assert!(md.contains("### Vec (`rust.vec`)"));
        assert!(md.contains("language primitive"), "says why there is no code");
        assert!(!md.contains("```"), "no empty code fence");
    }

    /// #4080 deliberately does not validate ids at plan-write time, so THIS is the first place a typo
    /// becomes visible. Silently dropping it would leave the worker believing the plan named nothing.
    #[test]
    fn a_dangling_id_is_reported_not_silently_dropped() {
        let md = algo_refs_block(&[r("no-such-algo", None, None, None, None)]).expect("a block");
        assert!(md.contains("`no-such-algo` — NOT FOUND"), "the id is named: {md}");
        assert!(md.contains("mention the unresolved reference"), "so the plan can be corrected");
    }

    #[test]
    fn a_mixed_set_renders_every_entry() {
        let md = algo_refs_block(&[
            r("merge.rs", Some("merge"), Some("rust"), None, Some("fn merge() {}")),
            r("rust.vec", Some("Vec"), Some("rust"), None, None),
            r("ghost", None, None, None, None),
        ])
        .expect("a block");
        for expect in ["### merge", "### Vec", "`ghost` — NOT FOUND"] {
            assert!(md.contains(expect), "missing {expect} in:\n{md}");
        }
    }

    /// `write_worker_context` is rewritten on every launch and must converge — a second pass must not
    /// append the section twice. Also pins the no-plan-db and empty-stream no-ops: every failure path
    /// here is best-effort and must never abort a launch.
    #[test]
    fn injection_is_idempotent_and_a_missing_store_is_a_no_op() {
        // temp_home repoints the process-global home, so it MUST hold the same lock the sibling
        // injection tests take — without it this races them and fails an unrelated test.
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("algorefs");
        let hub = home.join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        let wt_local = home.join("CLAUDE.local.md");
        std::fs::write(&wt_local, "# plan\n").unwrap();

        // No plan.db at the hub ⇒ silent no-op (never a panic, never an abort).
        inject_required_algorithms(&hub, &wt_local, "sorter");
        assert_eq!(std::fs::read_to_string(&wt_local).unwrap(), "# plan\n");

        // A real store whose feature declares one required algorithm.
        let store = plandb::Store::open(&hub.join("plan.db")).unwrap();
        store
            .feature_upsert(&plandb::PlanFeature {
                slug: "sorter".into(),
                name: "Sorter".into(),
                requires: vec!["definitely-not-a-real-impl-4082".into()],
                ..Default::default()
            })
            .unwrap();

        inject_required_algorithms(&hub, &wt_local, "sorter");
        let once = std::fs::read_to_string(&wt_local).unwrap();
        assert!(once.contains("# plan"), "keeps the existing context");
        assert!(once.contains(ALGO_REFS_MARKER), "the section is injected");

        inject_required_algorithms(&hub, &wt_local, "sorter");
        let twice = std::fs::read_to_string(&wt_local).unwrap();
        assert_eq!(once, twice, "a second launch converges — the section appears exactly once");

        // A stream with no matching feature adds nothing.
        let before = twice.clone();
        inject_required_algorithms(&hub, &wt_local, "no-such-stream");
        assert_eq!(std::fs::read_to_string(&wt_local).unwrap(), before);
    }

    /// A feature that requires NOTHING must add no section — the common case.
    #[test]
    fn a_feature_with_no_requires_adds_nothing() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("algorefsnone");
        let hub = home.join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        let wt_local = home.join("CLAUDE.local.md");
        std::fs::write(&wt_local, "# plan\n").unwrap();
        let store = plandb::Store::open(&hub.join("plan.db")).unwrap();
        store
            .feature_upsert(&plandb::PlanFeature { slug: "plain".into(), name: "Plain".into(), ..Default::default() })
            .unwrap();
        inject_required_algorithms(&hub, &wt_local, "plain");
        assert_eq!(std::fs::read_to_string(&wt_local).unwrap(), "# plan\n");
    }
}
