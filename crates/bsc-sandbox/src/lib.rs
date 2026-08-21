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

pub mod profile;

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
}

impl std::fmt::Display for SpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpecError::EmptyCommand => write!(f, "sandbox spec has no command to run"),
            SpecError::CredentialWithoutHome => write!(
                f,
                "a credential file was given with no `home` to bind it under — the session would                  launch unauthenticated, which a harness may report as missing state rather than                  as an error"
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
            // Deny by default. A caller that needs a toolchain widens this deliberately.
            usr: Usr::Curated(MINIMAL_BINS.iter().map(|s| s.to_string()).collect()),
            mounts: vec![
                Mount::ReadWrite { host: worktree.into(), guest: PathBuf::from("/repo") },
                Mount::ReadOnly { host: store.into(), guest: PathBuf::from("/plan") },
            ],
            cwd: PathBuf::from("/repo"),
            // No gates by default here: this is the low-level constructor, and `profile::for_role`
            // is where a real launch picks one up. Defaulting a security binary in would make its
            // ABSENCE the silent case, which is backwards.
            hook_bin: None,
            home: None,
            credential_file: None,
            env: vec![("HOME".into(), "/repo".into())],
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
