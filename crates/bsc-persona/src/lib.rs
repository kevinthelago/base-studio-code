//! `bsc-persona` core — file CRUD over the USER persona store at
//! `~/.base-studio-code/personas/<id>.json` (#2094, an instance of #1325).
//!
//! A **persona** is the CRUD-able behavioral identity of an agent — a start prompt + attached skills +
//! default model, running under a referenced ROLE (its permission floor). This is the one store the
//! desktop Personas library and every live console session + the planner share: the desktop UI reaches
//! it through the generic `bsc` command (`bsc persona …`, over the #2114 bridge), and a session's own
//! shell reaches the same store through the [`cli`] module — so the planner can mint a persona the same
//! way it mints a skill.
//!
//! Each persona is written **verbatim** (the frontend owns the JSON shape; the store never imposes a
//! typed schema). The `id` is slugified into a single safe directory segment so it can never escape the
//! `personas/` dir. Packaged (built-in) personas are seeded into this store on first hydrate + kept
//! reconciled by the frontend, exactly like the user blueprint library (`bsc-blueprint`).
//!
//! The agent-facing CLI lives in [`cli`] (`bsc persona …`), dispatched by the unified `bsc` binary
//! (#1877).

pub mod cli;

use std::path::{Path, PathBuf};

/// A handle to the user persona store rooted at a `personas/` directory.
pub struct Store {
    dir: PathBuf,
}

impl Store {
    /// Open a store rooted at an explicit `personas/` directory (used by tests + callers that resolve
    /// the base dir themselves).
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Store { dir: dir.into() }
    }

    /// Open the default user store at `~/.base-studio-code/personas/`. `Err` when no home dir is
    /// resolvable (matching the `bsc-*` CLI convention).
    pub fn open_default() -> Result<Self, String> {
        let base = bsc_util::bsc_base_dir()
            .ok_or("could not resolve a home directory; set HOME/USERPROFILE")?;
        Ok(Store::new(base.join("personas")))
    }

    /// The on-disk path for persona `id`. The id is slugified (every char outside `[A-Za-z0-9_-]`
    /// becomes `_`) and rejected when empty / `.` / `..`, so it can never escape the `personas/` dir.
    pub fn file(&self, id: &str) -> Result<PathBuf, String> {
        let safe = safe_id(id)?;
        Ok(self.dir.join(format!("{safe}.json")))
    }

    /// The verbatim JSON of every persona on disk (the library hydrates from this). Skips unreadable /
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

    /// The verbatim JSON of one persona, or `None` if absent.
    pub fn get(&self, id: &str) -> Result<Option<String>, String> {
        let path = self.file(id)?;
        match std::fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("get: {e}")),
        }
    }

    /// Persist a persona to `personas/<id>.json`, written verbatim (the frontend owns the shape).
    pub fn set(&self, id: &str, json: &str) -> Result<(), String> {
        let path = self.file(id)?;
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        std::fs::write(&path, json).map_err(|e| format!("set: {e}"))
    }

    /// Remove a persona's file (no-op if absent).
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let path = self.file(id)?;
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("remove: {e}"))?;
        }
        Ok(())
    }

    /// The store's `personas/` directory.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// Slugify a persona id into a single safe directory segment: keep `[A-Za-z0-9_-]`, replace every
/// other char with `_`, and reject the result if it is empty / `.` / `..` (so it can never escape the
/// parent dir). Byte-identical to `bsc-blueprint`'s `safe_id`.
fn safe_id(id: &str) -> Result<String, String> {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err("persona id is empty/invalid".into());
    }
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bsc-persona-test-{}", uniq()));
        let _ = std::fs::remove_dir_all(&dir);
        (Store::new(dir.clone()), dir)
    }

    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    #[test]
    fn set_get_list_remove_round_trips() {
        let (s, _dir) = tmp_store();
        assert!(s.list().is_empty(), "a missing dir ⇒ empty list");
        assert_eq!(s.get("worker").unwrap(), None, "absent ⇒ None");

        let json = r#"{"id":"persona-worker","name":"Worker","role":"worker","skills":[]}"#;
        s.set("persona-worker", json).unwrap();
        assert_eq!(s.get("persona-worker").unwrap().as_deref(), Some(json), "stored verbatim");
        assert_eq!(s.list(), vec![json.to_string()]);

        s.remove("persona-worker").unwrap();
        assert_eq!(s.get("persona-worker").unwrap(), None);
        assert!(s.list().is_empty());
        s.remove("persona-worker").unwrap(); // no-op when absent
    }

    #[test]
    fn upsert_overwrites_by_id() {
        let (s, _dir) = tmp_store();
        s.set("p", r#"{"id":"p","name":"v1"}"#).unwrap();
        s.set("p", r#"{"id":"p","name":"v2"}"#).unwrap();
        assert_eq!(s.get("p").unwrap().as_deref(), Some(r#"{"id":"p","name":"v2"}"#));
        assert_eq!(s.list().len(), 1, "same id ⇒ one file");
    }

    #[test]
    fn slug_check_neutralizes_path_traversal() {
        let (s, dir) = tmp_store();
        let path = s.file("../../etc/passwd").unwrap();
        assert_eq!(path.parent(), Some(dir.as_path()), "never escapes the personas dir");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "______etc_passwd.json");
    }

    #[test]
    fn slug_check_rejects_empty_id() {
        let (s, _dir) = tmp_store();
        assert!(s.file("").is_err(), "empty id is rejected");
        assert!(s.set("", "{}").is_err(), "set with empty id is rejected");
    }
}
