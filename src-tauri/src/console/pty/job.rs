// Process-tree kill primitive for a PTY shell: a Windows Job Object (kill-on-close)
// or, on Unix, the shell's process-group id reaped with `killpg` on drop. Each PTY
// session owns one so dropping the session reclaims the whole tree — `claude`, any
// `gh`/`git`/MCP child, etc. (extracted from pty.rs, #1660).

/// RAII wrapper around a Windows Job Object configured to kill every assigned
/// process when the last handle closes. We give each PTY shell its own job and
/// assign the shell's PID right after spawn, so dropping the session on
/// `pty_kill` / app exit terminates the whole tree (shell → `claude` → any
/// `gh`/`git`/MCP child). Without this, `portable_pty::Child::kill()` only
/// reaches the immediate shell — observed in the field as ~28 orphan
/// `bash`/`claude`/WebView children holding cwd locks after app exit.
#[cfg(windows)]
pub(super) struct PtyJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

/// Unix counterpart of the Job Object: the process-group id of the PTY shell.
/// `portable_pty` runs `setsid()` in the spawned shell, so the shell leads a new
/// session and a process group whose pgid equals the shell's pid. Every child it
/// spawns (`claude`, `gh`, `git`, MCP servers) stays in that group unless it
/// re-`setsid`s, so `killpg(pgid, SIGKILL)` on drop terminates the whole tree —
/// the same orphan-leak fix the Windows job provides. Stored in an atomic so
/// `assign_pid(&self, …)` can record the pid through the shared `new()`/
/// `assign_pid` call site without `&mut`; `PtyJob` stays `Send + Sync`.
#[cfg(not(windows))]
pub(super) struct PtyJob {
    pgid: std::sync::atomic::AtomicI32,
}

#[cfg(windows)]
impl PtyJob {
    /// Create a kill-on-close job. Returns `Err` if the kernel refuses; the
    /// caller logs and proceeds without tree-kill rather than failing the spawn.
    pub(super) fn new() -> std::io::Result<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: NULL attributes + NULL name is the documented anonymous-job
        // form; the call returns a valid HANDLE or NULL on failure.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // Zero-init is the documented way to start an EXTENDED_LIMIT_INFORMATION
        // and then set only the flags we care about.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: pointer + size match the JobObjectExtendedLimitInformation
        // information class.
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            // Don't leak the handle when configuration fails.
            unsafe { CloseHandle(handle); }
            return Err(err);
        }
        Ok(Self { handle })
    }

    /// Assign the process identified by `pid` to this job. The process's later
    /// descendants inherit job membership (modern Windows nested-job default),
    /// so the whole tree shares the job's kill-on-close fate. Opens a transient
    /// process handle with `PROCESS_SET_QUOTA | PROCESS_TERMINATE` — the minimum
    /// access `AssignProcessToJobObject` requires.
    pub(super) fn assign_pid(&self, pid: u32) -> std::io::Result<()> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        // SAFETY: OpenProcess returns a valid HANDLE or NULL on failure.
        let proc = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if proc.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: both handles are valid until we close `proc` below.
        let ok = unsafe { AssignProcessToJobObject(self.handle, proc) };
        let err = if ok == 0 { Some(std::io::Error::last_os_error()) } else { None };
        unsafe { CloseHandle(proc); }
        match err { Some(e) => Err(e), None => Ok(()) }
    }
}

#[cfg(windows)]
impl Drop for PtyJob {
    fn drop(&mut self) {
        // Closing the last handle on a KILL_ON_JOB_CLOSE job terminates every
        // process still in the job — that's the actual tree kill.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle); }
    }
}

// SAFETY: a job HANDLE is an opaque OS-side reference; the kernel handles
// cross-thread access. We never expose the raw handle outside this module.
#[cfg(windows)]
unsafe impl Send for PtyJob {}
#[cfg(windows)]
unsafe impl Sync for PtyJob {}

#[cfg(not(windows))]
impl PtyJob {
    /// Create an unbound job. The shell's process group isn't known until after
    /// spawn, so `pgid` starts at 0 (no-op on drop) and is filled by `assign_pid`.
    /// Infallible — the `Result` mirrors the Windows signature for a shared call
    /// site.
    pub(super) fn new() -> std::io::Result<Self> {
        Ok(Self { pgid: std::sync::atomic::AtomicI32::new(0) })
    }

    /// Record the shell's pid as the group to reap. Because `portable_pty`
    /// `setsid`s the child, the shell IS its group leader, so pgid == pid — no
    /// `getpgid` round-trip (which could race the child's `setsid`). Infallible;
    /// the `Result` mirrors the Windows signature.
    pub(super) fn assign_pid(&self, pid: u32) -> std::io::Result<()> {
        self.pgid.store(pid as i32, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(not(windows))]
impl Drop for PtyJob {
    fn drop(&mut self) {
        let pgid = self.pgid.load(std::sync::atomic::Ordering::Relaxed);
        if pgid > 0 {
            // SAFETY: `killpg` takes a pgid + signal and has no memory effects.
            // A negative-or-zero pgid is excluded above; ESRCH (group already
            // gone — every member exited and was reaped) is the benign no-op
            // case, so we ignore the return value. SIGKILL (not SIGTERM) matches
            // the Windows job's unconditional kill-on-close and can't be trapped,
            // guaranteeing no surviving `claude`/`gh`/`git` descendants.
            unsafe { libc::killpg(pgid, libc::SIGKILL); }
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(any(windows, unix))]
    use super::PtyJob;

    /// Loadbearing claim of the orphan-kill fix: dropping the job handle kills
    /// every assigned process (and its descendants). Spawn a ~30 s `ping` —
    /// without the kill we'd hit the deadline; with it the process exits in
    /// milliseconds. Windows-only; the Unix tree-kill is covered by
    /// `pty_job_drop_kills_process_group` below.
    #[cfg(windows)]
    #[test]
    fn pty_job_drop_kills_assigned_process() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let mut child = Command::new("cmd")
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ping for job-kill test");

        let job = PtyJob::new().expect("create job object");
        job.assign_pid(child.id()).expect("assign ping pid to job");

        // Closing the only handle on a KILL_ON_JOB_CLOSE job must terminate
        // every assigned process — that's the orphan kill.
        drop(job);

        let mut exited = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => panic!("try_wait failed: {e}"),
            }
        }
        // Always reap before asserting so the test never leaks a Child handle
        // (satisfies clippy::zombie_processes); kill() is a harmless no-op once
        // the job already terminated it.
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            exited,
            "ping survived 2s after job drop — kill-on-close not effective"
        );
    }

    /// Loadbearing claim of the Unix orphan-kill fix (#118): dropping the job
    /// must reap the shell's WHOLE process group, not just the immediate child —
    /// otherwise `claude`/`gh`/`git` grandchildren leak and hold cwd locks. Mimic
    /// the real spawn: a shell that `setsid`s (so pgid == its pid, exactly what
    /// `portable_pty` does) and backgrounds a 30 s `sleep` GRANDCHILD in that same
    /// group. After `assign_pid` + drop, the grandchild — which `Child::kill()`
    /// alone would never reach — must be gone well inside its 30 s sleep.
    #[cfg(unix)]
    #[test]
    fn pty_job_drop_kills_process_group() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        // `echo $!` prints the backgrounded sleep's pid (the grandchild), then the
        // shell `wait`s so it stays group leader while we operate on the group.
        let mut child = {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30 & echo $!; wait"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            // SAFETY: pre_exec runs in the forked child before exec; `setsid` only
            // creates a new session/process group and has no async-signal-unsafe
            // allocation. This reproduces portable_pty's child setup so pgid == pid.
            unsafe {
                c.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            c.spawn().expect("spawn sh for group-kill test")
        };

        let grandchild: i32 = {
            let stdout = child.stdout.take().expect("piped stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read grandchild pid");
            line.trim().parse().expect("parse grandchild pid")
        };

        let job = PtyJob::new().expect("create job");
        job.assign_pid(child.id()).expect("assign shell pid to job");

        // Drop must `killpg(pgid, SIGKILL)` the whole group — shell AND the
        // backgrounded sleep grandchild.
        drop(job);
        // Reap the direct child so it doesn't linger as a zombie; the grandchild
        // is reparented to init, which reaps it once SIGKILL lands.
        let _ = child.wait();

        // SAFETY: `kill(pid, 0)` performs only an existence/permission check, no
        // signal delivery; returns 0 while the process exists (incl. zombie) and
        // -1/ESRCH once it's gone. Poll until the grandchild disappears.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if unsafe { libc::kill(grandchild, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // Best-effort cleanup before failing so we don't leak a 30 s sleep.
        unsafe { libc::kill(grandchild, libc::SIGKILL); }
        panic!("grandchild {grandchild} survived job drop — process-group kill not effective");
    }
}
