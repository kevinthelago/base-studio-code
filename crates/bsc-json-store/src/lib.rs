//! `bsc-json-store` core — the shared file CRUD behind the USER **verbatim-JSON-per-id** stores
//! (#2158, an instance of #1325). Both `bsc-blueprint` (`~/.base-studio-code/blueprints/<id>.json`,
//! #1719) and `bsc-persona` (`~/.base-studio-code/personas/<id>.json`, #2094) were byte-identical
//! copies of this store; they are now thin shims that supply their own directory segment + noun.
//!
//! Each record is written **verbatim** (the frontend owns the JSON shape; the store never imposes a
//! typed schema). The `id` is slugified into a single safe directory segment so it can never escape
//! the store dir — byte-identical to the app's `fsx::safe_dir_segment` slug guard (#1761).
//!
//! The agent-facing CLI scaffold lives in [`cli`] (`bsc <noun> …`), parameterized per store by a
//! [`cli::CliSpec`] and dispatched by the unified `bsc` binary (#1877).

pub mod cli;

use std::path::{Path, PathBuf};

/// A handle to a verbatim-JSON-per-id user store rooted at a store directory (`blueprints/`,
/// `personas/`, …). `noun` is the singular record name used in the id-validation error.
pub struct Store {
    dir: PathBuf,
    noun: &'static str,
}

impl Store {
    /// Open a store rooted at an explicit directory (used by the CLI + tests). `noun` names the
    /// record for the id-validation error (e.g. `"blueprint"`, `"persona"`).
    pub fn new(dir: impl Into<PathBuf>, noun: &'static str) -> Self {
        Store { dir: dir.into(), noun }
    }

    /// Open the default user store at `~/.base-studio-code/<segment>/`. `Err` when no home dir is
    /// resolvable (matching the `bsc-*` CLI convention).
    pub fn open_default(segment: &str, noun: &'static str) -> Result<Self, String> {
        let base = bsc_util::bsc_base_dir()
            .ok_or("could not resolve a home directory; set HOME/USERPROFILE")?;
        Ok(Store::new(base.join(segment), noun))
    }

    /// The on-disk path for record `id`. The id is slugified (every char outside `[A-Za-z0-9_-]`
    /// becomes `_`) and rejected when empty / `.` / `..`, so it can never escape the store dir.
    pub fn file(&self, id: &str) -> Result<PathBuf, String> {
        let safe = safe_id(id, self.noun)?;
        Ok(self.dir.join(format!("{safe}.json")))
    }

    /// The verbatim JSON of every record on disk (the library hydrates from this). Skips unreadable /
    /// empty files; a missing dir ⇒ empty.
    pub fn list(&self) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(s) = std::fs::read_to_string(&p) {
                    if !s.trim().is_empty() {
                        out.push(s);
                    }
                }
            }
        }
        out
    }

    /// The verbatim JSON of one record, or `None` if absent.
    pub fn get(&self, id: &str) -> Result<Option<String>, String> {
        let path = self.file(id)?;
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("get: {e}")),
        }
    }

    /// Persist a record to `<dir>/<id>.json`, written verbatim (the frontend owns the shape).
    pub fn set(&self, id: &str, json: &str) -> Result<(), String> {
        let path = self.file(id)?;
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        std::fs::write(&path, json).map_err(|e| format!("set: {e}"))
    }

    /// Remove a record's file (no-op if absent).
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.file(id)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
        }
        Ok(())
    }

    /// The store's directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// Slugify a record id into a single safe directory segment: keep `[A-Za-z0-9_-]`, replace every
/// other char with `_`, and reject an id with no real content (so it can never escape the parent
/// dir). Same output as `platform/fsx.rs::safe_dir_segment` for every id carrying an alphanumeric
/// (kept duplicated because that helper lives in the (Tauri) app crate) — this copy is stricter
/// only for degenerate all-punctuation ids, which it rejects instead of storing as underscores.
fn safe_id(id: &str, noun: &str) -> Result<String, String> {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // A dot can never survive the mapper above, so the fsx-style post-slug `.`/`..` match would
    // be dead code here; requiring an alphanumeric rejects the same traversal shapes (`..` slugs
    // to `__`) and keeps all-punctuation ids from colliding onto one underscores-only file.
    if !safe.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("{noun} id is empty/invalid"));
    }
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bsc-json-store-test-{}", uniq()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::new(dir.clone(), "record"), dir)
    }

    // A per-test unique suffix so parallel tests never share a dir.
    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    #[test]
    fn set_get_list_remove_round_trips() {
        let (s, _dir) = tmp_store();
        assert!(s.list().is_empty(), "a missing dir ⇒ empty list");
        assert_eq!(s.get("demo").unwrap(), None, "absent ⇒ None");

        let json = r#"{"id":"demo","name":"Demo","sections":[]}"#;
        s.set("demo", json).unwrap();
        assert_eq!(s.get("demo").unwrap().as_deref(), Some(json), "stored verbatim");
        assert_eq!(s.list(), vec![json.to_string()]);

        s.remove("demo").unwrap();
        assert_eq!(s.get("demo").unwrap(), None);
        assert!(s.list().is_empty());
        // remove is a no-op when absent.
        s.remove("demo").unwrap();
    }

    #[test]
    fn upsert_overwrites_by_id() {
        let (s, _dir) = tmp_store();
        s.set("r", r#"{"id":"r","name":"v1"}"#).unwrap();
        s.set("r", r#"{"id":"r","name":"v2"}"#).unwrap();
        assert_eq!(s.get("r").unwrap().as_deref(), Some(r#"{"id":"r","name":"v2"}"#));
        assert_eq!(s.list().len(), 1, "same id ⇒ one file");
    }

    #[test]
    fn list_skips_empty_and_non_json() {
        let (s, dir) = tmp_store();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("good.json"), r#"{"id":"good"}"#).unwrap();
        std::fs::write(dir.join("blank.json"), "   ").unwrap(); // whitespace-only ⇒ skipped
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap(); // non-json ⇒ skipped
        let mut got = s.list();
        got.sort();
        assert_eq!(got, vec![r#"{"id":"good"}"#.to_string()]);
    }

    #[test]
    fn slug_check_neutralizes_path_traversal() {
        let (s, dir) = tmp_store();
        // `..`, slashes, and separators all map to `_`, so the file stays inside the store dir.
        let path = s.file("../../etc/passwd").unwrap();
        assert_eq!(path.parent(), Some(dir.as_path()), "never escapes the store dir");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "______etc_passwd.json");
    }

    #[test]
    fn slug_check_rejects_empty_id_with_the_stores_noun() {
        let (s, _dir) = tmp_store();
        assert!(s.file("").is_err(), "empty id is rejected");
        assert!(s.set("", "{}").is_err(), "set with empty id is rejected");
        // The error carries the store's own noun so each shim reports its record name.
        assert_eq!(safe_id("", "blueprint"), Err("blueprint id is empty/invalid".into()));
        assert_eq!(safe_id("..", "persona"), Err("persona id is empty/invalid".into()));
    }
}
