//! An agent's isolation spec, and how it becomes an exec-ready argv.
//!
//! # Why this exists
//!
//! `bsc-confine`, `bsc-scope` and `bsc-deny` are **PreToolUse hooks** — they read the *declared*
//! tool payload and return before the command runs. So `Bash("python3 build.py")` is opaque to
//! them, and anything `build.py` opens escapes. The enforcement point is wrong by construction,
//! not badly implemented.
//!
//! A mount namespace is **inherited by every descendant process**. Construct it once at agent
//! launch and the escape fails at the syscall, for every child, forever. `tools/sandbox/`
//! demonstrates both halves; this crate is that demonstration turned into something the fleet can
//! call.
//!
//! # The one design decision worth knowing
//!
//! [`SandboxSpec::render`] returns an **argv**, never a shell string. There is no quoting layer,
//! so there is no quoting bug and no shell metacharacter to escape. Validation here is therefore
//! not about injection — it is about catching specs that would produce a *surprising* sandbox
//! (a relative guest path resolves against bwrap's cwd; a unit name with a slash is not a unit).
//!
//! The render is pure and platform-independent **on purpose**: it means these tests run on the
//! Windows host today, before the Linux migration lands, rather than being untestable until then.


use std::path::{Path, PathBuf};

/// One entry in the agent's filesystem view.
///
/// Anything not named here does not exist inside the namespace — it is *absent*, not denied,
/// which is the whole point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mount {
    /// The agent's own worktree. The only writable host path it should normally get.
    ReadWrite { host: PathBuf, guest: PathBuf },
    /// A store surface. Read-only so an agent cannot rewrite the plan it is working from.
    ReadOnly { host: PathBuf, guest: PathBuf },
    /// Scratch that disappears with the namespace.
    Tmpfs { guest: PathBuf },
}

/// Kernel-enforced resource ceilings for one agent.
///
/// This is the half that pays for itself independently of security: the repo has an OOM history,
/// serializes full gates behind a cross-worktree lock, and pins `jobs = 4` globally — all
/// userspace negotiation for something cgroups enforce directly.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Limits {
    /// e.g. `"2G"`. Rendered with `MemorySwapMax=0` alongside it, because a memory cap that can
    /// swap is not a cap.
    pub memory_max: Option<String>,
    pub tasks_max: Option<u32>,
    pub cpu_weight: Option<u32>,
}

/// How much of `/usr` the agent gets — the base image's ambient authority, made a choice.
///
/// The principle behind the split: **a library is data, an executable is capability.** Binding
/// `/usr/lib` wholesale hands over shared objects, which do nothing on their own. Binding
/// `/usr/bin` wholesale hands over every tool installed on the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Usr {
    /// Bind all of `/usr`. Convenient, and **ambient authority**: measured on the dev host, that
    /// is **1558 binaries**, including `bsc` and `bsc-agent` themselves. Use knowingly.
    All,
    /// Libraries wholesale; only the named binaries from `/usr/bin`.
    ///
    /// Measured with [`MINIMAL_BINS`]: `/usr/bin` goes from 1558 entries to 27, `bsc`,
    /// `bsc-agent`, `apt`, `curl` and `ssh` all become unreachable, and shell pipelines
    /// (`cat`/`grep`/`sed`/`wc`), plus `bash`, still work.
    Curated(Vec<String>),
}

/// Enough for shell pipelines and nothing else. Extend it per toolchain — a Rust worker wants
/// `cargo`/`rustc`, a Node one wants `node`/`npm` — rather than reaching for [`Usr::All`].
///
/// `dash` earns its place because `/usr/bin/sh` is a symlink to it; binding `sh` alone yields a
/// dangling link.
pub const MINIMAL_BINS: &[&str] = &[
    "basename", "bash", "cat", "cp", "cut", "dash", "date", "dirname", "env", "false", "find",
    "grep", "head", "ls", "mkdir", "mv", "printf", "rm", "sed", "sort", "tail", "tr", "true",
    "uniq", "wc", "xargs",
];

/// A language toolchain, resolved from the host, that a cage needs in order to BUILD — request #135
/// (`network-monitor:director`): a Rust-only project's workers landed in a cage with no `cargo`, no
/// `rustc`, and — because the cage is deliberately curated — no `apt`/`curl` to fetch one either. The
/// gate that was supposed to confirm every stream's work could only mark it `complete`, never
/// `verified`, because there was nothing to build or test with.
///
/// The fix is not to hand the cage a package manager and a network: `apt` would be ambient authority
/// over the host, and a worker with `--share-net` is a bigger grant than a bound compiler. It is to
/// bind the toolchain that is ALREADY installed on the host into the namespace, the same way `git`/
/// `gh` already are.
///
/// # The one posture decision in here
///
/// `RUSTUP_HOME` is bound READ-ONLY — it holds the compiler and the standard library, and nothing a
/// session does should ever edit them. `CARGO_HOME`, though, is written on every build (the registry
/// index, downloaded crates, `.package-cache`), so binding the HOST's would give every caged agent
/// write access to the crate cache every other build on the machine reads from — a poisoned entry
/// would outlive the session and cross into unrelated work. The session gets its OWN `CARGO_HOME`,
/// writable, under its stores root instead. First build in a pane re-downloads its dependencies; a
/// confused or compromised agent still cannot reach the host's cache.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Toolchain {
    /// Host→guest binds this toolchain needs.
    pub mounts: Vec<Mount>,
    /// Variables to set. A `PATH` entry here is PREPENDED to the spec's existing `PATH` rather than
    /// replacing it — see [`SandboxSpec::add_toolchain`].
    pub env: Vec<(String, String)>,
    /// Extra `/usr/bin` names to curate in, e.g. the linker a compiler shells out to.
    pub bins: Vec<String>,
}

/// Where a toolchain's read-only host bits land inside the cage. Fixed rather than caller-chosen,
/// the same reasoning as [`HOOK_GUEST_PATH`]: two subsystems have to agree on it without talking.
pub const RUSTUP_GUEST_PATH: &str = "/rustup";
/// Where the host's `cargo`/`rustc` rustup shims are bound, read-only.
pub const RUST_BIN_GUEST_PATH: &str = "/rust/bin";
/// Where the session's own, writable `CARGO_HOME` is bound.
pub const RUST_CARGO_HOME_GUEST_PATH: &str = "/cargo";

/// The binaries `rustc` shells out to that are NOT themselves part of the toolchain. Without these a
/// build compiles every crate and only then dies at the link step — the most expensive way to fail,
/// and one that reads as a Rust problem when it is a missing `cc`.
const RUST_LINK_BINS: &[&str] = &["cc", "gcc", "ld", "as", "ar"];

/// Describe the Rust toolchain for a cage, given the host's rustup layout and the writable
/// `CARGO_HOME` the session should use.
///
/// Pure — it builds a description from paths and never touches the filesystem — so the whole shape
/// is testable without a toolchain installed. The caller decides whether the host paths actually
/// exist; see `rust_toolchain_for` at the launcher for that half.
pub fn rust_toolchain(
    host_cargo_bin: &Path,
    host_rustup_home: &Path,
    session_cargo_home: &Path,
) -> Toolchain {
    Toolchain {
        mounts: vec![
            // The compiler and std, read-only. `settings.toml` lives here too, which is how the
            // shims below resolve the default toolchain — bind the directory, not just `toolchains/`.
            Mount::ReadOnly {
                host: host_rustup_home.to_path_buf(),
                guest: PathBuf::from(RUSTUP_GUEST_PATH),
            },
            // The rustup shims. They are not symlinks into the toolchain — they are rustup itself,
            // re-execing the real binary out of RUSTUP_HOME — so binding them alone would give a
            // `cargo` that cannot find a compiler.
            Mount::ReadOnly {
                host: host_cargo_bin.to_path_buf(),
                guest: PathBuf::from(RUST_BIN_GUEST_PATH),
            },
            // ...and the one writable half. See the type docs for why this is NOT the host's.
            Mount::ReadWrite {
                host: session_cargo_home.to_path_buf(),
                guest: PathBuf::from(RUST_CARGO_HOME_GUEST_PATH),
            },
        ],
        env: vec![
            ("RUSTUP_HOME".into(), RUSTUP_GUEST_PATH.into()),
            ("CARGO_HOME".into(), RUST_CARGO_HOME_GUEST_PATH.into()),
            ("PATH".into(), format!("{RUST_BIN_GUEST_PATH}:{RUST_CARGO_HOME_GUEST_PATH}/bin")),
        ],
        bins: RUST_LINK_BINS.iter().map(|s| s.to_string()).collect(),
    }
}

/// Which systemd scope wraps the namespace — i.e. where the cgroup limits are applied, if anywhere.
///
/// This exists because the obvious rendering does not work for the user agents actually run as.
/// `systemd-run --scope` creates a **system** scope and needs root or an interactive polkit prompt;
/// an ordinary user gets `Failed to start transient scope unit: Interactive authentication
/// required.` and the session dies instantly. Agents are deliberately unprivileged — #1994 gives
/// each its own Linux user — so the system scope is the one mode almost nothing can use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// `systemd-run --user --scope`. The caller's OWN systemd instance, so no privileges are
    /// needed — but there must BE one for that uid. A `useradd`-created agent has none until
    /// `loginctl enable-linger` is set for it, which belongs in provisioning.
    User,
    /// `systemd-run --scope`. A system scope: root, or a polkit prompt nobody is there to answer.
    System,
    /// No systemd wrapper at all — `bwrap` directly.
    ///
    /// **The isolation is unchanged and the LIMITS ARE GONE.** Namespaces are what confine the
    /// filesystem, pids and network; the scope only ever carried the cgroup caps. A caller landing
    /// here still gets a real cage, just an unbounded one, and must say so out loud — a session
    /// believing it has caps it does not is how a memory cap becomes a machine-wide OOM.
    None,
}

/// Where [`SandboxSpec::hook_bin`] is bound INSIDE the namespace.
///
/// Fixed rather than caller-chosen, because a session's `.claude/settings.json` has to name it and
/// that file is written by a different subsystem. A guest path both sides hard-code cannot drift;
/// a configurable one silently can, and the failure mode is a gate that never fires.
///
/// **At the root, deliberately — NOT under `/usr`.** `/usr/local/bin/bsc-hook` was the obvious
/// choice and it does not work: under [`Usr::All`] the spec does `--ro-bind /usr /usr`, and binding
/// into that needs a mountpoint created inside a read-only mount, which bwrap refuses with
/// `Can't create file at /usr/local/bin/bsc-hook: Read-only file system`. The launch fails
/// outright. Under [`Usr::Curated`] it happens to work, so the bug would have hidden until someone
/// widened a role — an end-to-end run caught it, string assertions had not.
///
/// The namespace's root is a tmpfs bwrap owns, so a mountpoint there always succeeds. There is no
/// FHS tidiness to trade away: this filesystem is constructed, not inherited.
pub const HOOK_GUEST_PATH: &str = "/bsc-hook";

/// Where [`SandboxSpec::credential_file`] is bound, relative to [`SandboxSpec::home`].
///
/// The harness reads its token from `~/.claude/.credentials.json`. Binding the WHOLE `~/.claude`
/// would hand the agent every project's transcripts and settings on the machine, so exactly this
/// one file crosses.
pub const CREDENTIAL_GUEST_REL: &str = ".claude/.credentials.json";

/// Where [`SandboxSpec::harness_state_file`] is bound, relative to [`SandboxSpec::home`].
///
/// Claude Code keeps its ONBOARDING and account state here, separately from the credential. A HOME
/// holding `.claude/.credentials.json` but no `.claude.json` reads to it as a first run, so it starts
/// the OAuth flow and asks for a pasted code — which is exactly what a caged session did, while the
/// credential it needed was sitting right beside it.
pub const HARNESS_STATE_GUEST_REL: &str = ".claude.json";

/// Where [`SandboxSpec::history_dir`] is bound, relative to [`SandboxSpec::home`].
///
/// Claude Code keeps a session's TRANSCRIPTS here, one directory per working directory. `--continue`
/// reads them, so on a tmpfs HOME there is never anything to continue: the caged designer reported
/// `has_history=false · resumed=false` on every launch and started fresh every time, while the
/// uncaged studios resumed normally from the user's real HOME.
///
/// Bound rather than made persistent wholesale, because the rest of a tmpfs HOME SHOULD die with the
/// session — this is the one part whose whole purpose is to outlive it.
pub const HISTORY_GUEST_REL: &str = ".claude/projects";

/// Where [`SandboxSpec::rc_file`] is bound INSIDE the namespace.
///
/// At the root for the same reason as [`HOOK_GUEST_PATH`]: under [`Usr::All`] a path beneath /usr
/// is a mountpoint inside a read-only bind, which bwrap refuses outright.
pub const RC_GUEST_PATH: &str = "/bsc-rc";

/// Where the session's working tree is bound INSIDE the namespace.
///
/// The guest path is FIXED and deliberately unlike the host's: a cage whose repo lived at its real
/// path would leak the host layout into every transcript. The cost is that anything the harness keys
/// on an absolute path — its per-project trust record, notably — cannot match what the user approved
/// on the host, because this path exists only inside the cage.
pub const REPO_GUEST_PATH: &str = "/repo";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxSpec {
    /// systemd scope name. Must be unit-safe: `[A-Za-z0-9_-]+`.
    ///
    /// **It must also be UNIQUE PER LAUNCH.** `systemd-run --unit=X` refuses a name that is still
    /// loaded — `Unit X.scope was already loaded or has a fragment file` — so back-to-back runs
    /// under one fixed name collide and the second simply does not start. A caller should key it
    /// on something already unique, such as the pane id.
    pub unit: String,
    pub limits: Limits,
    /// Which systemd scope carries [`Self::limits`]. [`Scope::None`] renders no wrapper and, with
    /// it, no limits — see that variant.
    pub scope: Scope,
    /// The base image. Defaults to [`Usr::Curated`] with [`MINIMAL_BINS`] — deny by default, with
    /// [`Usr::All`] as a visible escape rather than the silent status quo.
    pub usr: Usr,
    pub mounts: Vec<Mount>,
    /// Working directory *inside* the namespace, so it must be a guest path.
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// `false` (the default for a worker) unshares the network entirely.
    pub network: bool,
    /// Start from an EMPTY environment and set only what [`Self::env`] names.
    ///
    /// Without this bwrap inherits the parent's environment wholesale. Measured on a real launch:
    /// **25 variables crossed, including `GH_TOKEN` and `AWS_SECRET`** — live credentials handed
    /// to an agent that never asked for them, plus `BSC_*` host paths that mean nothing inside.
    /// With it: 2 variables, exactly what the spec declares.
    ///
    /// Defaults to `true` in [`profile::for_role`]. Setting it `false` is a deliberate,
    /// visible escape, the same way [`Usr::All`] is.
    pub clear_env: bool,
    /// Host path to the `bsc-hook` binary, bound READ-ONLY at [`HOOK_GUEST_PATH`].
    ///
    /// A mount namespace is path-granular, so it subsumes `bsc-confine` and cannot subsume
    /// `bsc-scope` (globs *within* one read-write worktree) or fully subsume `bsc-deny` (a present
    /// binary invoked with dangerous flags). Those two checks therefore have to be reachable from
    /// INSIDE, and that means a binary in the namespace.
    ///
    /// It is deliberately not `bsc`: the umbrella is ~66 MB and links a writable SQLite store,
    /// which is the ambient authority the isolation exists to remove. `bsc-hook` is 0.21 MB, opens
    /// nothing, and shares its decision logic with the umbrella via `bsc-util` so the two cannot
    /// enforce different floors.
    ///
    /// `None` ⇒ no gates inside the namespace. That is a real posture (path confinement only), not
    /// an error, so it stays expressible — but it is the weaker one and should be chosen, not
    /// defaulted into.
    pub hook_bin: Option<PathBuf>,
    /// A private `HOME` inside the namespace, backed by **tmpfs**.
    ///
    /// `None` leaves `HOME` to whatever [`Self::env`] declares — historically `/repo`, which
    /// collapses two different things that merely share a name: the session's CONFIG
    /// (`<worktree>/.claude/settings.json`, which belongs in the worktree and is read from the cwd
    /// tree) and the harness's own STATE and credentials (`~/.claude`, which does not — it would
    /// land in the git tree and outlive the session).
    ///
    /// tmpfs is the point: harness state is per-session and evaporates, so nothing accumulates in a
    /// worktree that gets recycled and no transcript survives a run.
    pub home: Option<PathBuf>,
    /// Host path to the ONE credential file bound read-only at
    /// `<home>/`[`CREDENTIAL_GUEST_REL`]. Requires [`Self::home`].
    ///
    /// This is the single deliberate secret. Before `clear_env`, 25 variables crossed by
    /// inheritance including `GH_TOKEN` and `AWS_SECRET`; this is one file, chosen, read-only, and
    /// nameable by a test.
    ///
    /// The agent can READ its own token — unavoidable, since the harness needs it to reach the
    /// model, and inherent to running an agent at all rather than introduced by the sandbox. What
    /// the sandbox adds is that it cannot MODIFY it, and that a `network: false` role cannot send
    /// it anywhere.
    pub credential_file: Option<PathBuf>,
    /// The harness's own state file, bound READ-WRITE at `<home>/`[`HARNESS_STATE_GUEST_REL`].
    /// Requires [`Self::home`].
    ///
    /// Read-write, and therefore expected to be a PER-SESSION COPY rather than the host's own file:
    /// the harness rewrites this as it runs, and a writable bind of the real one would hand the cage
    /// exactly the ambient authority it exists to remove. The app makes the copy, the same way it
    /// projects the plan store.
    pub harness_state_file: Option<PathBuf>,
    /// A PERSISTENT host directory bound READ-WRITE at `<home>/`[`HISTORY_GUEST_REL`], so the session
    /// can resume its own previous conversation. Requires [`Self::home`].
    ///
    /// The cage's HOME is a tmpfs on purpose — the harness's scratch state should not outlive the
    /// session. Transcripts are the exception: a studio is a CONTINUING conversation, and one that
    /// starts over on every launch is not the same feature. Per-session, like the state copy, and
    /// outside the git tree, which is what the tmpfs was protecting.
    ///
    /// Note the harness keys these by the working directory, and inside the cage that is always
    /// [`REPO_GUEST_PATH`] — so the key is stable across launches, which is exactly what makes
    /// resuming possible. It also means two studios sharing a host directory would share a
    /// conversation; they get one directory each instead.
    pub history_dir: Option<PathBuf>,
    /// A shell rc bound read-only at [`RC_GUEST_PATH`], for the session's init line to `source`.
    ///
    /// It exists because the init line is written to a PTY in CANONICAL MODE, where Linux caps a
    /// line at 4096 bytes and TRUNCATES beyond it. Inlining ~1.5 KB of shell helpers alongside a
    /// ~3 KB agent kickoff produced a 4332-byte line: cut mid-string, leaving an unterminated
    /// quote, so the shell sat at its `>` continuation prompt and the agent never launched.
    ///
    /// A `source` is twenty characters however large the helpers are, which is the same reason
    /// `bsc-env.sh` exists for an unsandboxed session.
    pub rc_file: Option<PathBuf>,
    pub command: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpecError {
    EmptyCommand,
    UnitNotSafe(String),
    /// A guest path must be absolute or bwrap resolves it against its own cwd.
    GuestPathNotAbsolute(PathBuf),
    HostPathNotAbsolute(PathBuf),
    EnvKeyNotSafe(String),
    /// A curated bin is a BASENAME in /usr/bin, never a path.
    BinNotABasename(String),
    /// A credential file was supplied with no `home` to bind it under. Refused rather than
    /// dropped: a silently unauthenticated session degrades quietly (see #4084's shape).
    CredentialWithoutHome,
    /// Same refusal as [`Self::CredentialWithoutHome`], for the harness state file.
    HarnessStateWithoutHome,
}

impl std::fmt::Display for SpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpecError::EmptyCommand => write!(f, "sandbox spec has no command to run"),
            SpecError::CredentialWithoutHome => write!(
                f,
                "a credential file was given with no `home` to bind it under — the session would                  launch unauthenticated, which a harness may report as missing state rather than                  as an error"
            ),
            SpecError::HarnessStateWithoutHome => write!(
                f,
                "harness state was given with no `home` to bind it under — the session would re-run onboarding and ask for a pasted OAuth code"
            ),
            SpecError::UnitNotSafe(u) => {
                write!(f, "unit name {u:?} is not unit-safe (want [A-Za-z0-9_-]+)")
            }
            SpecError::GuestPathNotAbsolute(p) => write!(
                f,
                "guest path {p:?} must be absolute — a relative one resolves against bwrap's cwd"
            ),
            SpecError::HostPathNotAbsolute(p) => write!(f, "host path {p:?} must be absolute"),
            SpecError::EnvKeyNotSafe(k) => {
                write!(f, "env key {k:?} is not a valid identifier")
            }
            SpecError::BinNotABasename(b) => write!(
                f,
                "curated binary {b:?} must be a basename in /usr/bin, not a path"
            ),
        }
    }
}

impl std::error::Error for SpecError {}

fn unit_safe(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn env_key_safe(s: &str) -> bool {
    let mut cs = s.chars();
    match cs.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Lossy on non-UTF-8 paths. Acceptable here: every path in a spec is one we constructed
/// (a worktree root, a store dir), not arbitrary user input.
fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Every path in a rendered argv is a **Linux** path — the argv describes a Linux system even
/// when the process rendering it is not running on one.
///
/// `Path::is_absolute()` cannot be used here: it is host-platform dependent, and on Windows
/// `PathBuf::from("/repo").is_absolute()` is **false** because Windows wants a drive letter. Using
/// it made every render fail on the Windows dev host while passing on Linux — i.e. it quietly
/// reintroduced exactly the platform dependence this crate exists to avoid.
fn posix_absolute(p: &Path) -> bool {
    p.to_string_lossy().starts_with('/')
}

impl SandboxSpec {
    /// A fleet worker: its own worktree writable at `/repo`, the plan store read-only at `/plan`,
    /// no network.
    ///
    /// This is the shape `tools/sandbox/namespace-escape.sh` proves closes the escape, so the
    /// convenience constructor and the demonstration cannot drift apart.
    pub fn worker(unit: impl Into<String>, worktree: impl Into<PathBuf>, store: impl Into<PathBuf>, command: Vec<String>) -> Self {
        SandboxSpec {
            unit: unit.into(),
            limits: Limits::default(),
            // The USER scope by default: agents are unprivileged, and a system scope needs root or
            // a polkit prompt nobody is there to answer. The launcher downgrades from here when it
            // probes and finds no user systemd instance.
            scope: Scope::User,
            // No history: a bare worker is a one-shot, and the escape demonstration must not depend
            // on a directory existing. The studios opt in.
            history_dir: None,
            // Deny by default. A caller that needs a toolchain widens this deliberately.
            usr: Usr::Curated(MINIMAL_BINS.iter().map(|s| s.to_string()).collect()),
            mounts: vec![
                Mount::ReadWrite { host: worktree.into(), guest: PathBuf::from(REPO_GUEST_PATH) },
                Mount::ReadOnly { host: store.into(), guest: PathBuf::from("/plan") },
            ],
            cwd: PathBuf::from(REPO_GUEST_PATH),
            // No gates by default here: this is the low-level constructor, and `profile::for_role`
            // is where a real launch picks one up. Defaulting a security binary in would make its
            // ABSENCE the silent case, which is backwards.
            hook_bin: None,
            home: None,
            credential_file: None,
            harness_state_file: None,
            rc_file: None,
            env: vec![("HOME".into(), REPO_GUEST_PATH.into())],
            network: false,
            // Deny by default here too: the spec's env is the WHOLE environment, not an overlay
            // on whatever the app happened to be holding.
            clear_env: true,
            command,
        }
    }

    pub fn with_limits(mut self, limits: Limits) -> Self {
        self.limits = limits;
        self
    }

    /// Widen or narrow the base image. Use this to add a toolchain rather than reaching for
    /// [`Usr::All`], which is ambient authority.
    pub fn with_usr(mut self, usr: Usr) -> Self {
        self.usr = usr;
        self
    }

    /// [`MINIMAL_BINS`] plus the named extras — the usual way to add a toolchain.
    pub fn curated_with(extra: &[&str]) -> Usr {
        let mut v: Vec<String> = MINIMAL_BINS.iter().map(|s| s.to_string()).collect();
        v.extend(extra.iter().map(|s| s.to_string()));
        Usr::Curated(v)
    }

    /// Fold a [`Toolchain`] (e.g. [`rust_toolchain`]) into this spec: its mounts, its variables, and
    /// its extra `/usr/bin` names.
    ///
    /// Three merges rather than three appends, because each has a way of going silently wrong:
    ///
    /// * **`PATH` is PREPENDED, never replaced.** The spec's own `PATH` is where everything the cage
    ///   already binds lives — `git`, `gh`, the harness. Setting the toolchain's `PATH` wholesale
    ///   would produce a session that can compile and cannot run a shell.
    /// * **Any other variable REPLACES** a same-named one, so a caller can correct e.g. `CARGO_HOME`
    ///   rather than ending up with two entries whose winner depends on bwrap's argument order.
    /// * **`Usr::All` is left alone.** It already has every binary; extending a curated list that is
    ///   not there would be a no-op that reads like it did something.
    pub fn add_toolchain(&mut self, tc: Toolchain) {
        self.mounts.extend(tc.mounts);

        for (k, v) in tc.env {
            if k == "PATH" {
                match self.env.iter_mut().find(|(ek, _)| ek == "PATH") {
                    Some((_, existing)) => *existing = format!("{v}:{existing}"),
                    None => self.env.push((k, v)),
                }
            } else {
                match self.env.iter_mut().find(|(ek, _)| *ek == k) {
                    Some((_, existing)) => *existing = v,
                    None => self.env.push((k, v)),
                }
            }
        }

        if let Usr::Curated(bins) = &mut self.usr {
            for b in tc.bins {
                if !bins.contains(&b) {
                    bins.push(b);
                }
            }
        }
    }

    fn validate(&self) -> Result<(), SpecError> {
        if self.command.is_empty() {
            return Err(SpecError::EmptyCommand);
        }
        if !unit_safe(&self.unit) {
            return Err(SpecError::UnitNotSafe(self.unit.clone()));
        }
        if !posix_absolute(&self.cwd) {
            return Err(SpecError::GuestPathNotAbsolute(self.cwd.clone()));
        }
        for m in &self.mounts {
            let (host, guest) = match m {
                Mount::ReadWrite { host, guest } | Mount::ReadOnly { host, guest } => {
                    (Some(host), guest)
                }
                Mount::Tmpfs { guest } => (None, guest),
            };
            if !posix_absolute(guest) {
                return Err(SpecError::GuestPathNotAbsolute(guest.clone()));
            }
            if let Some(h) = host {
                if !posix_absolute(h) {
                    return Err(SpecError::HostPathNotAbsolute(h.clone()));
                }
            }
        }
        if let Usr::Curated(bins) = &self.usr {
            for b in bins {
                // 92 is the backslash byte. Compared numerically because a literal one is
                // mangled by every layer between here and the file.
                if b.is_empty() || b.starts_with('.') || b.bytes().any(|c| c == b'/' || c == 92) {
                    return Err(SpecError::BinNotABasename(b.clone()));
                }
            }
        }
        if let Some(hb) = &self.hook_bin {
            if !posix_absolute(hb) {
                return Err(SpecError::HostPathNotAbsolute(hb.clone()));
            }
        }
        if let Some(home) = &self.home {
            if !posix_absolute(home) {
                return Err(SpecError::GuestPathNotAbsolute(home.clone()));
            }
        }
        if let Some(rc) = &self.rc_file {
            if !posix_absolute(rc) {
                return Err(SpecError::HostPathNotAbsolute(rc.clone()));
            }
        }
        if let Some(st) = &self.harness_state_file {
            if !posix_absolute(st) {
                return Err(SpecError::HostPathNotAbsolute(st.clone()));
            }
            if self.home.is_none() {
                return Err(SpecError::HarnessStateWithoutHome);
            }
        }
        if let Some(cred) = &self.credential_file {
            if !posix_absolute(cred) {
                return Err(SpecError::HostPathNotAbsolute(cred.clone()));
            }
            // A credential with nowhere to land would be silently dropped, and the session would
            // come up unauthenticated — which the harness may report as "no memory" rather than as
            // an error (the #4084 shape). Refuse instead.
            if self.home.is_none() {
                return Err(SpecError::CredentialWithoutHome);
            }
        }
        for (k, _) in &self.env {
            if !env_key_safe(k) {
                return Err(SpecError::EnvKeyNotSafe(k.clone()));
            }
        }
        Ok(())
    }

    /// The full argv: a `systemd-run` scope carrying the limits, wrapping a `bwrap` namespace,
    /// wrapping the command.
    ///
    /// The cgroup caps, as `systemd-run -p` flags. Called ONLY when a scope exists — see the note
    /// in [`render`] about why they must not be emitted otherwise.
    fn render_limits(&self, a: &mut Vec<String>) {
        if let Some(m) = &self.limits.memory_max {
            a.push("-p".into());
            a.push(format!("MemoryMax={m}"));
            // A memory cap that can swap is not a cap.
            a.push("-p".into());
            a.push("MemorySwapMax=0".into());
        }
        if let Some(t) = self.limits.tasks_max {
            a.push("-p".into());
            a.push(format!("TasksMax={t}"));
        }
        if let Some(w) = self.limits.cpu_weight {
            a.push("-p".into());
            a.push(format!("CPUWeight={w}"));
        }
    }

    /// Returns argv rather than a shell string — see the module docs.
    pub fn render(&self) -> Result<Vec<String>, SpecError> {
        self.validate()?;
        let mut a: Vec<String> = Vec::new();

        // The scope wrapper, when there is one. Under `Scope::None` the whole prefix is dropped —
        // INCLUDING the `-p` limit flags, which would otherwise be passed to a `systemd-run` that
        // is not there. Rendering caps with nowhere to apply them is how a spec looks correct and
        // enforces nothing.
        if self.scope != Scope::None {
            a.push("systemd-run".into());
            if self.scope == Scope::User {
                a.push("--user".into());
            }
            a.extend(["--scope", "--quiet", "--collect"].map(String::from));
            a.push(format!("--unit={}", self.unit));
            self.render_limits(&mut a);
            a.push("--".into());
        }

        a.push("bwrap".into());
        // --unshare-all covers mount/pid/net/user/uts/ipc/cgroup. --share-net selectively hands
        // the network back, so the default really is "no network" rather than "we remembered".
        a.push("--unshare-all".into());
        if self.network {
            a.push("--share-net".into());
        }
        a.push("--die-with-parent".into());
        // BEFORE any --setenv: bwrap applies arguments in order, so clearing after setting would
        // wipe the very variables the spec declares.
        if self.clear_env {
            a.push("--clearenv".into());
        }

        // The base image.
        match &self.usr {
            Usr::All => {
                a.extend(["--ro-bind", "/usr", "/usr"].map(String::from));
                a.extend(["--symlink", "usr/sbin", "/sbin"].map(String::from));
            }
            Usr::Curated(bins) => {
                // Libraries wholesale — they are data. /usr/lib64 holds the DYNAMIC LINKER, and
                // without it every exec fails as `execvp: No such file or directory`, which reads
                // like a missing binary and is not. `-try` because a host may not have it.
                a.extend(["--ro-bind", "/usr/lib", "/usr/lib"].map(String::from));
                a.extend(["--ro-bind-try", "/usr/lib64", "/usr/lib64"].map(String::from));
                // terminfo, ca-certificates, locale — data a normal tool expects.
                a.extend(["--ro-bind-try", "/usr/share", "/usr/share"].map(String::from));
                // GCC's own internal helpers. On current Debian/Ubuntu (gcc-14) `cc1`, `cc1plus`,
                // `lto1`, `collect2` and `liblto_plugin.so` live under `/usr/libexec/gcc/<triplet>/
                // <ver>/`, NOT `/usr/lib/gcc/...` — that older path still holds compatibility copies
                // of some files, which is exactly what makes this failure confusing: a caged agent
                // can `ls /usr/lib/gcc/.../liblto_plugin.so` and find it, while `cc` still can't,
                // because `cc`'s real search resolves to the libexec copy. Without this bind, `cc -c`
                // fails outright ("cannot execute 'cc1'") and a plain `cc foo.c` that gets past that
                // dies at link time with "-fuse-linker-plugin, but liblto_plugin.so not found" —
                // reproduced against this host's live gcc-14 and confirmed as the fix (request #144).
                // `-try`: a host whose gcc predates the libexec split has nothing here to bind.
                a.extend(["--ro-bind-try", "/usr/libexec", "/usr/libexec"].map(String::from));

                // Executables individually. Sorted and de-duplicated so the render is
                // deterministic regardless of the order a caller assembled the list in.
                let mut sorted: Vec<&String> = bins.iter().collect();
                sorted.sort();
                sorted.dedup();
                for b in sorted.iter() {
                    // `-try` so a list that is a superset across hosts does not abort the launch;
                    // a genuinely missing tool then fails at the point of use, where it is legible.
                    a.push("--ro-bind-try".into());
                    a.push(format!("/usr/bin/{b}"));
                    a.push(format!("/usr/bin/{b}"));
                }
                // /usr/bin/sh is a symlink to dash on Debian; binding `sh` would bind the link and
                // leave it dangling, so recreate it only when its target is actually in the set.
                if sorted.iter().any(|b| b.as_str() == "dash") {
                    a.extend(["--symlink", "dash", "/usr/bin/sh"].map(String::from));
                }
                // No /usr/sbin is bound, so point /sbin at the curated bin dir rather than at a
                // path that does not exist.
                a.extend(["--symlink", "usr/bin", "/sbin"].map(String::from));
            }
        }
        // A network role needs the machinery to USE the network, and none of it lives in /usr.
        // Without this the cage shares a network namespace and still cannot reach anything:
        // Claude Code reported `Failed to connect to api.anthropic.com: ETIMEOUT`, which is DNS
        // failing for want of a resolver, not a routing problem.
        //
        //   resolv.conf     the nameserver list — no DNS at all without it
        //   nsswitch.conf   how glibc resolves names in the first place
        //   hosts           the local overrides glibc consults first
        //   ssl             the CA bundle; TLS fails even once DNS works
        //
        // Bound ONLY when the network is shared. A role with `network: false` has nothing to
        // resolve and nothing to verify, so it gets none of it — the cage stays as small as the
        // role's job allows, which is the same rule the curated /usr follows.
        if self.network {
            for f in ["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts"] {
                a.push("--ro-bind-try".into());
                a.push(f.into());
                a.push(f.into());
            }
            a.extend(["--ro-bind-try", "/etc/ssl", "/etc/ssl"].map(String::from));
            a.extend(["--ro-bind-try", "/usr/lib/ssl", "/usr/lib/ssl"].map(String::from));
        }
        a.extend(["--symlink", "usr/lib", "/lib"].map(String::from));
        a.extend(["--symlink", "usr/lib64", "/lib64"].map(String::from));
        a.extend(["--symlink", "usr/bin", "/bin"].map(String::from));
        a.extend(["--proc", "/proc"].map(String::from));
        a.extend(["--dev", "/dev"].map(String::from));
        a.extend(["--tmpfs", "/tmp"].map(String::from));

        // The PreToolUse gates a sandboxed session can actually reach. Bound AFTER the /usr arm so
        // a curated bind cannot overmount it, and BEFORE the caller's mounts so a caller cannot
        // shadow the gate with one of its own — a security check that a later mount can hide is not
        // a check.
        if let Some(hb) = &self.hook_bin {
            a.push("--ro-bind".into());
            a.push(s(hb));
            a.push(HOOK_GUEST_PATH.to_string());
        }

        // A private HOME on tmpfs, plus the one credential file. Both before the caller's mounts,
        // for the same reason the gate is: a later mount must not be able to shadow either.
        //
        // bwrap CREATES the intermediate dirs when the destination sits on a tmpfs it owns, so
        // `<home>/.claude/` needs no prior mkdir — verified by running it, after the hook bind
        // taught us that binding into a READ-ONLY mount fails instead.
        if let Some(rc) = &self.rc_file {
            a.push("--ro-bind".into());
            a.push(s(rc));
            a.push(RC_GUEST_PATH.to_string());
        }
        if let Some(home) = &self.home {
            a.push("--tmpfs".into());
            a.push(s(home));
            if let Some(cred) = &self.credential_file {
                a.push("--ro-bind".into());
                a.push(s(cred));
                // Joined as a STRING with an explicit '/', never `PathBuf::join`: that uses the
                // HOST separator, so rendering this spec on Windows produced
                // `/home/agent\.claude/.credentials.json` — a backslash inside a POSIX guest path.
                // Same family as the `Path::is_absolute()` bug: host-platform path handling has no
                // business constructing guest paths. A test pins the separator.
                let h = s(home);
                a.push(format!("{}/{}", h.trim_end_matches('/'), CREDENTIAL_GUEST_REL));
            }
            // READ-WRITE, unlike the credential: the harness rewrites its own state as it runs, and a
            // read-only bind would make every write fail rather than make the session stateless. Safe
            // because the caller binds a per-session COPY — see the field's docs.
            if let Some(st) = &self.harness_state_file {
                a.push("--bind".into());
                a.push(s(st));
                // Same string join as above: `PathBuf::join` would use the HOST separator and emit a
                // backslash into a POSIX guest path when rendered on Windows.
                let h = s(home);
                a.push(format!("{}/{}", h.trim_end_matches('/'), HARNESS_STATE_GUEST_REL));
            }
            // The one part of HOME that must SURVIVE the session — see the field's docs. Bound after
            // the credential and the state file so it cannot be shadowed by either: bwrap applies
            // mounts in order, and `.claude/projects` sits under the same `.claude` the credential
            // creates.
            if let Some(hist) = &self.history_dir {
                a.push("--bind".into());
                a.push(s(hist));
                let h = s(home);
                a.push(format!("{}/{}", h.trim_end_matches('/'), HISTORY_GUEST_REL));
            }
        }

        for m in &self.mounts {
            match m {
                Mount::ReadWrite { host, guest } => {
                    a.push("--bind".into());
                    a.push(s(host));
                    a.push(s(guest));
                }
                Mount::ReadOnly { host, guest } => {
                    a.push("--ro-bind".into());
                    a.push(s(host));
                    a.push(s(guest));
                }
                Mount::Tmpfs { guest } => {
                    a.push("--tmpfs".into());
                    a.push(s(guest));
                }
            }
        }

        a.push("--chdir".into());
        a.push(s(&self.cwd));
        for (k, v) in &self.env {
            a.push("--setenv".into());
            a.push(k.clone());
            a.push(v.clone());
        }

        a.push("--".into());
        a.extend(self.command.iter().cloned());
        Ok(a)
    }
}

/// The pane's per-session stores directory: `<base>/sandbox-stores/<safe(pane_id)>`.
///
/// Pulled out of the launcher so a REPLAY (`bsc sandbox replay <pane-id>`) computes the SAME path
/// from a bare pane id — the sanitizer (alnum/`-` kept, everything else folded to `_`) has to be
/// byte-identical on both sides, or a replay looks in a directory the launcher never wrote to.
pub fn sandbox_stores_root(base: &Path, pane_id: &str) -> PathBuf {
    let safe: String = pane_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    base.join("sandbox-stores").join(safe)
}

/// Where [`write_launch_argv`] persists a rendered namespace launch, inside [`sandbox_stores_root`].
pub const LAUNCH_ARGV_FILE: &str = "launch-argv";

/// Persist a rendered argv so a LATER `bsc sandbox replay <pane-id>` can reconstruct the exact same
/// cage a launch actually used.
///
/// This exists because nothing else does: the launcher only ever logged a SUMMARY ("N store(s), N
/// outbox(es)"), never the argv itself, so reproducing a real cage outside the app meant grepping
/// `journalctl` for a debug line that was never written there — a real dev session tried exactly
/// that and had no way to get the argv back out (request #135).
///
/// NUL-joined, one trailing NUL per element: an argv element is a C string and can therefore never
/// itself CONTAIN a NUL, which makes this the one separator that needs no quoting layer at all — the
/// same reasoning [`SandboxSpec::render`] leans on for returning an argv rather than a shell string.
pub fn write_launch_argv(stores_root: &Path, argv: &[String]) -> std::io::Result<()> {
    let mut buf = Vec::new();
    for a in argv {
        buf.extend_from_slice(a.as_bytes());
        buf.push(0);
    }
    std::fs::write(stores_root.join(LAUNCH_ARGV_FILE), buf)
}

/// The inverse of [`write_launch_argv`].
pub fn read_launch_argv(stores_root: &Path) -> std::io::Result<Vec<String>> {
    let raw = std::fs::read(stores_root.join(LAUNCH_ARGV_FILE))?;
    let mut parts: Vec<String> =
        raw.split(|&b| b == 0).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
    // The writer's trailing NUL splits into one final EMPTY element — drop exactly that one, not
    // every empty element, so a genuinely empty argv entry in the middle survives the round trip.
    if parts.last().map(String::is_empty).unwrap_or(false) {
        parts.pop();
    }
    Ok(parts)
}

/// The two guest hooks a namespaced launch installs (`SANDBOXED_HOOKS` in
/// `@/app/console/lib/sessionLaunch`), and the host shell function each stands in for outside a
/// mount namespace — the same two functions `console/shell_rc.rs` installs via `BASH_ENV` on every
/// unsandboxed session.
const GUEST_TO_HOST_HOOKS: &[(&str, &str)] = &[("scope", "bsc-scope"), ("bash-deny", "bsc-deny")];

/// The host shell function standing in for one `/bsc-hook <verb>` guest command, or `None` when
/// `command` does not name a guest hook at all (every other hook a settings.json carries is already
/// host-resolvable, and this must not touch those).
fn host_hook_equivalent(command: &str) -> Option<&'static str> {
    let verb = command.strip_prefix(HOOK_GUEST_PATH)?.strip_prefix(' ')?;
    GUEST_TO_HOST_HOOKS.iter().find(|(guest, _)| *guest == verb).map(|(_, host)| *host)
}

fn rewrite_guest_commands(v: &mut serde_json::Value, changed: &mut bool) {
    match v {
        serde_json::Value::String(s) => {
            if let Some(host) = host_hook_equivalent(s) {
                *s = host.to_string();
                *changed = true;
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                rewrite_guest_commands(item, changed);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values_mut() {
                rewrite_guest_commands(item, changed);
            }
        }
        _ => {}
    }
}

/// Rewrite a `.claude/settings.json` `hooks` block IN PLACE, replacing every `{HOOK_GUEST_PATH}
/// <verb>` PreToolUse command with its host-resolvable shell-function equivalent. Returns whether
/// anything changed.
///
/// This is the REPAIR half of `hook_floor_mismatch` (`session/settings.rs` in the desktop crate):
/// that function detects a session whose hooks name a path that resolves only inside a mount
/// namespace while the session is NOT running in one — the PreToolUse gate then fails to execute,
/// **non-blocking**, so the session runs with no write-scope gate and no dangerous-command floor.
/// The mapping here is total and derived, not guessed: `scope`/`bash-deny` are the only two guest
/// verbs a namespaced launch ever installs, and `bsc-scope`/`bsc-deny` are their exact host
/// counterparts — so there is no case where keeping the stale guest path is the right answer, and
/// this never asks, it always fixes.
///
/// Pure string substitution over the JSON tree rather than a structural rebuild: a settings file
/// nests commands at `hooks.<event>[].hooks[].command` alongside every OTHER hook (`bsc-audit`,
/// `bsc-confine`, the turn-accounting pair, …) this function knows nothing about, and a rebuild
/// would have to reconstruct all of it. Substitution is the identity-preserving edit a stale guest
/// path actually needs.
pub fn rewrite_guest_hooks(config: &mut serde_json::Value) -> bool {
    let mut changed = false;
    if let Some(hooks) = config.get_mut("hooks") {
        rewrite_guest_commands(hooks, &mut changed);
    }
    changed
}

#[cfg(test)]
mod hook_repair_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rewrites_both_guest_commands_to_their_host_equivalents() {
        let mut config = json!({
            "hooks": {
                "PreToolUse": [
                    {"matcher": "Edit|Write|MultiEdit|NotebookEdit", "hooks": [{"type": "command", "command": "/bsc-hook scope"}]},
                    {"matcher": "Bash", "hooks": [{"type": "command", "command": "/bsc-hook bash-deny"}]}
                ]
            }
        });
        assert!(rewrite_guest_hooks(&mut config));
        let dumped = config.to_string();
        assert!(dumped.contains("bsc-scope"), "{dumped}");
        assert!(dumped.contains("bsc-deny"), "{dumped}");
        assert!(!dumped.contains(HOOK_GUEST_PATH), "{dumped}");
    }

    #[test]
    fn a_settings_file_with_no_guest_hooks_is_left_untouched() {
        let mut config = json!({
            "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "bsc-deny"}]}]}
        });
        let before = config.clone();
        assert!(!rewrite_guest_hooks(&mut config));
        assert_eq!(config, before);
    }

    #[test]
    fn a_config_with_no_hooks_key_at_all_is_a_no_op_not_a_panic() {
        let mut config = json!({"permissions": {}});
        assert!(!rewrite_guest_hooks(&mut config));
    }

    #[test]
    fn does_not_mangle_a_command_that_merely_starts_with_the_guest_path() {
        // A hypothetical `/bsc-hook-other` binary must not be treated as the guest hook — the guest
        // path must be followed by a SPACE, not just a shared prefix.
        let mut config = json!({
            "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "/bsc-hook-other thing"}]}]}
        });
        assert!(!rewrite_guest_hooks(&mut config));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SandboxSpec {
        SandboxSpec::worker(
            "bsc-agent-abc123",
            "/home/k/wt/repo--stream",
            "/home/k/.base-studio-code/plans",
            vec!["claude".into(), "--continue".into()],
        )
    }

    fn idx(a: &[String], needle: &str) -> Option<usize> {
        a.iter().position(|x| x == needle)
    }

    #[test]
    fn command_is_last_and_after_the_final_separator() {
        let a = spec().render().unwrap();
        let last_sep = a.iter().rposition(|x| x == "--").unwrap();
        assert_eq!(&a[last_sep + 1..], &["claude".to_string(), "--continue".to_string()]);
    }

    #[test]
    fn worker_gets_its_worktree_writable_and_the_store_read_only() {
        let a = spec().render().unwrap();
        let bind = idx(&a, "--bind").unwrap();
        assert_eq!(a[bind + 2], "/repo");
        let ro = a
            .iter()
            .enumerate()
            .find(|(i, x)| *x == "--ro-bind" && a[i + 2] == "/plan")
            .map(|(i, _)| i)
            .expect("store must be mounted read-only at /plan");
        assert_eq!(a[ro + 2], "/plan");
    }

    #[test]
    fn a_network_role_gets_what_it_takes_to_actually_use_the_network() {
        // Sharing the netns is not enough: without a resolver the cage reaches nothing, which is
        // how Claude Code timed out on api.anthropic.com inside a worker that HAD --share-net.
        let mut sp = spec();
        sp.network = true;
        let a = sp.render().unwrap();
        for f in ["/etc/resolv.conf", "/etc/nsswitch.conf", "/etc/hosts"] {
            assert!(a.windows(3).any(|w| w[0] == "--ro-bind-try" && w[1] == f && w[2] == f),
                    "{f} must be bound for a network role: {a:?}");
        }
        assert!(a.iter().any(|x| x == "/etc/ssl"), "and the CA bundle, or TLS fails: {a:?}");
    }

    #[test]
    fn a_no_network_role_gets_no_resolver_and_no_ca_bundle() {
        // Nothing to resolve and nothing to verify, so the cage stays smaller — the same rule the
        // curated /usr follows.
        let a = spec().render().unwrap();          // network is off by default
        assert!(!a.iter().any(|x| x == "/etc/resolv.conf"));
        assert!(!a.iter().any(|x| x == "/etc/ssl"));
    }

    #[test]
    fn network_is_off_unless_asked_for() {
        let a = spec().render().unwrap();
        assert!(idx(&a, "--unshare-all").is_some());
        assert!(idx(&a, "--share-net").is_none(), "worker must not get the network");

        let mut s = spec();
        s.network = true;
        assert!(idx(&s.render().unwrap(), "--share-net").is_some());
    }

    #[test]
    fn memory_cap_always_disables_swap() {
        // A cap that can swap is not a cap, so the two must never be separable.
        let a = spec()
            .with_limits(Limits { memory_max: Some("2G".into()), ..Default::default() })
            .render()
            .unwrap();
        assert!(a.contains(&"MemoryMax=2G".to_string()));
        assert!(a.contains(&"MemorySwapMax=0".to_string()));
    }

    #[test]
    fn absent_limits_render_nothing() {
        let a = spec().render().unwrap();
        assert!(!a.iter().any(|x| x.starts_with("MemoryMax")));
        assert!(!a.iter().any(|x| x.starts_with("TasksMax")));
        assert!(!a.iter().any(|x| x.starts_with("CPUWeight")));
    }

    // ── the scope, and what each mode actually costs ────────────────────────────────────────

    #[test]
    fn the_user_scope_needs_no_privileges_and_says_so_in_the_argv() {
        // The default, because agents are unprivileged. `--user` MUST precede `--scope`, which is
        // how systemd-run reads it.
        let a = spec().render().unwrap();
        assert_eq!(a[0], "systemd-run");
        assert_eq!(a[1], "--user");
        assert!(a.contains(&"--scope".to_string()));
    }

    #[test]
    fn the_system_scope_is_the_one_that_needs_root() {
        // Kept expressible, not default: it is what produced `Failed to start transient scope
        // unit: Interactive authentication required.` for an ordinary user.
        let mut sp = spec();
        sp.scope = Scope::System;
        let a = sp.render().unwrap();
        assert_eq!(a[0], "systemd-run");
        assert!(!a.contains(&"--user".to_string()));
    }

    #[test]
    fn no_scope_means_bwrap_directly_and_the_isolation_is_unchanged() {
        let mut sp = spec();
        sp.scope = Scope::None;
        let a = sp.render().unwrap();
        assert_eq!(a[0], "bwrap", "no wrapper at all: {a:?}");
        assert!(!a.iter().any(|x| x == "systemd-run"));
        // The cage itself is untouched — that is the whole point of the fallback being acceptable.
        assert!(a.iter().any(|x| x == "--unshare-all"));
        assert!(a.windows(3).any(|w| w[0] == "--bind" && w[2] == "/repo"));
    }

    #[test]
    fn no_scope_drops_the_limits_rather_than_rendering_them_nowhere() {
        // The failure this guards is subtle: `-p MemoryMax=…` with no `systemd-run` in front is
        // either a bwrap argument error or silently meaningless, and either way a caller reading
        // the spec would believe the cap applies. Losing the caps is acceptable; PRETENDING to
        // have them is not.
        let mut sp = spec();
        sp.limits = Limits {
            memory_max: Some("2G".into()),
            tasks_max: Some(64),
            cpu_weight: Some(50),
        };
        sp.scope = Scope::None;
        let a = sp.render().unwrap();
        assert!(!a.iter().any(|x| x == "-p"), "no -p flags without a scope: {a:?}");
        assert!(!a.iter().any(|x| x.starts_with("MemoryMax")));
        assert!(!a.iter().any(|x| x.starts_with("TasksMax")));
        // ...and the SAME limits do render when there is a scope to carry them.
        sp.scope = Scope::User;
        let b = sp.render().unwrap();
        assert!(b.iter().any(|x| x == "MemoryMax=2G"));
        assert!(b.iter().any(|x| x == "TasksMax=64"));
    }

    #[test]
    fn limits_render_when_set() {
        let a = spec()
            .with_limits(Limits {
                memory_max: Some("512M".into()),
                tasks_max: Some(64),
                cpu_weight: Some(50),
            })
            .render()
            .unwrap();
        assert!(a.contains(&"TasksMax=64".to_string()));
        assert!(a.contains(&"CPUWeight=50".to_string()));
    }

    #[test]
    fn base_image_is_always_present() {
        let a = spec().render().unwrap();
        for flag in ["--proc", "--dev", "--tmpfs", "--die-with-parent"] {
            assert!(idx(&a, flag).is_some(), "missing {flag}");
        }
    }

    #[test]
    fn env_renders_as_setenv_pairs() {
        let a = spec().render().unwrap();
        let i = idx(&a, "--setenv").unwrap();
        assert_eq!(a[i + 1], "HOME");
        assert_eq!(a[i + 2], "/repo");
    }

    #[test]
    fn empty_command_is_refused() {
        let mut s = spec();
        s.command.clear();
        assert_eq!(s.render().unwrap_err(), SpecError::EmptyCommand);
    }

    #[test]
    fn unit_name_must_be_unit_safe() {
        for bad in ["has space", "has/slash", "", "semi;colon"] {
            let mut s = spec();
            s.unit = bad.into();
            assert_eq!(s.render().unwrap_err(), SpecError::UnitNotSafe(bad.into()));
        }
    }

    #[test]
    fn relative_guest_path_is_refused() {
        // bwrap would resolve it against its own cwd, which is not what any caller means.
        let mut s = spec();
        s.mounts.push(Mount::Tmpfs { guest: PathBuf::from("scratch") });
        assert_eq!(
            s.render().unwrap_err(),
            SpecError::GuestPathNotAbsolute(PathBuf::from("scratch"))
        );
    }

    #[test]
    fn bad_env_key_is_refused() {
        let mut s = spec();
        s.env.push(("2BAD".into(), "x".into()));
        assert_eq!(s.render().unwrap_err(), SpecError::EnvKeyNotSafe("2BAD".into()));
    }

    #[test]
    fn posix_paths_validate_identically_on_every_host() {
        // REGRESSION. validate() originally used Path::is_absolute(), which is host-platform
        // dependent: on Windows PathBuf::from("/repo").is_absolute() is FALSE. Every render
        // therefore failed on the Windows dev host while passing on Linux — quietly
        // reintroducing the platform dependence this crate exists to avoid. Caught only because
        // the tests were written to run on the host we are actually developing on.
        assert!(spec().render().is_ok(), "a POSIX spec must render on ANY host");

        // A host-native absolute path is still not a Linux path, and must be refused.
        let mut s = spec();
        s.cwd = PathBuf::from("C:/repo");
        assert_eq!(
            s.render().unwrap_err(),
            SpecError::GuestPathNotAbsolute(PathBuf::from("C:/repo"))
        );
    }

    #[test]
    fn nothing_outside_the_spec_is_bound() {
        // The guarantee is that a path not named is ABSENT. Under the curated default the only
        // host paths bound are the library dirs and the worktree/store the spec asked for —
        // every executable is named individually and lives under /usr/bin.
        let a = spec().render().unwrap();
        let bound: Vec<&String> = a
            .iter()
            .enumerate()
            .filter(|(i, x)| {
                (*x == "--bind" || *x == "--ro-bind" || *x == "--ro-bind-try") && i + 2 < a.len()
            })
            .map(|(i, _)| &a[i + 1])
            .filter(|p| !p.starts_with("/usr/bin/"))
            .collect();
        assert_eq!(
            bound,
            vec![
                "/usr/lib",
                "/usr/lib64",
                "/usr/share",
                "/usr/libexec",
                "/home/k/wt/repo--stream",
                "/home/k/.base-studio-code/plans"
            ]
        );
    }

    #[test]
    fn worker_denies_by_default_and_all_of_usr_is_never_implicit() {
        // Measured: binding /usr wholesale exposes 1558 binaries including bsc itself. The
        // default must be the curated set, with Usr::All reachable only by asking for it.
        let a = spec().render().unwrap();
        assert!(
            !a.windows(3).any(|w| w[0] == "--ro-bind" && w[1] == "/usr" && w[2] == "/usr"),
            "the default must NOT bind all of /usr"
        );
        assert!(matches!(spec().usr, Usr::Curated(_)));

        let all = spec().with_usr(Usr::All).render().unwrap();
        assert!(all.windows(3).any(|w| w[0] == "--ro-bind" && w[1] == "/usr" && w[2] == "/usr"));
    }

    #[test]
    fn curated_binds_each_executable_individually() {
        let a = spec().render().unwrap();
        for b in ["cat", "grep", "sed", "bash", "dash"] {
            assert!(
                a.windows(3).any(|w| w[0] == "--ro-bind-try"
                    && w[1] == format!("/usr/bin/{b}")
                    && w[2] == format!("/usr/bin/{b}")),
                "missing {b}"
            );
        }
        // Nothing the set did not name.
        for b in ["bsc", "bsc-agent", "apt", "curl", "ssh"] {
            assert!(
                !a.iter().any(|x| x == &format!("/usr/bin/{b}")),
                "{b} must not be reachable"
            );
        }
    }

    #[test]
    fn lib64_is_bound_because_it_holds_the_dynamic_linker() {
        // Omitting it makes every exec fail as `execvp: No such file or directory`, which reads
        // like a missing binary and is not. Found the hard way.
        let a = spec().render().unwrap();
        assert!(a.windows(3).any(|w| w[0] == "--ro-bind-try" && w[1] == "/usr/lib64"));
        assert!(a.windows(3).any(|w| w[0] == "--ro-bind" && w[1] == "/usr/lib"));
    }

    /// Request #144: a real gcc-14 host keeps `cc1`/`cc1plus`/`lto1`/`liblto_plugin.so` under
    /// `/usr/libexec/gcc/<triplet>/<ver>/`, not `/usr/lib/gcc/...` — binding only `/usr/lib` leaves a
    /// curated cage where `cc` execs but `cc -c` fails ("cannot execute 'cc1'") and a bare link fails
    /// with "-fuse-linker-plugin, but liblto_plugin.so not found" despite the file being visible
    /// under `/usr/lib/gcc/...` (a stale compatibility copy, not the one gcc actually searches for).
    /// Reproduced live against this host's gcc-14 with a hand-built bwrap invocation before this fix,
    /// and confirmed fixed by adding this bind. `-try`, like the other library dirs: a host whose gcc
    /// predates the libexec split has nothing here to bind, and that must not abort the launch.
    #[test]
    fn libexec_is_bound_so_gccs_internal_helpers_are_reachable() {
        let a = spec().render().unwrap();
        assert!(
            a.windows(3).any(|w| w[0] == "--ro-bind-try" && w[1] == "/usr/libexec" && w[2] == "/usr/libexec"),
            "gcc-14's cc1/lto1/liblto_plugin.so live under /usr/libexec/gcc/... on current Debian/Ubuntu"
        );
    }

    #[test]
    fn sh_symlink_is_emitted_only_when_its_target_is_in_the_set() {
        // /usr/bin/sh is a symlink to dash; recreating it without dash leaves a dangling link.
        let a = spec().render().unwrap();
        assert!(a.windows(3).any(|w| w[0] == "--symlink" && w[1] == "dash" && w[2] == "/usr/bin/sh"));

        let no_dash = spec().with_usr(Usr::Curated(vec!["cat".into()])).render().unwrap();
        assert!(!no_dash.iter().any(|x| x == "/usr/bin/sh"));
    }

    #[test]
    fn curated_render_is_deterministic_regardless_of_caller_order() {
        let a = spec().with_usr(Usr::Curated(vec!["sed".into(), "cat".into(), "cat".into()]));
        let b = spec().with_usr(Usr::Curated(vec!["cat".into(), "sed".into()]));
        assert_eq!(a.render().unwrap(), b.render().unwrap());
    }

    #[test]
    fn curated_with_extends_the_minimal_set() {
        let usr = SandboxSpec::curated_with(&["cargo", "rustc"]);
        let a = spec().with_usr(usr).render().unwrap();
        for b in ["cargo", "rustc", "cat"] {
            assert!(a.iter().any(|x| x == &format!("/usr/bin/{b}")), "missing {b}");
        }
    }

    #[test]
    fn a_curated_bin_must_be_a_basename() {
        for bad in ["/usr/bin/cat", "../cat", ".hidden", ""] {
            let sp = spec().with_usr(Usr::Curated(vec![bad.into()]));
            assert_eq!(sp.render().unwrap_err(), SpecError::BinNotABasename(bad.into()));
        }
    }

    // ── the Rust toolchain — request #143 (network-monitor:director) ──────────────────────────

    /// A toolchain must not be able to make the rest of the cage unreachable. `PATH` is the sharp
    /// edge: the spec's own `/usr/local/bin:/usr/bin:/bin` is where `bash`, `git`, `gh` and the
    /// harness are bound, so a toolchain that REPLACED it would produce a session that can compile
    /// and cannot run a shell.
    #[test]
    fn a_toolchain_prepends_to_path_and_never_replaces_it() {
        let mut sp = spec();
        sp.env = vec![
            ("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into()),
            ("TERM".into(), "xterm".into()),
        ];
        sp.add_toolchain(rust_toolchain(
            Path::new("/h/.cargo/bin"),
            Path::new("/h/.rustup"),
            Path::new("/h/stores/pane/cargo"),
        ));
        let path = sp.env.iter().find(|(k, _)| k == "PATH").map(|(_, v)| v.clone()).unwrap();
        assert_eq!(path, "/rust/bin:/cargo/bin:/usr/local/bin:/usr/bin:/bin");
        assert_eq!(sp.env.iter().filter(|(k, _)| k == "PATH").count(), 1, "PATH must not be duplicated");
        assert!(sp.env.iter().any(|(k, v)| k == "TERM" && v == "xterm"), "unrelated vars survive");
    }

    /// The posture decision, pinned: the compiler is read-only and the cache is NOT the host's.
    /// Binding the host `CARGO_HOME` writable would let any caged agent poison the crate cache every
    /// other build on the machine reads from, which outlives the session entirely.
    #[test]
    fn the_toolchain_is_read_only_except_the_sessions_own_cargo_home() {
        let tc = rust_toolchain(
            Path::new("/h/.cargo/bin"),
            Path::new("/h/.rustup"),
            Path::new("/h/stores/pane/cargo"),
        );
        let ro: Vec<_> = tc
            .mounts
            .iter()
            .filter_map(|m| match m {
                Mount::ReadOnly { host, .. } => Some(host.clone()),
                _ => None,
            })
            .collect();
        let rw: Vec<_> = tc
            .mounts
            .iter()
            .filter_map(|m| match m {
                Mount::ReadWrite { host, .. } => Some(host.clone()),
                _ => None,
            })
            .collect();
        assert!(ro.contains(&PathBuf::from("/h/.rustup")), "RUSTUP_HOME must be read-only");
        assert!(ro.contains(&PathBuf::from("/h/.cargo/bin")), "the shims must be read-only");
        assert_eq!(
            rw,
            vec![PathBuf::from("/h/stores/pane/cargo")],
            "the ONLY writable path is the session's own CARGO_HOME"
        );
    }

    /// A compiler with no linker compiles everything and then dies at the last step — the most
    /// expensive possible failure, and one that reads as a Rust problem when it is a missing `cc`.
    #[test]
    fn the_linker_is_curated_in_alongside_the_compiler() {
        let mut sp = spec();
        sp.usr = Usr::Curated(vec!["bash".into(), "cc".into()]);
        sp.add_toolchain(rust_toolchain(Path::new("/h/.cargo/bin"), Path::new("/h/.rustup"), Path::new("/h/c")));
        let Usr::Curated(bins) = &sp.usr else { panic!("still curated") };
        for need in ["cc", "ld", "as", "ar"] {
            assert!(bins.contains(&need.to_string()), "missing linker bin {need}");
        }
        assert_eq!(bins.iter().filter(|b| *b == "cc").count(), 1, "an already-present bin is not duplicated");
        assert!(bins.contains(&"bash".to_string()), "the existing set survives");
    }

    /// `Usr::All` already has every binary, so extending a curated list that is not there would be a
    /// no-op that reads like it did something.
    #[test]
    fn adding_a_toolchain_to_usr_all_changes_no_bins() {
        let mut sp = spec();
        sp.usr = Usr::All;
        sp.add_toolchain(rust_toolchain(Path::new("/h/.cargo/bin"), Path::new("/h/.rustup"), Path::new("/h/c")));
        assert_eq!(sp.usr, Usr::All);
    }

    /// The render end to end: a worker whose spec got a toolchain actually has `cargo`/`rustc`
    /// reachable via the shim bind, and the render still succeeds (the toolchain's guest paths are
    /// absolute, so `validate()` accepts them).
    #[test]
    fn a_worker_with_a_toolchain_renders_the_rust_bin_mount() {
        let mut sp = spec();
        sp.add_toolchain(rust_toolchain(Path::new("/h/.cargo/bin"), Path::new("/h/.rustup"), Path::new("/h/c")));
        let a = sp.render().unwrap();
        assert!(a.windows(3).any(|w| w[0] == "--ro-bind" && w[1] == "/h/.cargo/bin" && w[2] == RUST_BIN_GUEST_PATH));
        assert!(a.windows(3).any(|w| w[0] == "--ro-bind" && w[1] == "/h/.rustup" && w[2] == RUSTUP_GUEST_PATH));
        assert!(a.windows(3).any(|w| w[0] == "--bind" && w[1] == "/h/c" && w[2] == RUST_CARGO_HOME_GUEST_PATH));
    }
}

#[cfg(test)]
mod clear_env_tests {
    use super::*;

    fn spec() -> SandboxSpec {
        SandboxSpec::worker("u", "/wt", "/store", vec!["sh".into()])
    }

    #[test]
    fn a_worker_starts_from_an_empty_environment() {
        // Without this, bwrap inherits the parent's environment wholesale. MEASURED on a real
        // launch: 25 variables crossed, including GH_TOKEN and AWS_SECRET — live credentials
        // handed to an agent that never asked for them.
        assert!(spec().clear_env, "deny by default");
        let a = spec().render().unwrap();
        assert!(a.contains(&"--clearenv".to_string()));
    }

    #[test]
    fn clearenv_precedes_every_setenv_or_it_wipes_them() {
        // bwrap applies arguments IN ORDER. Clearing after setting would drop the very variables
        // the spec declares, which fails silently as "the shell has no HOME".
        let a = spec().render().unwrap();
        let clear = a.iter().position(|x| x == "--clearenv").unwrap();
        let first_set = a.iter().position(|x| x == "--setenv").unwrap();
        assert!(clear < first_set, "--clearenv must come first");
    }

    #[test]
    fn opting_out_is_possible_but_must_be_explicit() {
        // The escape exists — some caller may genuinely need the host environment — but it is a
        // visible field, not the default, exactly like Usr::All.
        let mut s = spec();
        s.clear_env = false;
        assert!(!s.render().unwrap().contains(&"--clearenv".to_string()));
    }

    #[test]
    fn the_declared_env_still_crosses() {
        // Clearing must not defeat the spec: HOME is what makes /repo the agent's home.
        let a = spec().render().unwrap();
        let i = a.iter().position(|x| x == "--setenv").unwrap();
        assert_eq!(a[i + 1], "HOME");
        assert_eq!(a[i + 2], "/repo");
    }
}

#[cfg(test)]
mod launch_argv_tests {
    use super::*;

    #[test]
    fn the_stores_root_sanitizes_the_pane_id_like_the_launcher_does() {
        // Byte-identical to the launcher's own sanitizer (console/pty/mod.rs) — a replay computes
        // this path from a bare pane id, with no access to what the launcher actually used.
        let root = sandbox_stores_root(Path::new("/base"), "studio:worker-1/x");
        assert_eq!(root, PathBuf::from("/base/sandbox-stores/studio_worker-1_x"));
    }

    #[test]
    fn a_written_argv_round_trips_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let argv: Vec<String> = vec![
            "bwrap".into(),
            "--bind".into(),
            "/home/agent work".into(), // a space, to prove there is no shell-quoting layer
            "".into(),                 // a genuinely empty element, mid-argv
            "/repo".into(),
        ];
        write_launch_argv(dir.path(), &argv).unwrap();
        assert_eq!(read_launch_argv(dir.path()).unwrap(), argv);
    }

    #[test]
    fn reading_a_launch_that_was_never_written_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_launch_argv(dir.path()).is_err());
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/profile.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-sandbox--<module>.rs
//     bsc graph impl set --id bsc-sandbox--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-sandbox--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));