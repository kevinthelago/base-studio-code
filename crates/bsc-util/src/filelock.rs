//! A named, cross-process, cross-session file lock under `~/.base-studio-code/locks/` —
//! the same directory `scripts/gateLock.mjs`'s full-gate slot lock already uses, generalized here so
//! any `bsc` verb can take a lock on something outside its own process (request #185: two sessions
//! running `git merge --no-ff` in the SAME `wt-integrate` working directory at once raced each other's
//! git state — an in-progress conflict resolution from one session was visible, mid-resolution, to a
//! `git status` run by the other).
//!
//! ## Staleness is TIME-ONLY, not pid-liveness — and that is deliberate
//!
//! The gate slot lock (`scripts/gateLock.mjs`) steals a lock once its holder's PID is dead. That is
//! right for a lock held only while ONE PROCESS runs. It is wrong here: `bsc plan integrate` is meant
//! to be held ACROSS its own process exiting — a merge conflict needs a human or an agent to resolve it
//! over several separate commands (edit, `git add`, `git commit`), and the `bsc plan integrate` call
//! that hit the conflict is long gone by the time that happens ([`FileLock::leak`]). Checking "is that
//! pid alive" would declare the lock abandoned the instant the conflicted merge returns control to the
//! shell — exactly the moment it must stay held. So the only staleness signal here is age past
//! `max_age_ms`, the same fail-open shape for the same reason: a lock nobody is coming back to must not
//! wedge every future caller forever, but a lock actively in use must not be second-guessed.

use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where every named lock lives.
pub fn locks_dir() -> Option<PathBuf> {
    crate::bsc_base_dir().map(|b| b.join("locks"))
}

/// A stable, filesystem-safe lock name scoped to `dir` — its CANONICALIZED path, hashed, so two
/// different directories that merely share a basename (`wt-integrate` under two different repos) never
/// collide, and the same directory maps to the same lock file no matter which cwd a caller started
/// from. `prefix` namespaces the lock kind (e.g. `"integrate"`) so a future second use of this module
/// cannot collide with this one on the same path.
pub fn lock_name(prefix: &str, dir: &Path) -> String {
    let canon = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let mut h = std::collections::hash_map::DefaultHasher::new();
    canon.hash(&mut h);
    format!("{prefix}-{:016x}.lock", h.finish())
}

/// What a held lock's on-disk record says about its holder.
#[derive(Debug, Clone, Default)]
pub struct LockInfo {
    pub pid: u32,
    pub at_ms: i64,
}

/// A held lock. Dropping it releases automatically — the path for a clean, uneventful operation. A
/// caller that means the lock to OUTLIVE this process (see module doc) calls [`FileLock::leak`]
/// instead, which is the only way a lock survives past `main` returning.
pub struct FileLock {
    path: PathBuf,
    released: bool,
}

impl FileLock {
    /// Release now.
    pub fn release(mut self) {
        self.do_release();
    }

    fn do_release(&mut self) {
        if !self.released {
            let _ = fs::remove_file(&self.path);
            self.released = true;
        }
    }

    /// Leave the lock ON DISK past this guard's drop — the deliberate "still working on it, outside
    /// this process" path (a merge conflict, a multi-step manual fix). The caller is responsible for
    /// releasing it later ([`release_named`]), or it ages out via `max_age_ms`.
    pub fn leak(mut self) {
        self.released = true; // Drop then does nothing — the file is left in place.
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        self.do_release();
    }
}

fn record_now() -> String {
    format!("{{\"pid\":{},\"at\":{}}}", std::process::id(), crate::now_ms())
}

/// Hand-rolled: this crate is dependency-free by design (see the crate doc), so no `serde_json` here
/// for two integer fields.
fn parse_record(s: &str) -> Option<LockInfo> {
    let pid = extract_num(s, "\"pid\":")?;
    let at_ms = extract_num(s, "\"at\":")?;
    Some(LockInfo { pid: pid as u32, at_ms })
}

fn extract_num(s: &str, key: &str) -> Option<i64> {
    let i = s.find(key)? + key.len();
    let rest = &s[i..];
    let end = rest.find(|c: char| !c.is_ascii_digit() && c != '-').unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// Try to claim `name` once. `Ok(None)` when it is already held and not yet stale — the caller
/// retries or reports "busy" rather than blocking. A holder older than `max_age_ms` is stolen.
pub fn try_claim(name: &str, max_age_ms: i64) -> std::io::Result<Option<FileLock>> {
    let dir = locks_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir ($HOME/$USERPROFILE unset)"))?;
    fs::create_dir_all(&dir)?;
    let path = dir.join(name);
    let record = record_now();

    match File::options().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            f.write_all(record.as_bytes())?;
            return Ok(Some(FileLock { path, released: false }));
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }

    // Occupied. Unreadable/truncated is treated as abandoned rather than fatal — a half-written lock
    // file must not wedge every future caller.
    let held = fs::read_to_string(&path).ok().and_then(|s| parse_record(&s));
    let stale = match held {
        Some(h) => crate::now_ms().saturating_sub(h.at_ms) > max_age_ms,
        None => true,
    };
    if !stale {
        return Ok(None);
    }
    // Steal it. Losing the race to steal (someone else got there first) is fine — report "not
    // claimed" and let the caller retry, same as an ordinary busy lock.
    let _ = fs::remove_file(&path);
    match File::options().write(true).create_new(true).open(&path) {
        Ok(mut f) => {
            f.write_all(record.as_bytes())?;
            Ok(Some(FileLock { path, released: false }))
        }
        Err(_) => Ok(None),
    }
}

/// Block until `name` is free, claim it, and return the guard. `on_wait` fires once, the first time
/// the lock is found busy, with the current holder's info — a caller uses this for a "waiting on the
/// wt-integrate lock" notice, since a silent wait is indistinguishable from a hang (the same reason
/// the gate slot lock announces once before it starts polling quietly).
pub fn acquire_blocking(
    name: &str,
    max_age_ms: i64,
    poll: Duration,
    mut on_wait: impl FnMut(&LockInfo),
) -> std::io::Result<FileLock> {
    let mut announced = false;
    loop {
        if let Some(l) = try_claim(name, max_age_ms)? {
            return Ok(l);
        }
        if !announced {
            announced = true;
            let dir = locks_dir()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no home dir"))?;
            if let Some(h) = fs::read_to_string(dir.join(name)).ok().and_then(|s| parse_record(&s)) {
                on_wait(&h);
            }
        }
        std::thread::sleep(poll);
    }
}

/// Whether `name` is currently held (and not stale) — a read-only check for a caller that wants to
/// report status without racing to claim it itself.
pub fn is_held(name: &str, max_age_ms: i64) -> bool {
    let Some(dir) = locks_dir() else { return false };
    let Some(info) = fs::read_to_string(dir.join(name)).ok().and_then(|s| parse_record(&s)) else {
        return false;
    };
    crate::now_ms().saturating_sub(info.at_ms) <= max_age_ms
}

/// Release a lock by name directly — for a SEPARATE process/command finishing what an earlier,
/// already-exited holder left held via [`FileLock::leak`]. Returns whether anything was actually
/// there to release.
pub fn release_named(name: &str) -> std::io::Result<bool> {
    let Some(dir) = locks_dir() else { return Ok(false) };
    let path = dir.join(name);
    if path.exists() {
        fs::remove_file(&path)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // `locks_dir()` is keyed off `$HOME`/`$USERPROFILE`, process-global env state — tests that touch
    // it must not interleave with each other or with any other test in this crate that reads $HOME.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct HomeGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        prior: Option<String>,
        var: &'static str,
    }
    impl HomeGuard {
        fn set(dir: &Path) -> Self {
            let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            let prior = std::env::var(var).ok();
            std::env::set_var(var, dir);
            Self { _guard: guard, prior, var }
        }
    }
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prior {
                Some(v) => std::env::set_var(self.var, v),
                None => std::env::remove_var(self.var),
            }
        }
    }

    fn tmp_home() -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("bsc-filelock-test-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = fs::create_dir_all(&p);
        p
    }

    #[test]
    fn a_second_claim_is_refused_while_the_first_is_fresh() {
        let home = tmp_home();
        let _g = HomeGuard::set(&home);
        let l1 = try_claim("t-fresh", 60_000).unwrap();
        assert!(l1.is_some(), "first claim succeeds");
        let l2 = try_claim("t-fresh", 60_000).unwrap();
        assert!(l2.is_none(), "second claim is refused while the first is held and fresh");
        l1.unwrap().release();
    }

    #[test]
    fn release_frees_it_for_the_next_claim() {
        let home = tmp_home();
        let _g = HomeGuard::set(&home);
        let l1 = try_claim("t-release", 60_000).unwrap().unwrap();
        l1.release();
        let l2 = try_claim("t-release", 60_000).unwrap();
        assert!(l2.is_some(), "a released lock can be reclaimed immediately");
    }

    #[test]
    fn leak_survives_the_guard_dropping() {
        let home = tmp_home();
        let _g = HomeGuard::set(&home);
        let l1 = try_claim("t-leak", 60_000).unwrap().unwrap();
        l1.leak();
        // The guard is gone (out of scope), but the file must still be there.
        let l2 = try_claim("t-leak", 60_000).unwrap();
        assert!(l2.is_none(), "a leaked lock stays held after its guard drops");
        assert!(is_held("t-leak", 60_000));
        release_named("t-leak").unwrap();
    }

    #[test]
    fn a_stale_lock_is_stolen() {
        let home = tmp_home();
        let _g = HomeGuard::set(&home);
        let l1 = try_claim("t-stale", 60_000).unwrap().unwrap();
        l1.leak();
        // max_age_ms = 0: anything already written a moment ago now counts as stale.
        std::thread::sleep(Duration::from_millis(2));
        let l2 = try_claim("t-stale", 0).unwrap();
        assert!(l2.is_some(), "an aged-out lock is stolen rather than wedging every caller forever");
        l2.unwrap().release();
    }

    #[test]
    fn release_named_reports_whether_anything_was_there() {
        let home = tmp_home();
        let _g = HomeGuard::set(&home);
        assert!(!release_named("t-nothing").unwrap(), "nothing was held");
        let l1 = try_claim("t-something", 60_000).unwrap().unwrap();
        l1.leak();
        assert!(release_named("t-something").unwrap(), "the held lock was released");
    }

    #[test]
    fn lock_name_is_stable_and_distinguishes_directories() {
        let a = std::env::temp_dir();
        let b = std::env::temp_dir().join("elsewhere");
        let n1 = lock_name("integrate", &a);
        let n2 = lock_name("integrate", &a);
        assert_eq!(n1, n2, "the same directory always maps to the same lock name");
        let n3 = lock_name("integrate", &b);
        assert_ne!(n1, n3, "different directories must not collide even with a shared basename elsewhere");
    }
}
