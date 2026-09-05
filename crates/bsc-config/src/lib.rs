//! `bsc-config` (#168) — read/adopt verbs over the desktop app's runtime config-seed mirror
//! (`~/.base-studio-code/config/`, mirrored from the packaged `src-tauri/data/` tree by
//! `platform::config::ensure_seeded` on every boot, #4251).
//!
//! Before this crate, a file the app classified as DIVERGED from the packaged seed (an edit — or an
//! unknown-provenance copy — that #4251 correctly refuses to clobber) could be SEEN in the boot log
//! but not acted on: there was no verb to show what changed or to adopt the packaged copy, so the
//! only remedy was deleting the file by hand under `~/.base-studio-code/config/` (request #168).
//!
//! This crate embeds its OWN copy of the config-only subset of `data/` (`build.rs`, same exclude
//! list as `src-tauri/build.rs`'s `stage_config_seed`) rather than depending on the `base-studio-code`
//! app crate, which is Tauri-bound and not something a CLI-spawnable `crates/*` binary can pull in.
//! [`status`] is READ-ONLY and mirrors the classification `platform::config::seed_from` makes at
//! boot, without writing anything; [`reset`] performs the one write this crate offers — overwrite a
//! named file with the current packaged bytes and adopt that hash into the manifest.


use include_dir::{include_dir, Dir};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

/// The packaged config-only subset of `data/`, staged by `build.rs` into `$OUT_DIR/config-seed` —
/// this crate's own copy of the same tree `src-tauri/src/platform/config.rs` embeds, so `bsc config`
/// can classify and diff against "what's packaged" without depending on the Tauri app crate.
static EMBEDDED: Dir<'static> = include_dir!("$OUT_DIR/config-seed");

/// Bump in lockstep with `SEED_MANIFEST_VERSION` in `platform/config.rs` — both sides read and write
/// the SAME on-disk manifest file, so a format change on one side that the other doesn't recognise
/// must degrade to "no manifest" (never to a mis-parsed one), exactly as `seed_from` already does.
const SEED_MANIFEST_VERSION: u32 = 1;

/// rel-path → the lowercase-hex sha256 of the bytes last WRITTEN there by a seed pass (app boot or
/// `bsc config reset`). Same shape as `platform::config::SeedManifest` — duplicated, not shared,
/// because the two are different binaries; [`tests::the_manifest_shape_matches_the_app_side`] pins
/// the wire format so a change to one is caught rather than silently read wrong by the other.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct SeedManifest {
    version: u32,
    #[serde(default)]
    files: BTreeMap<String, String>,
}

/// Where the manifest lives — a SIBLING of the config root, never inside it. Must resolve to the
/// exact same path `platform::config::manifest_path` computes, since both read and write one file.
fn manifest_path(root: &Path) -> PathBuf {
    let mut name = root.file_name().unwrap_or_default().to_os_string();
    name.push(".seed-manifest.json");
    root.with_file_name(name)
}

/// Lowercase hex sha256 — the one content-hash form, matching `platform::config::sha256_hex`.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// Best-effort manifest read. An unreadable or unrecognised-version manifest degrades to empty —
/// the fail-safe `seed_from` already uses: every file becomes unknown-provenance rather than
/// mis-trusted, so the worst case is a status that over-reports `diverged`, never one that
/// under-reports it.
fn read_manifest(root: &Path) -> SeedManifest {
    std::fs::read_to_string(manifest_path(root))
        .ok()
        .and_then(|s| serde_json::from_str::<SeedManifest>(&s).ok())
        .filter(|m| m.version == SEED_MANIFEST_VERSION)
        .unwrap_or_default()
}

/// The runtime config root: `~/.base-studio-code/config/`. MUST resolve to the same directory as
/// `platform::config::config_root` — both this crate and the app read/write the SAME on-disk tree —
/// which is why it goes through the shared `bsc_util::bsc_base_dir` rather than re-deriving `$HOME`.
pub fn config_root() -> PathBuf {
    bsc_util::bsc_base_dir().unwrap_or_else(|| PathBuf::from(".base-studio-code")).join("config")
}

/// Every embedded (packaged) file as `rel path → bytes`, sorted by construction (`BTreeMap`).
pub fn embedded_files() -> BTreeMap<String, &'static [u8]> {
    fn walk(d: &Dir<'static>, out: &mut BTreeMap<String, &'static [u8]>) {
        for f in d.files() {
            out.insert(f.path().to_string_lossy().replace('\\', "/"), f.contents());
        }
        for sub in d.dirs() {
            walk(sub, out);
        }
    }
    let mut out = BTreeMap::new();
    walk(&EMBEDDED, &mut out);
    out
}

/// The current packaged bytes for `rel`, or `None` when it is not (or no longer) shipped.
pub fn packaged(rel: &str) -> Option<&'static [u8]> {
    EMBEDDED.get_file(rel).map(|f| f.contents())
}

/// Where one tracked file stands relative to the packaged seed. Mirrors the classification
/// `platform::config::seed_from` makes at boot — `Missing`/`Diverged` there is `written`/left
/// `diverged` here; `Stale`/`Retired` is what a next launch would silently `refresh`/`remove`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileState {
    /// Not on disk yet. The next app launch (or `bsc config reset`) creates it.
    Missing,
    /// On disk, matches the packaged bytes exactly. Nothing to do.
    UpToDate,
    /// On disk, hashes to exactly what was last SEEDED there (not what's packaged now) — an
    /// untouched mirror that fell behind. The next app launch refreshes it silently; `reset` does
    /// the same thing immediately.
    Stale,
    /// On disk, and its hash matches neither the current packaged bytes nor the last-seeded hash: a
    /// real edit, or a pre-manifest copy of unknown provenance. Never auto-refreshed — this is the
    /// state request #168 exists for: reachable now via `status`'s diff and `reset`'s adopt.
    Diverged,
    /// The seed that put this file here no longer ships, and the on-disk copy is UNTOUCHED — the
    /// next app launch removes it silently.
    Retired,
    /// The seed that put this file here no longer ships, but the on-disk copy was EDITED — kept
    /// forever, and (unlike `Diverged`) `reset` cannot help: there is no packaged copy to adopt.
    Orphaned,
}

impl FileState {
    pub fn as_str(self) -> &'static str {
        match self {
            FileState::Missing => "missing",
            FileState::UpToDate => "up_to_date",
            FileState::Stale => "stale",
            FileState::Diverged => "diverged",
            FileState::Retired => "retired",
            FileState::Orphaned => "orphaned",
        }
    }
}

/// One file's classification.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileStatus {
    pub rel: String,
    pub state: FileState,
}

/// Classify every packaged file, PLUS every manifest-tracked file no longer packaged, against
/// `dest` — READ-ONLY: no write, no manifest mutation. The testable core of [`status`], taking an
/// explicit seed set + root so a test can drive it against a seed that differs from what this
/// binary happens to have embedded (the same reason `platform::config::seed_from` takes its seed
/// set as a parameter rather than reading `EMBEDDED` directly).
pub fn status_at(seeds: &BTreeMap<String, &'static [u8]>, dest: &Path) -> Vec<FileStatus> {
    let manifest = read_manifest(dest);
    let mut out = Vec::new();

    for (rel, bytes) in seeds {
        let seed_hash = sha256_hex(bytes);
        let target = dest.join(rel);
        let state = match std::fs::read(&target) {
            Err(_) => FileState::Missing,
            Ok(current) => {
                let current_hash = sha256_hex(&current);
                if current_hash == seed_hash {
                    FileState::UpToDate
                } else if manifest.files.get(rel).is_some_and(|h| *h == current_hash) {
                    FileState::Stale
                } else {
                    FileState::Diverged
                }
            }
        };
        out.push(FileStatus { rel: rel.clone(), state });
    }

    let live: BTreeSet<&String> = seeds.keys().collect();
    for (rel, seeded_hash) in &manifest.files {
        if live.contains(rel) {
            continue;
        }
        let target = dest.join(rel);
        match std::fs::read(&target) {
            Ok(current) if sha256_hex(&current) == *seeded_hash => {
                out.push(FileStatus { rel: rel.clone(), state: FileState::Retired });
            }
            Ok(_) => out.push(FileStatus { rel: rel.clone(), state: FileState::Orphaned }),
            Err(_) => {} // already gone on disk; nothing to report
        }
    }

    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

/// [`status_at`] against the real packaged seed and the real [`config_root`].
pub fn status() -> Vec<FileStatus> {
    status_at(&embedded_files(), &config_root())
}

/// Why [`reset`] could not adopt the packaged copy.
#[derive(Debug)]
pub enum ResetError {
    /// `rel` names no currently-packaged file — either a typo, or a RETIRED seed (there is nothing
    /// left to adopt; an orphaned file in that state can only be removed by hand).
    NotPackaged,
    Io(io::Error),
}

impl std::fmt::Display for ResetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResetError::NotPackaged => write!(
                f,
                "not a currently packaged config file (a typo, or a retired seed with nothing left to adopt — see `bsc config status`)"
            ),
            ResetError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<io::Error> for ResetError {
    fn from(e: io::Error) -> Self {
        ResetError::Io(e)
    }
}

/// Overwrite `rel`'s on-disk copy under `root` with the CURRENT packaged `bytes` and adopt that hash
/// into the manifest, so a subsequent `status_at` classifies it `UpToDate`. The testable core of
/// [`reset`].
fn reset_at(rel: &str, bytes: &[u8], root: &Path) -> Result<String, ResetError> {
    let target = root.join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&target, bytes)?;

    let mut manifest = read_manifest(root);
    let hash = sha256_hex(bytes);
    manifest.version = SEED_MANIFEST_VERSION;
    manifest.files.insert(rel.to_string(), hash.clone());
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| ResetError::Io(io::Error::other(e.to_string())))?;
    std::fs::write(manifest_path(root), json)?;
    Ok(hash)
}

/// Adopt the packaged copy of `rel` — the write half of request #168. Errors with
/// [`ResetError::NotPackaged`] when `rel` isn't currently shipped (nothing to adopt).
pub fn reset(rel: &str) -> Result<String, ResetError> {
    let bytes = packaged(rel).ok_or(ResetError::NotPackaged)?;
    reset_at(rel, bytes, &config_root())
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/diff.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-config--<module>.rs
//     bsc graph impl set --id bsc-config--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-config--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-config--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));