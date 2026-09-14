-- A STORE THAT KEEPS HISTORY (`the-committed-record-store-does-not-grow-a-full-copy-per-edit`): superseded
-- revisions live in `record_history` as gzipped deltas, and `record_revs` holds each record's HEAD only.
-- The raw reader must read the heads exactly as it reads a store holding every revision in full, and
-- never take a history row for a record — history has no `json` column to take.
-- Regenerate: rm -f history.db && sqlite3 history.db < history.sql
PRAGMA journal_mode = DELETE;
CREATE TABLE record_revs (
    id       TEXT    NOT NULL,
    lane     TEXT    NOT NULL DEFAULT 'main',
    rev      INTEGER NOT NULL CHECK (rev > 0),
    base_rev INTEGER,
    json     TEXT,
    tier     TEXT    NOT NULL DEFAULT 'impl',
    at       INTEGER NOT NULL,
    by       TEXT    NOT NULL DEFAULT '',
    note     TEXT,
    PRIMARY KEY (id, lane, rev)
);
-- Created FIRST in the schema's lookup order would be the trap; it is created second and holds more rows.
CREATE TABLE record_history (
    id          TEXT    NOT NULL,
    lane        TEXT    NOT NULL DEFAULT 'main',
    rev         INTEGER NOT NULL CHECK (rev > 0),
    base_rev    INTEGER,
    tier        TEXT    NOT NULL DEFAULT 'impl',
    at          INTEGER NOT NULL,
    by          TEXT    NOT NULL DEFAULT '',
    note        TEXT,
    against_rev INTEGER,
    delta       BLOB,
    PRIMARY KEY (id, lane, rev)
);
INSERT INTO record_revs (id, lane, rev, base_rev, json, tier, at, by, note) VALUES
  ('x.rs','main',3,NULL,'{"id":"x.rs","v":3}','impl',3,'fix',NULL),
  ('gone.rs','main',2,NULL,NULL,'impl',2,'fix','removed'),
  ('x.rs','some-slice',2,3,'{"id":"x.rs","where":"lane"}','impl',5,'fix',NULL);
INSERT INTO record_history (id, lane, rev, base_rev, tier, at, by, note, against_rev, delta) VALUES
  ('x.rs','main',2,NULL,'impl',2,'fix',NULL,3,zeroblob(40)),
  ('x.rs','main',1,NULL,'impl',1,'fix',NULL,2,zeroblob(40)),
  ('gone.rs','main',1,NULL,'impl',1,'fix',NULL,NULL,zeroblob(30)),
  ('x.rs','some-slice',1,3,'impl',4,'fix',NULL,2,zeroblob(40)),
  -- A history row with no head at all: nothing a store writes, and exactly what a reader must never surface.
  ('orphan.rs','main',9,NULL,'impl',1,'fix',NULL,NULL,zeroblob(20));
