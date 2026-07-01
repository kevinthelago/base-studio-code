//! Runtime config loading (#2027 P2). The packaged `data/` tree is embedded at build time as the
//! SEED; on first run it is copied into the user config dir (`~/.base-studio-code/config/`), and each
//! config surface is read from there at runtime — the embedded copy is the always-available fallback.
//! So editing a prompt/taxonomy under the config dir takes effect on the next launch with NO rebuild,
//! and the whole tree is the basis for the export/import bundle (#2027 P3).
//!
//! Migration is incremental: each former `include_str!`/`include_dir!` site moves to [`load_str`] one
//! slice at a time (this slice: `permissions/base.json` + `sources/oauth-providers.json`). Until every
//! site has moved, the packaged bytes are embedded both here (the seed `Dir`) and at the not-yet-moved
//! sites — a temporary, harmless duplication in the binary.

use include_dir::{include_dir, Dir};
use std::path::{Path, PathBuf};

/// The packaged config tree (`src-tauri/data/`), embedded at build time — the seed written on first
/// run AND the fallback read when a surface is absent from the config dir.
static EMBEDDED: Dir<'static> = include_dir!("$CARGO_MANIFEST_DIR/data");

/// The runtime config root: `~/.base-studio-code/config/`. Mirrors the packaged `data/` layout.
pub(crate) fn config_root() -> PathBuf {
    super::paths::bsc_base_dir().join("config")
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

/// First-run seed: mirror the embedded tree into [`config_root`], writing only files that are ABSENT
/// so a user edit is never clobbered. Idempotent — safe to call on every boot. Best-effort; on an I/O
/// error the embedded fallback stays in force, so a seed failure is non-fatal.
pub(crate) fn ensure_seeded() -> std::io::Result<()> {
    seed_dir(&EMBEDDED, &config_root())
}

fn seed_dir(dir: &Dir, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for f in dir.files() {
        if let Some(name) = f.path().file_name() {
            let target = dest.join(name);
            if !target.exists() {
                std::fs::write(&target, f.contents())?;
            }
        }
    }
    for sub in dir.dirs() {
        if let Some(name) = sub.path().file_name() {
            seed_dir(sub, &dest.join(name))?;
        }
    }
    Ok(())
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
}
