//! Local on-disk cache (#1196) — SQLite under `~/.base-studio-code/research/cache.db` (override with
//! `$BSC_RESEARCH_CACHE`). Caches fetched paper records, extracted full text, and search results
//! keyed by canonical id / query, so repeated grounding is fast + offline-friendly and stays within
//! upstream rate limits. The cache is a pure optimization: every lookup returns `Option`, and the
//! caller falls back to the network on a miss, so a missing/corrupt cache never breaks a tool call.

use crate::types::Paper;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Cache {
    conn: Connection,
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

impl Cache {
    /// The default cache path: `$BSC_RESEARCH_CACHE`, else `~/.base-studio-code/research/cache.db`.
    pub fn default_path() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("BSC_RESEARCH_CACHE") {
            let p = p.trim();
            if !p.is_empty() {
                return Some(PathBuf::from(p));
            }
        }
        let home = std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok())?;
        Some(PathBuf::from(home).join(".base-studio-code").join("research").join("cache.db"))
    }

    /// Open (creating parent dirs + schema) the cache at `path`. Use `":memory:"` for tests.
    pub fn open(path: &Path) -> Result<Cache, String> {
        if path.as_os_str() != ":memory:" {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("cache dir: {e}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|e| format!("open cache: {e}"))?;
        Cache::init(conn)
    }

    /// An in-memory cache (tests).
    pub fn in_memory() -> Result<Cache, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open cache: {e}"))?;
        Cache::init(conn)
    }

    fn init(conn: Connection) -> Result<Cache, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS papers   (id TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS fulltext (id TEXT PRIMARY KEY, text TEXT NOT NULL, fetched_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS kv       (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);",
        )
        .map_err(|e| format!("cache schema: {e}"))?;
        Ok(Cache { conn })
    }

    /// Store a paper record by its canonical id.
    pub fn put_paper(&self, paper: &Paper) -> Result<(), String> {
        let json = serde_json::to_string(paper).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO papers (id, json, fetched_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
                rusqlite::params![paper.id, json, now_secs()],
            )
            .map_err(|e| format!("cache put_paper: {e}"))?;
        Ok(())
    }

    /// Look up a cached paper by canonical id.
    pub fn get_paper(&self, id: &str) -> Option<Paper> {
        let json: String = self
            .conn
            .query_row("SELECT json FROM papers WHERE id = ?1", [id], |r| r.get(0))
            .ok()?;
        serde_json::from_str(&json).ok()
    }

    /// Store extracted full text by canonical id.
    pub fn put_fulltext(&self, id: &str, text: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO fulltext (id, text, fetched_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at",
                rusqlite::params![id, text, now_secs()],
            )
            .map_err(|e| format!("cache put_fulltext: {e}"))?;
        Ok(())
    }

    /// Look up cached full text by canonical id.
    pub fn get_fulltext(&self, id: &str) -> Option<String> {
        self.conn
            .query_row("SELECT text FROM fulltext WHERE id = ?1", [id], |r| r.get(0))
            .ok()
    }

    /// Store an arbitrary JSON-serializable value under `key` (e.g. a search result set).
    pub fn put_json<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<(), String> {
        let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO kv (key, json, fetched_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
                rusqlite::params![key, json, now_secs()],
            )
            .map_err(|e| format!("cache put_json: {e}"))?;
        Ok(())
    }

    /// Look up a JSON value stored under `key`, deserializing to `T`.
    pub fn get_json<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        let json: String = self
            .conn
            .query_row("SELECT json FROM kv WHERE key = ?1", [key], |r| r.get(0))
            .ok()?;
        serde_json::from_str(&json).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Source;

    #[test]
    fn paper_roundtrips_through_cache() {
        let cache = Cache::in_memory().unwrap();
        assert!(cache.get_paper("arxiv:1").is_none());
        let mut p = Paper::new("arxiv:1", Source::Arxiv, "Ray tracing");
        p.year = Some(2024);
        cache.put_paper(&p).unwrap();
        let got = cache.get_paper("arxiv:1").unwrap();
        assert_eq!(got, p);
        // Upsert overwrites.
        let mut p2 = p.clone();
        p2.title = "Path tracing".into();
        cache.put_paper(&p2).unwrap();
        assert_eq!(cache.get_paper("arxiv:1").unwrap().title, "Path tracing");
    }

    #[test]
    fn fulltext_and_kv_roundtrip() {
        let cache = Cache::in_memory().unwrap();
        cache.put_fulltext("arxiv:1", "full body text").unwrap();
        assert_eq!(cache.get_fulltext("arxiv:1").as_deref(), Some("full body text"));

        cache.put_json("search:rt", &vec!["a".to_string(), "b".to_string()]).unwrap();
        let got: Vec<String> = cache.get_json("search:rt").unwrap();
        assert_eq!(got, vec!["a", "b"]);
    }
}
