-- A DDL that DOCUMENTS ITS COLUMNS INLINE, which is what the live ledger does and what no
-- library-written fixture produces. Regenerate: rm -f commented.db && sqlite3 commented.db < commented.sql
PRAGMA journal_mode = DELETE;
CREATE TABLE record_revs (
    id TEXT NOT NULL,        -- the record id, which is also its module path
    lane TEXT NOT NULL,      -- main, or a slice's lane
    rev INTEGER NOT NULL,    /* append-only, so max(rev) is the store */
    json TEXT NOT NULL,      -- the body, and this is not, or 'a--b', a comment
    note TEXT
);
INSERT INTO record_revs (id, lane, rev, json, note)
VALUES ('c.rs','main',1,'{"id":"c.rs","ok":1}',NULL);
