//! `jobs.db` — the one place bank entries and the profile are written.

use crate::{now_ms, valid_id, Entry, Kind, Profile, Source, SourceKind, Status};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::{Path, PathBuf};

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS bank_entries (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    title         TEXT NOT NULL,
    org           TEXT,
    start         TEXT,
    end_          TEXT,
    body          TEXT,
    tags          TEXT NOT NULL,
    parent        TEXT REFERENCES bank_entries(id),
    status        TEXT NOT NULL,
    source_kind   TEXT NOT NULL,
    source_ref    TEXT,
    created_ms    INTEGER NOT NULL,
    updated_ms    INTEGER NOT NULL
);
-- The profile is one row: there is one user.
CREATE TABLE IF NOT EXISTS profile (
    one       INTEGER PRIMARY KEY CHECK (one = 1),
    name      TEXT,
    headline  TEXT,
    email     TEXT,
    phone     TEXT,
    location  TEXT,
    links     TEXT NOT NULL
);
";

/// An entry's fields to write. `None` leaves a field as it is; `Some(None)` clears an optional one.
#[derive(Debug, Clone, Default)]
pub struct EntryPatch {
    pub kind: Option<Kind>,
    pub title: Option<String>,
    pub org: Option<Option<String>>,
    pub start: Option<Option<String>>,
    pub end: Option<Option<String>>,
    pub body: Option<Option<String>>,
    pub tags: Option<Vec<String>>,
    pub parent: Option<Option<String>>,
    pub source: Option<Source>,
    /// The user is confirming the entry as written — the CLI's `--confirm`. An agent never sets it.
    pub confirm: bool,
}

/// The profile's fields to write, merged the same way as [`EntryPatch`].
#[derive(Debug, Clone, Default)]
pub struct ProfilePatch {
    pub name: Option<Option<String>>,
    pub headline: Option<Option<String>>,
    pub email: Option<Option<String>>,
    pub phone: Option<Option<String>>,
    pub location: Option<Option<String>>,
    pub links: Option<Vec<String>>,
}

pub struct Jobs {
    conn: Connection,
}

const COLUMNS: &str =
    "id, kind, title, org, start, end_, body, tags, parent, status, source_kind, source_ref, created_ms, updated_ms";

fn text<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

fn from_text<T: serde::de::DeserializeOwned>(s: &str) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

fn row_entry(r: &Row) -> rusqlite::Result<Entry> {
    let tags: String = r.get(7)?;
    Ok(Entry {
        id: r.get(0)?,
        kind: from_text(&r.get::<_, String>(1)?)?,
        title: r.get(2)?,
        org: r.get(3)?,
        start: r.get(4)?,
        end: r.get(5)?,
        body: r.get(6)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        parent: r.get(8)?,
        status: from_text(&r.get::<_, String>(9)?)?,
        source: Source { kind: from_text(&r.get::<_, String>(10)?)?, reference: r.get(11)? },
        created_ms: r.get(12)?,
        updated_ms: r.get(13)?,
    })
}

impl Jobs {
    /// `$BSC_JOBS_DB`, else `~/.base-studio-code/jobs.db`.
    pub fn default_path() -> Option<PathBuf> {
        bsc_sqlite_util::default_store_path("BSC_JOBS_DB", &["jobs.db"])
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = bsc_sqlite_util::open_migrated(path, |c| c.execute_batch(SCHEMA))
            .map_err(|e| format!("open jobs {}: {e}", path.display()))?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = bsc_sqlite_util::open_in_memory_migrated(|c| c.execute_batch(SCHEMA))
            .map_err(|e| format!("open jobs: {e}"))?;
        Ok(Self { conn })
    }

    pub fn entry(&self, id: &str) -> Result<Option<Entry>, String> {
        self.conn
            .query_row(&format!("SELECT {COLUMNS} FROM bank_entries WHERE id = ?1"), [id], row_entry)
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Every entry, grouped by kind in resume order, then oldest first within a kind.
    pub fn entries(&self) -> Result<Vec<Entry>, String> {
        let mut st = self
            .conn
            .prepare(&format!("SELECT {COLUMNS} FROM bank_entries ORDER BY created_ms, id"))
            .map_err(|e| e.to_string())?;
        let mut all: Vec<Entry> =
            st.query_map([], row_entry).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        all.sort_by_key(|e| Kind::ALL.iter().position(|k| *k == e.kind));
        Ok(all)
    }

    /// The entries whose parent is `id`.
    pub fn children(&self, id: &str) -> Result<Vec<String>, String> {
        let mut st =
            self.conn.prepare("SELECT id FROM bank_entries WHERE parent = ?1 ORDER BY id").map_err(|e| e.to_string())?;
        let ids = st.query_map([id], |r| r.get(0)).map_err(|e| e.to_string())?;
        ids.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Create or update an entry. Merges: an unset field keeps its value.
    ///
    /// A new entry is a DRAFT unless the patch confirms it. Changing the CONTENT of a confirmed entry
    /// (anything a document would print — kind, title, org, period, body, tags, parent) returns it to
    /// draft unless the same write confirms it: the user confirmed the old words, not these.
    pub fn set_entry(&self, id: &str, patch: &EntryPatch) -> Result<Entry, String> {
        if !valid_id(id) {
            return Err(format!("`{id}` is not an entry id — use a slug: a-z, 0-9 and '-', 1-60 chars"));
        }
        let existing = self.entry(id)?;
        let now = now_ms();
        let pick = |new: &Option<Option<String>>, old: Option<String>| match new {
            Some(v) => v.clone().filter(|s| !s.trim().is_empty()),
            None => old,
        };
        let base = existing.clone();
        let kind = patch.kind.or(base.as_ref().map(|e| e.kind)).ok_or_else(|| {
            format!("`{id}` is a new entry — it needs --kind (experience, project, result, skill, story, education, certification)")
        })?;
        let title = match (&patch.title, &base) {
            (Some(t), _) if !t.trim().is_empty() => t.trim().to_string(),
            (Some(_), _) => return Err("an entry's title cannot be empty".into()),
            (None, Some(e)) => e.title.clone(),
            (None, None) => return Err(format!("`{id}` is a new entry — it needs --title")),
        };
        let parent = pick(&patch.parent, base.as_ref().and_then(|e| e.parent.clone()));
        if let Some(p) = &parent {
            if p == id {
                return Err(format!("`{id}` cannot be its own parent"));
            }
            let Some(pe) = self.entry(p)? else {
                return Err(format!("parent `{p}` is not in the bank — add it first"));
            };
            if !matches!(pe.kind, Kind::Experience | Kind::Project | Kind::Education) {
                return Err(format!(
                    "parent `{p}` is a {} — an entry can only belong to an experience, a project or an education",
                    pe.kind.as_str()
                ));
            }
        }
        let source = patch.source.clone().or(base.as_ref().map(|e| e.source.clone())).unwrap_or_else(Source::manual);
        if source.kind != SourceKind::Manual && source.reference.is_none() {
            return Err(format!("source `{source}` names nothing it was read out of"));
        }
        let mut next = Entry {
            id: id.to_string(),
            kind,
            title,
            org: pick(&patch.org, base.as_ref().and_then(|e| e.org.clone())),
            start: pick(&patch.start, base.as_ref().and_then(|e| e.start.clone())),
            end: pick(&patch.end, base.as_ref().and_then(|e| e.end.clone())),
            body: pick(&patch.body, base.as_ref().and_then(|e| e.body.clone())),
            tags: patch.tags.clone().or(base.as_ref().map(|e| e.tags.clone())).unwrap_or_default(),
            parent,
            status: Status::Draft,
            source,
            created_ms: base.as_ref().map(|e| e.created_ms).unwrap_or(now),
            updated_ms: now,
        };
        next.status = match (&base, patch.confirm) {
            (_, true) => Status::Confirmed,
            (None, false) => Status::Draft,
            (Some(old), false) if same_content(old, &next) => old.status,
            (Some(_), false) => Status::Draft,
        };
        self.conn
            .execute(
                &format!(
                    "INSERT INTO bank_entries ({COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
                     ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, org=excluded.org,
                       start=excluded.start, end_=excluded.end_, body=excluded.body, tags=excluded.tags,
                       parent=excluded.parent, status=excluded.status, source_kind=excluded.source_kind,
                       source_ref=excluded.source_ref, updated_ms=excluded.updated_ms"
                ),
                params![
                    next.id,
                    text(&next.kind),
                    next.title,
                    next.org,
                    next.start,
                    next.end,
                    next.body,
                    serde_json::to_string(&next.tags).unwrap_or_else(|_| "[]".into()),
                    next.parent,
                    text(&next.status),
                    text(&next.source.kind),
                    next.source.reference,
                    next.created_ms,
                    next.updated_ms
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(next)
    }

    /// The user has read these entries as they stand and confirms them. An unknown id refuses the whole
    /// batch, so a typo cannot leave half a list confirmed.
    pub fn confirm(&self, ids: &[String]) -> Result<Vec<Entry>, String> {
        let missing: Vec<&str> =
            ids.iter().map(String::as_str).filter(|id| !matches!(self.entry(id), Ok(Some(_)))).collect();
        if !missing.is_empty() {
            return Err(format!("not in the bank: {} — nothing was confirmed", missing.join(", ")));
        }
        let now = now_ms();
        for id in ids {
            self.conn
                .execute(
                    "UPDATE bank_entries SET status = 'confirmed', updated_ms = ?2 WHERE id = ?1 AND status != 'confirmed'",
                    params![id, now],
                )
                .map_err(|e| e.to_string())?;
        }
        ids.iter().map(|id| self.entry(id).map(|e| e.expect("checked above"))).collect()
    }

    /// Delete an entry. One that other entries belong to is refused, naming them — deleting a role must
    /// not quietly orphan the results that happened in it.
    pub fn remove(&self, id: &str) -> Result<Entry, String> {
        let entry = self.entry(id)?.ok_or_else(|| format!("no entry `{id}`"))?;
        let children = self.children(id)?;
        if !children.is_empty() {
            return Err(format!(
                "`{id}` has entries that belong to it: {} — remove or re-parent them first",
                children.join(", ")
            ));
        }
        self.conn.execute("DELETE FROM bank_entries WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
        Ok(entry)
    }

    pub fn profile(&self) -> Result<Profile, String> {
        self.conn
            .query_row("SELECT name, headline, email, phone, location, links FROM profile WHERE one = 1", [], |r| {
                let links: String = r.get(5)?;
                Ok(Profile {
                    name: r.get(0)?,
                    headline: r.get(1)?,
                    email: r.get(2)?,
                    phone: r.get(3)?,
                    location: r.get(4)?,
                    links: serde_json::from_str(&links).unwrap_or_default(),
                })
            })
            .optional()
            .map(Option::unwrap_or_default)
            .map_err(|e| e.to_string())
    }

    pub fn set_profile(&self, patch: &ProfilePatch) -> Result<Profile, String> {
        let old = self.profile()?;
        let pick = |new: &Option<Option<String>>, old: Option<String>| match new {
            Some(v) => v.clone().filter(|s| !s.trim().is_empty()),
            None => old,
        };
        let next = Profile {
            name: pick(&patch.name, old.name),
            headline: pick(&patch.headline, old.headline),
            email: pick(&patch.email, old.email),
            phone: pick(&patch.phone, old.phone),
            location: pick(&patch.location, old.location),
            links: patch.links.clone().unwrap_or(old.links),
        };
        self.conn
            .execute(
                "INSERT INTO profile (one, name, headline, email, phone, location, links) VALUES (1,?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(one) DO UPDATE SET name=excluded.name, headline=excluded.headline, email=excluded.email,
                   phone=excluded.phone, location=excluded.location, links=excluded.links",
                params![
                    next.name,
                    next.headline,
                    next.email,
                    next.phone,
                    next.location,
                    serde_json::to_string(&next.links).unwrap_or_else(|_| "[]".into())
                ],
            )
            .map_err(|e| e.to_string())?;
        Ok(next)
    }
}

/// Whether two versions of an entry would print the same. The source is provenance, not content, and
/// the timestamps and status are bookkeeping.
fn same_content(a: &Entry, b: &Entry) -> bool {
    a.kind == b.kind
        && a.title == b.title
        && a.org == b.org
        && a.start == b.start
        && a.end == b.end
        && a.body == b.body
        && a.tags == b.tags
        && a.parent == b.parent
}
