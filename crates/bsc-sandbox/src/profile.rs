//! A session's ROLE, turned into the namespace it runs in.
//!
//! The role gate in `sessionRoles.ts` bounds a session on three axes — `git`, `github`, `code`.
//! This maps those axes onto things a kernel can enforce: which paths exist, whether a network
//! namespace is shared, and which executables are reachable.
//!
//! # What a namespace can and cannot take over from the hooks
//!
//! Worth stating plainly, because the plan item originally overstated it. A mount namespace is
//! **path-granular**:
//!
//! | hook | subsumed? | why |
//! |---|---|---|
//! | `bsc-confine` | **yes** | "is this path outside my root" — the path is simply absent, for every descendant |
//! | `bsc-scope` | **no** | it enforces GLOB rules *within* the worktree (`src/features/x/**` yes, `src/store/**` no). The worktree is one rw mount; a namespace cannot express that |
//! | `bsc-deny` | **partly** | a binary absent from the curated `/usr` cannot run at all, but a PRESENT binary invoked with dangerous flags still needs the check |
//!
//! So the end state is namespace for path confinement, hooks retained for glob scope and command
//! shape. Complementary, not sequential — and hooks may only stop being the floor **where a
//! namespace actually replaces them**, never globally.
//!
//! # The store question, and the one role that does not fit yet
//!
//! `bsc` is in the always-allowed mandatory tier, and workers are documented as reading every
//! store through it directly. Inside a namespace that would mean binding the `bsc` binary **and a
//! writable SQLite database** into every agent — the exact ambient authority the isolation exists
//! to remove. So a sandboxed session reads stores as the **read-only projections** instead
//! (`/plan`, `/graph`, `/ui`, `/coord` — see `bsc-storefs`), and does not get `bsc`.
//!
//! `Role::Designer` used to be the exception — its whole surface is `bsc ui`, which WRITES, and a
//! read-only projection could not express a write, so it bound `bsc` and carried ambient
//! authority. **That hole is closed.** The UI store now has a write surface at `/ui/out`
//! (`bsc_storefs::ui`), exactly as `/coord/out` is one for coordination. No role binds `bsc`, and
//! [`Profile::caveat`] is `None` for every role.

use crate::{Limits, Mount, SandboxSpec, Scope, SpecError, Usr, MINIMAL_BINS};
use std::path::{Path, PathBuf};

/// The roles the app launches. Deliberately a closed set: an unrecognised role is **refused**,
/// never defaulted to something permissive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Planner,
    Worker,
    Director,
    Triage,
    Tester,
    Reviewer,
    Issuer,
    Juror,
    Documentor,
    /// Kept although [`Role::parse`] no longer yields it — the profile it describes is the one the
    /// caged designer will need, and deleting it would mean rebuilding that reasoning from scratch.
    /// See the note in `parse` for why nothing produces it today.
    Designer,
}

/// Every [`Role`], for sweeps that must not miss one.
///
/// Kept exhaustive by [`Role::assert_listed`] rather than by discipline: adding a variant makes
/// that match fail to compile until the variant is added here too. A role missing from this list
/// is not a smaller sweep — it is a guard that silently stops covering it, which is precisely how
/// `needs_network` shipped wrong for exactly one role.
pub const ALL_ROLES: [Role; 10] = [
    Role::Planner,
    Role::Worker,
    Role::Director,
    Role::Triage,
    Role::Tester,
    Role::Reviewer,
    Role::Issuer,
    Role::Juror,
    Role::Documentor,
    Role::Designer,
];

impl Role {
    /// Compile-time proof that [`ALL_ROLES`] names every variant.
    ///
    /// The match is exhaustive and every arm asserts the variant is in the list, so a new `Role`
    /// breaks the build here — at the list — instead of quietly shrinking every sweep that reads it.
    #[cfg(test)]
    fn assert_listed(self) {
        let listed = match self {
            Role::Planner | Role::Worker | Role::Director | Role::Triage | Role::Tester => true,
            Role::Reviewer | Role::Issuer | Role::Juror | Role::Documentor | Role::Designer => true,
        };
        assert!(listed && ALL_ROLES.contains(&self), "{self:?} is missing from ALL_ROLES");
    }

    pub fn parse(s: &str) -> Option<Role> {
        Some(match s {
            "planner" => Role::Planner,
            "worker" => Role::Worker,
            "director" => Role::Director,
            "triage" => Role::Triage,
            "tester" => Role::Tester,
            "reviewer" => Role::Reviewer,
            "issuer" => Role::Issuer,
            "juror" => Role::Juror,
            "documentor" => Role::Documentor,
            // `designer` is DELIBERATELY ABSENT — do not add it back without finishing the caged
            // surface first (`complete-the-caged-designer-surface`).
            //
            // It was here once, and every designer session died on its first instructed command:
            //
            //     Exit code 127   /bin/bash: line 1: bsc: command not found
            //
            // The designer's whole documented surface is `bsc ui`, and this module refuses to bind
            // `bsc` on purpose (see the module docs — a writable SQLite store in the cage is the
            // ambient authority the isolation exists to remove). Worse, `/ui` is projected as the
            // summary tier only, with no `srcText`, so a caged designer cannot even READ the
            // component it is meant to edit. There is no path through that cage to its job.
            //
            // It was never a decision, either: `designer` was already a session role when roles were
            // mapped onto namespaces, while `architect`, `librarian`, `sound-designer` and
            // `integrator` were not — so the designer became the only caged studio by name collision.
            // Uncaged, it matches its four siblings and its own context is true again.
            _ => return None,
        })
    }

    /// `git` axis from the role gate: does this role reach a git remote at all?
    fn uses_git(self) -> bool {
        !matches!(self, Role::Triage | Role::Designer)
    }

    /// `github` axis: does this role talk to GitHub?
    fn uses_github(self) -> bool {
        !matches!(self, Role::Designer)
    }

    /// Does this role's own WORK reach a remote — a git remote or the GitHub API?
    ///
    /// Derived from the two axes rather than guessed per role: fetching, pushing and every `gh`
    /// call cross the network. `designer` is the one role that is `none/none/none`, so it is the
    /// one role whose work needs no remote at all.
    ///
    /// This is NOT the same question as [`Self::needs_network`], and conflating the two is exactly
    /// what broke the designer — see there. Kept `pub` and kept accurate because it is the axis a
    /// per-destination egress filter would be built from, the day there is a mechanism for one.
    pub fn work_reaches_a_remote(self) -> bool {
        self.uses_git() || self.uses_github()
    }

    /// Does this role's cage need the network? **Always** — because the HARNESS runs inside it.
    ///
    /// ## The bug this signature exists to prevent
    /// This used to be `uses_git() || uses_github()`, which reasoned only about the role's own
    /// tools. That is correct about git and `gh` and silently wrong about the LLM: every session
    /// is driven by a harness that must reach its provider's API, and the harness is INSIDE the
    /// cage — `namespace_argv` binds `node` and `claude`, and copies the credential and the
    /// harness state in, precisely so the caged Claude Code can authenticate.
    ///
    /// Every role except `designer` happens to need git or `gh`, so the gap was invisible until
    /// the one `none/none/none` role got caged. Then the designer's session unshared the network,
    /// Claude Code could not reach `api.anthropic.com`, and the pane died into a defunct `bwrap`
    /// showing the harness's own *"Session creation failed"*. The identical symptom is already
    /// recorded one layer down, in the comment that added the resolver binds for network roles.
    ///
    /// ## Why this is not "the designer lost its isolation"
    /// It lost the part of it that could never have worked. Everything else the profile gives it
    /// still holds — a curated `/usr`, a private `HOME` on tmpfs, read-only store projections, a
    /// writable outbox instead of the `bsc` binary, no git and no `gh`. What it does NOT have is a
    /// per-destination egress filter, and it never did: `bwrap` shares the host network namespace
    /// wholesale, so the only two states available here are "all of it" and "none of it". A role
    /// that must talk to an API cannot be given "none of it".
    ///
    /// Narrowing this to the provider endpoint alone needs a mechanism this crate does not have
    /// (a per-session netns with filtering, or a proxy). That is a separate piece of work, and
    /// [`Self::work_reaches_a_remote`] is deliberately kept — it is the honest answer to "would
    /// this role's own tools touch a remote?", which is what such a filter would be built from.
    pub fn needs_network(self) -> bool {
        // Unconditional, and deliberately not written as `work_reaches_a_remote() || harness`: the
        // harness alone settles it for every role, so an expression suggesting the role's own axes
        // still participate would be misleading. They do not. `work_reaches_a_remote` stays as the
        // separate, still-true question above.
        true
    }
}

/// Where a session's directories live on the host.
#[derive(Debug, Clone, Default)]
pub struct SessionPaths {
    /// Writable at `/repo`. A worktree for a worker, the project hub for a planner or director.
    pub root: PathBuf,
    /// `(guest name, host path)` — each mounted read-only at `/<name>`. Typically the
    /// `bsc-storefs` projections: `plan`, `graph`, `ui`, `coord`.
    pub stores: Vec<(String, PathBuf)>,
    /// `(guest path, host path)` — each mounted READ-WRITE, AFTER the read-only stores, so it
    /// lands as a writable hole in an otherwise read-only projection. Typically `/coord/out`
    /// (emit coordination) and `/ui/out` (author components).
    ///
    /// Each mountpoint must ALREADY EXIST inside its projection: bwrap cannot `mkdir` inside a
    /// read-only bind and fails with `Can't mkdir /coord/out: Read-only file system`.
    pub outboxes: Vec<(String, PathBuf)>,
    /// Host path to the `bsc-hook` binary, bound read-only at [`crate::HOOK_GUEST_PATH`].
    ///
    /// A mount namespace subsumes `bsc-confine` and CANNOT subsume `bsc-scope` or fully subsume
    /// `bsc-deny` (see the table in this module's docs), so those two checks have to be reachable
    /// from inside. `None` ⇒ path confinement only, which is a real but weaker posture.
    pub hook_bin: Option<PathBuf>,
    /// `$BSC_SCOPE_GLOBS` for the gate — whitespace-separated globs, or `__bsc_deny_all__` for a
    /// `code: none` role. Empty ⇒ no write-scope restriction.
    ///
    /// Note it is passed as CONFIG rather than inherited: the namespace clears the environment, and
    /// the value the gate sees is namespace-relative (matched against paths under `/repo`), not the
    /// host-shaped one an unsandboxed session would carry.
    pub scope_globs: String,
    /// `$BSC_DENY_BASH` for the gate — newline-separated role/user deny patterns. The built-in
    /// dangerous floor is compiled in and needs no configuration.
    pub deny_bash: String,
    /// A private `HOME` inside the namespace, backed by tmpfs. See [`SandboxSpec::home`] — the
    /// short version is that the worktree owns session CONFIG and must not also own harness STATE.
    pub home: Option<PathBuf>,
    /// Host path to the one credential file the harness needs, bound read-only under `home`.
    /// Requires `home`; supplying it without one is refused rather than dropped.
    pub credential_file: Option<PathBuf>,
    /// The harness's own state file (Claude Code's `~/.claude.json`) — a PER-SESSION COPY, bound
    /// read-write. Without it a private HOME reads as a first run and the harness re-runs onboarding.
    pub harness_state_file: Option<PathBuf>,
    /// A persistent host directory for the harness's TRANSCRIPTS, so a session can resume its own
    /// previous conversation. See [`crate::SandboxSpec::history_dir`].
    pub history_dir: Option<PathBuf>,
    /// A shell rc bound read-only at [`crate::RC_GUEST_PATH`] — see [`SandboxSpec::rc_file`] for
    /// why helpers travel as a file rather than inline in the init line.
    pub rc_file: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct Profile {
    pub spec: SandboxSpec,
    /// Non-empty when this profile knowingly grants more than the isolation model wants. Callers
    /// should surface it rather than drop it — an undocumented hole is the thing that rots.
    pub caveat: Option<String>,
}

/// Extra executables a role needs on top of [`MINIMAL_BINS`].
fn bins_for(role: Role) -> Vec<&'static str> {
    let mut v = Vec::new();
    if role.uses_git() {
        v.push("git");
    }
    if role.uses_github() {
        v.push("gh");
    }
    // `designer` used to get `bsc` here, and that was the one remaining hole: its whole surface is
    // `bsc ui`, which WRITES, and a read-only projection could not express a write. It now authors
    // through the `/ui/out` outbox (see `bsc_storefs::ui`), so it needs no binary and no database
    // — and NO role carries ambient authority any more.
    v
}

/// The real host path of an executable on `PATH`, following symlinks.
///
/// The curated `/usr` binds `/usr/bin/<name>` for every harness binary, which quietly assumes every
/// one of them lives there. That holds for a system or npm-global install and is FALSE for a per-user
/// install — Claude Code's default is `~/.local/bin/claude`, a symlink into a versioned directory
/// under `$HOME`, and the cage gives the agent a private empty `$HOME` by design.
///
/// The failure was silent because the bind uses `--ro-bind-try`: a missing source is skipped rather
/// than refused, so the launch succeeded and the agent met `command not found`. That is the same
/// "the cage shipped complete and useless" failure the harness test exists to catch, in a new guise.
///
/// Returns `None` when the name is not on `PATH` at all — the caller then falls back to the
/// `/usr/bin/<name>` bind, which is right for anything genuinely installed there.
fn real_bin_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(name);
        if cand.is_file() {
            // Canonicalize: a launcher shim is usually a symlink into a versioned directory, and it is
            // the TARGET that has to be bound.
            return cand.canonicalize().ok().or(Some(cand));
        }
    }
    None
}


/// Build the namespace a role runs in.
///
/// `extra_bins` is the caller's toolchain — a Rust worker wants `cargo`/`rustc`, a Node one
/// `node`/`npm`. Passing it explicitly is the point: the alternative is [`Usr::All`], which is
/// every binary on the host.
/// The namespace's WHOLE environment — `clear_env` drops everything else, so this list is not an
/// overlay on the host's environment but a replacement for it.
///
/// Four things cross, and each is here for a stated reason:
///
/// - `HOME` — the worktree, so a shell has somewhere to be.
/// - `TERM` — this is an interactive terminal session and a shell without it renders badly. It
///   carries no authority. (Measured: an *inherited* environment brought `GH_TOKEN` and
///   `AWS_SECRET` across, which is why nothing is inherited any more.)
/// - `BSC_REPO_ROOT` / `BSC_SCOPE_GLOBS` / `BSC_DENY_BASH` — configuration for the `bsc-hook`
///   gates, and only when a hook binary is actually bound. Passing them when nothing can read them
///   would be noise that reads like a working gate.
///
/// `BSC_REPO_ROOT` is `/repo`, the GUEST path — the gate matches paths as the session sees them,
/// so a host-shaped root would fail to strip and every write would land outside scope.
fn hook_env(paths: &SessionPaths) -> Vec<(String, String)> {
    // HOME follows the private tmpfs when there is one, and falls back to the worktree otherwise
    // so every existing caller is unchanged.
    let home = paths
        .home
        .as_ref()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|| "/repo".to_string());
    let mut env = vec![
        ("HOME".to_string(), home),
        // PATH is SET, not left to bash. `--clearenv` removes it, and bash's fallback default ends
        // in `.` — measured inside the cage:
        //   PATH=/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:.
        // The current directory is the agent's own WRITABLE worktree, so a file named like a
        // command would be found before the real one. Handing an agent a PATH it can write to is
        // precisely what the isolation exists to prevent, so the cage supplies its own.
        ("PATH".to_string(), "/usr/local/bin:/usr/bin:/bin".to_string()),
        (
            "TERM".to_string(),
            std::env::var("TERM").unwrap_or_else(|_| "xterm-256color".into()),
        ),
    ];
    if paths.hook_bin.is_some() {
        env.push(("BSC_REPO_ROOT".to_string(), "/repo".to_string()));
        if !paths.scope_globs.is_empty() {
            env.push(("BSC_SCOPE_GLOBS".to_string(), paths.scope_globs.clone()));
        }
        if !paths.deny_bash.is_empty() {
            env.push(("BSC_DENY_BASH".to_string(), paths.deny_bash.clone()));
        }
    }
    env
}

pub fn for_role(
    role: Role,
    unit: impl Into<String>,
    paths: &SessionPaths,
    extra_bins: &[&str],
    limits: Limits,
    scope: Scope,
    command: Vec<String>,
) -> Result<Profile, SpecError> {
    let mut mounts = vec![Mount::ReadWrite {
        host: paths.root.clone(),
        guest: PathBuf::from("/repo"),
    }];
    for (name, host) in &paths.stores {
        mounts.push(Mount::ReadOnly {
            host: host.clone(),
            guest: PathBuf::from(format!("/{name}")),
        });
    }
    // AFTER the store mounts, so each writable hole lands on top of its read-only projection.
    for (guest, host) in &paths.outboxes {
        mounts.push(Mount::ReadWrite { host: host.clone(), guest: PathBuf::from(guest) });
    }

    let mut bins: Vec<String> = MINIMAL_BINS.iter().map(|s| s.to_string()).collect();
    bins.extend(bins_for(role).iter().map(|s| s.to_string()));
    bins.extend(extra_bins.iter().map(|s| s.to_string()));

    // ...and bind each harness binary from where it ACTUALLY is. The curated `/usr` will also try
    // `/usr/bin/<name>`; this mount lands afterwards, so a per-user install wins and a system one is
    // unaffected. Without it a `~/.local` install is skipped in silence and the agent finds out at
    // `command not found`.
    for b in extra_bins {
        if let Some(real) = real_bin_path(b) {
            // Formatted ONCE and compared by reference: allocating a PathBuf purely to compare against
            // is what `clippy::cmp_owned` objects to, and it was building the same string twice.
            let guest = format!("/usr/bin/{b}");
            if real.as_path() != Path::new(&guest) {
                mounts.push(Mount::ReadOnly { host: real, guest: PathBuf::from(guest) });
            }
        }
    }

    let spec = SandboxSpec {
        unit: unit.into(),
        limits,
        // Defaults to the user scope; `for_role` takes it from the caller so the launcher can pass
        // what it actually PROBED rather than what we hope is true.
        scope,
        usr: Usr::Curated(bins),
        mounts,
        history_dir: paths.history_dir.clone(),
        cwd: PathBuf::from("/repo"),
        // The WHOLE environment, not an overlay — `clear_env` below drops everything else.
        //
        // TERM is passed through because this is an interactive terminal session and a shell with
        // no TERM renders badly; it carries no authority. HOME is the worktree. Nothing else
        // crosses: measured, an inherited environment brought GH_TOKEN and AWS_SECRET with it.
        env: hook_env(paths),
        network: role.needs_network(),
        clear_env: true,
        hook_bin: paths.hook_bin.clone(),
        // A private HOME on tmpfs whenever the caller asked for one. The worktree keeps the
        // session CONFIG (`<worktree>/.claude/settings.json`, read from the cwd tree); the harness
        // gets its own STATE dir that does not land in the git tree and does not outlive the run.
        home: paths.home.clone(),
        credential_file: paths.credential_file.clone(),
        harness_state_file: paths.harness_state_file.clone(),
        rc_file: paths.rc_file.clone(),
        command,
    };
    // Render once so a bad spec is refused HERE, at the join, rather than at launch.
    spec.render()?;

    // No role carries a caveat today — the designer one closed when `/ui/out` gave the UI store a
    // write surface. The mechanism stays because the NEXT hole should announce itself the same
    // way rather than living only in a doc comment.
    let caveat = None;

    Ok(Profile { spec, caveat })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> SessionPaths {
        SessionPaths {
            root: PathBuf::from("/home/k/wt/repo--stream"),
            stores: vec![
                ("plan".into(), PathBuf::from("/home/k/proj/plan")),
                ("coord".into(), PathBuf::from("/home/k/proj/coord")),
            ],
            outboxes: vec![
                ("/coord/out".into(), PathBuf::from("/home/k/proj/coord-out")),
                ("/ui/out".into(), PathBuf::from("/home/k/proj/ui-out")),
            ],
            // The default fixture carries NO gates, so every pre-existing test keeps asserting the
            // posture it was written against. `gated_paths()` is the opt-in.
            hook_bin: None,
            scope_globs: String::new(),
            deny_bash: String::new(),
            home: None,
            credential_file: None,
            harness_state_file: None,
            // No transcripts by default, so every pre-existing test keeps asserting the cage it was
            // written against; `resume_tests` opts in.
            history_dir: None,
            rc_file: None,
        }
    }

    /// The same session, WITH the hook binary bound and configured.
    fn gated_paths() -> SessionPaths {
        SessionPaths {
            hook_bin: Some(PathBuf::from("/opt/bsc/bsc-hook")),
            scope_globs: "src/features/** crates/**".into(),
            deny_bash: "vi
ed".into(),
            ..paths()
        }
    }

    fn build(role: Role) -> Profile {
        for_role(role, "u", &paths(), &[], Limits::default(), Scope::User, vec!["sh".into()]).unwrap()
    }

    /// `ALL_ROLES` names every variant — the precondition for every sweep below.
    ///
    /// Without this the sweeps look thorough and quietly skip whatever was added last. `parse` is
    /// checked in the same direction: a role the app can NAME but the list omits would be caged by
    /// a profile no test ever swept.
    #[test]
    fn all_roles_names_every_variant() {
        for r in ALL_ROLES {
            r.assert_listed();
        }
        assert_eq!(ALL_ROLES.len(), 10, "a Role was added or removed — update the sweeps");
        for name in [
            "planner", "worker", "director", "triage", "tester", "reviewer", "issuer", "juror",
            "documentor",
        ] {
            let r = Role::parse(name).unwrap_or_else(|| panic!("{name} should parse"));
            assert!(ALL_ROLES.contains(&r), "{name} parses but is not in ALL_ROLES");
        }
    }

    /// THE STUDIO ROLES ARE UNCAGED TOGETHER, and `designer` is one of them.
    ///
    /// It used to be the exception, and that was never a decision: `designer` was already a session
    /// role when roles were mapped onto namespaces, while `architect`, `librarian`, `sound-designer`
    /// and `integrator` were not — so the designer became the only caged studio by name collision.
    /// In that cage every session died on its first instructed command (`bsc: command not found`),
    /// because its whole documented surface is `bsc ui` and this module refuses to bind `bsc`.
    ///
    /// This pins the five together so the designer cannot quietly rejoin the set. Re-adding it is a
    /// real decision with a precondition — the caged surface has to be able to do the job first
    /// (`complete-the-caged-designer-surface`) — and that decision should break this test and be
    /// made here, not slip in as a one-line parser entry.
    #[test]
    fn the_studio_roles_are_uncaged_together() {
        for name in ["designer", "architect", "librarian", "sound-designer", "integrator"] {
            assert!(
                Role::parse(name).is_none(),
                "{name} must NOT resolve to a namespace profile — the studios run uncaged until the \
                 caged surface can do their job. Re-adding one is a decision; make it here.",
            );
        }
        // ...and the profile it would use is still MODELLED, so completing the cage means filling in
        // a surface rather than re-deriving what a designer may touch.
        assert!(ALL_ROLES.contains(&Role::Designer));
        assert!(!Role::Designer.work_reaches_a_remote(), "still the one role that needs no remote");
    }

    #[test]
    fn an_unknown_role_is_refused_not_defaulted() {
        // The security-relevant one: a typo must not silently yield a permissive namespace.
        assert!(Role::parse("wroker").is_none());
        assert!(Role::parse("").is_none());
        assert!(Role::parse("root").is_none());
        assert_eq!(Role::parse("worker"), Some(Role::Worker));
    }

    /// EVERY role gets the network, because the harness runs inside the cage.
    ///
    /// This test is the INVERSE of the one it replaces (`only_designer_runs_without_the_network`),
    /// and the inversion is the point rather than a relaxation. The old rule read the network off
    /// the role's git/github axes; the designer is the one role that is none on both, so it alone
    /// launched with `--unshare-all` and no `--share-net`. That was correct about git and `gh` and
    /// wrong about the LLM: Claude Code runs INSIDE the namespace, could not reach
    /// `api.anthropic.com`, and the pane died into a defunct `bwrap` showing the harness's own
    /// "Session creation failed".
    ///
    /// So the assertion has to be that no role is network-less, checked over the WHOLE role set
    /// rather than a sample — a new `none/none/none` role would otherwise reintroduce exactly this
    /// bug and no test would say so.
    #[test]
    fn every_role_gets_the_network_because_the_harness_is_in_the_cage() {
        for r in ALL_ROLES {
            assert!(r.needs_network(), "{r:?} must have the network — its harness is in the cage");
            assert!(build(r).spec.network, "{r:?} must render --share-net");
        }
    }

    /// The role's OWN reach is still a real question, and still answered honestly.
    ///
    /// `work_reaches_a_remote` is what `needs_network` used to be. It is kept — and kept correct —
    /// because it is the axis a per-destination egress filter would be built from. Losing it would
    /// mean rediscovering which roles actually touch a remote when that work starts.
    #[test]
    fn the_designer_is_still_the_one_role_whose_own_work_needs_no_remote() {
        assert!(!Role::Designer.work_reaches_a_remote());
        for r in ALL_ROLES {
            if r == Role::Designer {
                continue;
            }
            assert!(r.work_reaches_a_remote(), "{r:?} reaches a remote through git or gh");
        }
    }

    /// A cage with the network shared must also carry the machinery to USE it.
    ///
    /// `--share-net` alone is not connectivity: without a resolver the session gets
    /// "Failed to connect to api.anthropic.com: ETIMEOUT", which reads as a routing problem and is
    /// DNS failing for want of `/etc/resolv.conf`. That was already fixed for network roles; this
    /// pins it for the role that only just became one, since the designer is the role that would
    /// regress silently if the binds were ever made conditional on something narrower.
    #[test]
    fn the_designer_cage_carries_the_resolver_and_the_ca_bundle() {
        let argv = build(Role::Designer).spec.render().unwrap();
        assert!(argv.iter().any(|a| a == "--share-net"), "designer must share the net");
        for f in ["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts", "/etc/ssl"] {
            assert!(argv.iter().any(|a| a == f), "designer cage is missing {f}");
        }
    }

    #[test]
    fn no_role_gets_bsc_including_designer() {
        // A sandboxed session reads stores as projections; binding bsc would mean binding a
        // writable database too.
        // INVERTED when the designer hole closed: it authors through /ui/out now.
        for r in [Role::Planner, Role::Worker, Role::Director, Role::Triage, Role::Documentor, Role::Designer] {
            let a = build(r).spec.render().unwrap();
            assert!(!a.iter().any(|x| x == "/usr/bin/bsc"), "{r:?} must not get bsc");
        }
    }

    #[test]
    fn the_designer_authors_through_an_outbox_instead() {
        // What replaced the bsc grant: a WRITABLE hole at /ui/out, bound after the read-only /ui.
        let a = build(Role::Designer).spec.render().unwrap();
        assert!(a.windows(3).any(|w| w[0] == "--bind" && w[2] == "/ui/out"), "/ui/out must be writable");
        let hole = a.iter().position(|x| x == "/ui/out").unwrap();
        let last_ro = a.iter().enumerate().filter(|(_, x)| *x == "--ro-bind").map(|(i, _)| i).max().unwrap();
        assert!(hole > last_ro, "a writable hole bound before its projection is overmounted");
    }

    #[test]
    fn no_role_carries_ambient_authority_any_more() {
        // The designer caveat closed with /ui/out. The MECHANISM stays so the NEXT hole announces
        // itself the same way rather than living only in a doc comment — but today there is none.
        for r in [
            Role::Planner, Role::Worker, Role::Director, Role::Triage, Role::Tester,
            Role::Reviewer, Role::Issuer, Role::Juror, Role::Documentor, Role::Designer,
        ] {
            assert!(build(r).caveat.is_none(), "{r:?} must carry no caveat");
        }
    }

    #[test]
    fn git_and_gh_follow_the_role_gate_axes() {
        let triage = build(Role::Triage).spec.render().unwrap();
        assert!(!triage.iter().any(|x| x == "/usr/bin/git"), "triage is git: none");
        assert!(triage.iter().any(|x| x == "/usr/bin/gh"));

        let designer = build(Role::Designer).spec.render().unwrap();
        assert!(!designer.iter().any(|x| x == "/usr/bin/git"));
        assert!(!designer.iter().any(|x| x == "/usr/bin/gh"));

        let worker = build(Role::Worker).spec.render().unwrap();
        assert!(worker.iter().any(|x| x == "/usr/bin/git"));
    }

    #[test]
    fn stores_mount_read_only_and_the_outbox_writable_over_coord() {
        let a = build(Role::Worker).spec.render().unwrap();
        let ro: Vec<&String> = a
            .iter()
            .enumerate()
            .filter(|(i, x)| *x == "--ro-bind" && i + 2 < a.len())
            .map(|(i, _)| &a[i + 2])
            .collect();
        assert!(ro.contains(&&"/plan".to_string()));
        assert!(ro.contains(&&"/coord".to_string()));

        // A writable hole must come AFTER its read-only projection, or it is overmounted.
        let coord = a.iter().position(|x| x == "/coord").unwrap();
        let out = a.iter().position(|x| x == "/coord/out").unwrap();
        assert!(out > coord, "the outbox must be bound after the coord projection");
    }

    #[test]
    fn the_toolchain_is_supplied_rather_than_assumed() {
        let p = for_role(
            Role::Worker,
            "u",
            &paths(),
            &["cargo", "rustc"],
            Limits::default(),
            Scope::User,
            vec!["sh".into()],
        )
        .unwrap();
        let a = p.spec.render().unwrap();
        for b in ["cargo", "rustc", "git", "cat"] {
            assert!(a.iter().any(|x| x == &format!("/usr/bin/{b}")), "missing {b}");
        }
        assert!(!a.iter().any(|x| x == "/usr/bin/node"), "nothing unasked-for");
    }


    /// The binaries the dangerous floor (`bsc-util/src/dangerous.rs`) exists to police.
    /// Splitting them here is the whole finding of the slice-3 measurement.
    const STRUCTURALLY_ABSENT: &[&str] =
        &["sudo", "dd", "mkfs.ext4", "mkfs", "shutdown", "reboot", "curl", "wget"];

    #[test]
    fn the_dangerous_floor_binaries_stay_out_of_every_profile() {
        // MEASURED, not assumed: of the 24 entries in the dangerous floor, 8 become structurally
        // impossible because their binary is simply not bound. This test is what stops a future
        // widening of MINIMAL_BINS from quietly re-admitting one.
        for r in [Role::Planner, Role::Worker, Role::Director, Role::Triage, Role::Designer] {
            let a = build(r).spec.render().unwrap();
            for b in STRUCTURALLY_ABSENT {
                assert!(
                    !a.iter().any(|x| x == &format!("/usr/bin/{b}")),
                    "{r:?} must not reach {b}"
                );
            }
        }
    }

    #[test]
    fn the_hook_is_still_needed_for_exactly_what_we_grant_on_purpose() {
        // The other 12 entries are git-push-force and the gh auth/secret/workflow verbs. Those
        // binaries are capability we hand over deliberately, and the danger is a FLAG — which a
        // mount namespace cannot see. So this asserts the boundary rather than pretending the
        // namespace closed it.
        let w = build(Role::Worker).spec.render().unwrap();
        assert!(w.iter().any(|x| x == "/usr/bin/git"), "a worker genuinely needs git");
        let d = build(Role::Director).spec.render().unwrap();
        assert!(d.iter().any(|x| x == "/usr/bin/gh"), "a director genuinely needs gh");
        // Which is precisely why bsc-deny must NOT be demoted to telemetry for these roles.
    }

    #[test]
    fn only_the_worktree_and_its_outboxes_are_writable() {
        // The rm blast radius. Measured in a real namespace: rm on a read-only store fails with
        // "Read-only file system", the host projection survives, and `rm -rf /` exits 1 — so the
        // damage an `rm -rf /` can do is bounded to the agent's own (recoverable) worktree.
        let a = build(Role::Worker).spec.render().unwrap();
        let writable: Vec<&String> = a
            .iter()
            .enumerate()
            .filter(|(i, x)| *x == "--bind" && i + 2 < a.len())
            .map(|(i, _)| &a[i + 2])
            .collect();
        // The worktree plus exactly the outboxes the caller asked for — nothing else. Adding a
        // writable path anywhere in the stack has to change this line, which is the point.
        assert_eq!(writable, vec!["/repo", "/coord/out", "/ui/out"]);
    }


    // ── the hook gates (static-hook-binary-reaches-into-the-namespace) ──────────────────────────

    fn gated() -> Vec<String> {
        for_role(Role::Worker, "u", &gated_paths(), &[], Limits::default(), Scope::User, vec!["bash".into()])
            .expect("a gated worker profile renders")
            .spec
            .render()
            .expect("and validates")
    }

    // ── HOME and the one credential (a-sandboxed-session-can-launch-its-harness) ────────────────

    // ── the harness's own state (a-caged-harness-reruns-onboarding) ─────────────────────────────
    //
    // The credential alone leaves a private HOME looking like a FIRST RUN to Claude Code, because its
    // onboarding/account state lives in a separate `~/.claude.json`. It then starts the OAuth flow and
    // asks for a pasted code — with the credential it needed sitting right beside it.

    fn stated_paths() -> SessionPaths {
        SessionPaths {
            harness_state_file: Some(PathBuf::from("/host/session/home/.claude.json")),
            ..homed_paths()
        }
    }

    fn stated() -> Vec<String> {
        for_role(Role::Worker, "u", &stated_paths(), &[], Limits::default(), Scope::User, vec!["bash".into()])
            .expect("renders")
            .spec
            .render()
            .expect("validates")
    }

    #[test]
    fn harness_state_binds_read_write_under_the_guest_home() {
        let argv = stated();
        let i = argv
            .iter()
            .position(|a| a == "/host/session/home/.claude.json")
            .expect("the state file must be bound");
        // READ-WRITE: the harness rewrites this as it runs, so `--ro-bind` would fail every write
        // rather than make the session stateless.
        assert_eq!(argv[i - 1], "--bind", "harness state must be writable: {argv:?}");
        assert_eq!(argv[i + 1], "/home/agent/.claude.json");
    }

    #[test]
    fn the_guest_state_path_is_posix_even_when_rendered_on_windows() {
        // Same family as the credential's separator bug: a `PathBuf::join` here emits a backslash
        // inside a POSIX guest path when this renders on Windows.
        let argv = stated();
        let guest = argv
            .iter()
            .find(|a| a.starts_with("/home/agent") && a.ends_with(".claude.json"))
            .expect("a guest-side state path");
        assert!(!guest.contains(char::from(92)), "guest path must be POSIX: {guest}");
    }

    #[test]
    fn state_without_a_home_is_refused_rather_than_dropped() {
        // Dropping it silently puts the session back at the onboarding prompt, which reads as a frozen
        // terminal rather than as an error — the failure this item is about.
        let p = SessionPaths {
            home: None,
            credential_file: None,
            harness_state_file: Some(PathBuf::from("/host/session/home/.claude.json")),
            ..paths()
        };
        let err = for_role(Role::Worker, "u", &p, &[], Limits::default(), Scope::User, vec!["bash".into()])
            .and_then(|p| p.spec.render())
            .expect_err("state with no home must refuse");
        assert!(matches!(err, SpecError::HarnessStateWithoutHome), "got {err:?}");
    }

    #[test]
    fn a_session_with_no_state_file_still_renders() {
        // Best-effort: a host with no `~/.claude.json` (a fresh machine) must still launch.
        let argv = homed();
        assert!(
            !argv.iter().any(|a| a.ends_with("/.claude.json")),
            "nothing should be bound when there is no state file: {argv:?}"
        );
    }

    fn homed_paths() -> SessionPaths {
        SessionPaths {
            home: Some(PathBuf::from("/home/agent")),
            credential_file: Some(PathBuf::from("/host/kevin/.claude/.credentials.json")),
            ..gated_paths()
        }
    }

    fn homed() -> Vec<String> {
        for_role(Role::Worker, "u", &homed_paths(), &[], Limits::default(), Scope::User, vec!["bash".into()])
            .expect("renders")
            .spec
            .render()
            .expect("validates")
    }

    #[test]
    fn path_is_supplied_so_bash_does_not_fall_back_to_one_containing_dot() {
        // Measured before this: with PATH unset, bash defaults to a list ENDING IN `.` — the
        // current directory, which inside the cage is the agent's own writable worktree. A repo
        // file named `ls` would then win over /usr/bin/ls.
        let a = gated();
        let path = a
            .windows(3)
            .find(|w| w[0] == "--setenv" && w[1] == "PATH")
            .map(|w| w[2].clone())
            .expect("the cage supplies its own PATH");
        assert!(!path.split(':').any(|p| p == "." || p.is_empty()),
                "no cwd and no empty entry on PATH: {path}");
        assert!(path.contains("/usr/bin"), "and the curated bins are reachable: {path}");
    }

    #[test]
    fn a_private_home_is_tmpfs_and_home_points_at_it() {
        let a = homed();
        assert!(a.windows(2).any(|w| w[0] == "--tmpfs" && w[1] == "/home/agent"));
        assert!(a.windows(3).any(|w| w[0] == "--setenv" && w[1] == "HOME" && w[2] == "/home/agent"));
        // And emphatically NOT the worktree — that is the collapse this exists to undo.
        assert!(!a.windows(3).any(|w| w[0] == "--setenv" && w[1] == "HOME" && w[2] == "/repo"));
    }

    #[test]
    fn without_a_private_home_the_worktree_is_still_home_so_callers_are_unchanged() {
        let a = gated();
        assert!(a.windows(3).any(|w| w[0] == "--setenv" && w[1] == "HOME" && w[2] == "/repo"));
        assert!(!a.iter().any(|x| x == "/home/agent"));
    }

    #[test]
    fn exactly_one_secret_crosses_and_it_is_read_only() {
        let a = homed();
        assert!(
            a.windows(3).any(|w| w[0] == "--ro-bind"
                && w[1] == "/host/kevin/.claude/.credentials.json"
                && w[2] == "/home/agent/.claude/.credentials.json"),
            "the credential binds READ-ONLY at the guest home: {a:?}"
        );
        // The whole ~/.claude must never cross — it holds every project's transcripts and settings.
        assert!(
            !a.windows(3).any(|w| w[0].starts_with("--ro-bind")
                && w[1] == "/host/kevin/.claude"),
            "the credential is ONE FILE, never the directory: {a:?}"
        );
        // And it is the only host path under a home directory that appears at all.
        let secrets: Vec<&String> =
            a.iter().filter(|x| x.starts_with("/host/kevin")).collect();
        assert_eq!(secrets.len(), 1, "exactly one secret crosses, got {secrets:?}");
    }

    #[test]
    fn a_credential_with_nowhere_to_land_is_refused_not_dropped() {
        // Silently dropping it launches an UNAUTHENTICATED session, and a harness may report that
        // as missing state rather than as an error — the #4084 shape, where a refused read was
        // read as "nothing there" and every agent ran with memory disabled unnoticed.
        let paths = SessionPaths {
            home: None,
            credential_file: Some(PathBuf::from("/host/kevin/.claude/.credentials.json")),
            ..paths()
        };
        let err = for_role(Role::Worker, "u", &paths, &[], Limits::default(), Scope::User, vec!["bash".into()])
            .and_then(|p| p.spec.render())
            .expect_err("a credential with no home must refuse");
        assert!(matches!(err, SpecError::CredentialWithoutHome), "got {err:?}");
    }

    /// The credential crosses the boundary exactly once, and NOTHING here bounds where it can go.
    ///
    /// This test used to assert the opposite half too — that the designer held a credential it had
    /// no network to send anywhere. That property is GONE, and it is recorded here rather than
    /// deleted with the assertion, because losing a security property silently is worse than
    /// losing it: the harness runs inside the cage and must reach its provider, so every role now
    /// shares the host network namespace. `bwrap` offers no per-destination filter, so "can hold a
    /// token" and "can send it" are no longer separable by this mechanism for ANY role.
    ///
    /// What the namespace still bounds is how MUCH crosses: one credential file, read-only, at a
    /// fixed guest path — which is what the assertions below pin. Narrowing egress again needs a
    /// filtering netns or a proxy; until then this doc comment is the honest statement of the gap.
    #[test]
    fn exactly_one_credential_crosses_and_egress_is_no_longer_bounded() {
        let a = for_role(
            Role::Designer,
            "u",
            &homed_paths(),
            &[],
            Limits::default(),
            Scope::User,
            vec!["bash".into()],
        )
        .unwrap()
        .spec
        .render()
        .unwrap();
        // The credential is bound, read-only, at the guest path the harness reads.
        assert!(a.iter().any(|x| x.ends_with("/.claude/.credentials.json")));
        // ...and it is the ONLY host secret that crosses. This is the assertion that still bounds
        // something, so it is the one that has to stay sharp.
        let secrets: Vec<&String> = a.iter().filter(|x| x.starts_with("/host/kevin")).collect();
        assert_eq!(secrets.len(), 1, "exactly one secret crosses, got {secrets:?}");
        // And the gap, asserted rather than merely described: the designer DOES have the network
        // now. If a future change re-unshares it, this fails and points at the doc comment above
        // instead of at a session that dies with "Session creation failed".
        assert!(a.iter().any(|x| x == "--share-net"), "the harness needs the network: {a:?}");
    }

    #[test]
    fn the_guest_credential_path_is_posix_on_every_host() {
        // `PathBuf::join` uses the HOST separator, so building this guest path that way rendered
        // `/home/agent\.claude/.credentials.json` when the spec was built on Windows. A guest path
        // must never be constructed with host-platform path handling.
        let a = homed();
        let guest = a
            .iter()
            .find(|x| x.contains(".credentials.json") && x.starts_with("/home/agent"))
            .expect("the credential is bound somewhere under the guest home");
        assert_eq!(guest, "/home/agent/.claude/.credentials.json");
        // 92 is the backslash byte, compared numerically for the reason lib.rs already states:
        // a literal one is mangled by every layer between here and the file.
        assert!(!guest.contains(char::from(92u8)), "no host separator in a guest path: {guest}");
    }

    #[test]
    fn the_hook_binary_is_bound_read_only_at_the_fixed_guest_path() {
        let a = gated();
        assert!(
            a.windows(3).any(|w| w[0] == "--ro-bind"
                && w[1] == "/opt/bsc/bsc-hook"
                && w[2] == crate::HOOK_GUEST_PATH),
            "the gate binary must be bound READ-ONLY at the fixed path: {a:?}"
        );
    }

    #[test]
    fn no_hook_binary_means_no_gate_config_rather_than_dangling_vars() {
        // Absence has to be honest. Exporting BSC_SCOPE_GLOBS with nothing able to read it would
        // read like a working gate in every log and every `env` dump.
        let a = for_role(Role::Worker, "u", &paths(), &[], Limits::default(), Scope::User, vec!["bash".into()])
            .unwrap()
            .spec
            .render()
            .unwrap();
        assert!(!a.iter().any(|x| x.starts_with("BSC_")), "no gate vars without a gate: {a:?}");
        assert!(!a.iter().any(|x| x == crate::HOOK_GUEST_PATH));
    }

    #[test]
    fn the_gate_config_is_namespace_relative_never_a_host_path() {
        let a = gated();
        // bwrap renders `--setenv KEY VALUE` as THREE argv entries, not `KEY=VALUE`.
        let setenv = |k: &str, v: &str| {
            a.windows(3).any(|w| w[0] == "--setenv" && w[1] == k && w[2] == v)
        };
        assert!(
            setenv("BSC_REPO_ROOT", "/repo"),
            "the gate matches paths as the SESSION sees them; a host root would never strip: {a:?}"
        );
        assert!(setenv("BSC_SCOPE_GLOBS", "src/features/** crates/**"));
        assert!(setenv("BSC_DENY_BASH", "vi
ed"));
        // And emphatically not the host worktree the caller passed in.
        assert!(!a.windows(3).any(|w| w[0] == "--setenv"
            && w[1] == "BSC_REPO_ROOT"
            && w[2].starts_with("/home/")));
    }

    #[test]
    fn a_caller_mount_cannot_shadow_the_gate() {
        // A security check a later mount can overmount is not a check. The bind is emitted before
        // the caller's own mounts, so bwrap applies it FIRST and a colliding mount would have to be
        // an explicit later one rather than an accident of ordering.
        let a = gated();
        let hook_at = a.iter().position(|x| x == crate::HOOK_GUEST_PATH).expect("bound");
        let first_store = a.iter().position(|x| x == "/plan").expect("stores are mounted");
        assert!(hook_at < first_store, "the gate binds before caller mounts: {a:?}");
    }

    #[test]
    fn the_gate_binary_is_not_bsc_and_binds_no_store() {
        // The whole reason this is a separate binary: binding `bsc` would mean binding a writable
        // SQLite database, which is the ambient authority the isolation exists to remove.
        let a = gated();
        assert!(!a.iter().any(|x| x == "/usr/bin/bsc"), "still no bsc: {a:?}");
        assert!(!a.iter().any(|x| x.ends_with("plan.db") || x.ends_with("studio-code.db")));
    }

    #[test]
    fn every_role_starts_from_an_empty_environment() {
        // The leak this closes was not theoretical: an inherited environment carried GH_TOKEN and
        // AWS_SECRET into the namespace. No role should opt out of that by accident.
        for r in [Role::Planner, Role::Worker, Role::Director, Role::Triage, Role::Designer] {
            let p = build(r);
            assert!(p.spec.clear_env, "{r:?} must clear the environment");
            assert!(p.spec.render().unwrap().contains(&"--clearenv".to_string()));
        }
    }

    #[test]
    fn nothing_is_inherited_and_the_declared_set_is_small() {
        // The property is that no HOST value crosses, not that the list has a particular length —
        // the spec's `env` IS the whole environment, so every entry here was chosen.
        //
        //   HOME  the worktree, so a shell has somewhere to be
        //   TERM  an interactive terminal renders badly without it, and it carries no authority
        //   PATH  supplied rather than left to bash, whose fallback default ends in `.` — the
        //         agent's own writable worktree (see the PATH test above)
        //
        // TERM is the one value read from the host, and only its VALUE: a terminal type is not a
        // capability. Everything else is a literal.
        let p = build(Role::Worker);
        let keys: Vec<&str> = p.spec.env.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["HOME", "PATH", "TERM"]);
        // The thing that actually matters: nothing carrying authority is in here.
        for (k, _) in &p.spec.env {
            assert!(
                !k.starts_with("BSC_") && !k.contains("TOKEN") && !k.contains("SECRET")
                    && !k.contains("KEY") && !k.contains("AWS") && !k.contains("GH_"),
                "no credential or host-path variable may be declared: {k}"
            );
        }
    }

    #[test]
    fn a_bad_spec_is_refused_at_the_join_not_at_launch() {
        // Rendering here means a caller learns about a broken profile when it builds one.
        let e = for_role(Role::Worker, "bad unit", &paths(), &[], Limits::default(), Scope::User, vec!["sh".into()]);
        assert_eq!(e.unwrap_err(), SpecError::UnitNotSafe("bad unit".into()));

        let empty = for_role(Role::Worker, "u", &paths(), &[], Limits::default(), Scope::User, vec![]);
        assert_eq!(empty.unwrap_err(), SpecError::EmptyCommand);
    }
}

#[cfg(test)]
mod resume_tests {
    use super::*;
    use crate::HISTORY_GUEST_REL;

    fn with_history(dir: &str) -> Vec<String> {
        let paths = SessionPaths {
            root: PathBuf::from("/home/k/wt/repo--stream"),
            home: Some(PathBuf::from("/home/agent")),
            history_dir: Some(PathBuf::from(dir)),
            ..Default::default()
        };
        for_role(Role::Designer, "u", &paths, &[], Limits::default(), Scope::User, vec!["bash".into()])
            .unwrap()
            .spec
            .render()
            .unwrap()
    }

    /// A studio must be able to RESUME, and on a tmpfs HOME it could not.
    ///
    /// Claude Code keeps transcripts under `$HOME/.claude/projects`. The cage's HOME is a tmpfs, so
    /// they died with the session: `has_history=false · resumed=false` on every launch, and the init
    /// line's `claude --continue` fell through to a fresh `claude` every time. The uncaged studios
    /// resumed normally, which is why only the designer looked broken.
    #[test]
    fn the_transcript_directory_is_bound_writable_under_home() {
        let a = with_history("/host/store/home/projects");
        let want = format!("/home/agent/{HISTORY_GUEST_REL}");
        let at = a
            .windows(3)
            .position(|w| w[0] == "--bind" && w[1] == "/host/store/home/projects" && w[2] == want)
            .expect("the transcript dir must be bound READ-WRITE at the guest history path");
        // WRITABLE, not `--ro-bind`: the harness appends to these as it runs, and a read-only bind
        // would fail every write rather than make the session stateless.
        assert_eq!(a[at], "--bind");
    }

    /// It has to come AFTER the tmpfs that creates the HOME it lives in.
    ///
    /// bwrap applies mounts in order, so a bind under `/home/agent` that preceded `--tmpfs
    /// /home/agent` would be silently overlaid — present in the argv, absent in the cage, and the
    /// session would look exactly as broken as before with the fix apparently applied.
    #[test]
    fn it_is_ordered_after_the_tmpfs_home_that_would_otherwise_bury_it() {
        let a = with_history("/host/store/home/projects");
        let tmpfs = a.windows(2).position(|w| w[0] == "--tmpfs" && w[1] == "/home/agent").unwrap();
        let hist = a.iter().position(|x| x == "/host/store/home/projects").unwrap();
        assert!(hist > tmpfs, "the transcript bind must come after --tmpfs {}", "/home/agent");
    }

    /// No history dir asked for ⇒ nothing bound. A one-shot worker is not a conversation.
    #[test]
    fn a_spec_without_a_history_dir_binds_nothing_extra() {
        let paths = SessionPaths {
            root: PathBuf::from("/home/k/wt/repo--stream"),
            home: Some(PathBuf::from("/home/agent")),
            ..Default::default()
        };
        let a = for_role(Role::Worker, "u", &paths, &[], Limits::default(), Scope::User, vec!["bash".into()])
            .unwrap()
            .spec
            .render()
            .unwrap();
        assert!(!a.iter().any(|x| x.ends_with(HISTORY_GUEST_REL)), "nothing to bind: {a:?}");
    }
}
