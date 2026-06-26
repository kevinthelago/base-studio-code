//! `bsc-util` (#1646) — the tiny, dependency-free home for the few primitives that were
//! copy-pasted (with subtly divergent behavior) across the desktop app and the `bsc-*` CLIs:
//!
//!   - [`home_dir`] / [`bsc_base_dir`] — resolve the user's home and the
//!     `~/.base-studio-code` base dir. **ONE precedence**, so the app and every CLI agree on
//!     which store they read/write (see the latent Windows bug fixed below).
//!   - [`now_secs`] / [`now_ms`] — the epoch clock (formerly re-implemented in
//!     `compliance`, `research`, `bsc-agent`, `perf`).
//!   - [`epoch_ms_to_iso8601`] / [`iso8601_to_epoch_ms`] — the civil-date pair (Howard
//!     Hinnant's algorithm, no `chrono`/`time` dep), formerly split between
//!     `logs::days_from_civil` and `bsc-agent`'s `epoch_to_iso8601`.
//!
//! Pure (no I/O beyond reading env vars), std-only, so it links into the leanest CLI for free.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// The user's home directory, resolved WITHOUT a `dirs`/`home` crate.
///
/// # Precedence (the fix for #1646)
/// On Windows: `USERPROFILE`, then `HOME`. On Unix: `HOME`.
///
/// This deliberately matches what the **desktop app** (`platform/paths.rs`) has always
/// resolved, because real installs already persist `~/.base-studio-code` under that path. The
/// `bsc-*` CLIs previously resolved `HOME`-first on every platform, so under **Git Bash on
/// Windows** (which sets `HOME` to an MSYS path) the app and the CLIs landed on *different*
/// `~/.base-studio-code` dirs and silently read/wrote separate stores. Unifying on the app's
/// order keeps every process pointed at the one store users already have data in — choosing the
/// CLIs' order instead would orphan that data. Empty values are treated as unset (so an empty
/// `USERPROFILE` falls through to `HOME` on Windows).
///
/// Returns `None` when no usable home variable is set.
pub fn home_dir() -> Option<PathBuf> {
    let pick = |key: &str| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
    };
    if cfg!(windows) {
        pick("USERPROFILE").or_else(|| pick("HOME"))
    } else {
        pick("HOME")
    }
}

/// The `~/.base-studio-code` base directory — the root of every app/CLI on-disk store
/// (projects, logs, skills.db, compliance, research cache, …). `None` when [`home_dir`] is unset.
pub fn bsc_base_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".base-studio-code"))
}

/// Current Unix time in **seconds** (0 if the clock is before the epoch).
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Current Unix time in **milliseconds** (0 if the clock is before the epoch).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Epoch **milliseconds** → `YYYY-MM-DDTHH:MM:SSZ` (UTC, second resolution), no external crate.
///
/// Uses Howard Hinnant's civil-from-days algorithm so timestamps match the `bsc-*` helpers'
/// `date -u +%Y-%m-%dT%H:%M:%SZ` output. Sub-second precision is dropped (the format has none).
pub fn epoch_ms_to_iso8601(ms: i64) -> String {
    let secs = ms.div_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `YYYY-MM-DDTHH:MM:SSZ` (UTC) → epoch **milliseconds**, the inverse of [`epoch_ms_to_iso8601`].
/// Returns `None` on a malformed value. (The seconds field defaults to `00` if absent; a trailing
/// `Z` is optional.)
pub fn iso8601_to_epoch_ms(ts: &str) -> Option<i64> {
    let ts = ts.trim();
    let (date, time) = ts.split_once('T')?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let da: i64 = d.next()?.parse().ok()?;
    let time = time.trim_end_matches('Z');
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let s: i64 = t.next().unwrap_or("0").parse().ok()?;
    let days = days_from_civil(y, mo, da);
    Some((days * 86_400 + h * 3_600 + mi * 60 + s) * 1_000)
}

/// Days since the Unix epoch for a civil (y, m, d) date — Howard Hinnant's algorithm (no deps).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    // home_dir() reads process-wide env vars; serialize the tests that mutate them.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        _lock: MutexGuard<'static, ()>,
        home: Option<std::ffi::OsString>,
        userprofile: Option<std::ffi::OsString>,
    }
    impl EnvGuard {
        fn take() -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let g = EnvGuard {
                _lock: lock,
                home: std::env::var_os("HOME"),
                userprofile: std::env::var_os("USERPROFILE"),
            };
            std::env::remove_var("HOME");
            std::env::remove_var("USERPROFILE");
            g
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match &self.userprofile {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
        }
    }

    /// Pins the chosen precedence (#1646): on Windows `USERPROFILE` wins over `HOME`; on Unix
    /// only `HOME` is consulted. This is the regression guard for the latent split that had the
    /// app and the CLIs resolving different `~/.base-studio-code` dirs under Git Bash on Windows.
    #[test]
    fn home_dir_precedence_matches_the_app() {
        let _g = EnvGuard::take();

        // Both set: the platform-preferred var wins.
        std::env::set_var("USERPROFILE", "C:/Users/win");
        std::env::set_var("HOME", "/home/nix");
        if cfg!(windows) {
            assert_eq!(home_dir(), Some(PathBuf::from("C:/Users/win")));
        } else {
            assert_eq!(home_dir(), Some(PathBuf::from("/home/nix")));
        }

        // On Windows, an empty USERPROFILE falls through to HOME; on Unix HOME still wins.
        std::env::set_var("USERPROFILE", "");
        assert_eq!(home_dir(), Some(PathBuf::from("/home/nix")));

        // Nothing usable set ⇒ None, and bsc_base_dir is None too.
        std::env::remove_var("HOME");
        std::env::remove_var("USERPROFILE");
        assert_eq!(home_dir(), None);
        assert_eq!(bsc_base_dir(), None);
    }

    #[test]
    fn bsc_base_dir_appends_the_dotdir() {
        let _g = EnvGuard::take();
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        std::env::set_var(key, "/somewhere");
        assert_eq!(bsc_base_dir(), Some(PathBuf::from("/somewhere").join(".base-studio-code")));
    }

    #[test]
    fn iso8601_formats_known_epochs() {
        assert_eq!(epoch_ms_to_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(epoch_ms_to_iso8601(1_700_000_000_000), "2023-11-14T22:13:20Z");
        // Sub-second precision is dropped, not rounded.
        assert_eq!(epoch_ms_to_iso8601(1_999), "1970-01-01T00:00:01Z");
    }

    #[test]
    fn iso8601_parses_and_round_trips() {
        assert_eq!(iso8601_to_epoch_ms("1970-01-01T00:00:01Z"), Some(1_000));
        assert_eq!(iso8601_to_epoch_ms("2026-06-26T10:04:59Z"), Some(1_782_468_299_000));
        // The seconds field is optional.
        assert_eq!(iso8601_to_epoch_ms("1970-01-01T00:00"), Some(0));
        assert_eq!(iso8601_to_epoch_ms("not-a-time"), None);
        // Round-trips through both directions at second resolution.
        let ms = 1_782_468_299_000;
        assert_eq!(iso8601_to_epoch_ms(&epoch_ms_to_iso8601(ms)), Some(ms));
    }

    #[test]
    fn now_is_monotonic_ish_and_consistent() {
        assert!(now_secs() > 1_700_000_000);
        assert!(now_ms() >= now_secs() * 1_000);
    }
}
