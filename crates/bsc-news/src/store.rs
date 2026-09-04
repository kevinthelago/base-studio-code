//! The article store — SQLite at `~/.base-studio-code/news/news.db` (override with `$BSC_NEWS_DB`).
//!
//! **Versions are append-only, and that is the whole design.** A poll that finds an already-seen URL
//! with changed text writes a NEW row rather than updating the old one, so a stealth edit is
//! observable after the fact. Nothing upstream can give this back later: GDELT and the commercial
//! aggregators snapshot a URL once, so an edit made an hour after publication is invisible to them
//! forever. The same append-only history supplies the **first-seen** time, which is what orders a
//! wire cascade — an upstream's claimed `pubDate` is routinely wrong or backdated, so it is stored
//! verbatim and never used for ordering.

use crate::types::ArticleVersion;
use bsc_util::now_secs;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub struct Store {
    conn: Connection,
}

/// What a write did to one URL — the poll report's unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Wrote {
    /// The URL had never been seen; version 1 was written.
    New,
    /// The URL was known and its text had changed; a new version was appended.
    Revised,
    /// The URL was known and its text was byte-identical; nothing was written.
    Unchanged,
}

impl Store {
    /// `$BSC_NEWS_DB`, else `~/.base-studio-code/news/news.db`.
    pub fn default_path() -> Option<PathBuf> {
        bsc_sqlite_util::default_store_path("BSC_NEWS_DB", &["news", "news.db"])
    }

    /// Open (creating parent dirs + schema) the store at `path`. `":memory:"` works for tests.
    pub fn open(path: &Path) -> Result<Store, String> {
        Store::init(bsc_sqlite_util::open_db_str(path, "news store")?)
    }

    /// An in-memory store (tests).
    pub fn in_memory() -> Result<Store, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open news store: {e}"))?;
        Store::init(conn)
    }

    fn init(conn: Connection) -> Result<Store, String> {
        conn.execute_batch(
            // No UPDATE path exists against this table anywhere in the crate: (url, seq) is the key
            // and every write is an INSERT, which is what makes the history trustworthy.
            "CREATE TABLE IF NOT EXISTS versions (
                 url             TEXT    NOT NULL,
                 seq             INTEGER NOT NULL,
                 outlet_id       TEXT    NOT NULL,
                 fetched_at      INTEGER NOT NULL,
                 published_claim TEXT,
                 title           TEXT    NOT NULL,
                 summary         TEXT    NOT NULL,
                 PRIMARY KEY (url, seq)
             );
             CREATE INDEX IF NOT EXISTS versions_outlet ON versions (outlet_id);
             CREATE INDEX IF NOT EXISTS versions_fetched ON versions (fetched_at);",
        )
        .map_err(|e| format!("news schema: {e}"))?;
        Ok(Store { conn })
    }

    /// The latest version of one URL, or `None` if never seen.
    pub fn latest(&self, url: &str) -> Option<ArticleVersion> {
        self.conn
            .query_row(
                "SELECT url, seq, outlet_id, fetched_at, published_claim, title, summary
                   FROM versions WHERE url = ?1 ORDER BY seq DESC LIMIT 1",
                [url],
                row_to_version,
            )
            .ok()
    }

    /// Every version of one URL, oldest first — the revision history for a single article.
    pub fn history(&self, url: &str) -> Result<Vec<ArticleVersion>, String> {
        self.query(
            "SELECT url, seq, outlet_id, fetched_at, published_claim, title, summary
               FROM versions WHERE url = ?1 ORDER BY seq ASC",
            rusqlite::params![url],
        )
    }

    /// The FIRST version of every URL, newest-first-seen first. This is the set every signal reads:
    /// a cascade is ordered by when each outlet first published, so a later revision must not be
    /// able to reorder it.
    pub fn first_versions(&self, since: i64) -> Result<Vec<ArticleVersion>, String> {
        self.query(
            "SELECT url, seq, outlet_id, fetched_at, published_claim, title, summary
               FROM versions WHERE seq = 1 AND fetched_at >= ?1 ORDER BY fetched_at DESC",
            rusqlite::params![since],
        )
    }

    /// Every URL that has more than one version — the articles that were edited after publication.
    pub fn revised(&self, since: i64) -> Result<Vec<ArticleVersion>, String> {
        self.query(
            "SELECT v.url, v.seq, v.outlet_id, v.fetched_at, v.published_claim, v.title, v.summary
               FROM versions v
               JOIN (SELECT url, MAX(seq) AS m FROM versions GROUP BY url HAVING COUNT(*) > 1) t
                 ON t.url = v.url AND t.m = v.seq
              WHERE v.fetched_at >= ?1
              ORDER BY v.fetched_at DESC",
            rusqlite::params![since],
        )
    }

    fn query(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Result<Vec<ArticleVersion>, String> {
        let mut stmt = self.conn.prepare(sql).map_err(|e| format!("news query: {e}"))?;
        let rows = stmt.query_map(params, row_to_version).map_err(|e| format!("news query: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("news query: {e}"))
    }

    /// Record one fetched item, appending a version only when the text actually changed.
    ///
    /// `fetched_at` is taken as an argument rather than read from the clock so tests can lay out a
    /// cascade in time; production callers pass [`bsc_util::now_secs`].
    pub fn record(
        &self,
        outlet_id: &str,
        item: &crate::types::FeedItem,
        fetched_at: i64,
    ) -> Result<Wrote, String> {
        let (seq, verdict) = match self.latest(&item.url) {
            None => (1, Wrote::New),
            Some(prev) if prev.title == item.title && prev.summary == item.summary => {
                return Ok(Wrote::Unchanged)
            }
            Some(prev) => (prev.seq + 1, Wrote::Revised),
        };
        self.conn
            .execute(
                "INSERT INTO versions (url, seq, outlet_id, fetched_at, published_claim, title, summary)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    item.url,
                    seq,
                    outlet_id,
                    fetched_at,
                    item.published_claim,
                    item.title,
                    item.summary
                ],
            )
            .map_err(|e| format!("news record: {e}"))?;
        Ok(verdict)
    }

    /// Convenience for callers with the wall clock.
    pub fn record_now(&self, outlet_id: &str, item: &crate::types::FeedItem) -> Result<Wrote, String> {
        self.record(outlet_id, item, now_secs())
    }

    /// The newest `published_claim` this outlet has ever supplied, and its version count — what
    /// `bsc news outlets` reports so a zero can be told from a dead feed.
    pub fn outlet_freshness(&self, outlet_id: &str) -> (i64, Option<i64>) {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM versions WHERE outlet_id = ?1", [outlet_id], |r| r.get(0))
            .unwrap_or(0);
        let newest: Option<i64> = self
            .conn
            .query_row("SELECT MAX(fetched_at) FROM versions WHERE outlet_id = ?1", [outlet_id], |r| r.get(0))
            .ok()
            .flatten();
        (count, newest)
    }
}

fn row_to_version(r: &rusqlite::Row) -> rusqlite::Result<ArticleVersion> {
    Ok(ArticleVersion {
        url: r.get(0)?,
        seq: r.get(1)?,
        outlet_id: r.get(2)?,
        fetched_at: r.get(3)?,
        published_claim: r.get(4)?,
        title: r.get(5)?,
        summary: r.get(6)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::FeedItem;

    fn item(url: &str, title: &str, summary: &str) -> FeedItem {
        FeedItem {
            url: url.into(),
            title: title.into(),
            summary: summary.into(),
            published_claim: Some("Fri, 04 Sep 2026 14:00:00 GMT".into()),
        }
    }

    #[test]
    fn a_first_sighting_writes_version_one() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.record("bbc", &item("u1", "Headline", "Body"), 100).unwrap(), Wrote::New);
        let v = s.latest("u1").unwrap();
        assert_eq!(v.seq, 1);
        assert_eq!(v.fetched_at, 100);
    }

    #[test]
    fn identical_text_writes_nothing() {
        let s = Store::in_memory().unwrap();
        s.record("bbc", &item("u1", "Headline", "Body"), 100).unwrap();
        assert_eq!(s.record("bbc", &item("u1", "Headline", "Body"), 200).unwrap(), Wrote::Unchanged);
        assert_eq!(s.history("u1").unwrap().len(), 1, "re-polling an unchanged feed must not grow the store");
    }

    #[test]
    fn a_changed_headline_appends_a_version_and_keeps_the_old_one() {
        // This is the stealth-edit case, and the reason nothing in this crate UPDATEs a version row.
        let s = Store::in_memory().unwrap();
        s.record("bbc", &item("u1", "Two killed in strike", "Body"), 100).unwrap();
        assert_eq!(s.record("bbc", &item("u1", "Two die in blast", "Body"), 200).unwrap(), Wrote::Revised);
        let h = s.history("u1").unwrap();
        assert_eq!(h.len(), 2);
        assert_eq!(h[0].title, "Two killed in strike", "the ORIGINAL wording must survive the edit");
        assert_eq!(h[1].title, "Two die in blast");
        assert_eq!(h[0].seq, 1);
        assert_eq!(h[1].seq, 2);
    }

    #[test]
    fn first_versions_returns_only_seq_one_so_a_revision_cannot_reorder_a_cascade() {
        let s = Store::in_memory().unwrap();
        s.record("ap", &item("wire", "Wire copy", ""), 100).unwrap();
        s.record("bbc", &item("echo", "Echo copy", ""), 150).unwrap();
        // The wire edits its story LATER than the echo first published.
        s.record("ap", &item("wire", "Wire copy revised", ""), 900).unwrap();
        let firsts = s.first_versions(0).unwrap();
        assert_eq!(firsts.len(), 2, "one row per URL, not one per version");
        let wire = firsts.iter().find(|v| v.url == "wire").unwrap();
        assert_eq!(wire.fetched_at, 100, "a later edit must not move the wire's first-seen time");
        assert_eq!(wire.title, "Wire copy");
    }

    #[test]
    fn revised_lists_only_urls_that_actually_changed() {
        let s = Store::in_memory().unwrap();
        s.record("bbc", &item("stable", "Same", ""), 100).unwrap();
        s.record("bbc", &item("stable", "Same", ""), 200).unwrap();
        s.record("bbc", &item("edited", "Before", ""), 100).unwrap();
        s.record("bbc", &item("edited", "After", ""), 200).unwrap();
        let r = s.revised(0).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].url, "edited");
        assert_eq!(r[0].title, "After", "revised reports the CURRENT text; history has the rest");
    }

    #[test]
    fn since_filters_by_our_fetch_time_not_the_claimed_one() {
        let s = Store::in_memory().unwrap();
        s.record("bbc", &item("old", "Old", ""), 100).unwrap();
        s.record("bbc", &item("new", "New", ""), 500).unwrap();
        assert_eq!(s.first_versions(200).unwrap().len(), 1);
        assert_eq!(s.first_versions(0).unwrap().len(), 2);
    }

    #[test]
    fn freshness_reports_count_and_newest_fetch_per_outlet() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.outlet_freshness("xinhua"), (0, None), "an unpolled outlet reads as empty, not as an error");
        s.record("bbc", &item("u1", "A", ""), 100).unwrap();
        s.record("bbc", &item("u2", "B", ""), 400).unwrap();
        assert_eq!(s.outlet_freshness("bbc"), (2, Some(400)));
    }
}
