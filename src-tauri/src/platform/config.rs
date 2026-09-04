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

/// The packaged config tree, embedded at build time — the seed written on first run AND the fallback
/// read when a surface is absent from the config dir.
///
/// This is the CONFIG-ONLY subset of `src-tauri/data/`, staged into `$OUT_DIR/config-seed` by
/// `build.rs` (see `NON_CONFIG_DIRS` there). It used to be the raw `data/` tree, which swept in
/// `components/` (8.3 MB, incl. the 388 `app/**` records) and `knowledge/` (2.6 MB) — ~11 MB of an
/// ~11.5 MB tree that no config read has ever named. The cost was that editing any record rebuilt AND
/// relinked the app: 20.5s against a 1.3s no-op.
///
/// The paths are unchanged — `get_file("fleet/director-protocol.md")` still resolves — because the
/// staged tree mirrors `data/` exactly, minus the two non-config dirs.
static EMBEDDED: Dir<'static> = include_dir!("$OUT_DIR/config-seed");

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

/// Every EMBEDDED file whose packaged path ends with `suffix`, as `data/`-relative forward-slash paths
/// — for a test that must enumerate a packaged SURFACE rather than a hand-kept list of its members.
///
/// The distinction matters: a list written into a test can only assert things about the files someone
/// remembered to add to it, so the one case it must catch — a NEW file of that kind shipping without
/// the property — is exactly the case it misses. Walking the tree makes the test's subject the shipped
/// set itself. Recursive because charters live one directory down (`designer/claude.md`), which
/// [`embedded_dir_files`] (non-recursive, single dir) cannot reach.
#[cfg(test)]
pub(crate) fn embedded_paths_ending_with(suffix: &str) -> Vec<String> {
    fn walk(d: &Dir<'_>, suffix: &str, out: &mut Vec<String>) {
        for f in d.files() {
            let p = f.path().to_string_lossy().replace('\\', "/");
            if p.ends_with(suffix) {
                out.push(p);
            }
        }
        for sub in d.dirs() {
            walk(sub, suffix, out);
        }
    }
    let mut out = Vec::new();
    walk(&EMBEDDED, suffix, &mut out);
    out.sort();
    out
}

/// What a [`ensure_seeded`] pass did, so staleness is REPORTED rather than silent.
///
/// The whole defect this replaces was invisible: the mirror won at read time and nothing ever said
/// it had stopped matching what shipped. A pass that refreshes nine files and preserves two edits
/// must be able to say so.
///
/// This module only REPORTS `diverged`/`orphaned` (into the boot log); it never acts on them. The
/// verb that does — `bsc config status` (classify + diff) and `bsc config reset <rel>` (adopt the
/// packaged copy) — lives in the Tauri-free `bsc-config` crate (#168), which embeds its own copy of
/// this same config-only seed so a CLI session can reach it without depending on this app crate.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SeedReport {
    /// Files written because the config dir had no copy (a genuine first run, or a new seed file).
    pub written: Vec<String>,
    /// Files overwritten because the on-disk copy still hashed to what we last seeded — i.e. nobody
    /// had edited it, so it was a stale mirror of an older release and not a user's config.
    pub refreshed: Vec<String>,
    /// Files left alone because the on-disk copy does NOT hash to what we seeded: a real edit (or an
    /// unknown-provenance copy from before the manifest existed). Never clobbered — reported.
    pub diverged: Vec<String>,
    /// Files removed because the seed that put them there is gone and the copy was untouched. This
    /// is what stops a retired blueprint/persona resurrecting forever through the overlay.
    pub retired: Vec<String>,
    /// Files whose seed is gone but whose copy was EDITED — left in place, surfaced as orphaned.
    pub orphaned: Vec<String>,
}

impl SeedReport {
    /// A one-line summary for the boot log, or `None` when the pass changed and found nothing —
    /// the steady state, which should stay silent so the interesting passes are visible.
    pub(crate) fn summary(&self) -> Option<String> {
        let counts = [
            ("written", self.written.len()),
            ("refreshed", self.refreshed.len()),
            ("diverged", self.diverged.len()),
            ("retired", self.retired.len()),
            ("orphaned", self.orphaned.len()),
        ];
        let parts: Vec<String> = counts
            .iter()
            .filter(|(_, n)| *n > 0)
            .map(|(label, n)| format!("{n} {label}"))
            .collect();
        (!parts.is_empty()).then(|| parts.join(", "))
    }
}

/// Bump when the manifest's shape changes incompatibly. A manifest whose version we don't recognise
/// is treated as ABSENT (every file becomes unknown-provenance and is preserved), never as an error:
/// downgrading the app must not license clobbering a user's config.
const SEED_MANIFEST_VERSION: u32 = 1;

/// rel-path → the lowercase-hex sha256 of the bytes WE last wrote there.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct SeedManifest {
    version: u32,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

/// Where the manifest lives — a SIBLING of the config root, never inside it.
///
/// That placement is load-bearing twice over. `get_config_files` walks the config root and serves
/// every file it finds, so a manifest inside would be handed to the frontend as a config surface;
/// and the export bundle (`export_from`) would carry one machine's seed bookkeeping into another
/// machine's import. Deriving it from the root rather than from `bsc_base_dir()` also keeps the
/// test seam honest: [`with_config_root`] repoints the root, and the manifest follows it.
fn manifest_path(root: &Path) -> PathBuf {
    let mut name = root.file_name().unwrap_or_default().to_os_string();
    name.push(".seed-manifest.json");
    root.with_file_name(name)
}

/// Lowercase hex sha256 — the one content-hash form, matching `bsc_ui::kit::sha256_hex`.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Every embedded file as `(forward-slash rel path, bytes)`.
fn embedded_files(dir: &Dir<'static>) -> Vec<(String, &'static [u8])> {
    fn walk(d: &Dir<'static>, out: &mut Vec<(String, &'static [u8])>) {
        for f in d.files() {
            out.push((f.path().to_string_lossy().replace('\\', "/"), f.contents()));
        }
        for sub in d.dirs() {
            walk(sub, out);
        }
    }
    let mut out = Vec::new();
    walk(dir, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Mirror the embedded tree into [`config_root`], REFRESHING what the user never touched.
///
/// The config dir wins at read time ([`load_str`]), which is the point — a prompt or protocol can be
/// edited without a rebuild. The original seeder wrote only where a file was ABSENT, so that same
/// precedence meant a mirror written on first boot kept winning forever and no packaged improvement
/// could ever reach an existing install: measured on one machine, 20 of 154 mirrored files were
/// stale, including every studio charter and the persona capability floors, plus (in an earlier
/// audit) `permissions/base.json` and the `bsc-*` shell hooks — the security surface.
///
/// The fix is the one `components/` already got in #2483: record what we wrote, so "the user edited
/// this" and "this is our own stale copy" stop being indistinguishable. `components/` was excluded
/// from seeding outright (#2514); that is not available here, because the overlay exists precisely so
/// these files CAN be customised and dropping that silently is a behaviour change for anyone who has.
///
/// Idempotent — safe on every boot. Best-effort at the call site: on an I/O error the embedded
/// fallback stays in force, so a seed failure is non-fatal.
pub(crate) fn ensure_seeded() -> std::io::Result<SeedReport> {
    seed_root(&EMBEDDED, &config_root())
}

/// The testable core of [`ensure_seeded`], against an explicit destination.
///
/// The `components/` exclusion this used to carry as a `SEED_SKIP_DIRS` filter is gone and stays
/// gone: `components/` is no longer in the embedded tree at all (`build.rs`'s `NON_CONFIG_DIRS`), so
/// the filter was vacuous — and a guard that can no longer fire reads to the next author as
/// protection that is still active. The `config/components must not be seeded` guarantee is
/// unchanged and still tested, enforced one layer earlier by never embedding the directory.
fn seed_root(dir: &Dir<'static>, dest: &Path) -> std::io::Result<SeedReport> {
    seed_from(&embedded_files(dir), dest)
}

/// The seeding ALGORITHM, over an explicit seed set — separated from the embedded tree so the tests
/// can drive it with a seed that CHANGES between passes.
///
/// That separation is the difference between testing this and not. The five behaviours all turn on
/// what happened on a previous pass with a DIFFERENT seed — refresh needs the packaged bytes to move
/// under an untouched copy, and retirement needs a seed file to stop shipping. Against the real
/// `EMBEDDED` tree (a build-time constant) neither is expressible, so a test could only ever observe
/// the first-run case — which is the one case that never broke.
fn seed_from(seeds: &[(String, &[u8])], dest: &Path) -> std::io::Result<SeedReport> {
    std::fs::create_dir_all(dest)?;
    let mpath = manifest_path(dest);
    // An unreadable or unrecognised manifest degrades to "no manifest": every file becomes
    // unknown-provenance and is therefore PRESERVED. Failing safe here means the worst case of a
    // corrupt manifest is a stale mirror, never a destroyed edit.
    let mut manifest: SeedManifest = std::fs::read_to_string(&mpath)
        .ok()
        .and_then(|s| serde_json::from_str::<SeedManifest>(&s).ok())
        .filter(|m| m.version == SEED_MANIFEST_VERSION)
        .unwrap_or_default();

    let mut report = SeedReport::default();
    let mut seeded_now: BTreeMap<String, String> = BTreeMap::new();

    for (rel, bytes) in seeds {
        let target = dest.join(rel);
        let seed_hash = sha256_hex(bytes);
        let on_disk = std::fs::read(&target).ok();

        match on_disk {
            // Absent — a first run, or a seed file that did not exist in the last release.
            None => {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&target, bytes)?;
                report.written.push(rel.clone());
                seeded_now.insert(rel.clone(), seed_hash);
            }
            Some(current) => {
                let current_hash = sha256_hex(&current);
                if current_hash == seed_hash {
                    // Already current. Adopt it into the manifest — this is also the MIGRATION path
                    // for an install that predates the manifest and happens to be up to date.
                    seeded_now.insert(rel.clone(), seed_hash);
                } else if manifest.files.get(rel).is_some_and(|h| *h == current_hash) {
                    // Hashes to exactly what we last wrote, so nobody has touched it: our own stale
                    // copy, and safe to move forward.
                    std::fs::write(&target, bytes)?;
                    report.refreshed.push(rel.clone());
                    seeded_now.insert(rel.clone(), seed_hash);
                } else {
                    // Either a genuine edit, or a pre-manifest copy whose provenance we cannot know.
                    // Both are PRESERVED: we cannot tell a stale copy from an edited one without
                    // history, and guessing wrong destroys the user's work. Reported, not silent.
                    report.diverged.push(rel.clone());
                    // Keep the prior expectation so this stays classified as diverged next boot,
                    // rather than oscillating.
                    if let Some(prev) = manifest.files.get(rel) {
                        seeded_now.insert(rel.clone(), prev.clone());
                    }
                }
            }
        }
    }

    // Retirement: a file we seeded whose seed no longer ships. Untouched ⇒ remove, which is what
    // stops a deleted blueprint/persona being offered forever through the additive overlay. Edited
    // ⇒ leave it and say so.
    let live: std::collections::BTreeSet<&String> = seeds.iter().map(|(r, _)| r).collect();
    for (rel, seeded_hash) in &manifest.files {
        if live.contains(rel) {
            continue;
        }
        let target = dest.join(rel);
        match std::fs::read(&target) {
            Ok(current) if sha256_hex(&current) == *seeded_hash => {
                std::fs::remove_file(&target)?;
                report.retired.push(rel.clone());
            }
            Ok(_) => {
                report.orphaned.push(rel.clone());
                seeded_now.insert(rel.clone(), seeded_hash.clone());
            }
            // Already gone — drop it from the manifest silently.
            Err(_) => {}
        }
    }

    manifest.version = SEED_MANIFEST_VERSION;
    manifest.files = seeded_now;
    if let Ok(json) = serde_json::to_string_pretty(&manifest) {
        std::fs::write(&mpath, json)?;
    }
    Ok(report)
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
        seed_root(&EMBEDDED, &root).unwrap();
        // a NESTED packaged file was materialized to disk
        let base = root.join("permissions/base.json");
        assert!(base.exists(), "a nested embedded file is seeded onto disk");
        assert!(!std::fs::read_to_string(&base).unwrap().trim().is_empty());
        // a subsequent re-seed preserves a user edit (only-absent-files rule)
        std::fs::write(&base, "USER_EDIT").unwrap();
        seed_root(&EMBEDDED, &root).unwrap();
        assert_eq!(
            std::fs::read_to_string(&base).unwrap(),
            "USER_EDIT",
            "a re-seed must never overwrite a file the user has edited",
        );
        std::fs::remove_dir_all(&root).ok();
    }


    // ── Hash-based refresh (#4251) ───────────────────────────────────────────
    //
    // These drive `seed_from` with a SYNTHETIC seed rather than `EMBEDDED`, because every behaviour
    // that broke turns on the packaged bytes CHANGING between two passes — which a build-time
    // constant cannot express. Against `EMBEDDED` the only observable case is the first run, and the
    // first run is the one case the old seeder got right.

    /// A synthetic packaged tree: `(rel path, contents)`.
    fn seed_set(entries: &[(&str, &'static str)]) -> Vec<(String, &'static [u8])> {
        entries.iter().map(|(rel, body)| (rel.to_string(), body.as_bytes())).collect()
    }

    fn read(root: &Path, rel: &str) -> String {
        std::fs::read_to_string(root.join(rel)).unwrap_or_default()
    }

    /// THE DEFECT, stated as a test: a packaged improvement must reach an install that already has a
    /// mirror. Before #4251 the second pass was a no-op because the file merely EXISTED, which is how
    /// 20 of this machine's 154 mirrored files — every studio charter, the persona capability floors,
    /// and in an earlier audit `permissions/base.json` and the `bsc-*` hooks — sat stale while the
    /// repo shipped the fix and the gate stayed green.
    #[test]
    fn an_untouched_copy_is_refreshed_when_the_packaged_bytes_move() {
        let root = scratch_dir("refresh");
        seed_from(&seed_set(&[("fleet/protocol.md", "v1")]), &root).unwrap();
        assert_eq!(read(&root, "fleet/protocol.md"), "v1", "first run writes the seed");

        let report = seed_from(&seed_set(&[("fleet/protocol.md", "v2")]), &root).unwrap();
        assert_eq!(read(&root, "fleet/protocol.md"), "v2", "an untouched copy follows the seed forward");
        assert_eq!(report.refreshed, vec!["fleet/protocol.md".to_string()]);
        assert!(report.diverged.is_empty(), "an untouched copy is not a divergence");
        std::fs::remove_dir_all(&root).ok();
    }

    /// The other half, and the one that must never regress: the overlay exists so config CAN be
    /// customised, so an edit outranks a packaged change and is REPORTED rather than silently kept.
    #[test]
    fn a_user_edit_is_never_clobbered_by_a_refresh_and_is_reported() {
        let root = scratch_dir("edit");
        seed_from(&seed_set(&[("planner/process.md", "v1")]), &root).unwrap();
        std::fs::write(root.join("planner/process.md"), "MY EDIT").unwrap();

        let report = seed_from(&seed_set(&[("planner/process.md", "v2")]), &root).unwrap();
        assert_eq!(read(&root, "planner/process.md"), "MY EDIT", "an edit is never clobbered");
        assert_eq!(report.diverged, vec!["planner/process.md".to_string()]);
        assert!(report.refreshed.is_empty());

        // And it stays classified — a diverged file must not oscillate back to "refreshable".
        let again = seed_from(&seed_set(&[("planner/process.md", "v3")]), &root).unwrap();
        assert_eq!(read(&root, "planner/process.md"), "MY EDIT");
        assert_eq!(again.diverged, vec!["planner/process.md".to_string()]);
        std::fs::remove_dir_all(&root).ok();
    }

    /// Retirement — the half that stops a deleted record resurrecting. The frontend overlay is
    /// ADDITIVE BY STEM, so a retired blueprint left in the mirror keeps being offered forever; an
    /// audit found 26 retired seeds still overlaying, including blueprints deleted releases ago.
    #[test]
    fn a_retired_seed_removes_an_untouched_copy_but_keeps_an_edited_one() {
        let root = scratch_dir("retire");
        seed_from(&seed_set(&[("blueprints/keep.json", "{}"), ("blueprints/gone.json", "{}"),
                              ("blueprints/mine.json", "{}")]), &root).unwrap();
        std::fs::write(root.join("blueprints/mine.json"), "{\"edited\":true}").unwrap();

        let report = seed_from(&seed_set(&[("blueprints/keep.json", "{}")]), &root).unwrap();
        assert!(!root.join("blueprints/gone.json").exists(), "an untouched retired seed is removed");
        assert_eq!(report.retired, vec!["blueprints/gone.json".to_string()]);
        assert!(root.join("blueprints/mine.json").exists(), "an EDITED retired seed is kept");
        assert_eq!(report.orphaned, vec!["blueprints/mine.json".to_string()]);
        assert!(root.join("blueprints/keep.json").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    /// MIGRATION, the case every existing install lands in: a mirror with no manifest.
    ///
    /// We cannot tell a stale copy from an edited one without history, so an unmatched file is
    /// PRESERVED and reported — never adopted, never clobbered. A file that already matches the
    /// shipped seed is adopted silently, which is what lets a current install start tracking.
    #[test]
    fn a_preexisting_mirror_with_no_manifest_is_preserved_or_adopted_but_never_clobbered() {
        let root = scratch_dir("migrate");
        std::fs::create_dir_all(root.join("personas")).unwrap();
        // Hand-written, no manifest: one matches the shipped seed, one does not.
        std::fs::write(root.join("personas/current.json"), "v1").unwrap();
        std::fs::write(root.join("personas/unknown.json"), "SOMETHING ELSE").unwrap();
        assert!(!manifest_path(&root).exists(), "the premise: no manifest yet");

        let report = seed_from(
            &seed_set(&[("personas/current.json", "v1"), ("personas/unknown.json", "v1")]),
            &root,
        )
        .unwrap();
        assert_eq!(read(&root, "personas/unknown.json"), "SOMETHING ELSE", "unknown provenance is kept");
        assert_eq!(report.diverged, vec!["personas/unknown.json".to_string()]);

        // The matching one was ADOPTED — proven by it now refreshing, which it could not do unless
        // the migration pass recorded its hash.
        let next = seed_from(
            &seed_set(&[("personas/current.json", "v2"), ("personas/unknown.json", "v2")]),
            &root,
        )
        .unwrap();
        assert_eq!(read(&root, "personas/current.json"), "v2", "an adopted file refreshes");
        assert_eq!(next.refreshed, vec!["personas/current.json".to_string()]);
        assert_eq!(read(&root, "personas/unknown.json"), "SOMETHING ELSE", "still preserved");
        std::fs::remove_dir_all(&root).ok();
    }

    /// The manifest must not live inside the config root.
    ///
    /// Two concrete consequences if it did: `get_config_files` walks the root and hands everything it
    /// finds to the frontend as a config surface, and `export_from` would carry one machine's seed
    /// bookkeeping into another machine's import.
    #[test]
    fn the_manifest_lives_outside_the_config_root() {
        let root = scratch_dir("manifest-outside");
        seed_from(&seed_set(&[("permissions/base.json", "{}")]), &root).unwrap();

        assert!(manifest_path(&root).exists(), "the manifest is written");
        assert!(!manifest_path(&root).starts_with(&root), "and it is NOT inside the config root");
        let bundle = export_from(&root);
        assert!(
            bundle.files.keys().all(|k| !k.contains("seed-manifest")),
            "the export bundle must not carry seed bookkeeping: {:?}",
            bundle.files.keys().collect::<Vec<_>>(),
        );
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_file(manifest_path(&root)).ok();
    }

    /// Fail SAFE: an unreadable manifest must degrade to preserving everything, never to clobbering.
    /// The worst case of a corrupt manifest is a stale mirror; a destroyed edit is not acceptable.
    #[test]
    fn a_corrupt_manifest_preserves_rather_than_clobbers() {
        let root = scratch_dir("corrupt");
        seed_from(&seed_set(&[("shell/confine.sh", "v1")]), &root).unwrap();
        std::fs::write(manifest_path(&root), "{ not json").unwrap();

        let report = seed_from(&seed_set(&[("shell/confine.sh", "v2")]), &root).unwrap();
        assert_eq!(read(&root, "shell/confine.sh"), "v1", "no manifest ⇒ preserve, never clobber");
        assert_eq!(report.diverged, vec!["shell/confine.sh".to_string()]);
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_file(manifest_path(&root)).ok();
    }

    /// The steady state stays quiet, so the passes that DID something are visible in the boot log.
    #[test]
    fn the_report_is_silent_when_a_pass_changes_nothing() {
        let root = scratch_dir("quiet");
        let seeds = seed_set(&[("roles/x.json", "{}")]);
        assert!(seed_from(&seeds, &root).unwrap().summary().is_some(), "a first run reports its writes");
        assert_eq!(seed_from(&seeds, &root).unwrap().summary(), None, "an unchanged pass is silent");
        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_file(manifest_path(&root)).ok();
    }

    /// The `#2514` guarantee, now enforced one layer earlier.
    ///
    /// `config/components/` must never materialize: an auto-seeded copy acted as a stale override
    /// that pinned the effective component seed at each install's first-run roster, so refresh/retire
    /// verdicts could never fire. That used to be a `SEED_SKIP_DIRS` filter over an embedded
    /// `components/`; the directory is no longer embedded at all, so the outcome is unchanged and the
    /// filter is gone. The assertion is written against the OUTCOME rather than the mechanism, so it
    /// survives either implementation.
    #[test]
    fn the_component_kits_are_never_seeded_but_real_config_still_mirrors() {
        let root = scratch_dir("seed-skip");
        seed_root(&EMBEDDED, &root).unwrap();
        assert!(!root.join("components").exists(), "config/components must not be seeded");
        assert!(!root.join("knowledge").exists(), "config/knowledge must not be seeded");
        // Real config surfaces still seed as before.
        assert!(root.join("permissions/base.json").exists(), "config surfaces still mirror");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Every top-level dir under `data/` is either an embedded config surface or explicitly classified
    /// as non-config. Adding one must force a DECISION.
    ///
    /// Without this, a new `data/<surface>/` would simply not be embedded — `load_str` would return
    /// `""` and the feature would read as empty rather than broken, at runtime, with a green build.
    /// That is the same silent-narrowing failure this repo keeps paying for, and the reason the
    /// exclusion list lives in `build.rs` where it can be checked rather than inferred.
    /// The build script must watch the data ROOT, or a newly added top-level dir never triggers a
    /// rebuild — cargo re-runs on a watched directory's entries changing, and the per-dir watches only
    /// cover dirs that already existed.
    ///
    /// A SOURCE ASSERTION because nothing at run time can observe a MISSING `rerun-if-changed`: the
    /// symptom is a seed that reads back empty on a CLEAN checkout while the authoring worktree, which
    /// stumbled into a rebuild, stays green. That asymmetry is what let it reach the promote gate.
    #[test]
    fn the_build_script_watches_the_data_root_not_only_its_subdirs() {
        let build_rs = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs");
        let src = std::fs::read_to_string(&build_rs).expect("build.rs is readable");
        let staging = match src.split_once("fn stage_config_seed") {
            Some((_, rest)) => rest,
            None => panic!("build.rs no longer has `stage_config_seed` — this guard needs re-pointing"),
        };
        // Both watches must be present, and they cover different things: the ROOT catches a NEW
        // top-level dir, the per-dir ones catch an edit inside a dir that already existed.
        let root_watch = staging
            .lines()
            .any(|l| l.contains("rerun-if-changed") && l.contains("src.display()"));
        let per_dir_watch = staging
            .lines()
            .any(|l| l.contains("rerun-if-changed") && l.contains("path.display()"));
        assert!(root_watch, "build.rs must watch the data ROOT, or a new top-level dir is never seen");
        assert!(per_dir_watch, "the per-dir watches must stay — the root watch misses edits inside a dir");
    }

    #[test]
    fn every_data_dir_is_either_embedded_or_classified_non_config() {
        // Kept in sync with `NON_CONFIG_DIRS` in build.rs by the assertion below.
        const NON_CONFIG: &[&str] = &["components", "knowledge"];

        let data = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("data");
        let mut unclassified = Vec::new();
        for entry in std::fs::read_dir(&data).expect("data/ is readable").flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if NON_CONFIG.contains(&name.as_str()) {
                assert!(
                    EMBEDDED.get_dir(&name).is_none(),
                    "`{name}` is classified non-config but IS embedded — build.rs and this test disagree",
                );
                continue;
            }
            if EMBEDDED.get_dir(&name).is_none() {
                unclassified.push(name);
            }
        }
        unclassified.sort();
        assert!(
            unclassified.is_empty(),
            "these data/ dirs are neither embedded nor classified non-config, so every read of them \
             would return \"\" at runtime with a green build: {unclassified:?}. Add them to \
             NON_CONFIG_DIRS in build.rs if they are not config surfaces.",
        );
    }

    /// The staged seed must mirror `data/` FILE FOR FILE for every included surface.
    ///
    /// build.rs stages a copy, and a copy can be incomplete. The hazard being pinned is a config
    /// surface that stops reaching the binary — which surfaces as an empty prompt or an absent
    /// permission rule, not as a build failure.
    #[test]
    fn the_staged_seed_matches_the_source_tree_file_for_file() {
        const NON_CONFIG: &[&str] = &["components", "knowledge"];
        let data = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("data");

        let mut missing = Vec::new();
        for entry in std::fs::read_dir(&data).expect("data/ is readable").flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if NON_CONFIG.contains(&name.as_str()) {
                continue;
            }
            collect_missing(&path, &data, &mut missing);
        }
        missing.sort();
        assert!(
            missing.is_empty(),
            "build.rs staged an INCOMPLETE config seed — these files exist under data/ but are not \
             embedded, so reading them returns \"\" at runtime: {missing:?}",
        );
    }

    /// Every file under `dir` whose `data/`-relative path is absent from [`EMBEDDED`].
    fn collect_missing(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_missing(&path, base, out);
                continue;
            }
            let Ok(rel) = path.strip_prefix(base) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if EMBEDDED.get_file(&rel).is_none() {
                out.push(rel);
            }
        }
    }

    #[test]
    fn export_import_round_trips_the_config_tree() {
        let src = scratch_dir("bundle-src");
        seed_root(&EMBEDDED, &src).unwrap();
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
