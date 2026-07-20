//! Runtime config loading (#2027 P2). The packaged `data/` tree is embedded at build time as the
//! SEED; on first run it is copied into the user config dir (`~/.base-studio-code/config/`), and each
//! config surface is read from there at runtime — the embedded copy is the always-available fallback.
//! So editing a prompt/taxonomy under the config dir takes effect on the next launch with NO rebuild,
//! and the whole tree is the basis for the export/import bundle (#2027 P3).
//!
//! Every Rust config surface (permissions, OAuth providers, planner prompts, fleet protocols, stage
//! directives) now reads through [`load_str`]/[`load_opt`]; the packaged bytes are embedded once here
//! (the seed `Dir`). This module also owns the export/import config bundle (#2027 P3).

use crate::StrErr;
use include_dir::{include_dir, Dir};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The packaged config tree (`src-tauri/data/`), embedded at build time — the seed written on first
/// run AND the fallback read when a surface is absent from the config dir.
static EMBEDDED: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/data");

thread_local! {
    /// Per-thread override of the runtime config root — see [`with_config_root`]. `None` (always, in
    /// production) means [`config_root`] resolves the real one off the process environment.
    static CONFIG_ROOT_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// The runtime config root: `~/.base-studio-code/config/`. Mirrors the packaged `data/` layout.
///
/// Honours the [`with_config_root`] thread-local override when one is in force, so a test can pin the
/// root it reads through instead of inheriting whatever `HOME`/`USERPROFILE` a sibling test last set.
pub(crate) fn config_root() -> PathBuf {
    if let Some(root) = CONFIG_ROOT_OVERRIDE.with(|c| c.borrow().clone()) {
        return root;
    }
    super::paths::bsc_base_dir().join("config")
}

/// Run `f` with the runtime config root pinned to `root` **for the calling thread only** (#3479).
///
/// A TEST SEAM, and the reason it exists is the disease #3382 documented: `cargo test` runs a crate's
/// tests as parallel THREADS OF ONE PROCESS, so the process environment is shared mutable state.
/// [`config_root`] is derived from `HOME`/`USERPROFILE`, and `testutil::temp_home` repoints BOTH —
/// process-wide, permanently (it never restores them). Every test that merely READS a config surface
/// therefore resolves a root it never chose, and can resolve a *different* one from one [`load_str`]
/// call to the next: `session::designer`'s workspace test wrote the spec under the real home (the
/// config-dir copy) and read it back under a sibling's temp home (the embedded seed), so it was green
/// alone and red beside `session::launch`.
///
/// A serializing mutex does NOT fix that class — a lock only orders the tests that TAKE it, while
/// every test that just reads the env stays exposed (`testutil::ENV_LOCK` is exactly that partial
/// guard, and the designer test never took it). The thread-local removes the sharing instead: each
/// thread sees exactly the root it asked for, tests keep running in parallel, and no lock is needed.
/// The previous value is restored on drop, so it survives a panicking assertion.
///
/// Mirrors `bsc_cli_util::with_scopes` / `with_scratch` / `with_repo_root`, the same seam one layer down.
#[cfg(test)]
pub(crate) fn with_config_root<T>(root: &Path, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<PathBuf>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let prev = self.0.take();
            CONFIG_ROOT_OVERRIDE.with(|c| *c.borrow_mut() = prev);
        }
    }
    let prev = CONFIG_ROOT_OVERRIDE.with(|c| c.borrow_mut().replace(root.to_path_buf()));
    let _restore = Restore(prev);
    f()
}

/// Load a config surface's UTF-8 text: the on-disk copy under [`config_root`] if present + readable,
/// else the embedded seed. `rel` is a forward-slash path relative to the config root (= the packaged
/// `data/` layout), e.g. `"permissions/base.json"`. Returns `""` if the surface exists nowhere.
pub(crate) fn load_str(rel: &str) -> String {
    load_from(&config_root(), rel)
}

/// [`load_str`] against an explicit root — the testable core (the public fn wraps it with the real
/// config root). On-disk wins; the embedded seed is the fallback.
fn load_from(root: &Path, rel: &str) -> String {
    if let Ok(s) = std::fs::read_to_string(root.join(rel)) {
        return s;
    }
    EMBEDDED
        .get_file(rel)
        .and_then(|f| f.contents_utf8())
        .unwrap_or_default()
        .to_string()
}

/// Like [`load_str`] but returns `None` when the surface exists in NEITHER the config dir nor the
/// embedded seed (vs `""`), so a caller can distinguish "absent" (e.g. an unknown id) from "present".
pub(crate) fn load_opt(rel: &str) -> Option<String> {
    if let Ok(s) = std::fs::read_to_string(config_root().join(rel)) {
        return Some(s);
    }
    EMBEDDED.get_file(rel).and_then(|f| f.contents_utf8()).map(str::to_string)
}

/// The EMBEDDED seed's text for `rel`, IGNORING any on-disk override — the shipped artifact. For
/// tests that validate the packaged content (drift guards, prompt/protocol-content assertions): they
/// must stay independent of a developer's local config-dir edits, so they read the seed directly, not
/// [`load_str`]. Returns `""` if `rel` isn't in the packaged tree.
#[cfg(test)]
pub(crate) fn embedded_str(rel: &str) -> String {
    EMBEDDED
        .get_file(rel)
        .and_then(|f| f.contents_utf8())
        .unwrap_or_default()
        .to_string()
}

/// The EMBEDDED files directly under `dir_rel` (non-recursive), as `(file_stem, utf8_contents)` — for
/// tests that enumerate a packaged surface (e.g. the stage-directive key set), ignoring on-disk
/// overrides so they validate the SHIPPED set. Empty if the dir isn't packaged.
#[cfg(test)]
pub(crate) fn embedded_dir_files(dir_rel: &str) -> Vec<(String, String)> {
    EMBEDDED
        .get_dir(dir_rel)
        .map(|d| {
            d.files()
                .filter_map(|f| {
                    let stem = f.path().file_stem()?.to_string_lossy().into_owned();
                    Some((stem, f.contents_utf8()?.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Packaged top-level dirs that are NOT runtime config and must never be mirrored into the config
/// dir. `components/` (the packaged component kits, #2305) is owned by the `bsc ui` kit store + its
/// hash-based seed refresh (#2483); an auto-seeded copy became a de-facto override that pinned every
/// install's effective seed at its first-run roster — refresh/retire verdicts could never fire
/// (#2514). The frontend no longer reads a `config/components/` overlay at all (`builtinKits.ts`);
/// skipping the seed keeps the trap files from materializing on new installs.
const SEED_SKIP_DIRS: &[&str] = &["components"];

/// First-run seed: mirror the embedded tree into [`config_root`], writing only files that are ABSENT
/// so a user edit is never clobbered, and skipping the non-config [`SEED_SKIP_DIRS`]. Idempotent —
/// safe to call on every boot. Best-effort; on an I/O error the embedded fallback stays in force, so
/// a seed failure is non-fatal.
pub(crate) fn ensure_seeded() -> std::io::Result<()> {
    seed_root(&EMBEDDED, &config_root())
}

/// The top level of the seed mirror: like [`seed_dir`] but excluding [`SEED_SKIP_DIRS`].
fn seed_root(dir: &Dir, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    seed_files(dir, dest)?;
    for sub in dir.dirs() {
        if let Some(name) = sub.path().file_name() {
            if SEED_SKIP_DIRS.iter().any(|s| name == std::ffi::OsStr::new(s)) {
                continue;
            }
            seed_dir(sub, &dest.join(name))?;
        }
    }
    Ok(())
}

fn seed_dir(dir: &Dir, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    seed_files(dir, dest)?;
    for sub in dir.dirs() {
        if let Some(name) = sub.path().file_name() {
            seed_dir(sub, &dest.join(name))?;
        }
    }
    Ok(())
}

/// Write `dir`'s direct files into `dest`, only where absent (a user edit is never clobbered).
fn seed_files(dir: &Dir, dest: &Path) -> std::io::Result<()> {
    for f in dir.files() {
        if let Some(name) = f.path().file_name() {
            let target = dest.join(name);
            if !target.exists() {
                std::fs::write(&target, f.contents())?;
            }
        }
    }
    Ok(())
}

// ── Config bundle: export / import (#2027 P3) ────────────────────────────────

/// Bump on an incompatible bundle-format change. Import accepts an equal-or-older version and rejects
/// a NEWER one (a bundle written by a future app it can't safely read).
pub(crate) const BUNDLE_VERSION: u32 = 1;

/// The whole active configuration as one portable, versioned document — every file under the config
/// root, keyed by its forward-slash relative path. Round-trips through export → import so a user or
/// org can snapshot, share, and restore the entire configuration (the epic's headline deliverable).
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct ConfigBundle {
    /// Bundle-format version ([`BUNDLE_VERSION`]).
    pub version: u32,
    /// rel-path → UTF-8 contents, for every file under the config root.
    pub files: BTreeMap<String, String>,
}

/// Serialize the config tree at `root` into a [`ConfigBundle`] (recursive; text files only).
fn export_from(root: &Path) -> ConfigBundle {
    let mut files = BTreeMap::new();
    collect_files(root, root, &mut files);
    ConfigBundle { version: BUNDLE_VERSION, files }
}

fn collect_files(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(base, &path, out);
        } else if let (Ok(rel), Ok(contents)) =
            (path.strip_prefix(base), std::fs::read_to_string(&path))
        {
            out.insert(rel.to_string_lossy().replace('\\', "/"), contents);
        }
    }
}

/// Write a bundle's files into `root`. `replace` clears the root FIRST (an exact restore — files not
/// in the bundle are removed); otherwise merges (overwrites the listed files, leaves the rest). Errors
/// on a bundle newer than [`BUNDLE_VERSION`]. Returns the number of files written.
fn import_into(root: &Path, bundle: &ConfigBundle, replace: bool) -> std::io::Result<usize> {
    if bundle.version > BUNDLE_VERSION {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("bundle version {} is newer than supported ({BUNDLE_VERSION}) — update the app", bundle.version),
        ));
    }
    if replace && root.exists() {
        std::fs::remove_dir_all(root)?;
    }
    for (rel, contents) in &bundle.files {
        let target = root.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, contents)?;
    }
    Ok(bundle.files.len())
}

/// Export the active configuration to `path` as a versioned JSON bundle (#2027 P3). Seeds the config
/// dir first, so a never-edited install still exports the shipped defaults. Returns the file count.
#[tauri::command]
pub(crate) fn export_config_bundle(path: String) -> Result<usize, String> {
    ensure_seeded().str_err()?;
    let bundle = export_from(&config_root());
    let json = serde_json::to_string_pretty(&bundle).str_err()?;
    std::fs::write(&path, json).str_err()?;
    Ok(bundle.files.len())
}

/// Import a config bundle from `path` into the config dir (#2027 P3). `replace` = exact restore (clear
/// first); otherwise merge. Returns the number of files written. Changes take effect on the NEXT launch
/// (the loaders read the config dir at startup).
#[tauri::command]
pub(crate) fn import_config_bundle(path: String, replace: bool) -> Result<usize, String> {
    let json = std::fs::read_to_string(&path).str_err()?;
    let bundle: ConfigBundle =
        serde_json::from_str(&json).map_err(|e| format!("not a valid config bundle: {e}"))?;
    import_into(&config_root(), &bundle, replace).str_err()
}

/// Return the entire runtime config dir as `rel-path → contents` (#2047). The frontend primes this at
/// boot so its config surfaces (blueprints / roles / skills / stages / taxonomies) read the config-dir
/// copy over the embedded default — the parity of P2's backend runtime loading. Seeds first, so a
/// never-edited install returns the shipped defaults.
#[tauri::command]
pub(crate) fn get_config_files() -> Result<BTreeMap<String, String>, String> {
    ensure_seeded().str_err()?;
    Ok(export_from(&config_root()).files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch dir under the OS temp dir (mirrors `fsx::tests::scratch_path`). Not created.
    fn scratch_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "bsc_cfg_{tag}_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ))
    }

    #[test]
    fn load_from_returns_the_embedded_seed_when_no_on_disk_override() {
        let root = scratch_dir("embed"); // never created → forces the embedded fallback
        let s = load_from(&root, "permissions/base.json");
        let v: serde_json::Value =
            serde_json::from_str(&s).expect("the embedded base.json is served as the fallback + is valid JSON");
        assert!(v.is_object() && !s.trim().is_empty(), "a real embedded surface is served on fallback");
    }

    #[test]
    fn load_from_prefers_the_on_disk_copy_over_the_embedded_seed() {
        let root = scratch_dir("override");
        std::fs::create_dir_all(root.join("permissions")).unwrap();
        std::fs::write(root.join("permissions/base.json"), "ON_DISK_WINS").unwrap();
        assert_eq!(load_from(&root, "permissions/base.json"), "ON_DISK_WINS");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn load_from_returns_empty_for_a_surface_that_exists_nowhere() {
        let root = scratch_dir("absent");
        assert_eq!(load_from(&root, "does/not/exist.json"), "");
    }

    /// #3479 — the override decides what [`load_str`] reads, for THIS thread only. A sibling thread
    /// (standing in for every other test in the process) keeps resolving the real root, so pinning is
    /// isolation and not another piece of shared mutable state.
    #[test]
    fn with_config_root_pins_load_str_for_the_calling_thread_only() {
        let root = scratch_dir("pin");
        std::fs::create_dir_all(root.join("permissions")).unwrap();
        std::fs::write(root.join("permissions/base.json"), "PINNED").unwrap();

        with_config_root(&root, || {
            assert_eq!(config_root(), root, "the pinned root wins over the ambient home");
            assert_eq!(load_str("permissions/base.json"), "PINNED");
            // A sibling thread is unaffected — the override never leaves the thread that set it.
            let sibling = std::thread::spawn(|| load_str("permissions/base.json"));
            assert_ne!(sibling.join().unwrap(), "PINNED", "the override must not leak across threads");
        });
        assert_ne!(config_root(), root, "the real root is restored when the closure returns");
        std::fs::remove_dir_all(&root).ok();
    }

    /// The restore is Drop-based, so it survives an unwinding assertion — a failing test must not
    /// leave the pin in place for whatever the harness runs next on that thread.
    #[test]
    fn with_config_root_restores_the_previous_root_including_on_panic() {
        let outer = scratch_dir("outer");
        let inner = scratch_dir("inner");
        with_config_root(&outer, || {
            with_config_root(&inner, || assert_eq!(config_root(), inner));
            assert_eq!(config_root(), outer, "the nested pin restores its parent, not the real root");

            let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                with_config_root(&inner, || panic!("a failing assertion"));
            }));
            assert!(caught.is_err(), "the panic propagates");
            assert_eq!(config_root(), outer, "a panicking body still restores the previous root");
        });
    }

    #[test]
    fn seed_dir_mirrors_the_embedded_tree_and_never_clobbers_a_user_edit() {
        let root = scratch_dir("seed");
        seed_dir(&EMBEDDED, &root).unwrap();
        // a NESTED packaged file was materialized to disk
        let base = root.join("permissions/base.json");
        assert!(base.exists(), "a nested embedded file is seeded onto disk");
        assert!(!std::fs::read_to_string(&base).unwrap().trim().is_empty());
        // a subsequent re-seed preserves a user edit (only-absent-files rule)
        std::fs::write(&base, "USER_EDIT").unwrap();
        seed_dir(&EMBEDDED, &root).unwrap();
        assert_eq!(
            std::fs::read_to_string(&base).unwrap(),
            "USER_EDIT",
            "a re-seed must never overwrite a file the user has edited",
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn seed_root_skips_the_component_kits_but_mirrors_real_config() {
        // The packaged kits ARE embedded (the skip below is meaningful, not vacuous)…
        assert!(
            EMBEDDED.get_dir("components").is_some(),
            "data/components is packaged — if this moved, retire SEED_SKIP_DIRS with it",
        );
        let root = scratch_dir("seed-skip");
        seed_root(&EMBEDDED, &root).unwrap();
        // …but are NEVER mirrored into the config dir: an auto-seeded copy acted as a stale override
        // pinning the effective component seed at its first-run roster (#2514).
        assert!(!root.join("components").exists(), "config/components must not be seeded");
        // Real config surfaces still seed as before.
        assert!(root.join("permissions/base.json").exists(), "config surfaces still mirror");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn export_import_round_trips_the_config_tree() {
        let src = scratch_dir("bundle-src");
        seed_dir(&EMBEDDED, &src).unwrap();
        std::fs::write(src.join("permissions/base.json"), "EDITED").unwrap();
        let bundle = export_from(&src);
        assert_eq!(bundle.version, BUNDLE_VERSION);
        assert_eq!(bundle.files.get("permissions/base.json").map(String::as_str), Some("EDITED"));
        assert!(bundle.files.contains_key("planner/process.md"), "nested files are captured");

        let dst = scratch_dir("bundle-dst");
        let n = import_into(&dst, &bundle, false).unwrap();
        assert_eq!(n, bundle.files.len());
        assert_eq!(std::fs::read_to_string(dst.join("permissions/base.json")).unwrap(), "EDITED");
        assert!(dst.join("planner/process.md").exists(), "a nested file round-trips");
        std::fs::remove_dir_all(&src).ok();
        std::fs::remove_dir_all(&dst).ok();
    }

    #[test]
    fn import_rejects_a_bundle_newer_than_this_app() {
        let dst = scratch_dir("bundle-ver");
        let bundle = ConfigBundle { version: BUNDLE_VERSION + 1, files: BTreeMap::new() };
        assert!(import_into(&dst, &bundle, false).is_err(), "a future-version bundle is rejected");
    }

    #[test]
    fn replace_mode_clears_files_absent_from_the_bundle() {
        let dst = scratch_dir("bundle-replace");
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(dst.join("stale.txt"), "old").unwrap();
        let mut files = BTreeMap::new();
        files.insert("planner/x.md".to_string(), "new".to_string());
        import_into(&dst, &ConfigBundle { version: BUNDLE_VERSION, files }, true).unwrap();
        assert!(!dst.join("stale.txt").exists(), "replace removes files not in the bundle");
        assert_eq!(std::fs::read_to_string(dst.join("planner/x.md")).unwrap(), "new");
        std::fs::remove_dir_all(&dst).ok();
    }
}
