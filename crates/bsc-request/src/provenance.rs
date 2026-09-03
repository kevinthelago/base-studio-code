//! WHERE a request came from (`a-request-records-where-it-actually-came-from`) — the filing context
//! `bsc request new` stamps beside the ask itself.
//!
//! # One field could not answer "who filed this"
//!
//! `origin` used to hold either a resolvable PANE id (`studio-code:director`) or arbitrary free text
//! (`claude`, `lane-c4`, `princess-bubblegum (dev session)`), because `--from` and `$BSC_AUDIT_PANE`
//! both landed in it. MEASURED on the live queue: 8 of 9 claimed requests carried free text and one
//! carried a pane id, and the only way to tell them apart was looking for a `:` — which calls
//! `lane-c4` a pane and `princess-bubblegum (dev session)` an actor by accident of punctuation. The
//! two are now separate columns, so the STORE knows which it holds and no reader has to guess.
//!
//! # ABSENT IS A REAL STATE
//!
//! Every function here returns `None` for anything it cannot resolve, and nothing substitutes a
//! plausible default. A fabricated cwd or an invented repo reads exactly like a measured one and is
//! worse than a blank, because it is the shape a reader trusts. That is why the git discovery below
//! refuses to guess a repository for a `.git` file whose `gitdir:` it cannot make sense of, rather
//! than falling back to the working tree.
//!
//! # Pure over injected inputs
//!
//! The environment and the clock are process-global, so the capture rules are written as functions
//! over an injected lookup / an injected path. That is not ceremony: `$BSC_AUDIT_PANE` is exactly the
//! kind of global that parallel test threads cannot each own (the reason `AUDIT_PANE_ENV_LOCK` exists
//! in `cli.rs`), and a rule that can only be exercised by mutating the real process environment ends
//! up with no test at all.

use std::path::{Component, Path, PathBuf};

/// This binary's crate version — the `bsc` a request was filed by. Stamped on every new request so a
/// report about behaviour that has since changed can be read against the build that produced it.
pub const BSC_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Trim a candidate to `Some(non-empty)`, dropping the `?` the shell helpers write for an unknown pane
/// (`${BSC_AUDIT_PANE:-?}`). A row attributed to a session called "?" is worse than one that admits it
/// has no origin.
pub(crate) fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && s != "?")
}

/// The working tree a request was filed in. Each field is independently absent: a filing from a
/// directory that is not in a repository still records its `cwd`, and a linked worktree whose
/// `gitdir:` pointer is unreadable still records its `worktree`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TreeLocation {
    /// The absolute directory `bsc request new` ran in.
    pub cwd: Option<String>,
    /// The REPOSITORY — the main working tree, shared by every linked worktree cut from it.
    pub repo: Option<String>,
    /// The WORKING TREE the filer was in. Equals `repo` in the main checkout and differs in a linked
    /// worktree, which is the whole point: a `bsc ui` gap hit in `wt-131` and one hit at the root are
    /// different reports, and before this they were the same record.
    pub worktree: Option<String>,
    /// The checked-out branch. Absent on a detached HEAD — a raw sha is not a branch, and recording
    /// one in a column readers treat as a branch name is the fabrication this module exists to avoid.
    pub branch: Option<String>,
}

/// Locate the repository / worktree / branch containing `cwd`, by reading git's own on-disk layout.
///
/// NO `git` SUBPROCESS. Discovery is a walk up the ancestors looking for `.git`, then two small file
/// reads. Shelling out would make the filing context depend on `git` being on PATH and on a process
/// spawn succeeding inside whatever cage the session runs in — for a field whose entire value is being
/// trustworthy — and it would be untestable without a real repository.
///
/// The two shapes git actually writes are both handled by ONE rule:
///   * a `.git` DIRECTORY  → the main working tree; its parent is the repository;
///   * a `.git` FILE       → a linked worktree, holding `gitdir: <repo>/.git/worktrees/<name>`.
///
/// In both cases the repository is the parent of the `.git` component of the resolved git dir, so the
/// linked-worktree case needs no special arithmetic — only a `gitdir:` that parses.
pub fn locate_tree(cwd: &Path) -> TreeLocation {
    let mut loc = TreeLocation { cwd: path_string(cwd), ..Default::default() };
    let Some((tree, git_dir)) = find_git_dir(cwd) else { return loc };
    loc.worktree = path_string(&tree);
    // A working tree whose `gitdir:` pointer did not parse is still a MEASURED working tree; only the
    // fields that pointer would have answered go absent. Collapsing all four to null because one read
    // failed would throw away something that was observed.
    let Some(git_dir) = git_dir else { return loc };
    // The repository is the parent of the `.git` component. `rposition` (not `position`) because a
    // path may legitimately contain an earlier `.git` — a fixture tree, a nested checkout — and the
    // one that matters is the closest to the git dir itself.
    let comps: Vec<Component> = git_dir.components().collect();
    loc.repo = comps
        .iter()
        .rposition(|c| c.as_os_str() == ".git")
        .map(|i| comps[..i].iter().collect::<PathBuf>())
        .filter(|p| !p.as_os_str().is_empty())
        .and_then(|p| path_string(&p));
    loc.branch = read_branch(&git_dir);
    loc
}

/// The nearest ancestor holding a `.git`, paired with the git dir it resolves to — `None` for the git
/// dir when the pointer is unreadable or unparseable, so the caller can still record the tree it found.
fn find_git_dir(start: &Path) -> Option<(PathBuf, Option<PathBuf>)> {
    for dir in start.ancestors() {
        let dot = dir.join(".git");
        let Ok(meta) = std::fs::metadata(&dot) else { continue };
        if meta.is_dir() {
            return Some((dir.to_path_buf(), Some(dot)));
        }
        // A `.git` FILE is a linked worktree's pointer. An unreadable or unparseable one yields no git
        // dir rather than a guess — the tree is still reported, the fields it could not answer are not.
        let resolved = std::fs::read_to_string(&dot)
            .ok()
            .and_then(|text| {
                text.lines().find_map(|l| l.trim().strip_prefix("gitdir:")).map(|t| t.trim().to_string())
            })
            .filter(|t| !t.is_empty())
            .map(|t| {
                let p = PathBuf::from(t);
                if p.is_absolute() { normalize(&p) } else { normalize(&dir.join(p)) }
            });
        return Some((dir.to_path_buf(), resolved));
    }
    None
}

/// The branch `git_dir/HEAD` points at, or `None` when HEAD is detached (a bare sha) or unreadable.
fn read_branch(git_dir: &Path) -> Option<String> {
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let r = head.trim().strip_prefix("ref:")?.trim().strip_prefix("refs/heads/")?.trim();
    (!r.is_empty()).then(|| r.to_string())
}

/// Lexically resolve `.`/`..` — a `gitdir:` pointer is routinely relative, and the un-normalized join
/// would store `…/wt-131/../.git/worktrees/wt-131`, which is correct and unreadable. Purely lexical on
/// purpose: it must not touch the filesystem or follow symlinks, so it cannot fail.
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A path as a string, absent when it is empty or not valid UTF-8 — a lossy path is a fabricated one.
fn path_string(p: &Path) -> Option<String> {
    p.to_str().map(str::to_string).filter(|s| !s.is_empty())
}

/// WHO was driving — the agent harness, its model, and its session id, read from the environment the
/// launcher already exports. Every field is independently absent.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Filer {
    /// `claude-code` or `bsc-agent`. Absent for a plain shell, which is honest — nobody said.
    pub harness: Option<String>,
    /// The model, namespaced by provider when the provider is known (`anthropic/claude-sonnet-4-6`).
    /// A cost complaint from a 35B local operator and one from Claude are different reports, and this
    /// is the field that tells them apart.
    pub model: Option<String>,
    /// The harness's own session id, so a request can be read back against that session's transcript.
    pub session_id: Option<String>,
}

/// Read [`Filer`] from an injected environment lookup.
///
/// The two harnesses are detected by variables ONLY they carry. `BSC_AGENT_BIN` is deliberately not
/// one of them: `pty_create` exports it to every pane regardless of harness, so keying on it would
/// label every Claude Code session `bsc-agent` — a wrong answer that looks like a measured one.
pub fn filer(env: &dyn Fn(&str) -> Option<String>) -> Filer {
    let get = |k: &str| clean(env(k));
    // bsc-agent first: it is identified by variables the app writes for exactly that provider
    // (`bsc_agent_env`), whereas CLAUDECODE is set by a harness we do not launch and could in
    // principle be inherited into one.
    if get("BSC_AGENT_PROVIDER").is_some() || get("BSC_AGENT_SESSION").is_some() {
        let provider = get("BSC_AGENT_PROVIDER");
        let model = get("BSC_AGENT_MODEL");
        return Filer {
            harness: Some("bsc-agent".to_string()),
            model: match (provider, model) {
                // Namespaced only when the model does not already carry one, matching `aider_model_arg`.
                (Some(p), Some(m)) if !m.contains('/') => Some(format!("{p}/{m}")),
                (_, Some(m)) => Some(m),
                (Some(p), None) => Some(p),
                (None, None) => None,
            },
            // The agent's session is a FILE PATH; its stem is the id. The whole path would record
            // where the transcript lives on one machine, which is not what a session id is for.
            session_id: get("BSC_AGENT_SESSION")
                .and_then(|p| Path::new(&p).file_stem().and_then(|s| s.to_str()).map(str::to_string)),
        };
    }
    if get("CLAUDECODE").is_some() {
        return Filer {
            harness: Some("claude-code".to_string()),
            // Only when the session was pinned to a model explicitly. Claude Code does not otherwise
            // publish which model is driving, so this is absent far more often than not — which is the
            // correct record, not a gap to paper over with a default model name.
            model: get("ANTHROPIC_MODEL"),
            session_id: get("CLAUDE_CODE_SESSION_ID"),
        };
    }
    Filer::default()
}

/// The build of `bsc` that filed a request: its crate version, and when the binary was written
/// (epoch ms). Absent when the executable cannot be located or stat'd.
///
/// The build TIME is the load-bearing half. Half the live queue reports behaviour that has since
/// changed, and nothing recorded what was running — so "is this still true?" could not be asked. The
/// mtime of the executable is the same signal `bsc version` prints, so the two agree by construction.
pub fn build_stamp(exe: Option<&Path>) -> (Option<String>, Option<i64>) {
    let built = exe
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    (Some(BSC_VERSION.to_string()), built)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| m.get(k).cloned()
    }

    /// A temp dir that cleans itself up — the git-layout fixtures below need real files on disk,
    /// because the discovery deliberately reads git's layout rather than shelling out to git.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let p = std::env::temp_dir().join(format!("bsc-req-prov-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_directory_outside_any_repository_records_only_its_cwd() {
        let t = Tmp::new("bare");
        let loc = locate_tree(&t.0);
        assert_eq!(loc.cwd.as_deref(), t.0.to_str(), "the cwd is always measurable");
        assert_eq!(loc.repo, None, "no repository is INVENTED for a directory that is not in one");
        assert_eq!(loc.worktree, None);
        assert_eq!(loc.branch, None);
    }

    #[test]
    fn a_main_checkout_reports_itself_as_both_repo_and_worktree() {
        let t = Tmp::new("main");
        let git = t.0.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/develop\n").unwrap();
        let sub = t.0.join("crates/bsc-request/src");
        std::fs::create_dir_all(&sub).unwrap();
        // Filed from a nested directory — discovery walks UP, so the record is the tree, not the cwd.
        let loc = locate_tree(&sub);
        assert_eq!(loc.cwd.as_deref(), sub.to_str());
        assert_eq!(loc.repo.as_deref(), t.0.to_str(), "the repository is the .git's parent");
        assert_eq!(loc.worktree.as_deref(), t.0.to_str(), "and it IS the working tree here");
        assert_eq!(loc.branch.as_deref(), Some("develop"));
    }

    /// The case the whole field exists for: a filing from `wt-131` and one from the repo root are
    /// DIFFERENT reports, and `repo` alone cannot tell them apart.
    #[test]
    fn a_linked_worktree_reports_its_own_tree_and_branch_but_the_shared_repository() {
        let t = Tmp::new("linked");
        let repo = t.0.join("base-studio-code");
        let wt = t.0.join("base-studio-code/wt-131");
        let gitdir = repo.join(".git/worktrees/wt-131");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/a-request-records-where-it-came-from\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();

        let loc = locate_tree(&wt);
        assert_eq!(loc.worktree.as_deref(), wt.to_str(), "the tree the filer was actually in");
        assert_eq!(loc.repo.as_deref(), repo.to_str(), "the shared repository, from the .git component");
        assert_eq!(
            loc.branch.as_deref(),
            Some("a-request-records-where-it-came-from"),
            "the WORKTREE's branch — the shared repo's HEAD says main and would be the wrong answer",
        );
    }

    #[test]
    fn a_relative_gitdir_pointer_resolves_and_normalizes() {
        let t = Tmp::new("rel");
        let repo = t.0.join("repo");
        let wt = repo.join("wt-a");
        let gitdir = repo.join(".git/worktrees/wt-a");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(gitdir.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
        std::fs::write(wt.join(".git"), "gitdir: ../.git/worktrees/wt-a\n").unwrap();
        let loc = locate_tree(&wt);
        assert_eq!(loc.repo.as_deref(), repo.to_str(), "resolved AND lexically normalized — no ../ left in the record");
        assert_eq!(loc.branch.as_deref(), Some("feature"));
    }

    #[test]
    fn a_detached_head_records_no_branch_rather_than_a_sha() {
        let t = Tmp::new("detached");
        let git = t.0.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        std::fs::write(git.join("HEAD"), "9f3c0aa11b2c3d4e5f60718293a4b5c6d7e8f900\n").unwrap();
        let loc = locate_tree(&t.0);
        assert_eq!(loc.worktree.as_deref(), t.0.to_str(), "the tree is still measurable");
        assert_eq!(loc.branch, None, "a sha is not a branch name — absent beats a value readers misread");
    }

    #[test]
    fn an_unparseable_gitdir_pointer_yields_no_repo_rather_than_the_worktree() {
        let t = Tmp::new("broken");
        std::fs::write(t.0.join(".git"), "this is not a gitdir pointer\n").unwrap();
        let loc = locate_tree(&t.0);
        assert_eq!(loc.repo, None, "no repository is guessed from a pointer that does not parse");
        assert_eq!(loc.branch, None);
        assert_eq!(loc.cwd.as_deref(), t.0.to_str(), "what WAS measured is still recorded");
        assert_eq!(loc.worktree.as_deref(), t.0.to_str(), "and so is the tree — one failed read is not four absences");
    }

    #[test]
    fn a_claude_code_session_is_identified_and_its_model_stays_absent_unless_pinned() {
        let f = filer(&env_of(&[("CLAUDECODE", "1"), ("CLAUDE_CODE_SESSION_ID", "sess-42")]));
        assert_eq!(f.harness.as_deref(), Some("claude-code"));
        assert_eq!(f.session_id.as_deref(), Some("sess-42"));
        assert_eq!(f.model, None, "Claude Code does not publish its model — absent, never a default name");
        let pinned = filer(&env_of(&[("CLAUDECODE", "1"), ("ANTHROPIC_MODEL", "claude-opus-5")]));
        assert_eq!(pinned.model.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn a_bsc_agent_session_records_its_provider_namespaced_model_and_session_stem() {
        let f = filer(&env_of(&[
            ("BSC_AGENT_PROVIDER", "local"),
            ("BSC_AGENT_MODEL", "qwen3-35b"),
            ("BSC_AGENT_SESSION", "/home/x/.base-studio-code/agent/abc123.json"),
        ]));
        assert_eq!(f.harness.as_deref(), Some("bsc-agent"));
        assert_eq!(f.model.as_deref(), Some("local/qwen3-35b"), "a 35B local operator is a different report");
        assert_eq!(f.session_id.as_deref(), Some("abc123"), "the stem, not the machine-local path");
        let already = filer(&env_of(&[("BSC_AGENT_PROVIDER", "anthropic"), ("BSC_AGENT_MODEL", "anthropic/x")]));
        assert_eq!(already.model.as_deref(), Some("anthropic/x"), "an already-namespaced model is not double-prefixed");
    }

    /// `BSC_AGENT_BIN` is exported to EVERY pane. Keying the harness off it would label every Claude
    /// Code session `bsc-agent` — the exact class of plausible-looking wrong answer this module bans.
    #[test]
    fn the_universally_exported_agent_binary_var_does_not_identify_a_harness() {
        let f = filer(&env_of(&[("BSC_AGENT_BIN", "/home/x/.base-studio-code/bin/bsc-agent")]));
        assert_eq!(f, Filer::default(), "nothing was said about the harness, so nothing is recorded");
    }

    #[test]
    fn a_plain_shell_records_no_harness_at_all() {
        assert_eq!(filer(&env_of(&[])), Filer::default(), "absent is a real state");
    }

    #[test]
    fn blank_and_the_unknown_pane_sentinel_are_absences() {
        assert_eq!(clean(Some("  ".into())), None);
        assert_eq!(clean(Some("?".into())), None, "the shell helpers' unknown-pane sentinel");
        assert_eq!(clean(Some(" x ".into())).as_deref(), Some("x"), "trimmed, not dropped");
        assert_eq!(clean(None), None);
    }

    #[test]
    fn a_build_stamp_carries_a_version_and_an_absent_time_for_a_binary_that_is_not_there() {
        let (v, at) = build_stamp(Some(Path::new("/definitely/not/a/binary")));
        assert_eq!(v.as_deref(), Some(BSC_VERSION), "the version is compiled in and always known");
        assert_eq!(at, None, "the build TIME is absent when the executable cannot be stat'd");
        let (_, none_at) = build_stamp(None);
        assert_eq!(none_at, None);
    }
}
