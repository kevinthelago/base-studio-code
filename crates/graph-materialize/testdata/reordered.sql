-- Columns in a DIFFERENT order than the ledger, plus a table-level constraint that is not a column,
-- so the reader is proven to locate `json` by NAME. Regenerate: rm -f reordered.db && sqlite3 reordered.db < reordered.sql
PRAGMA journal_mode = DELETE;
CREATE TABLE record_revs (lane TEXT, extra TEXT, json TEXT, id TEXT, rev INTEGER, PRIMARY KEY (id, lane, rev));
INSERT INTO record_revs (lane, extra, json, id, rev)
VALUES ('main','ignored','{"id":"z.rs","ok":true}','z.rs',1);
