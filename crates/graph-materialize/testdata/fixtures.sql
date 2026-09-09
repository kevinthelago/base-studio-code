-- Fixtures for `sqlite_read.rs`, WRITTEN BY REAL SQLITE so the reader is checked against another
-- implementation rather than against itself (`a-byte-identical-roundtrip-does-not-prove-the-parse`).
--
-- REGENERATE, from this directory:
--     rm -f ledger.db && sqlite3 ledger.db < fixtures.sql
--
-- Committed as bytes on purpose. `graph-materialize` is a build-dependency of 75 crates and its
-- manifest holds it to "serde_json and nothing else" — taking `rusqlite` even as a DEV-dependency puts
-- it in the Cargo.lock closure of every dependent, which is a real guard's real (if over-broad)
-- complaint on the 4 GB sensor binaries. A checked-in fixture keeps the differential property with no
-- dependency at all.

PRAGMA journal_mode = DELETE;

-- The ledger's real column layout and order.
CREATE TABLE record_revs (
    id TEXT NOT NULL, lane TEXT NOT NULL, rev INTEGER NOT NULL, base_rev INTEGER,
    json TEXT, tier TEXT, at INTEGER, by TEXT, note TEXT   -- json NULL = a TOMBSTONE
);

INSERT INTO record_revs (id, lane, rev, base_rev, json, tier, at, by, note) VALUES
  ('alpha.rs','main',1,NULL,'{"id":"alpha.rs","code":"fn a() {}"}','A',1,'fix',NULL),
  ('beta.rs', 'main',1,NULL,'{"id":"beta.rs","code":"fn b() {}"}', 'A',1,'fix',NULL),
  -- Out of insertion order, so "newest" cannot be satisfied by "last row read".
  ('x.rs','main',3,NULL,'{"id":"x.rs","v":3}','A',1,'fix',NULL),
  ('x.rs','main',1,NULL,'{"id":"x.rs","v":1}','A',1,'fix',NULL),
  ('x.rs','main',2,NULL,'{"id":"x.rs","v":2}','A',1,'fix',NULL),
  -- A HIGHER rev on another lane, which must not win on main.
  ('x.rs','some-slice',9,NULL,'{"id":"x.rs","where":"lane"}','A',1,'fix',NULL),
  ('y.rs','some-slice',1,NULL,'{"id":"y.rs","where":"lane"}','A',1,'fix',NULL),
  -- Multibyte: record bodies are prose-heavy source.
  ('u.rs','main',1,NULL,'{"id":"u.rs","code":"// — → ✓ 日本語 🌍"}','A',1,'fix',NULL),
  -- A TOMBSTONE: the ledger is append-only, so a delete is a newer revision with a NULL body. The
  -- reader must drop the id, NOT fall back to rev 1 — 198 real records depend on that distinction.
  ('dead.rs','main',1,NULL,'{"id":"dead.rs","code":"fn gone() {}"}','A',1,'fix',NULL),
  ('dead.rs','main',2,NULL,NULL,'A',2,'fix','superseded by `dead--mod.rs`');

-- A body far past one 4096-byte page, so the overflow CHAIN is exercised. 40,000 chars of "ab".
INSERT INTO record_revs (id, lane, rev, base_rev, json, tier, at, by, note)
SELECT 'big.rs','main',1,NULL,
       '{"id":"big.rs","code":"' || replace(hex(zeroblob(20000)), '00', 'ab') || '"}',
       'A',1,'fix',NULL;

-- 500 rows, enough for the table b-tree to grow INTERIOR pages rather than one leaf.
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 499)
INSERT INTO record_revs (id, lane, rev, base_rev, json, tier, at, by, note)
SELECT printf('r%04d.rs', i), 'main', 1, NULL,
       '{"id":"' || printf('r%04d.rs', i) || '","n":' || i || '}',
       'A', 1, 'fix', NULL
FROM n;
