//! The global UI-kit store (#2465) — immutable, versioned kit artifacts shared across blueprints.
//!
//! A blueprint REFERENCES a UI kit (a lockfile-style pin `{ id, version, hash, source? }`) instead
//! of embedding it, so the same kit is stored — and downloaded — exactly once no matter how many
//! blueprints pin it. Layout, one entry per `id@version`:
//!
//! ```text
//! ~/.base-studio-code/kits/<publisher>/<name>/<version>/
//!   manifest.json     # { id, version, sha256, kind, source? }
//!   kit.json          # the artifact (design-files kind: design.dc.html instead)
//! ```
//!
//! (The same `kits/` root also holds the FLAT component-library kit records —
//! `kits/<id>.json`, the `bsc component kit` verbatim-JSON store. The two coexist:
//! versioned entries are publisher DIRECTORIES, flat records are `.json` FILES, and
//! [`KitStore::list`] walks only the directory shape.)
//!
//! Identity is `id` (a publisher-scoped slug, `bsc/react-ui`) + an exact semver `version` + the
//! sha256 of the artifact bytes. A published `id@version` is IMMUTABLE: [`KitStore::add`] refuses to
//! overwrite an existing version with different content (changing a kit means bumping the version),
//! and is an idempotent no-op for identical content. `add` can also verify an expected sha256 BEFORE
//! writing (the resolve flow's fetch verification, #2433 posture) — on mismatch nothing is stored.
//!
//! The PACKAGED default `bsc/react-ui@1.0.0` (the generated `data/components/react-ui.json`, hash
//! sidecar `data/ui/react-ui-kit.meta.json`, both stamped by `reactUiKit.gen.test.ts`) resolves as a
//! store entry WITHOUT being copied at install time: `get`/`artifact`/`list`/`verify` fall back to
//! the embedded bytes when the entry isn't materialized on disk — so every install has the default
//! kit with zero setup, the same store-lookup → packaged-fallback overlay pattern as `@data`.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The packaged default kit's artifact — the generated `react-ui.json` (see the module docs).
/// CRLF-normalized before hashing/serving: the file is pinned `eol=lf` in .gitattributes, but a
/// pre-pin checkout may still hold it CRLF, and LF is the canonical (hash-recorded) byte form.
pub const PACKAGED_KIT_JSON: &str = include_str!("../../../src-tauri/data/components/react-ui.json");
/// The packaged kit's hash sidecar `{ id, version, kind, sha256 }` — generated alongside the
/// artifact so the packaged entry's manifest (incl. its content hash) needs no runtime hashing.
pub const PACKAGED_KIT_META_JSON: &str = include_str!("../../../src-tauri/data/ui/react-ui-kit.meta.json");

/// The two artifact kinds a store entry can hold (#2465): a component kit (a self-contained kit
/// JSON) or a design-files bundle (a `.dc.html` design document). Sibling artifacts — own id, same
/// store.
pub const KIT_KINDS: &[&str] = &["component-kit", "design-files"];

/// Lowercase hex sha256 of `bytes` — the store's one content-hash form.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The packaged artifact's canonical (LF) bytes.
fn packaged_artifact() -> String {
    PACKAGED_KIT_JSON.replace("\r\n", "\n")
}

/// The packaged entry's manifest, from the embedded sidecar, with `"source": "packaged"` stamped so
/// a reader can tell it apart from a fetched entry. `None` only on a malformed sidecar (guarded by
/// tests, so not in practice).
pub fn packaged_manifest() -> Option<Value> {
    let mut m: Value = serde_json::from_str(PACKAGED_KIT_META_JSON).ok()?;
    m.as_object_mut()?.insert("source".into(), json!("packaged"));
    Some(m)
}

/// Validate a store id: a publisher-scoped slug `publisher/name`, each segment lowercase
/// `[a-z0-9-]` starting alphanumeric. Strict (reject, not slugify) — the id IS the identity a hash
/// is pinned against, so silently rewriting it would corrupt the reference.
pub fn validate_id(id: &str) -> Result<(), String> {
    let seg_ok = |s: &str| {
        s.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
            && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    match id.split('/').collect::<Vec<_>>().as_slice() {
        [publisher, name] if seg_ok(publisher) && seg_ok(name) => Ok(()),
        _ => Err(format!(
            "invalid kit id '{id}' — want a publisher-scoped slug like 'bsc/react-ui' (lowercase [a-z0-9-], one '/')"
        )),
    }
}

/// Validate a version: `[0-9A-Za-z.-]`, starting alphanumeric (so `.`/`..`/empty can never form a
/// path segment). Exact versions only — pins carry no ranges.
pub fn validate_version(version: &str) -> Result<(), String> {
    let ok = version.starts_with(|c: char| c.is_ascii_alphanumeric())
        && version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    if ok { Ok(()) } else { Err(format!("invalid kit version '{version}' — want a semver like '1.0.0'")) }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    if KIT_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(format!("invalid kit kind '{kind}' — want one of: {}", KIT_KINDS.join(" | ")))
    }
}

/// The artifact's file name for a kind (deterministic from the manifest, so no extra field).
fn artifact_name(kind: &str) -> &'static str {
    if kind == "design-files" { "design.dc.html" } else { "kit.json" }
}

/// Split an `id@version` ref on the LAST `@` (the id itself never carries one, but be forgiving).
pub fn split_ref(kit_ref: &str) -> Result<(&str, &str), String> {
    match kit_ref.rsplit_once('@') {
        Some((id, version)) if !id.is_empty() && !version.is_empty() => Ok((id, version)),
        _ => Err(format!("invalid kit ref '{kit_ref}' — want '<id>@<version>' (e.g. bsc/react-ui@1.0.0)")),
    }
}

/// A handle to the versioned kit store rooted at a directory (`~/.base-studio-code/kits/` by
/// default). All operations resolve store-first, then fall back to the packaged entry.
pub struct KitStore {
    dir: PathBuf,
}

impl KitStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        KitStore { dir: dir.into() }
    }

    /// The default user store at `~/.base-studio-code/kits/`. `Err` when no home dir resolves.
    pub fn open_default() -> Result<Self, String> {
        let base = bsc_util::bsc_base_dir()
            .ok_or("could not resolve a home directory; set HOME/USERPROFILE")?;
        Ok(KitStore::new(base.join("kits")))
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
                serde_json::from_str(&s).map_err(|e| format!("corrupt manifest {}: {e}", path.display()))?,
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
            let kind = m.get("kind").and_then(Value::as_str).unwrap_or("component-kit");
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

    /// [`KitStore::add`] with an optional expected sha256 (lowercase hex) verified before writing.
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
        // Immutability: a published id@version never changes content. `get` also covers the
        // packaged entry, so the embedded default can't be shadowed by different bytes either.
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
        std::fs::write(dir.join("manifest.json"), pretty).map_err(|e| format!("write manifest: {e}"))?;
        Ok(manifest)
    }

    /// Every entry's manifest: the on-disk `<publisher>/<name>/<version>/manifest.json` walk plus
    /// the packaged entry when it isn't materialized. Sorted by (id, version) for stable output.
    /// Flat `kits/<id>.json` files (the component-library kit records) are ignored by shape.
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

    /// Remove a materialized entry (no-op when absent on disk). The packaged entry is embedded in
    /// the app and cannot be removed — removing its materialized copy just falls back to it.
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
            .ok_or_else(|| format!("{id}@{version} is not in the kit store"))?;
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

    fn tmp_store() -> (KitStore, PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "bsc-ui-kit-store-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (KitStore::new(dir.clone()), dir)
    }

    #[test]
    fn add_get_artifact_list_remove_round_trips() {
        let (s, dir) = tmp_store();
        let m = s.add("acme/neon", "1.2.0", "component-kit", Some("https://gist.github.com/x"), "{\"kit\":1}\n").unwrap();
        // Manifest shape: id/version/sha256/kind/source.
        assert_eq!(m["id"], "acme/neon");
        assert_eq!(m["version"], "1.2.0");
        assert_eq!(m["kind"], "component-kit");
        assert_eq!(m["source"], "https://gist.github.com/x");
        assert_eq!(m["sha256"].as_str().unwrap(), sha256_hex(b"{\"kit\":1}\n"));

        // On-disk layout: kits/<publisher>/<name>/<version>/{manifest.json, kit.json}.
        let entry = dir.join("acme").join("neon").join("1.2.0");
        assert!(entry.join("manifest.json").is_file());
        assert!(entry.join("kit.json").is_file());

        assert_eq!(s.get("acme/neon", "1.2.0").unwrap().unwrap(), m);
        assert_eq!(s.artifact("acme/neon", "1.2.0").unwrap().as_deref(), Some("{\"kit\":1}\n"));
        assert_eq!(s.get("acme/neon", "9.9.9").unwrap(), None, "unknown version ⇒ None");

        // list = the stored entry + the packaged fallback.
        let ids: Vec<String> = s.list().iter().map(|m| format!("{}@{}", m["id"].as_str().unwrap(), m["version"].as_str().unwrap())).collect();
        assert!(ids.contains(&"acme/neon@1.2.0".to_string()));
        assert!(ids.contains(&"bsc/react-ui@1.0.0".to_string()), "the packaged default is always listed: {ids:?}");

        s.remove("acme/neon", "1.2.0").unwrap();
        assert_eq!(s.get("acme/neon", "1.2.0").unwrap(), None);
        s.remove("acme/neon", "1.2.0").unwrap(); // no-op when absent
    }

    #[test]
    fn add_is_idempotent_for_identical_content_and_refuses_different_content() {
        let (s, _dir) = tmp_store();
        let m1 = s.add("acme/neon", "1.0.0", "component-kit", None, "same").unwrap();
        let m2 = s.add("acme/neon", "1.0.0", "component-kit", None, "same").unwrap();
        assert_eq!(m1, m2, "identical content ⇒ idempotent no-op");
        // Immutability: same id@version, different bytes ⇒ refused, entry untouched.
        let err = s.add("acme/neon", "1.0.0", "component-kit", None, "DIFFERENT").unwrap_err();
        assert!(err.contains("immutable"), "refusal names the immutability rule: {err}");
        assert_eq!(s.artifact("acme/neon", "1.0.0").unwrap().as_deref(), Some("same"));
    }

    #[test]
    fn add_verified_rejects_a_hash_mismatch_without_writing() {
        let (s, _dir) = tmp_store();
        let err = s
            .add_verified("acme/neon", "1.0.0", "component-kit", None, "payload", Some("deadbeef"))
            .unwrap_err();
        assert!(err.contains("sha256 mismatch"), "{err}");
        assert_eq!(s.get("acme/neon", "1.0.0").unwrap(), None, "nothing was stored");
        // The right expected hash goes through (case-insensitive).
        let expected = sha256_hex(b"payload").to_uppercase();
        s.add_verified("acme/neon", "1.0.0", "component-kit", None, "payload", Some(&expected)).unwrap();
    }

    #[test]
    fn verify_passes_a_good_entry_and_fails_a_corrupted_artifact() {
        let (s, dir) = tmp_store();
        s.add("acme/neon", "1.0.0", "component-kit", None, "good bytes").unwrap();
        assert_eq!(s.verify("acme/neon", "1.0.0").unwrap(), sha256_hex(b"good bytes"));
        // Corrupt the artifact on disk — verify must fail loudly.
        std::fs::write(dir.join("acme").join("neon").join("1.0.0").join("kit.json"), "tampered").unwrap();
        let err = s.verify("acme/neon", "1.0.0").unwrap_err();
        assert!(err.contains("FAILS verification"), "{err}");
        // A missing entry is a distinct error.
        assert!(s.verify("acme/none", "1.0.0").unwrap_err().contains("not in the kit store"));
    }

    #[test]
    fn packaged_default_resolves_without_being_materialized() {
        let (s, dir) = tmp_store();
        assert!(!dir.exists(), "nothing on disk");
        let m = s.get("bsc/react-ui", "1.0.0").unwrap().expect("packaged fallback resolves");
        assert_eq!(m["source"], "packaged");
        assert_eq!(m["kind"], "component-kit");
        let artifact = s.artifact("bsc/react-ui", "1.0.0").unwrap().expect("packaged artifact");
        assert_eq!(sha256_hex(artifact.as_bytes()), m["sha256"].as_str().unwrap(), "sidecar hash matches the embedded artifact bytes");
        // …and it verifies like any store entry.
        s.verify("bsc/react-ui", "1.0.0").unwrap();
    }

    #[test]
    fn packaged_sidecar_matches_the_embedded_artifact_and_the_generator_identity() {
        // Drift guard for the generated pair (reactUiKit.gen.test.ts writes both): the sidecar's
        // sha256 is the hash of the artifact's canonical LF bytes, and the identity is the packaged
        // pin every new blueprint gets.
        let meta: Value = serde_json::from_str(PACKAGED_KIT_META_JSON).unwrap();
        assert_eq!(meta["id"], "bsc/react-ui");
        assert_eq!(meta["version"], "1.0.0");
        assert_eq!(meta["kind"], "component-kit");
        assert_eq!(
            meta["sha256"].as_str().unwrap(),
            sha256_hex(packaged_artifact().as_bytes()),
            "react-ui-kit.meta.json drifted from react-ui.json — run `UPDATE_KITS=1 npx vitest run reactUiKit.gen`"
        );
        // The artifact self-describes the same identity (stamped by the generator).
        let artifact: Value = serde_json::from_str(&packaged_artifact()).unwrap();
        assert_eq!(artifact["id"], meta["id"]);
        assert_eq!(artifact["version"], meta["version"]);
    }

    #[test]
    fn packaged_entry_is_immutable_too() {
        let (s, _dir) = tmp_store();
        let err = s.add("bsc/react-ui", "1.0.0", "component-kit", None, "not the packaged bytes").unwrap_err();
        assert!(err.contains("immutable"), "{err}");
        // Materializing the EXACT packaged bytes is fine (idempotent with the fallback)…
        s.add("bsc/react-ui", "1.0.0", "component-kit", None, &packaged_artifact()).unwrap();
        // …and list stays deduped: one bsc/react-ui@1.0.0.
        let hits = s.list().iter().filter(|m| m["id"] == "bsc/react-ui" && m["version"] == "1.0.0").count();
        assert_eq!(hits, 1);
    }

    #[test]
    fn design_files_kind_stores_under_its_own_artifact_name() {
        let (s, dir) = tmp_store();
        s.add("acme/neon-design", "0.1.0", "design-files", None, "<!doctype html>…").unwrap();
        assert!(dir.join("acme").join("neon-design").join("0.1.0").join("design.dc.html").is_file());
        assert_eq!(s.artifact("acme/neon-design", "0.1.0").unwrap().as_deref(), Some("<!doctype html>…"));
        s.verify("acme/neon-design", "0.1.0").unwrap();
    }

    #[test]
    fn identity_validation_is_strict() {
        // Ids: publisher-scoped lowercase slugs only — never slugified (identity, not storage).
        for bad in ["react-ui", "a/b/c", "A/b", "a/", "/b", "a/../b", "a b/c", ""] {
            assert!(validate_id(bad).is_err(), "id '{bad}' must be rejected");
        }
        validate_id("bsc/react-ui").unwrap();
        validate_id("acme-corp/kit2").unwrap();
        // Versions: exact, path-safe.
        for bad in ["", ".", "..", "1.0/0", "1.0\\0", "@", "-1"] {
            assert!(validate_version(bad).is_err(), "version '{bad}' must be rejected");
        }
        validate_version("1.0.0").unwrap();
        validate_version("2.0.0-rc.1").unwrap();
        // Kinds: the closed set.
        assert!(validate_kind("blueprint").is_err());
        validate_kind("component-kit").unwrap();
        validate_kind("design-files").unwrap();
        // Refs: id@version.
        assert_eq!(split_ref("bsc/react-ui@1.0.0").unwrap(), ("bsc/react-ui", "1.0.0"));
        assert!(split_ref("bsc/react-ui").is_err());
        assert!(split_ref("@1.0.0").is_err());
    }
}
