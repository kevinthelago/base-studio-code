//! The PACKAGED persona floors — the ceiling a built-in persona is clamped against.
//!
//! ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
//! The narrow-only clamp resolves an ancestor as: the persona's own stored floor → the persona named
//! by `derivesFrom` → else the closed (all-`none`) floor. On a store where nothing has a floor yet,
//! every branch lands on closed, so EVERY floor write is refused — including the app seeding its own
//! packaged personas. "Narrow-only" silently became "no capability may ever be written".
//!
//! That was not caught by any unit test, because every clamp test seeds its ancestor with
//! `store.set()` directly and so bypasses the path under test. It was found by running the real
//! binary against a real empty store.
//!
//! So the chain gains one link, between the two it already had: a packaged persona's floor is its own
//! ceiling, read from the shipped data rather than from the store. A built-in can then be seeded at
//! its packaged capability and narrowed from there, while a widening past it stays refused.
//!
//! ── WHY NOT `include_str!` ──────────────────────────────────────────────────────────────────────
//! Embedding would make every persona edit recompile this crate and its dependents. The repo already
//! made that mistake once and reversed it (`the_high_churn_seeds_are_never_embedded_again`, measured
//! 3 crates / 7.4s vs 0 crates / 0.77s), and `bsc_util::packaged` is the mechanism that replaced it:
//! it resolves a data-relative path against `$BSC_DATA_DIR`, the shipped resource dir, the macOS
//! bundle, the WSL shared mount, and finally the dev checkout. The personas are listed in
//! `bundle.resources` so a SHIPPED build finds them too — a guard test pins that, because a missing
//! resource entry passes every local gate and fails only in a build nobody runs locally.

use serde_json::Value;
use std::path::PathBuf;

/// Data-relative directory holding the packaged persona definitions.
const PERSONA_DIR: &str = "personas";

/// Every readable packaged persona directory, in `bsc_util::packaged` resolution order.
fn persona_dirs() -> Vec<PathBuf> {
    bsc_util::packaged::data_dirs().into_iter().map(|d| d.join(PERSONA_DIR)).collect()
}

/// The packaged floor for `id`, or `None` when no shipped persona claims that id.
///
/// Scans rather than deriving a filename from the id, because the two do not match: `worker.json`
/// holds id `persona-worker`. Deriving would work for today's naming and break silently the first
/// time a persona is added under a different filename — and the failure would be an unclamped write,
/// which is the wrong direction to fail in.
///
/// The FIRST directory that yields a match wins, matching `data_dirs()`' documented precedence
/// (`$BSC_DATA_DIR` over the shipped copy over the dev checkout).
pub fn packaged_floor(id: &str) -> Option<Value> {
    for dir in persona_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            if v.get("id").and_then(Value::as_str) == Some(id) {
                return v.get("floor").cloned();
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Point `$BSC_DATA_DIR` at a scratch tree holding one packaged persona.
    /// See the twin in `cli.rs`: `BSC_DATA_DIR` is process-global, so these serialize for the sake
    /// of plain `cargo test`, which threads where nextest forks.
    static PACKAGED_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_packaged<T>(files: &[(&str, Value)], f: impl FnOnce() -> T) -> T {
        let _guard = PACKAGED_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = std::env::temp_dir().join(format!("bsc-packaged-{}-{:p}", std::process::id(), &files));
        let dir = root.join(PERSONA_DIR);
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in files {
            std::fs::write(dir.join(name), serde_json::to_string(body).unwrap()).unwrap();
        }
        // SAFETY-equivalent note: the crate's tests are single-threaded per process under nextest,
        // which is why this does not need the app crate's ENV_LOCK.
        unsafe { std::env::set_var("BSC_DATA_DIR", &root) };
        let out = f();
        unsafe { std::env::remove_var("BSC_DATA_DIR") };
        let _ = std::fs::remove_dir_all(&root);
        out
    }

    #[test]
    fn finds_a_floor_by_id_not_by_filename() {
        // The id and the filename deliberately disagree, as they do in the real packaged set.
        with_packaged(
            &[("worker.json", json!({"id": "persona-worker", "role": "worker", "floor": {"git": "write"}}))],
            || {
                let floor = packaged_floor("persona-worker").expect("packaged floor");
                assert_eq!(floor["git"], "write");
            },
        );
    }

    #[test]
    fn an_unknown_id_has_no_packaged_floor() {
        with_packaged(&[("worker.json", json!({"id": "persona-worker", "floor": {}}))], || {
            assert!(packaged_floor("persona-invented").is_none());
        });
    }

    #[test]
    fn a_packaged_persona_with_no_floor_yields_none_rather_than_an_empty_ceiling() {
        // An empty object would read as the CLOSED floor and refuse every write to that persona; the
        // caller must be able to tell "no ceiling declared" from "a ceiling of nothing".
        with_packaged(&[("x.json", json!({"id": "persona-x", "role": "worker"}))], || {
            assert!(packaged_floor("persona-x").is_none());
        });
    }

    #[test]
    fn unparseable_and_non_json_files_are_skipped_rather_than_aborting_the_scan() {
        with_packaged(
            &[("broken.json", json!("not-an-object")), ("good.json", json!({"id": "persona-good", "floor": {"ui": "read"}}))],
            || {
                assert_eq!(packaged_floor("persona-good").expect("floor")["ui"], "read");
            },
        );
    }
}
