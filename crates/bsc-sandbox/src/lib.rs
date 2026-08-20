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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxSpec {
    /// systemd scope name. Must be unit-safe: `[A-Za-z0-9_-]+`.
    pub unit: String,
    pub limits: Limits,
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

        // The base image. /usr read-only plus the usrmerge symlinks is the minimum that lets a
        // normal toolchain run; everything else the agent sees is what the spec names.
        a.extend(["--ro-bind", "/usr", "/usr"].map(String::from));
        a.extend(["--symlink", "usr/lib", "/lib"].map(String::from));
        a.extend(["--symlink", "usr/lib64", "/lib64"].map(String::from));
        a.extend(["--symlink", "usr/bin", "/bin"].map(String::from));
        a.extend(["--symlink", "usr/sbin", "/sbin"].map(String::from));
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
        // The guarantee is that a path not named is ABSENT. Only /usr comes from the base image;
        // every other host bind must have been asked for.
        let a = spec().render().unwrap();
        let bound: Vec<&String> = a
            .iter()
            .enumerate()
            .filter(|(i, x)| (*x == "--bind" || *x == "--ro-bind") && i + 2 < a.len())
            .map(|(i, _)| &a[i + 1])
            .collect();
        assert_eq!(
            bound,
            vec!["/usr", "/home/k/wt/repo--stream", "/home/k/.base-studio-code/plans"]
        );
    }
}
