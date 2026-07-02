//! `bsc-blueprint` core — file CRUD over the USER blueprint store at
//! `~/.base-studio-code/blueprints/<id>.json` (#1719, an instance of #1325).
//!
//! This is the one store the desktop Skills/Blueprint library and every live console session share:
//! the desktop UI reaches it through the generic `bsc` command (`bsc blueprint …`, #2143 — it retired
//! the per-verb `list/write/delete_blueprint` Tauri commands), and a session's own shell reaches the
//! same store through the [`cli`] module. Built-in blueprints are code/JSON-owned and out of scope —
//! this is the user store only.
//!
//! Each blueprint is written **verbatim** (the frontend owns the JSON shape; the store never imposes
//! a typed schema). The `id` is slugified into a single safe directory segment so it can never escape
//! the `blueprints/` dir — byte-identical to the Tauri path's `safe_dir_segment` check.
//!
//! The agent-facing CLI lives in [`cli`] (`bsc blueprint …`), dispatched by the unified `bsc` binary
//! (#1877) and by the legacy `bsc-blueprint` shim.

pub mod cli;

use std::path::{Path, PathBuf};

/// A handle to the user blueprint store rooted at a `blueprints/` directory.
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// Open a store rooted at an explicit `blueprints/` directory (used by tests + callers that
    /// resolve the base dir themselves).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Store { dir: dir.into() }
    }

    /// Open the default user store at `~/.base-studio-code/blueprints/`. `Err` when no home dir is
    /// resolvable (matching the `bsc-*` CLI convention).
    pub fn open_default() -> Result<Self, String> {
        let base = bsc_util::bsc_base_dir()
            .ok_or("could not resolve a home directory; set HOME/USERPROFILE")?;
        Ok(Store::new(base.join("blueprints")))
    }

    /// The on-disk path for blueprint `id`. The id is slugified (every char outside
    /// `[A-Za-z0-9_-]` becomes `_`) and rejected when empty / `.` / `..`, so it can never escape the
    /// `blueprints/` dir — byte-identical to the app's `fsx::safe_dir_segment` slug guard (#1761).
    pub fn file(&self, id: &str) -> Result<PathBuf, String> {
        let safe = safe_id(id)?;
        Ok(self.dir.join(format!("{safe}.json")))
    }

    /// The verbatim JSON of every user blueprint on disk (the library hydrates from this + the
    /// bundled built-ins). Skips unreadable / empty files; a missing dir ⇒ empty.
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

    /// The verbatim JSON of one blueprint, or `None` if absent.
    pub fn get(&self, id: &str) -> Result<Option<String>, String> {
        let path = self.file(id)?;
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("get: {e}")),
        }
    }

    /// Persist a blueprint to `blueprints/<id>.json`, written verbatim (the frontend owns the shape).
    pub fn set(&self, id: &str, json: &str) -> Result<(), String> {
        let path = self.file(id)?;
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        std::fs::write(&path, json).map_err(|e| format!("set: {e}"))
    }

    /// Remove a blueprint's file (no-op if absent).
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.file(id)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
        }
        Ok(())
    }

    /// The store's `blueprints/` directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// Slugify a blueprint id into a single safe directory segment: keep `[A-Za-z0-9_-]`, replace every
/// other char with `_`, and reject the result if it is empty / `.` / `..` (so it can never escape the
/// parent dir). Byte-identical to `platform/fsx.rs::safe_dir_segment` as applied by the Tauri
/// `blueprint_file`, kept duplicated here because that helper lives in the (Tauri) app crate.
fn safe_id(id: &str) -> Result<String, String> {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("blueprint id is empty/invalid".into());
    }
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bsc-blueprint-test-{}", uniq()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::new(dir.clone()), dir)
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
        s.set("bp", r#"{"id":"bp","name":"v1"}"#).unwrap();
        s.set("bp", r#"{"id":"bp","name":"v2"}"#).unwrap();
        assert_eq!(s.get("bp").unwrap().as_deref(), Some(r#"{"id":"bp","name":"v2"}"#));
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
        assert_eq!(path.parent(), Some(dir.as_path()), "never escapes the blueprints dir");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "______etc_passwd.json");
    }

    #[test]
    fn slug_check_rejects_empty_id() {
        let (s, _dir) = tmp_store();
        assert!(s.file("").is_err(), "empty id is rejected");
        assert!(s.set("", "{}").is_err(), "set with empty id is rejected");
    }
}
