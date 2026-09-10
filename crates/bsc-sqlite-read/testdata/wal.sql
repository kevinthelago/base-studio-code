-- A WAL-mode database. The mode persists in the header (write/read version 2) after a clean close, so
-- this fixture asserts the REFUSAL without needing a live -wal sidecar.
-- Regenerate: rm -f wal.db && sqlite3 wal.db < wal.sql
PRAGMA journal_mode = WAL;
CREATE TABLE record_revs (id TEXT, lane TEXT, rev INTEGER, json TEXT);
INSERT INTO record_revs VALUES ('x.rs','main',1,'{}');
