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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxSpec {
    /// systemd scope name. Must be unit-safe: `[A-Za-z0-9_-]+`.
    pub unit: String,
    pub limits: Limits,
    /// The base image. Defaults to [`Usr::Curated`] with [`MINIMAL_BINS`] — deny by default, with
    /// [`Usr::All`] as a visible escape rather than the silent status quo.
    pub usr: Usr,
    pub mounts: Vec<Mount>,
    /// Working directory *inside* the namespace, so it must be a guest path.
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// `false` (the default for a worker) unshares the network entirely.
    pub network: bool,
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
}

impl std::fmt::Display for SpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpecError::EmptyCommand => write!(f, "sandbox spec has no command to run"),
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
            // Deny by default. A caller that needs a toolchain widens this deliberately.
            usr: Usr::Curated(MINIMAL_BINS.iter().map(|s| s.to_string()).collect()),
            mounts: vec![
                Mount::ReadWrite { host: worktree.into(), guest: PathBuf::from("/repo") },
                Mount::ReadOnly { host: store.into(), guest: PathBuf::from("/plan") },
            ],
            cwd: PathBuf::from("/repo"),
            env: vec![("HOME".into(), "/repo".into())],
            network: false,
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
    /// Returns argv rather than a shell string — see the module docs.
    pub fn render(&self) -> Result<Vec<String>, SpecError> {
        self.validate()?;
        let mut a: Vec<String> = Vec::new();

        a.extend(["systemd-run", "--scope", "--quiet", "--collect"].map(String::from));
        a.push(format!("--unit={}", self.unit));
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
        a.push("--".into());

        a.push("bwrap".into());
        // --unshare-all covers mount/pid/net/user/uts/ipc/cgroup. --share-net selectively hands
        // the network back, so the default really is "no network" rather than "we remembered".
        a.push("--unshare-all".into());
        if self.network {
            a.push("--share-net".into());
        }
        a.push("--die-with-parent".into());

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
