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
    /// `(guest path, host path)` — each mounted READ-WRITE, AFTER the read-only stores, so it
    /// lands as a writable hole in an otherwise read-only projection. Typically `/coord/out`
    /// (emit coordination) and `/ui/out` (author components).
    ///
    /// Each mountpoint must ALREADY EXIST inside its projection: bwrap cannot `mkdir` inside a
    /// read-only bind and fails with `Can't mkdir /coord/out: Read-only file system`.
    pub outboxes: Vec<(String, PathBuf)>,
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
    // AFTER the store mounts, so each writable hole lands on top of its read-only projection.
    for (guest, host) in &paths.outboxes {
        mounts.push(Mount::ReadWrite { host: host.clone(), guest: PathBuf::from(guest) });
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

    #[test]
    fn a_bad_spec_is_refused_at_the_join_not_at_launch() {
        // Rendering here means a caller learns about a broken profile when it builds one.
        let e = for_role(Role::Worker, "bad unit", &paths(), &[], Limits::default(), vec!["sh".into()]);
        assert_eq!(e.unwrap_err(), SpecError::UnitNotSafe("bad unit".into()));

        let empty = for_role(Role::Worker, "u", &paths(), &[], Limits::default(), vec![]);
        assert_eq!(empty.unwrap_err(), SpecError::EmptyCommand);
    }
}
