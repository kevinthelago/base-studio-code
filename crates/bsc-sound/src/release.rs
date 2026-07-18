//! The global SOUND-kit release store (#3371, epic #3071 phase 4) — immutable, versioned sound-kit
//! artifacts a blueprint can pin.
//!
//! This is the sounds twin of the UI-kit release store ([`bsc_ui::kit`], #2465), deliberately
//! MIRRORED rather than reinvented: same manifest shape, same content-addressing, same immutability
//! rule, same packaged-fallback overlay, same `list|get|add|remove|verify` contract. A blueprint
//! REFERENCES a sound kit as a lockfile-style pin `{ id, version, hash, source? }` instead of
//! embedding it, so the same kit is stored — and downloaded — exactly once no matter how many
//! blueprints pin it. Layout, one entry per `id@version`:
//!
//! ```text
//! ~/.base-studio-code/sound-kits/<publisher>/<name>/<version>/
//!   manifest.json     # { id, version, sha256, kind: "sound-kit", source? }
//!   kit.json          # the artifact: the sound-kit object { id, name, primitives, voices, cues }
//! ```
//!
//! **Two stores, one crate, no overlap.** The FLAT working store (`bsc sound list/get/set/remove`,
//! #3080) is a SQLite `sounds.db` keyed by bare kit id — mutable, what the sound-designer authors
//! into. This RELEASE store is a directory of frozen `id@version` artifacts under a DIFFERENT root
//! (`sound-kits/`, never `sounds/`), so a release can never shadow a working kit or vice versa. The
//! backend split is the same one `bsc ui` already makes: a content-addressed immutable artifact is a
//! file tree (the artifact bytes ARE the identity), not a row in a mutable key/value store.
//!
//! Identity is `id` (a publisher-scoped slug, `bsc/signal`) + an exact `version` + the sha256 of the
//! artifact bytes. A published `id@version` is IMMUTABLE: [`ReleaseStore::add`] refuses to overwrite
//! an existing version with different content (changing a kit means bumping the version), and is an
//! idempotent no-op for identical content. `add` can also verify an expected sha256 BEFORE writing
//! (the resolve flow's fetch verification) — on mismatch nothing is stored.
//!
//! The PACKAGED default `bsc/signal@1.0.0` (the seed `data/sounds/signal.json`, hash sidecar
//! `data/sound/signal-kit.meta.json`) resolves as a store entry WITHOUT being copied at install time:
//! `get`/`artifact`/`list`/`verify` fall back to the embedded bytes when the entry isn't materialized
//! on disk — so a fresh install has the default kit with ZERO network, the same store-lookup →
//! packaged-fallback overlay pattern as `@data` and as `PACKAGED_UI_KIT_PIN`.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The packaged default kit's artifact — the `signal` seed (see the module docs). CRLF-normalized
/// before hashing/serving: the file is pinned `eol=lf` in .gitattributes, but a pre-pin checkout may
/// still hold it CRLF, and LF is the canonical (hash-recorded) byte form.
pub const PACKAGED_KIT_JSON: &str = include_str!("../../../src-tauri/data/sounds/signal.json");
/// The packaged kit's hash sidecar `{ id, version, kind, sha256 }` — generated alongside the artifact
/// (`signalKit.gen.test.ts`) so the packaged entry's manifest identity is DERIVED, never
/// hand-maintained. It lives under `data/sound/` (singular), NOT `data/sounds/`, so the frontend's
/// `@data/sounds/*.json` kit glob can never mistake the sidecar for a kit — exactly why the UI twin
/// sits in `data/ui/` rather than `data/components/`.
pub const PACKAGED_KIT_META_JSON: &str =
    include_str!("../../../src-tauri/data/sound/signal-kit.meta.json");

/// The one artifact kind this store holds. A closed set (like the UI store's) so a typo'd `--kind`
/// is rejected instead of silently creating an unreadable entry class.
pub const KIT_KINDS: &[&str] = &["sound-kit"];

/// Lowercase hex sha256 of `bytes` — the store's one content-hash form.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The packaged artifact's canonical (LF) bytes.
fn packaged_artifact() -> String {
    PACKAGED_KIT_JSON.replace("\r\n", "\n")
}

/// The packaged entry's manifest, from the embedded sidecar, with `"source": "packaged"` stamped so a
/// reader can tell it apart from a fetched entry. `None` only on a malformed sidecar (guarded by
/// tests, so not in practice).
pub fn packaged_manifest() -> Option<Value> {
    let mut m: Value = serde_json::from_str(PACKAGED_KIT_META_JSON).ok()?;
    m.as_object_mut()?.insert("source".into(), json!("packaged"));
    Some(m)
}

/// Validate a store id: a publisher-scoped slug `publisher/name`, each segment lowercase `[a-z0-9-]`
/// starting alphanumeric. Strict (reject, not slugify) — the id IS the identity a hash is pinned
/// against, so silently rewriting it would corrupt the reference.
pub fn validate_id(id: &str) -> Result<(), String> {
    let seg_ok = |s: &str| {
        s.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    match id.split('/').collect::<Vec<_>>().as_slice() {
        [publisher, name] if seg_ok(publisher) && seg_ok(name) => Ok(()),
        _ => Err(format!(
            "invalid sound-kit id '{id}' — want a publisher-scoped slug like 'bsc/signal' (lowercase [a-z0-9-], one '/')"
        )),
    }
}

/// Validate a version: `[0-9A-Za-z.-]`, starting alphanumeric (so `.`/`..`/empty can never form a path
/// segment). Exact versions only — pins carry no ranges.
pub fn validate_version(version: &str) -> Result<(), String> {
    let ok = version.starts_with(|c: char| c.is_ascii_alphanumeric())
        && version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("invalid sound-kit version '{version}' — want a semver like '1.0.0'"))
    }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if KIT_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("invalid sound-kit kind '{kind}' — want one of: {}", KIT_KINDS.join(" | ")))
    }
}

/// The artifact's file name (deterministic from the kind, so no extra manifest field). One kind
/// today; kept as a function so a future sibling kind slots in the way `design-files` did for UI.
fn artifact_name(_kind: &str) -> &'static str {
    "kit.json"
}

/// Split an `id@version` ref on the LAST `@` (the id itself never carries one, but be forgiving).
pub fn split_ref(kit_ref: &str) -> Result<(&str, &str), String> {
    match kit_ref.rsplit_once('@') {
        Some((id, version)) if !id.is_empty() && !version.is_empty() => Ok((id, version)),
        _ => Err(format!(
            "invalid sound-kit ref '{kit_ref}' — want '<id>@<version>' (e.g. bsc/signal@1.0.0)"
        )),
    }
}

/// Refuse a HOLLOW or shapeless release BEFORE the immutable entry is written (the #3167 posture,
/// applied to sounds from the start). A release must carry a real, playable payload:
///
/// - empty / whitespace-only content is refused (an empty `--file`, or nothing on stdin — the
///   pipeline produced no bytes);
/// - the content must parse as a JSON OBJECT holding a NON-EMPTY `cues` array — the exact shape the
///   store's consumers (`compileCue`, the `@bsc/sounds/<id>` resolver) read — so a parse failure, a
///   non-object, a missing `cues`, or zero cues is refused. A kit with no cues maps to no UI sound at
///   all: it is a silently-failed assembly, never a real kit.
///
/// The `release add` verb calls this before [`ReleaseStore::add`]/[`ReleaseStore::add_verified`], so
/// no path can persist a hollow entry. (The store itself stays content-agnostic — it hashes opaque
/// bytes — so this shape gate lives at the one user-facing entry point, not in the immutable-store
/// primitive.)
pub fn validate_artifact(_kind: &str, content: &str) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err(
            "refusing to store an EMPTY sound-kit release artifact — the release produced no bytes (an empty --file, or nothing on stdin)"
                .to_string(),
        );
    }
    let value: Value = serde_json::from_str(content).map_err(|e| {
        format!(
            "sound-kit release artifact is not valid JSON: {e} — it must be the kit object {{ id, name, primitives, voices, cues }}"
        )
    })?;
    let cues = value.get("cues").and_then(Value::as_array).ok_or_else(|| {
        "sound-kit release artifact has no `cues` array — it isn't a sound kit ({ id, name, primitives, voices, cues }); refusing to store a shapeless release"
            .to_string()
    })?;
    if cues.is_empty() {
        return Err(
            "sound-kit release artifact has ZERO cues — refusing to store a hollow release (a kit with no cues maps to no UI sound)"
                .to_string(),
        );
    }
    Ok(())
}

/// Canonicalize a live sound kit into release-artifact bytes (the `--from-store` one-shot). Unlike the
/// UI twin — where a kit is assembled from a kit record PLUS N separate component records — a sound
/// kit is ALREADY self-contained (`{ id, name, primitives, voices, cues }` in one record), so the
/// artifact is the kit itself. Re-serialized pretty with a trailing newline — the canonical byte form
/// — so the hash depends on the kit's CONTENT, not on however the authoring session happened to
/// format its `bsc sound set` payload. The emptiness/shape floor is [`validate_artifact`], which the
/// `add` verb runs on this result, so a cue-less kit is refused there rather than silently stored.
pub fn assemble_artifact(kit: &Value) -> String {
    let mut s = serde_json::to_string_pretty(kit).unwrap_or_else(|_| "{}".to_string());
    s.push('\n');
    s
}

/// A handle to the versioned sound-kit release store rooted at a directory
/// (`~/.base-studio-code/sound-kits/` by default). All operations resolve store-first, then fall back
/// to the packaged entry.
pub struct ReleaseStore {
    dir: PathBuf,
}

impl ReleaseStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        ReleaseStore { dir: dir.into() }
    }

    /// The default user store at `~/.base-studio-code/sound-kits/`. `Err` when no home dir resolves.
    pub fn open_default() -> Result<Self, String> {
        let base =
            bsc_util::bsc_base_dir().ok_or("could not resolve a home directory; set HOME/USERPROFILE")?;
        Ok(ReleaseStore::new(base.join("sound-kits")))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The on-disk entry dir for `id@version` (validated, so it can never escape the store root).
    fn entry_dir(&self, id: &str, version: &str) -> Result<PathBuf, String> {
        validate_id(id)?;
        validate_version(version)?;
        let (publisher, name) = id.split_once('/').expect("validated id has one '/'");
        Ok(self.dir.join(publisher).join(name).join(version))
    }

    /// The manifest of an entry MATERIALIZED on disk, or `None`.
    fn manifest_on_disk(&self, id: &str, version: &str) -> Result<Option<Value>, String> {
        let path = self.entry_dir(id, version)?.join("manifest.json");
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(Some(
                serde_json::from_str(&s)
                    .map_err(|e| format!("corrupt manifest {}: {e}", path.display()))?,
            )),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("read {}: {e}", path.display())),
        }
    }

    /// Whether `id@version` is the packaged default entry.
    fn is_packaged(id: &str, version: &str) -> bool {
        packaged_manifest().is_some_and(|m| {
            m.get("id").and_then(Value::as_str) == Some(id)
                && m.get("version").and_then(Value::as_str) == Some(version)
        })
    }

    /// One entry's manifest: the on-disk entry, else the packaged fallback, else `None`.
    pub fn get(&self, id: &str, version: &str) -> Result<Option<Value>, String> {
        if let Some(m) = self.manifest_on_disk(id, version)? {
            return Ok(Some(m));
        }
        Ok(if Self::is_packaged(id, version) { packaged_manifest() } else { None })
    }

    /// One entry's artifact text: on-disk, else the packaged fallback, else `None`.
    pub fn artifact(&self, id: &str, version: &str) -> Result<Option<String>, String> {
        if let Some(m) = self.manifest_on_disk(id, version)? {
            let kind = m.get("kind").and_then(Value::as_str).unwrap_or("sound-kit");
            let path = self.entry_dir(id, version)?.join(artifact_name(kind));
            return std::fs::read_to_string(&path)
                .map(Some)
                .map_err(|e| format!("read {}: {e}", path.display()));
        }
        Ok(if Self::is_packaged(id, version) { Some(packaged_artifact()) } else { None })
    }

    /// Add `id@version` with the artifact `content`. Computes the sha256; when `expected_sha256` is
    /// given the content is verified BEFORE anything is written (mismatch ⇒ `Err`, no store entry —
    /// the resolve flow's loud rejection). Immutability: an existing `id@version` (on disk or the
    /// packaged entry) with a DIFFERENT hash is refused; identical content is an idempotent no-op.
    /// Returns the entry's manifest.
    pub fn add(
        &self,
        id: &str,
        version: &str,
        kind: &str,
        source: Option<&str>,
        content: &str,
    ) -> Result<Value, String> {
        self.add_verified(id, version, kind, source, content, None)
    }

    /// [`ReleaseStore::add`] with an optional expected sha256 (lowercase hex) verified before writing.
    pub fn add_verified(
        &self,
        id: &str,
        version: &str,
        kind: &str,
        source: Option<&str>,
        content: &str,
        expected_sha256: Option<&str>,
    ) -> Result<Value, String> {
        validate_id(id)?;
        validate_version(version)?;
        validate_kind(kind)?;
        let hash = sha256_hex(content.as_bytes());
        if let Some(expected) = expected_sha256 {
            if !expected.eq_ignore_ascii_case(&hash) {
                return Err(format!(
                    "sha256 mismatch for {id}@{version}: expected {expected}, got {hash} — refusing to store"
                ));
            }
        }
        // Immutability: a published id@version never changes content. `get` also covers the packaged
        // entry, so the embedded default can't be shadowed by different bytes either.
        if let Some(existing) = self.get(id, version)? {
            let existing_hash = existing.get("sha256").and_then(Value::as_str).unwrap_or("");
            if existing_hash.eq_ignore_ascii_case(&hash) {
                return Ok(existing); // identical content — idempotent
            }
            return Err(format!(
                "{id}@{version} already exists with different content (sha256 {existing_hash} vs {hash}) — published versions are immutable; bump the version"
            ));
        }
        let mut manifest = json!({ "id": id, "version": version, "sha256": hash, "kind": kind });
        if let Some(src) = source.filter(|s| !s.is_empty()) {
            manifest["source"] = json!(src);
        }
        let dir = self.entry_dir(id, version)?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        std::fs::write(dir.join(artifact_name(kind)), content)
            .map_err(|e| format!("write artifact: {e}"))?;
        let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("manifest.json"), pretty)
            .map_err(|e| format!("write manifest: {e}"))?;
        Ok(manifest)
    }

    /// Every entry's manifest: the on-disk `<publisher>/<name>/<version>/manifest.json` walk plus the
    /// packaged entry when it isn't materialized. Sorted by (id, version) for stable output.
    pub fn list(&self) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        let dirs = |p: &Path| -> Vec<PathBuf> {
            std::fs::read_dir(p)
                .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect())
                .unwrap_or_default()
        };
        for publisher in dirs(&self.dir) {
            for name in dirs(&publisher) {
                for version in dirs(&name) {
                    if let Ok(s) = std::fs::read_to_string(version.join("manifest.json")) {
                        if let Ok(m) = serde_json::from_str::<Value>(&s) {
                            out.push(m);
                        }
                    }
                }
            }
        }
        if let Some(packaged) = packaged_manifest() {
            let same = |m: &Value| {
                m.get("id") == packaged.get("id") && m.get("version") == packaged.get("version")
            };
            if !out.iter().any(same) {
                out.push(packaged);
            }
        }
        let key = |m: &Value| {
            (
                m.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                m.get("version").and_then(Value::as_str).unwrap_or("").to_string(),
            )
        };
        out.sort_by_key(key);
        out
    }

    /// Remove a materialized entry (no-op when absent on disk). The packaged entry is embedded in the
    /// app and cannot be removed — removing its materialized copy just falls back to it.
    pub fn remove(&self, id: &str, version: &str) -> Result<(), String> {
        let dir = self.entry_dir(id, version)?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
        }
        Ok(())
    }

    /// Recompute an entry's artifact hash and check it against its manifest's `sha256`. `Ok(hash)`
    /// when they match; `Err` on a missing entry or a mismatch (a corrupted/tampered artifact).
    pub fn verify(&self, id: &str, version: &str) -> Result<String, String> {
        let manifest = self
            .get(id, version)?
            .ok_or_else(|| format!("{id}@{version} is not in the sound-kit release store"))?;
        let artifact = self
            .artifact(id, version)?
            .ok_or_else(|| format!("{id}@{version} has no artifact"))?;
        let recorded = manifest.get("sha256").and_then(Value::as_str).unwrap_or("").to_string();
        let actual = sha256_hex(artifact.as_bytes());
        if recorded.eq_ignore_ascii_case(&actual) {
            Ok(actual)
        } else {
            Err(format!(
                "{id}@{version} FAILS verification: manifest records sha256 {recorded}, artifact hashes to {actual}"
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (ReleaseStore, PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "bsc-sound-release-store-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (ReleaseStore::new(dir.clone()), dir)
    }

    /// A minimal but SHAPED sound-kit artifact (non-empty `cues`) — what the validation gate accepts.
    fn kit_json(cue: &str) -> String {
        format!(
            "{{\"id\":\"neon\",\"name\":\"Neon\",\"primitives\":[],\"voices\":[],\"cues\":[{{\"id\":\"{cue}\"}}]}}\n"
        )
    }

    #[test]
    fn add_get_artifact_list_remove_round_trips() {
        let (s, dir) = tmp_store();
        let art = kit_json("click");
        let m = s
            .add("acme/neon", "1.2.0", "sound-kit", Some("https://gist.github.com/x"), &art)
            .unwrap();
        // Manifest shape: id/version/sha256/kind/source — identical to the UI twin's.
        assert_eq!(m["id"], "acme/neon");
        assert_eq!(m["version"], "1.2.0");
        assert_eq!(m["kind"], "sound-kit");
        assert_eq!(m["source"], "https://gist.github.com/x");
        assert_eq!(m["sha256"].as_str().unwrap(), sha256_hex(art.as_bytes()));

        // On-disk layout: sound-kits/<publisher>/<name>/<version>/{manifest.json, kit.json}.
        let entry = dir.join("acme").join("neon").join("1.2.0");
        assert!(entry.join("manifest.json").is_file());
        assert!(entry.join("kit.json").is_file());

        assert_eq!(s.get("acme/neon", "1.2.0").unwrap().unwrap(), m);
        assert_eq!(s.artifact("acme/neon", "1.2.0").unwrap().as_deref(), Some(art.as_str()));
        // An UNKNOWN version of a known id resolves to nothing (never a nearest-match fallback).
        assert_eq!(s.get("acme/neon", "9.9.9").unwrap(), None, "unknown version ⇒ None");
        assert_eq!(s.artifact("acme/neon", "9.9.9").unwrap(), None);
        assert_eq!(s.get("acme/unknown", "1.2.0").unwrap(), None, "unknown id ⇒ None");
        // …and resolving it as a REF fails loudly rather than returning a stale entry.
        assert!(s.verify("acme/neon", "9.9.9").unwrap_err().contains("not in the sound-kit release store"));

        // list = the stored entry + the packaged fallback.
        let ids: Vec<String> = s
            .list()
            .iter()
            .map(|m| format!("{}@{}", m["id"].as_str().unwrap(), m["version"].as_str().unwrap()))
            .collect();
        assert!(ids.contains(&"acme/neon@1.2.0".to_string()));
        assert!(
            ids.contains(&"bsc/signal@1.0.0".to_string()),
            "the packaged default is always listed: {ids:?}"
        );

        s.remove("acme/neon", "1.2.0").unwrap();
        assert_eq!(s.get("acme/neon", "1.2.0").unwrap(), None);
        s.remove("acme/neon", "1.2.0").unwrap(); // no-op when absent
    }

    #[test]
    fn add_is_idempotent_for_identical_content_and_refuses_a_duplicate_with_different_bytes() {
        let (s, _dir) = tmp_store();
        let art = kit_json("click");
        let m1 = s.add("acme/neon", "1.0.0", "sound-kit", None, &art).unwrap();
        let m2 = s.add("acme/neon", "1.0.0", "sound-kit", None, &art).unwrap();
        assert_eq!(m1, m2, "identical content ⇒ idempotent no-op");
        // Immutability: the DUPLICATE-release failure case — same id@version, different bytes.
        let err = s.add("acme/neon", "1.0.0", "sound-kit", None, &kit_json("toggle")).unwrap_err();
        assert!(err.contains("immutable"), "refusal names the immutability rule: {err}");
        assert!(err.contains("bump the version"), "and says how to proceed: {err}");
        // …and the stored entry is UNTOUCHED by the refused write.
        assert_eq!(s.artifact("acme/neon", "1.0.0").unwrap().as_deref(), Some(art.as_str()));
    }

    #[test]
    fn add_verified_rejects_a_hash_mismatch_without_writing() {
        let (s, _dir) = tmp_store();
        let art = kit_json("click");
        let err = s
            .add_verified("acme/neon", "1.0.0", "sound-kit", None, &art, Some("deadbeef"))
            .unwrap_err();
        assert!(err.contains("sha256 mismatch"), "{err}");
        assert_eq!(s.get("acme/neon", "1.0.0").unwrap(), None, "nothing was stored");
        // The right expected hash goes through (case-insensitive).
        let expected = sha256_hex(art.as_bytes()).to_uppercase();
        s.add_verified("acme/neon", "1.0.0", "sound-kit", None, &art, Some(&expected)).unwrap();
    }

    #[test]
    fn verify_passes_a_good_entry_and_fails_loudly_on_a_corrupted_artifact() {
        let (s, dir) = tmp_store();
        let art = kit_json("click");
        s.add("acme/neon", "1.0.0", "sound-kit", None, &art).unwrap();
        assert_eq!(s.verify("acme/neon", "1.0.0").unwrap(), sha256_hex(art.as_bytes()));
        // Corrupt the artifact on disk — verify must fail loudly, naming both hashes.
        std::fs::write(dir.join("acme").join("neon").join("1.0.0").join("kit.json"), "tampered")
            .unwrap();
        let err = s.verify("acme/neon", "1.0.0").unwrap_err();
        assert!(err.contains("FAILS verification"), "{err}");
        assert!(err.contains(&sha256_hex(b"tampered")), "names the actual hash: {err}");
        // A missing entry is a DISTINCT error (not a verification failure).
        assert!(s.verify("acme/none", "1.0.0").unwrap_err().contains("not in the sound-kit release store"));
    }

    #[test]
    fn packaged_signal_kit_resolves_offline_without_being_materialized() {
        let (s, dir) = tmp_store();
        assert!(!dir.exists(), "nothing on disk — a fresh install");
        let m = s.get("bsc/signal", "1.0.0").unwrap().expect("packaged fallback resolves");
        assert_eq!(m["source"], "packaged", "tagged as the embedded entry, not a fetched one");
        assert_eq!(m["kind"], "sound-kit");
        let artifact = s.artifact("bsc/signal", "1.0.0").unwrap().expect("packaged artifact");
        assert_eq!(
            sha256_hex(artifact.as_bytes()),
            m["sha256"].as_str().unwrap(),
            "sidecar hash matches the embedded artifact bytes"
        );
        // …and it verifies like any store entry, with no network and no store dir.
        s.verify("bsc/signal", "1.0.0").unwrap();
        assert!(!dir.exists(), "resolving the packaged entry materializes NOTHING");
        // The artifact really is the playable kit (the shape `compileCue` reads).
        let kit: Value = serde_json::from_str(&artifact).unwrap();
        assert_eq!(kit["id"], "signal");
        assert!(!kit["cues"].as_array().unwrap().is_empty(), "the packaged kit carries cues");
        validate_artifact("sound-kit", &artifact).unwrap();
    }

    #[test]
    fn packaged_sidecar_matches_the_embedded_artifact_and_the_generator_identity() {
        // Drift guard for the generated pair (signalKit.gen.test.ts writes the sidecar): its sha256 is
        // the hash of the seed's canonical LF bytes, and the identity is the packaged pin #3372 will
        // default every new blueprint to.
        let meta: Value = serde_json::from_str(PACKAGED_KIT_META_JSON).unwrap();
        assert_eq!(meta["id"], "bsc/signal");
        assert_eq!(meta["version"], "1.0.0");
        assert_eq!(meta["kind"], "sound-kit");
        assert_eq!(
            meta["sha256"].as_str().unwrap(),
            sha256_hex(packaged_artifact().as_bytes()),
            "signal-kit.meta.json drifted from signal.json — run `UPDATE_KITS=1 npx vitest run signalKit.gen`"
        );
    }

    #[test]
    fn packaged_entry_is_immutable_too_and_lists_once() {
        let (s, _dir) = tmp_store();
        let err = s.add("bsc/signal", "1.0.0", "sound-kit", None, &kit_json("click")).unwrap_err();
        assert!(err.contains("immutable"), "{err}");
        // Materializing the EXACT packaged bytes is fine (idempotent with the fallback)…
        s.add("bsc/signal", "1.0.0", "sound-kit", None, &packaged_artifact()).unwrap();
        // …and list stays deduped: one bsc/signal@1.0.0.
        let hits =
            s.list().iter().filter(|m| m["id"] == "bsc/signal" && m["version"] == "1.0.0").count();
        assert_eq!(hits, 1);
    }

    /// The release store is a SEPARATE root from the flat working store (`sounds.db`): a release never
    /// shadows a working kit and `bsc sound get <id>` never sees a release. Pins the two-store split.
    #[test]
    fn release_store_is_isolated_from_the_flat_kit_store() {
        use bsc_json_store::Store;
        let (_s, dir) = tmp_store();
        let base = dir.join("base");
        std::fs::create_dir_all(&base).unwrap();

        // The flat working store, exactly as `cli::SPEC` configures it (segment `sounds`).
        let flat = Store::new(base.join("sounds"), "sound");
        flat.set("neon", "{\"id\":\"neon\",\"name\":\"Working\"}").unwrap();
        // The release store, at its OWN segment (`sound-kits`).
        let releases = ReleaseStore::new(base.join("sound-kits"));
        releases.add("acme/neon", "1.0.0", "sound-kit", None, &kit_json("click")).unwrap();

        // Distinct roots: the SQLite db and the versioned tree never collide.
        assert!(base.join("sounds.db").is_file(), "the flat store is sounds.db");
        assert!(base.join("sound-kits").join("acme").join("neon").join("1.0.0").is_dir());
        assert!(!base.join("sounds").join("acme").exists(), "no release wrote into the flat store");

        // Neither store can see the other's record.
        assert_eq!(releases.get("acme/neon", "1.0.0").unwrap().unwrap()["kind"], "sound-kit");
        assert_eq!(
            flat.get("neon").unwrap().as_deref(),
            Some("{\"id\":\"neon\",\"name\":\"Working\"}"),
            "the working kit is untouched by the release"
        );
        assert_eq!(flat.get("acme/neon").unwrap(), None, "a release id is not a flat-store key");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn identity_validation_is_strict() {
        // Ids: publisher-scoped lowercase slugs only — never slugified (identity, not storage).
        for bad in ["signal", "a/b/c", "A/b", "a/", "/b", "a/../b", "a b/c", ""] {
            assert!(validate_id(bad).is_err(), "id '{bad}' must be rejected");
        }
        validate_id("bsc/signal").unwrap();
        validate_id("acme-corp/kit2").unwrap();
        // Versions: exact, path-safe.
        for bad in ["", ".", "..", "1.0/0", "1.0\\0", "@", "-1"] {
            assert!(validate_version(bad).is_err(), "version '{bad}' must be rejected");
        }
        validate_version("1.0.0").unwrap();
        validate_version("2.0.0-rc.1").unwrap();
        // Kinds: the closed set — the UI store's kinds are NOT sound kinds.
        assert!(validate_kind("component-kit").is_err());
        assert!(validate_kind("design-files").is_err());
        validate_kind("sound-kit").unwrap();
        // Refs: id@version.
        assert_eq!(split_ref("bsc/signal@1.0.0").unwrap(), ("bsc/signal", "1.0.0"));
        assert!(split_ref("bsc/signal").is_err());
        assert!(split_ref("@1.0.0").is_err());
    }

    #[test]
    fn validate_artifact_refuses_empty_cueless_and_unparseable() {
        assert!(validate_artifact("sound-kit", "").unwrap_err().contains("EMPTY"));
        assert!(validate_artifact("sound-kit", "   \n\t ").unwrap_err().contains("EMPTY"));
        assert!(validate_artifact("sound-kit", "{ not json").unwrap_err().contains("not valid JSON"));
        // Valid JSON, wrong shape — no `cues` array.
        assert!(validate_artifact("sound-kit", "{\"id\":\"neon\"}").unwrap_err().contains("no `cues`"));
        assert!(validate_artifact("sound-kit", "[1,2,3]").unwrap_err().contains("no `cues`"));
        // The hollow-release case: a kit with zero cues maps to no UI sound at all.
        let hollow = "{\"id\":\"neon\",\"name\":\"N\",\"primitives\":[],\"voices\":[],\"cues\":[]}";
        assert!(validate_artifact("sound-kit", hollow).unwrap_err().contains("ZERO cues"));
        // A real, shaped kit passes.
        validate_artifact("sound-kit", &kit_json("click")).unwrap();
    }

    #[test]
    fn assemble_artifact_canonicalizes_a_live_kit_into_a_verifiable_release() {
        // Two formattings of the SAME kit canonicalize to identical bytes — so the release hash tracks
        // content, not the authoring session's whitespace.
        let compact: Value =
            serde_json::from_str("{\"id\":\"neon\",\"name\":\"Neon\",\"cues\":[{\"id\":\"click\"}]}")
                .unwrap();
        let spaced: Value = serde_json::from_str(
            "{\n  \"id\" : \"neon\",\n  \"name\":  \"Neon\",\n  \"cues\" : [ { \"id\": \"click\" } ]\n}",
        )
        .unwrap();
        let a = assemble_artifact(&compact);
        assert_eq!(a, assemble_artifact(&spaced), "formatting-independent canonical bytes");
        assert!(a.ends_with('\n'), "canonical trailing newline");

        // The assembled artifact is exactly the shape the `add` verb's gate accepts…
        validate_artifact("sound-kit", &a).unwrap();
        // …and a store round-trips + verifies it.
        let (s, _dir) = tmp_store();
        s.add("acme/neon", "2.0.0", "sound-kit", None, &a).unwrap();
        s.verify("acme/neon", "2.0.0").unwrap();
        assert_eq!(s.artifact("acme/neon", "2.0.0").unwrap().as_deref(), Some(a.as_str()));
    }

    #[test]
    fn assemble_artifact_with_no_cues_is_caught_by_the_validation_gate() {
        // An authoring session that never added a cue yields an empty `cues` array — refused by the
        // gate the `add` verb runs, so a hollow --from-store release is never stored.
        let kit: Value = serde_json::from_str("{\"id\":\"neon\",\"cues\":[]}").unwrap();
        assert!(validate_artifact("sound-kit", &assemble_artifact(&kit))
            .unwrap_err()
            .contains("ZERO cues"));
    }
}
