//! The speaker's accumulated habit, kept per `(speaker, channel)` so it outlives the invocation
//! that measured it.
//!
//! **A BASELINE THAT DIES WITH THE PROCESS IS NOT A BASELINE.** `bsc ear prosody` used to build a
//! [`Baseline`] from whatever files that one invocation happened to be given, score them against it,
//! and throw it away — so a segment was scored against its siblings rather than against the
//! speaker's habit, and running the same command on a different set of files silently changed every
//! z-score. [`MIN_BASELINE`](crate::prosody::MIN_BASELINE) observations are needed before a score
//! means anything at all, which one invocation over a handful of clips frequently cannot reach.
//!
//! **WHY A CHANNEL IS PART OF THE KEY.** Every absolute number prosody reports describes the whole
//! recording path — microphone, preamp gain, distance, room — as much as it describes the larynx.
//! A desk mic and a phone produce different f0 ranges, different loudness and (especially) different
//! harmonics-to-noise for the *same voice on the same day*. Pooling them into one baseline would
//! make the z-scores track WHICH DEVICE was used rather than how the speaker actually sounded, and
//! the resulting "change" would be an artefact. So the key is `(speaker, channel)` and two channels
//! never meet.
//!
//! **"CHANNEL" HERE IS THE RECORDING PATH, NOT [`DeviceInfo::channels`](crate::capture::DeviceInfo).**
//! That field is the mono/stereo count. This one is a label for the path a recording came in
//! through, defaulting to the capture device name. The collision is unfortunate and worth stating
//! once rather than rediscovering in a bug.
//!
//! **WHY ROWS AND NOT A SERIALISED BASELINE.** A [`Baseline`] would serialise to a single JSON blob,
//! and a JSON blob inside SQLite is still a JSON file — it just costs a database to read. One row
//! per observation keeps the numbers as numbers: they can be queried, counted, filtered by time,
//! and compressed as the numeric columns they are. It also means the baseline is *derived* rather
//! than stored, so improving how habit is accumulated does not strand every existing row.

use crate::prosody::{Baseline, Prosody};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

/// The speaker label used when none is given.
///
/// There is exactly one known person here, by design — the crate knows the maintainer and
/// anonymises everyone else (see `imprint`) — so a single default label is honest rather than a
/// placeholder waiting for a user table.
pub const DEFAULT_SPEAKER: &str = "me";

/// The channel label used when the capture device is unknown.
pub const UNKNOWN_CHANNEL: &str = "unknown";

pub(crate) mod schema {
    use rusqlite::Connection;

    /// Every table — the single source of truth for the set.
    pub(crate) const ALL_TABLES: &[&str] = &["observations"];

    pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS observations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                speaker         TEXT NOT NULL,          -- who; see DEFAULT_SPEAKER
                channel         TEXT NOT NULL,          -- the RECORDING PATH, not the mono/stereo count
                at              INTEGER NOT NULL DEFAULT 0,   -- epoch millis, for time-windowed reads
                f0_median       REAL NOT NULL,
                f0_range        REAL NOT NULL,
                rms_mean        REAL NOT NULL,
                rms_sd          REAL NOT NULL,
                zcr_mean        REAL NOT NULL,
                voiced_fraction REAL NOT NULL,
                onset_rate      REAL NOT NULL,
                duration_s      REAL NOT NULL,
                hnr_db          REAL NOT NULL,          -- voice QUALITY, kept apart from arousal
                jitter_local    REAL NOT NULL,
                shimmer_local   REAL NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_obs_key ON observations(speaker, channel, id);",
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn migrate_is_idempotent() {
            let conn = Connection::open_in_memory().unwrap();
            migrate(&conn).unwrap();
            migrate(&conn).unwrap(); // re-running on an existing db is a no-op
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='observations'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1);
        }
    }
}

/// The ear's own store.
pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_migrated(path, schema::migrate)? })
    }

    /// The test path — no disk, same schema.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        Ok(Store { conn: bsc_sqlite_util::open_in_memory_migrated(schema::migrate)? })
    }

    /// `$BSC_EAR_DB`, else `~/.base-studio-code/ear.db`.
    ///
    /// BESIDE the base dir, not inside `ear/`, because that is where every other store lives and
    /// where `bsc studio`'s capture guard looks for `<segment>.db`. A store tucked inside the
    /// crate's own directory would be invisible to the backup roster.
    pub fn default_path() -> Option<PathBuf> {
        bsc_sqlite_util::default_store_path("BSC_EAR_DB", &["ear.db"])
    }

    /// Record one measured segment against a `(speaker, channel)` habit.
    ///
    /// GATED AT THE DOOR on [`Prosody::has_speech`]: a segment with no voiced content carries no
    /// information about how a voice sounds, and its zeroed medians would drag every habit toward
    /// zero. Returns whether the observation was kept, so a caller can report honestly rather than
    /// imply it stored something it discarded.
    pub fn observe(
        &self,
        speaker: &str,
        channel: &str,
        p: &Prosody,
        at: i64,
    ) -> rusqlite::Result<bool> {
        if !p.has_speech() {
            return Ok(false);
        }
        self.conn.execute(
            "INSERT INTO observations
               (speaker, channel, at, f0_median, f0_range, rms_mean, rms_sd, zcr_mean,
                voiced_fraction, onset_rate, duration_s, hnr_db, jitter_local, shimmer_local)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                speaker,
                channel,
                at,
                p.f0_median,
                p.f0_range,
                p.rms_mean,
                p.rms_sd,
                p.zcr_mean,
                p.voiced_fraction,
                p.onset_rate,
                p.duration_s,
                p.hnr_db,
                p.jitter_local,
                p.shimmer_local
            ],
        )?;
        Ok(true)
    }

    /// Rebuild one `(speaker, channel)` habit from its rows.
    ///
    /// DERIVED, never stored — replayed through the same public [`Baseline::observe`] a live
    /// accumulation uses, so there is exactly one definition of what accumulating habit means and a
    /// reloaded baseline cannot drift from a fresh one.
    pub fn baseline(&self, speaker: &str, channel: &str) -> rusqlite::Result<Baseline> {
        let mut stmt = self.conn.prepare(
            "SELECT f0_median, f0_range, rms_mean, rms_sd, zcr_mean, voiced_fraction,
                    onset_rate, duration_s, hnr_db, jitter_local, shimmer_local
               FROM observations WHERE speaker = ?1 AND channel = ?2 ORDER BY id",
        )?;
        let rows = stmt.query_map(params![speaker, channel], |r| {
            Ok(Prosody {
                f0_median: r.get(0)?,
                f0_range: r.get(1)?,
                rms_mean: r.get(2)?,
                rms_sd: r.get(3)?,
                zcr_mean: r.get(4)?,
                voiced_fraction: r.get(5)?,
                onset_rate: r.get(6)?,
                duration_s: r.get(7)?,
                hnr_db: r.get(8)?,
                jitter_local: r.get(9)?,
                shimmer_local: r.get(10)?,
            })
        })?;
        let mut base = Baseline::default();
        for p in rows {
            base.observe(&p?);
        }
        Ok(base)
    }

    /// Every `(channel, count)` a speaker has been heard on, most-observed first.
    ///
    /// The discovery verb: a baseline is per channel, so a reader has to be able to find out which
    /// channels exist without already knowing their names.
    pub fn channels(&self, speaker: &str) -> rusqlite::Result<Vec<(String, u32)>> {
        let mut stmt = self.conn.prepare(
            "SELECT channel, COUNT(*) AS n FROM observations
              WHERE speaker = ?1 GROUP BY channel ORDER BY n DESC, channel",
        )?;
        let rows = stmt.query_map(params![speaker], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect()
    }

    /// Empty every table, leaving the schema in place.
    pub fn clear(&self) -> rusqlite::Result<()> {
        bsc_sqlite_util::clear_tables(&self.conn, schema::ALL_TABLES)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A measurable segment — `has_speech` needs a voiced fraction and a real f0.
    fn speech(f0: f32, hnr: f32) -> Prosody {
        Prosody {
            f0_median: f0,
            f0_range: 40.0,
            rms_mean: 0.05,
            rms_sd: 0.01,
            zcr_mean: 0.08,
            voiced_fraction: 0.7,
            onset_rate: 3.0,
            duration_s: 5.0,
            hnr_db: hnr,
            jitter_local: 0.01,
            shimmer_local: 0.04,
        }
    }

    #[test]
    fn an_observation_survives_reopening_the_store() {
        let dir = std::env::temp_dir().join(format!("bsc-ear-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ear.db");
        let _ = std::fs::remove_file(&path);

        {
            let s = Store::open(&path).unwrap();
            assert!(s.observe("me", "desk", &speech(120.0, 18.0), 1).unwrap());
        }
        // A SEPARATE OPEN — the whole point. The first process is gone.
        let s = Store::open(&path).unwrap();
        assert_eq!(s.baseline("me", "desk").unwrap().n, 1);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_channels_never_contaminate_one_baseline() {
        let s = Store::open_in_memory().unwrap();
        for _ in 0..5 {
            s.observe("me", "desk", &speech(120.0, 18.0), 1).unwrap();
        }
        for _ in 0..3 {
            // The SAME speaker through a phone: a different path, so different absolute numbers.
            s.observe("me", "phone", &speech(190.0, 8.0), 2).unwrap();
        }
        assert_eq!(s.baseline("me", "desk").unwrap().n, 5, "desk must hold only desk observations");
        assert_eq!(s.baseline("me", "phone").unwrap().n, 3, "phone must hold only phone observations");
        // And an unseen channel is EMPTY rather than silently falling back to another one.
        assert_eq!(s.baseline("me", "headset").unwrap().n, 0);
    }

    #[test]
    fn a_segment_with_no_speech_never_enters_the_baseline() {
        let s = Store::open_in_memory().unwrap();
        let silent = Prosody { voiced_fraction: 0.0, f0_median: 0.0, ..speech(0.0, 0.0) };
        assert!(!s.observe("me", "desk", &silent, 1).unwrap(), "it must report that it stored nothing");
        assert_eq!(s.baseline("me", "desk").unwrap().n, 0);
    }

    #[test]
    fn channels_are_discoverable_without_knowing_their_names() {
        let s = Store::open_in_memory().unwrap();
        s.observe("me", "desk", &speech(120.0, 18.0), 1).unwrap();
        s.observe("me", "desk", &speech(122.0, 17.0), 2).unwrap();
        s.observe("me", "phone", &speech(190.0, 8.0), 3).unwrap();
        assert_eq!(s.channels("me").unwrap(), vec![("desk".to_string(), 2), ("phone".to_string(), 1)]);
    }

    #[test]
    fn a_reloaded_baseline_matches_one_accumulated_in_memory() {
        let s = Store::open_in_memory().unwrap();
        let mut live = Baseline::default();
        for i in 0..7 {
            let p = speech(120.0 + i as f32, 18.0 - i as f32 * 0.5);
            s.observe("me", "desk", &p, i as i64).unwrap();
            live.observe(&p);
        }
        // Replay through the same public accumulator, so the two cannot drift.
        assert_eq!(s.baseline("me", "desk").unwrap(), live);
    }
}
