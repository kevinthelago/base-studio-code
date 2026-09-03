//! Packaged seed data, resolved at RUNTIME rather than compiled in.
//!
//! ## Why this module exists
//!
//! The big packaged seeds used to be `include_str!`'d straight into the binaries. That made a
//! **data** edit a **Rust** invalidation — and record editing is this app's primary authoring mode
//! ("new UI is authored into the store, never as a new `.tsx`"). Measured on a warm tree before this
//! change:
//!
//! | what | time | crates rebuilt |
//! |---|---|---|
//! | no-op build | 1.0s | 0 |
//! | touch `react-ui.json` | 7.4s | 3 (`bsc-component`, `bsc-ui`, `bsc`) |
//! | `cargo build -p bsc-ui` after that touch | 18.0s | — |
//!
//! `react-ui.json` is 5.3 MB and moved in 190 commits over 30 days; its 156-byte `.meta.json`
//! sidecar moved in 186, i.e. essentially in lockstep — so leaving the *tiny* one embedded would
//! have preserved the entire invalidation by itself. That is why size is not the selection rule
//! here; **churn** is.
//!
//! sccache cannot absorb any of it: across one such rebuild its counters moved 6 compile requests,
//! 0 executed, 0 hits, 0 misses. Workspace crates are non-cacheable because their source path is
//! part of the cache key, so every worktree pays the cost independently.
//!
//! ## The one thing that is still compiled in
//!
//! [`DEV_DATA_ROOT`] is a **path**, not a file's contents. It changes only if the crate itself
//! moves, so editing a seed cannot invalidate it. That distinction is the whole mechanism — keep it
//! in mind before adding anything else to this module.
//!
//! ## Failing loudly is deliberate
//!
//! A missing `include_str!` target was a *compile* error, so it could not reach a user. A missing
//! file at runtime can, and this repo's recurring failure mode is the check that passes while seeing
//! less than the reader assumes. So [`read_required`] panics with **every candidate path it tried**
//! rather than returning a default or an empty artifact — an empty kit would render as "no
//! components" and read like data loss.

use std::path::PathBuf;

/// The repo's `src-tauri/data` root, baked in at compile time **as a path string**.
///
/// This is the dev-checkout fallback and it is deliberately LAST: a shipped binary carries the build
/// machine's path here, which will simply not exist on a user's machine and falls through. Each
/// worktree compiles its own `bsc-util`, so each resolves to its own tree — which is the correct
/// per-worktree behaviour, not an accident.
pub const DEV_DATA_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../src-tauri/data");

/// The env override, honoured first so a test, a sandbox, or an unusual install can redirect the
/// whole seed set without touching the others.
pub const DATA_DIR_ENV: &str = "BSC_DATA_DIR";

/// The seeds this crate resolves at runtime, named relative to `src-tauri/data/`.
///
/// ONE list, three readers: the crates that load them, `bundle.resources` in `tauri.conf.json` (which
/// must ship exactly these), and the guard test that fails if one is ever `include_str!`'d again. A
/// seed added here without a matching `bundle.resources` entry would work in dev and break only in a
/// shipped build — so the test pins the two together rather than trusting them to stay aligned.
pub const RUNTIME_SEEDS: &[&str] = &[
    "components/react-ui.json",
    "ui/react-ui-kit.meta.json",
    "knowledge/algorithms.json",
    // bsc-ui, moved off `include_str!` so `src-tauri/data` can eventually be deleted entirely
    // (`epic-one-external-source-backs-up-and-seeds-the-system`). Listing them here is what ARMS the
    // two guards: one fails if any is embedded again, the other fails without a bundle.resources entry.
    "ui/primitives.json",
    "ui/themes.json",
    "ui/tokens-contract.css",
    "ui/style-descriptor.json",
    "ui/node-validation.fixtures.json",
    "stages/transformations.json",
    // plandb, moved off `include_str!` so `src-tauri/data` can eventually be deleted entirely
    // (`epic-one-external-source-backs-up-and-seeds-the-system`). Listing them ARMS the two guards:
    // one fails if any is embedded again, the other fails without a bundle.resources entry.
    "deploy/taxonomy.json",
    "market/rubric.json",
    "transformations/taxonomy.json",
    // bsc-component, bsc-graph and bsc defer, moved off `include_str!` so `src-tauri/data` can
    // eventually be deleted entirely (`epic-one-external-source-backs-up-and-seeds-the-system`).
    // `ui/platform-modules.json` is read by TWO crates and is listed once.
    "ui/preview-importmap.json",
    "ui/platform-modules.json",
    "sounds/signal.json",
    "fleet/defer-directive.md",
    "fleet/defer-stuck-directive.md",
];

/// Every directory a packaged seed may live in, in resolution order.
///
/// The order encodes who is asking:
///   1. `$BSC_DATA_DIR` — an explicit override always wins.
///   2. `<exe_dir>/data` — the shipped layout on Windows/Linux, where Tauri's `bundle.resources`
///      lands beside the executable. Also covers the app itself in a dev build.
///   3. `<exe_dir>/../Resources/data` — the macOS `.app`, where the executable sits in
///      `Contents/MacOS` and resources in `Contents/Resources`.
///   4. `~/.base-studio-code/data` — the SHARED-MOUNT case. The sealed WSL sandbox has no `/mnt/c`,
///      so a Windows [`DEV_DATA_ROOT`] cannot resolve inside it; what it does have is
///      `~/.base-studio-code` (the `/srv/bsc-shared` mount). Nothing in the app populates this
///      directory today — deliberately. Staging seeds here at boot would make every read between one
///      boot and the next serve a STALE copy of a file the dev is actively editing, which is the
///      exact failure mode the sidecar staging already has to defend against. Seeding it belongs to
///      sandbox provisioning, where the repo genuinely is not reachable.
///   5. [`DEV_DATA_ROOT`] — a dev checkout, always live and therefore never stale.
pub fn data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Ok(d) = std::env::var(DATA_DIR_ENV) {
        if !d.trim().is_empty() {
            dirs.push(PathBuf::from(d));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("data"));
            // macOS: Contents/MacOS/<exe> -> Contents/Resources/data
            if let Some(contents) = dir.parent() {
                dirs.push(contents.join("Resources").join("data"));
            }
        }
    }

    if let Some(base) = crate::bsc_base_dir() {
        dirs.push(base.join("data"));
    }

    dirs.push(PathBuf::from(DEV_DATA_ROOT));
    dirs
}

/// Every candidate path for one seed, named by its path RELATIVE to `src-tauri/data/`
/// (e.g. `"components/react-ui.json"`).
pub fn candidates(rel: &str) -> Vec<PathBuf> {
    data_dirs().into_iter().map(|d| d.join(rel)).collect()
}

/// The on-disk path a packaged seed currently resolves to — the first [`candidates`] entry that
/// exists, i.e. exactly the file [`read`] would return the contents of. `None` when no candidate
/// exists (a shipped build whose resources are missing, or `BSC_DATA_DIR` pointed somewhere empty).
///
/// Distinct from [`read`]: a caller that wants to WRITE the seed back in place (curate its packaged
/// copy, not just its runtime store — #141) needs the PATH, not the contents, and [`read`]'s own
/// resolution loop is otherwise private to it.
pub fn resolved_path(rel: &str) -> Option<PathBuf> {
    candidates(rel).into_iter().find(|p| p.is_file())
}

/// Read a packaged seed, or report every path that was tried.
///
/// CRLF is **not** normalized here — callers that hash or serve canonical bytes do their own
/// `\r\n` → `\n` pass, exactly as they did when this came from `include_str!`. Normalizing centrally
/// would silently change the bytes a hash is computed over.
pub fn read(rel: &str) -> Result<String, String> {
    let tried = candidates(rel);
    for path in &tried {
        if let Ok(text) = std::fs::read_to_string(path) {
            return Ok(text);
        }
    }
    Err(format!(
        "packaged seed `{rel}` not found. Tried, in order:\n{}\n\
         Set {DATA_DIR_ENV} to the directory holding the packaged `data/` tree, or reinstall so the \
         seeds ship beside the executable.",
        tried.iter().map(|p| format!("  {}", p.display())).collect::<Vec<_>>().join("\n")
    ))
}

/// Read a packaged seed or panic, naming every candidate.
///
/// The panic replaces what used to be a compile error, and it is the right shape: these seeds are
/// load-bearing (the default component kit, the algorithms graph), so continuing without one would
/// present an EMPTY library — indistinguishable from real data loss — instead of a clear fault.
pub fn read_required(rel: &str) -> String {
    read(rel).unwrap_or_else(|why| panic!("{why}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// `BSC_DATA_DIR` is process-global, so the tests that set it must not overlap. Under
    /// `cargo nextest` each test is its own process and this is redundant; under plain `cargo test`
    /// they share one, and without it these tests interleave and flake.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn env_guard() -> MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The env override must come first, or a test/sandbox cannot redirect a seed at all.
    #[test]
    fn the_env_override_is_tried_before_anything_else() {
        let _g = env_guard();
        std::env::set_var(DATA_DIR_ENV, "Z:/somewhere/custom");
        let first = candidates("components/react-ui.json").remove(0);
        std::env::remove_var(DATA_DIR_ENV);
        assert_eq!(first, PathBuf::from("Z:/somewhere/custom").join("components/react-ui.json"));
    }

    /// An empty/whitespace override is ignored rather than resolving to a bare relative path — an
    /// unset-but-exported env var is common in shells and must not blank out the search.
    #[test]
    fn a_blank_env_override_is_ignored() {
        let _g = env_guard();
        std::env::set_var(DATA_DIR_ENV, "   ");
        let dirs = data_dirs();
        std::env::remove_var(DATA_DIR_ENV);
        assert!(
            !dirs.iter().any(|d| d.as_os_str().is_empty() || d == &PathBuf::from("   ")),
            "a blank override must not become a search dir: {dirs:?}"
        );
    }

    /// The dev checkout is the LAST resort, never ahead of a real install.
    #[test]
    fn the_dev_checkout_is_the_last_candidate() {
        let _g = env_guard();
        std::env::remove_var(DATA_DIR_ENV);
        let dirs = data_dirs();
        assert_eq!(dirs.last().unwrap(), &PathBuf::from(DEV_DATA_ROOT));
        assert!(dirs.len() > 1, "there must be install candidates ahead of the dev tree: {dirs:?}");
    }

    /// `DEV_DATA_ROOT` must point at the real tree, or every dev build and test silently falls back
    /// to nothing. This is the test that fails if the crate is ever moved.
    #[test]
    fn the_dev_data_root_actually_resolves() {
        assert!(
            PathBuf::from(DEV_DATA_ROOT).join("components/react-ui.json").exists(),
            "DEV_DATA_ROOT does not point at src-tauri/data — did crates/bsc-util move? ({DEV_DATA_ROOT})"
        );
    }

    /// The three seeds this change moved off `include_str!` must all resolve, or the crates that
    /// read them panic at first use.
    #[test]
    fn every_runtime_loaded_seed_resolves() {
        for rel in
            ["components/react-ui.json", "ui/react-ui-kit.meta.json", "knowledge/algorithms.json"]
        {
            let text = read(rel).unwrap_or_else(|e| panic!("{e}"));
            assert!(!text.trim().is_empty(), "{rel} resolved but is empty");
        }
    }

    /// A miss must name EVERY path tried. A bare "not found" is what turns this into an hour of
    /// guessing, and there is no compile error to fall back on any more.
    #[test]
    fn a_missing_seed_names_every_candidate_it_tried() {
        let _g = env_guard();
        std::env::set_var(DATA_DIR_ENV, "Z:/definitely/not/here");
        let err = read("nope/missing.json").expect_err("a missing seed must be an error");
        std::env::remove_var(DATA_DIR_ENV);

        assert!(err.contains("nope/missing.json"), "must name the seed: {err}");
        assert!(err.contains("Z:/definitely/not/here"), "must name the override it tried: {err}");
        assert!(err.contains(DEV_DATA_ROOT), "must name the dev root it tried: {err}");
        assert!(err.contains(DATA_DIR_ENV), "must say how to fix it: {err}");
    }
}

#[cfg(test)]
mod class_a_conversion_tests {
    //! The seeds converted off `include_str!` so `src-tauri/data` can eventually be deleted
    //! (`epic-one-external-source-backs-up-and-seeds-the-system`).
    //!
    //! The three EXISTING guards already prove a listed seed is not embedded, is staged by
    //! `build.rs`, and ships in the bundle. What none of them proves is that the seed can actually
    //! be READ — a path could be listed everywhere and still be misspelled.

    /// Every listed seed resolves and is non-empty.
    ///
    /// This is the check the other three cannot make. `read_required` PANICS naming every path it
    /// tried, so a typo in a `RUNTIME_SEEDS` entry becomes a startup crash rather than a compile
    /// error — worth catching in a test instead of in the field.
    #[test]
    fn every_runtime_seed_actually_resolves_and_is_not_empty() {
        for rel in super::RUNTIME_SEEDS {
            let body = super::read(rel).unwrap_or_else(|why| panic!("{rel} is listed but unreadable:\n{why}"));
            assert!(!body.trim().is_empty(), "{rel} resolved but is empty — that reads as data loss");
        }
    }

    /// A seed is listed ONCE. `ui/platform-modules.json` is read by two crates and was the case that
    /// made this worth pinning: a duplicate entry would stage the same file twice and make the
    /// build-script/bundle lists disagree about their own length.
    #[test]
    fn no_seed_is_listed_twice() {
        let mut seen = std::collections::BTreeSet::new();
        for rel in super::RUNTIME_SEEDS {
            assert!(seen.insert(*rel), "{rel} is listed twice in RUNTIME_SEEDS");
        }
    }
}
