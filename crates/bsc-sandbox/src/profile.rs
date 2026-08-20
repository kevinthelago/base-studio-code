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
//! [`Role::Designer`] is the exception, and it is a **known, deliberate hole**: its entire surface
//! is `bsc ui`, which WRITES. A read-only projection cannot express that, so the designer profile
//! binds `bsc` and carries ambient authority until a write surface exists for the UI store the way
//! `/coord/out` does for coordination. It is marked, not hidden — see [`Profile::caveat`].

use crate::{Limits, Mount, SandboxSpec, SpecError, Usr, MINIMAL_BINS};
use std::path::PathBuf;

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
    Designer,
}

impl Role {
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
            "designer" => Role::Designer,
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

    /// Network is DERIVED from the two axes rather than guessed per role: fetching, pushing and
    /// every `gh` call cross the network. Only `designer` is `none/none/none`, and only it runs
    /// with the network unshared.
    pub fn needs_network(self) -> bool {
        self.uses_git() || self.uses_github()
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
    /// Writable at `/coord/out`, when the session may emit coordination events.
    ///
    /// The mountpoint must already exist inside the `coord` projection — bwrap cannot `mkdir`
    /// inside a read-only bind, and fails with `Can't mkdir /coord/out: Read-only file system`.
    pub outbox: Option<PathBuf>,
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
    if role == Role::Designer {
        // The known hole. See the module docs.
        v.push("bsc");
    }
    v
}

/// Build the namespace a role runs in.
///
/// `extra_bins` is the caller's toolchain — a Rust worker wants `cargo`/`rustc`, a Node one
/// `node`/`npm`. Passing it explicitly is the point: the alternative is [`Usr::All`], which is
/// every binary on the host.
pub fn for_role(
    role: Role,
    unit: impl Into<String>,
    paths: &SessionPaths,
    extra_bins: &[&str],
    limits: Limits,
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
    // AFTER the store mounts, so the writable hole lands on top of the read-only coord bind.
    if let Some(out) = &paths.outbox {
        mounts.push(Mount::ReadWrite {
            host: out.clone(),
            guest: PathBuf::from("/coord/out"),
        });
    }

    let mut bins: Vec<String> = MINIMAL_BINS.iter().map(|s| s.to_string()).collect();
    bins.extend(bins_for(role).iter().map(|s| s.to_string()));
    bins.extend(extra_bins.iter().map(|s| s.to_string()));

    let spec = SandboxSpec {
        unit: unit.into(),
        limits,
        usr: Usr::Curated(bins),
        mounts,
        cwd: PathBuf::from("/repo"),
        env: vec![("HOME".into(), "/repo".into())],
        network: role.needs_network(),
        command,
    };
    // Render once so a bad spec is refused HERE, at the join, rather than at launch.
    spec.render()?;

    let caveat = (role == Role::Designer).then(|| {
        "designer binds `bsc` and therefore carries ambient authority: its whole surface is \
         `bsc ui`, which WRITES, and a read-only projection cannot express a write. Remove this \
         once the UI store has a write surface the way /coord/out is one for coordination."
            .to_string()
    });

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
            outbox: Some(PathBuf::from("/home/k/proj/outbox")),
        }
    }

    fn build(role: Role) -> Profile {
        for_role(role, "u", &paths(), &[], Limits::default(), vec!["sh".into()]).unwrap()
    }

    #[test]
    fn an_unknown_role_is_refused_not_defaulted() {
        // The security-relevant one: a typo must not silently yield a permissive namespace.
        assert!(Role::parse("wroker").is_none());
        assert!(Role::parse("").is_none());
        assert!(Role::parse("root").is_none());
        assert_eq!(Role::parse("worker"), Some(Role::Worker));
    }

    #[test]
    fn only_designer_runs_without_the_network() {
        // Derived from the git/github axes rather than guessed: fetching, pushing and every gh
        // call cross the network, and designer is the one role that is none on both.
        assert!(!Role::Designer.needs_network());
        for r in [Role::Planner, Role::Worker, Role::Director, Role::Triage, Role::Juror] {
            assert!(r.needs_network(), "{r:?} should have the network");
        }
        assert!(!build(Role::Designer).spec.network);
        assert!(build(Role::Worker).spec.network);
    }

    #[test]
    fn no_role_but_designer_gets_bsc() {
        // A sandboxed session reads stores as projections; binding bsc would mean binding a
        // writable database too.
        for r in [Role::Planner, Role::Worker, Role::Director, Role::Triage, Role::Documentor] {
            let a = build(r).spec.render().unwrap();
            assert!(!a.iter().any(|x| x == "/usr/bin/bsc"), "{r:?} must not get bsc");
        }
        let d = build(Role::Designer).spec.render().unwrap();
        assert!(d.iter().any(|x| x == "/usr/bin/bsc"));
    }

    #[test]
    fn the_designer_hole_is_declared_and_no_other_role_carries_one() {
        // An undocumented exception is the thing that rots. This one announces itself.
        let c = build(Role::Designer).caveat.expect("designer must declare its caveat");
        assert!(c.contains("ambient authority"));
        assert!(c.contains("write"));
        for r in [Role::Planner, Role::Worker, Role::Director] {
            assert!(build(r).caveat.is_none(), "{r:?} should carry no caveat");
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

        // The writable hole must come AFTER the read-only coord bind, or it is overmounted.
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
            vec!["sh".into()],
        )
        .unwrap();
        let a = p.spec.render().unwrap();
        for b in ["cargo", "rustc", "git", "cat"] {
            assert!(a.iter().any(|x| x == &format!("/usr/bin/{b}")), "missing {b}");
        }
        assert!(!a.iter().any(|x| x == "/usr/bin/node"), "nothing unasked-for");
    }

    #[test]
    fn a_bad_spec_is_refused_at_the_join_not_at_launch() {
        // Rendering here means a caller learns about a broken profile when it builds one.
        let e = for_role(Role::Worker, "bad unit", &paths(), &[], Limits::default(), vec!["sh".into()]);
        assert_eq!(e.unwrap_err(), SpecError::UnitNotSafe("bad unit".into()));

        let empty = for_role(Role::Worker, "u", &paths(), &[], Limits::default(), vec![]);
        assert_eq!(empty.unwrap_err(), SpecError::EmptyCommand);
    }
}
