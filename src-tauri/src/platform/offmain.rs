//! Running a blocking command body OFF Tauri's main thread.
//!
//! **A plain sync `#[tauri::command]` runs on the MAIN THREAD.** Confirmed against
//! `tauri-macros`' `wrapper.rs`: a command with no `asyncness` takes the `body_blocking` path and
//! executes inline on the thread that received the IPC message. The main thread is also the window
//! event loop, so a command that does file/SQLite/process I/O does not merely delay the *next*
//! invoke — it stalls the UI itself. That is why the app freezes under fleet load rather than
//! simply lagging.
//!
//! Measured from one live app log (`[invoke]` lines): `logs_usage` alone occupied **1477.8s across
//! 3169 calls**, 86% of all main-thread command time. The tell that this is queueing rather than
//! slow work is that trivial commands share the same tail — `dir_exists` at 1594ms, and a cluster
//! of unrelated commands all topping out together near 17s.
//!
//! `#[tauri::command(async)]` is NOT the fix. On a sync fn the macro maps to `"sync_threadpool"` and
//! `body_async` calls the body *inside* the async block, so the work lands on a tokio WORKER. That
//! frees the main thread but trades a 1-wide queue for an n-worker one, and saturating the workers
//! stalls every other async task — including tasks awaiting a `spawn_blocking` result. Blocking work
//! belongs on the blocking pool, which is the shape #4074 already used for the `bsc` command.
//!
//! ## Concurrency is a real behaviour change, not a pure speedup
//!
//! Sync commands were implicitly serialized by sharing the main thread. Moving one off means it can
//! now overlap with every other command. That is safe for a PURE READ and is why this slice converts
//! only pure readers — a concurrent read of a log file or a `.db` has nothing to race. A command
//! that mutates shared state needs that reasoning done for it individually before it moves.

/// Run `f` on the blocking pool and await its value, yielding `fallback` if the task could not run.
///
/// For commands whose return type cannot express failure (`Vec<T>`, a map, a plain value) — the
/// fallback stands in for the empty/degraded result the caller already handles. A join error means
/// the task panicked or the runtime is shutting down; it is logged rather than swallowed silently,
/// because a command that quietly returns "nothing" looks exactly like a store that is genuinely
/// empty.
///
/// # Panics
/// Never. A panic inside `f` is contained by the blocking pool and surfaces as `fallback`.
pub(crate) async fn blocking_or<T, F>(label: &str, fallback: T, f: F) -> T
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(v) => v,
        Err(e) => {
            log::warn!("{label}: blocking task failed to run ({e}); returning the fallback");
            fallback
        }
    }
}

#[cfg(test)]
mod tests {
    use super::blocking_or;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// The whole point of the helper, pinned as a contract: a trivial call is NOT queued behind
    /// blocking ones. On the main thread it necessarily would be — that is one FIFO lane — so this
    /// asserts the property the fairness slice exists to deliver.
    ///
    /// Deliberately an ORDERING assertion, not a wall-clock one. This repo gates under heavy
    /// concurrent load (several worktree agents building at once), so "finished in under N ms" would
    /// flake for reasons that have nothing to do with the code. Counting how many blockers had
    /// finished when the quick call returned is robust at any speed: if the quick call were behind
    /// them in one lane, every blocker would necessarily have completed first.
    #[test]
    fn a_quick_call_does_not_wait_behind_blocking_ones() {
        const BLOCKERS: usize = 8;
        let done = Arc::new(AtomicUsize::new(0));

        let observed = tauri::async_runtime::block_on(async {
            let handles: Vec<_> = (0..BLOCKERS)
                .map(|_| {
                    let done = Arc::clone(&done);
                    tauri::async_runtime::spawn(async move {
                        blocking_or("blocker", (), move || {
                            std::thread::sleep(std::time::Duration::from_millis(250));
                            done.fetch_add(1, Ordering::SeqCst);
                        })
                        .await
                    })
                })
                .collect();

            // The "interactive" invoke: no work at all, issued while every blocker is in flight.
            blocking_or("quick", 0usize, || 0usize).await;
            let observed = done.load(Ordering::SeqCst);

            // Criterion 3 of the item — fairness, not starvation in the other direction. The
            // background work must still finish, so join every blocker rather than abandoning it.
            for h in handles {
                h.await.expect("a blocker task ran to completion");
            }
            observed
        });

        assert_eq!(
            done.load(Ordering::SeqCst),
            BLOCKERS,
            "every blocking task must still complete — this is fairness, not starvation reversed",
        );
        assert!(
            observed < BLOCKERS,
            "the quick call returned only after all {BLOCKERS} blockers finished, which is the \
             main-thread behaviour this helper exists to avoid",
        );
    }
}
