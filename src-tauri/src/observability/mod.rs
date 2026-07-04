//! Observability (#1300): managed log streams, performance metrics, and token accounting.

use std::sync::{Mutex, MutexGuard};

pub mod collector;
pub mod logs;
pub mod perf;
pub mod pty_faults;
pub mod tokens;

/// Lock a `Mutex`, recovering the guard from a poisoned lock (a panic while another holder had
/// it) instead of propagating the poison. Observability state — the config knobs plus the perf
/// ring and DB handle — stays safe to read after such a panic, so this is the single home for
/// the `lock().unwrap_or_else(|e| e.into_inner())` recovery idiom shared by `logs.rs`/`perf.rs`.
pub(crate) fn lock_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A `Clone`able config value guarded by a poison-tolerant `Mutex` (via `lock_recover`). The
/// shared shape behind `LogState`: held in memory, read as a clone via `get`, replaced wholesale
/// via `set`. (`perf`'s state carries more than a config — tracked PIDs, a ring buffer, the DB
/// handle — so it keeps its own `Mutex<PerfInner>` and only shares `lock_recover`.)
pub(crate) struct MutexConfig<T>(pub Mutex<T>);

impl<T: Clone> MutexConfig<T> {
    pub fn new(value: T) -> Self {
        Self(Mutex::new(value))
    }
    /// A clone of the current config.
    pub fn get(&self) -> T {
        lock_recover(&self.0).clone()
    }
    /// Replace the config wholesale.
    pub fn set(&self, value: T) {
        *lock_recover(&self.0) = value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutex_config_get_returns_clone_and_set_replaces() {
        let cfg = MutexConfig::new(7u32);
        assert_eq!(cfg.get(), 7);
        cfg.set(42);
        assert_eq!(cfg.get(), 42);
    }

    #[test]
    fn lock_recover_returns_guard_through_poison() {
        let m = Mutex::new(3u32);
        // Poison the mutex: panic while the guard is held.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("poison it");
        }));
        assert!(m.is_poisoned());
        // The idiom recovers the inner value rather than propagating the poison.
        *lock_recover(&m) += 1;
        assert_eq!(*lock_recover(&m), 4);
    }
}
