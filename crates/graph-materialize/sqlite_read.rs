// A READ-ONLY SQLite reader, in pure Rust, with no dependencies (`retire-the-committed-json-record-store`).
//
// ── WHY THIS EXISTS AND IS NOT `rusqlite` ───────────────────────────────────────────────────────────
// `graph-materialize` is a BUILD-DEPENDENCY of 75 crates, and its own manifest states the contract:
// "LEAN ON PURPOSE: `serde_json` and nothing else. This is a build-dependency of ~54 crates, so
// anything added here is compiled before any of them can start." Adding `rusqlite` would put the
// SQLite C amalgamation at the very front of every cold build, serialized ahead of all 75 — the other
// 21 crates that use `rusqlite` compile it ALONGSIDE other work, which is a different cost entirely.
//
// The build only ever READS, and it reads one table. None of `rusqlite`'s write, transaction,
// statement-cache or extension surface is reachable from here, so the honest trade is a few hundred
// lines of format parsing against a file format that is contractually stable ("SQLite format 3" has
// not changed since 2004 and the on-disk format is a documented compatibility promise).
//
// `rusqlite` IS taken as a DEV-dependency, which dependents never compile, so the tests write real
// databases with the real engine and assert this reader agrees with it. A hand-rolled parser that has
// only ever been checked against its own output is a claim, not evidence — `a-byte-identical-roundtrip-
// does-not-prove-the-parse` is exactly this trap, so the guard writes with one implementation and
// reads with the other.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────────────────────────────
// WAL. If the header says write-version 2, committed data can live in the `-wal` sidecar that this
// reader does not read, so it would return STALE ROWS while looking perfectly healthy — the worst
// failure this code could have. It refuses instead, naming the fix. MEASURED 2026-09-09 the ledger is
// in rollback-journal mode (write/read version 1, no `-wal`/`-shm` beside it), so this costs nothing
// today and catches the day someone flips it.

// NO `use` HERE. This file is `include!`d into the same module as `emit.rs`, which already imports
// `std::path::Path` — a second `use` of the same name is E0252. Paths below are fully qualified.

/// A SQLite page number. 1-based; 0 is the "no page" sentinel in overflow chains and child pointers.
type PageNo = u32;

/// One decoded column value — only the shapes the record store actually stores.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Null,
    Int(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Val {
    /// The text of a TEXT column, or `None` for every other shape. Callers want "the id" and "the
    /// json", and a NULL or an integer there is a corrupt row rather than a value to coerce.
    pub fn as_text(&self) -> Option<&str> {
        // Variants enumerated rather than `_`: `wildcard_enum_match_arm` is DENIED workspace-wide, and
        // the reason is worth keeping — a wildcard silently absorbs a variant added later, which here
        // would mean a new column shape quietly reading as "not text" instead of failing.
        match self {
            Val::Text(s) => Some(s),
            Val::Null | Val::Int(_) | Val::Real(_) | Val::Blob(_) => None,
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Val::Int(i) => Some(*i),
            Val::Null | Val::Real(_) | Val::Text(_) | Val::Blob(_) => None,
        }
    }
}

/// A whole database file, held in memory.
///
/// Read whole rather than seeked: the ledger is ~98 MB and the build reads EVERY record in it, so a
/// single sequential read beats thousands of `seek`+`read` pairs, and it removes an entire class of
/// partial-read handling. A build script that cannot afford 98 MB transiently cannot afford rustc.
pub struct Db {
    bytes: Vec<u8>,
    page_size: usize,
    /// Bytes reserved at the END of every page (header byte 20). Almost always 0, but it changes the
    /// usable size that every overflow calculation is derived from, so it is read rather than assumed.
    reserved: usize,
}

impl Db {
    /// Open and validate a database file.
    pub fn open(path: &std::path::Path) -> Result<Db, String> {
        let bytes = std::fs::read(path)
            .map_err(|e| format!("cannot read the record database at {}: {e}", path.display()))?;
        Db::from_bytes(bytes, &path.display().to_string())
    }

    pub fn from_bytes(bytes: Vec<u8>, what: &str) -> Result<Db, String> {
        if bytes.len() < 100 {
            return Err(format!("{what} is {} bytes — too short to be a SQLite database", bytes.len()));
        }
        if &bytes[0..16] != b"SQLite format 3\0" {
            return Err(format!("{what} is not a SQLite database (bad magic)"));
        }
        // Page size: a u16 at 16, where the value 1 means 65536 (it does not fit in the field).
        let raw_ps = u16::from_be_bytes([bytes[16], bytes[17]]) as usize;
        let page_size = if raw_ps == 1 { 65536 } else { raw_ps };
        if page_size < 512 || !page_size.is_power_of_two() {
            return Err(format!("{what} declares a page size of {page_size}, which is not a power of two ≥ 512"));
        }
        // THE WAL REFUSAL. See the header comment — reading the main file alone under WAL yields stale
        // rows silently, so this is the one condition worth failing the build over.
        let write_version = bytes[18];
        let read_version = bytes[19];
        if write_version == 2 || read_version == 2 {
            return Err(format!(
                "{what} is in WAL mode, and this reader does not read the `-wal` sidecar — it would \
                 return STALE records while looking healthy. Checkpoint it first \
                 (`PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;`) or teach this reader WAL."
            ));
        }
        let reserved = bytes[20] as usize;
        if reserved >= page_size {
            return Err(format!("{what} reserves {reserved} bytes of a {page_size}-byte page"));
        }
        // Text encoding at offset 56: 1 = UTF-8, 2 = UTF-16le, 3 = UTF-16be. Only UTF-8 is decoded,
        // and the others are refused rather than mojibaked into a record body.
        let enc = u32::from_be_bytes([bytes[56], bytes[57], bytes[58], bytes[59]]);
        if enc != 1 && enc != 0 {
            return Err(format!("{what} is UTF-16 (text encoding {enc}); this reader decodes UTF-8 only"));
        }
        Ok(Db { bytes, page_size, reserved })
    }

    /// Bytes usable on a page — the page minus whatever the header reserves at its end. Every overflow
    /// threshold below is derived from THIS, never from the raw page size.
    fn usable(&self) -> usize {
        self.page_size - self.reserved
    }

    fn page(&self, n: PageNo) -> Result<&[u8], String> {
        if n == 0 {
            return Err("page 0 requested — the file is corrupt or a child pointer is bad".into());
        }
        let start = (n as usize - 1) * self.page_size;
        let end = start + self.page_size;
        self.bytes
            .get(start..end)
            .ok_or_else(|| format!("page {n} is past the end of the file ({} bytes)", self.bytes.len()))
    }

    /// The root page of a table, from `sqlite_master` — which is itself the b-tree rooted at page 1.
    pub fn table_root(&self, table: &str) -> Result<PageNo, String> {
        for row in self.rows(1)? {
            // sqlite_master is (type, name, tbl_name, rootpage, sql)
            let kind = row.first().and_then(Val::as_text).unwrap_or("");
            let name = row.get(1).and_then(Val::as_text).unwrap_or("");
            if kind == "table" && name == table {
                return row
                    .get(3)
                    .and_then(Val::as_int)
                    .map(|i| i as PageNo)
                    .ok_or_else(|| format!("`{table}` has no root page in sqlite_master"));
            }
        }
        Err(format!("no table named `{table}` in this database"))
    }

    /// Every row of the table b-tree rooted at `root`, in b-tree order.
    pub fn rows(&self, root: PageNo) -> Result<Vec<Vec<Val>>, String> {
        let mut out = Vec::new();
        let mut seen = 0usize;
        self.walk(root, &mut out, &mut seen)?;
        Ok(out)
    }

    fn walk(&self, page_no: PageNo, out: &mut Vec<Vec<Val>>, visited: &mut usize) -> Result<(), String> {
        // A cycle in a corrupt file would otherwise recurse forever. The bound is the file's page
        // count, which no legitimate traversal can exceed.
        *visited += 1;
        let max_pages = self.bytes.len() / self.page_size + 1;
        if *visited > max_pages {
            return Err("the b-tree visits more pages than the file holds — it is cyclic or corrupt".into());
        }
        let page = self.page(page_no)?;
        // Page 1 carries the 100-byte file header before its b-tree header.
        let off = if page_no == 1 { 100 } else { 0 };
        let kind = page[off];
        let cell_count = u16::from_be_bytes([page[off + 3], page[off + 4]]) as usize;
        match kind {
            // Leaf table b-tree: the cells ARE the rows.
            0x0d => {
                let ptr_base = off + 8;
                for i in 0..cell_count {
                    let p = ptr_base + i * 2;
                    let cell_off = u16::from_be_bytes([
                        *page.get(p).ok_or("cell pointer past the page")?,
                        *page.get(p + 1).ok_or("cell pointer past the page")?,
                    ]) as usize;
                    out.push(self.leaf_cell(page, cell_off)?);
                }
                Ok(())
            }
            // Interior table b-tree: 4-byte left-child pointers plus a rightmost pointer in the header.
            0x05 => {
                let ptr_base = off + 12;
                for i in 0..cell_count {
                    let p = ptr_base + i * 2;
                    let cell_off = u16::from_be_bytes([
                        *page.get(p).ok_or("cell pointer past the page")?,
                        *page.get(p + 1).ok_or("cell pointer past the page")?,
                    ]) as usize;
                    let child = u32::from_be_bytes([
                        page[cell_off],
                        page[cell_off + 1],
                        page[cell_off + 2],
                        page[cell_off + 3],
                    ]);
                    self.walk(child, out, visited)?;
                }
                let right = u32::from_be_bytes([page[off + 8], page[off + 9], page[off + 10], page[off + 11]]);
                self.walk(right, out, visited)
            }
            // Index pages carry no table rows. Reached only if a caller hands us an index root.
            0x02 | 0x0a => Ok(()),
            other => Err(format!("page {page_no} has b-tree type 0x{other:02x}, which is not a table page")),
        }
    }

    /// Decode one leaf-table cell: `payload_size, rowid, payload[, overflow_page]`.
    fn leaf_cell(&self, page: &[u8], mut at: usize) -> Result<Vec<Val>, String> {
        let (payload_len, n) = varint(page, at)?;
        at += n;
        let (_rowid, n) = varint(page, at)?;
        at += n;
        let payload_len = payload_len as usize;

        // How much of the payload lives on THIS page. Straight from the format spec: for a table leaf,
        // X = U - 35; when the payload exceeds X, K decides between the minimum and the computed split.
        let u = self.usable();
        let x = u - 35;
        let local = if payload_len <= x {
            payload_len
        } else {
            let m = ((u - 12) * 32 / 255) - 23;
            let k = m + ((payload_len - m) % (u - 4));
            if k <= x { k } else { m }
        };

        let mut payload = Vec::with_capacity(payload_len);
        payload.extend_from_slice(
            page.get(at..at + local).ok_or("cell payload runs past the end of its page")?,
        );

        if local < payload_len {
            let p = at + local;
            let mut next = u32::from_be_bytes([
                *page.get(p).ok_or("overflow pointer past the page")?,
                *page.get(p + 1).ok_or("overflow pointer past the page")?,
                *page.get(p + 2).ok_or("overflow pointer past the page")?,
                *page.get(p + 3).ok_or("overflow pointer past the page")?,
            ]);
            let mut guard = 0usize;
            let max_pages = self.bytes.len() / self.page_size + 1;
            while next != 0 && payload.len() < payload_len {
                guard += 1;
                if guard > max_pages {
                    return Err("the overflow chain is longer than the file — it is cyclic".into());
                }
                let op = self.page(next)?;
                next = u32::from_be_bytes([op[0], op[1], op[2], op[3]]);
                let want = (payload_len - payload.len()).min(u - 4);
                payload.extend_from_slice(&op[4..4 + want]);
            }
            if payload.len() != payload_len {
                return Err(format!(
                    "overflow chain ended {} bytes short of the declared payload",
                    payload_len - payload.len()
                ));
            }
        }
        decode_record(&payload)
    }
}

/// A SQLite varint: up to 9 bytes, 7 bits each, big-endian; the 9th byte contributes all 8 of its bits.
fn varint(buf: &[u8], at: usize) -> Result<(u64, usize), String> {
    let mut v: u64 = 0;
    for i in 0..9 {
        let b = *buf.get(at + i).ok_or("varint runs past the end of the buffer")?;
        if i == 8 {
            v = (v << 8) | b as u64;
            return Ok((v, 9));
        }
        v = (v << 7) | (b & 0x7f) as u64;
        if b & 0x80 == 0 {
            return Ok((v, i + 1));
        }
    }
    unreachable!("the loop returns on i == 8")
}

/// Decode a record payload: a header of serial types, then the values back to back.
fn decode_record(payload: &[u8]) -> Result<Vec<Val>, String> {
    let (header_len, n) = varint(payload, 0)?;
    let header_len = header_len as usize;
    if header_len > payload.len() {
        return Err("record header is longer than the record".into());
    }
    let mut types = Vec::new();
    let mut at = n;
    while at < header_len {
        let (t, k) = varint(payload, at)?;
        at += k;
        types.push(t);
    }
    let mut body = header_len;
    let mut out = Vec::with_capacity(types.len());
    for t in types {
        let (val, size) = match t {
            0 => (Val::Null, 0usize),
            1..=6 => {
                let width = match t {
                    1 => 1,
                    2 => 2,
                    3 => 3,
                    4 => 4,
                    5 => 6,
                    _ => 8,
                };
                let b = payload.get(body..body + width).ok_or("integer runs past the record")?;
                // Sign-extend from the top bit of the first byte.
                let mut v: i64 = if b[0] & 0x80 != 0 { -1 } else { 0 };
                for byte in b {
                    v = (v << 8) | *byte as i64;
                }
                (Val::Int(v), width)
            }
            7 => {
                let b = payload.get(body..body + 8).ok_or("float runs past the record")?;
                let mut a = [0u8; 8];
                a.copy_from_slice(b);
                (Val::Real(f64::from_be_bytes(a)), 8)
            }
            8 => (Val::Int(0), 0),
            9 => (Val::Int(1), 0),
            10 | 11 => return Err(format!("serial type {t} is reserved and must not appear on disk")),
            t if t % 2 == 0 => {
                let len = ((t - 12) / 2) as usize;
                let b = payload.get(body..body + len).ok_or("blob runs past the record")?;
                (Val::Blob(b.to_vec()), len)
            }
            t => {
                let len = ((t - 13) / 2) as usize;
                let b = payload.get(body..body + len).ok_or("text runs past the record")?;
                let s = std::str::from_utf8(b).map_err(|e| format!("a TEXT column is not valid UTF-8: {e}"))?;
                (Val::Text(s.to_string()), len)
            }
        };
        body += size;
        out.push(val);
    }
    Ok(out)
}

/// Every record on `lane`, newest revision per id, as the `implementations` array the JSON store
/// would have carried.
///
/// The ledger keeps EVERY revision (`record_revs` is append-only, which is what makes a record's
/// history answerable), so "the store" is the max `rev` per id — reading them all and taking the
/// newest is what the JSON store's one-file-per-record layout expressed structurally.
pub fn read_lane(db_path: &std::path::Path, lane: &str) -> Result<Vec<serde_json::Value>, String> {
    let db = Db::open(db_path)?;
    let root = db.table_root("record_revs")?;
    let rows = db.rows(root)?;

    // Column order is read from sqlite_master's DDL rather than assumed, so a future ALTER TABLE that
    // appends a column cannot silently shift `json` into `note`.
    let cols = db.columns_of("record_revs")?;
    let idx = |name: &str| -> Result<usize, String> {
        cols.iter()
            .position(|c| c == name)
            .ok_or_else(|| format!("`record_revs` has no `{name}` column; it has {cols:?}"))
    };
    let (i_id, i_lane, i_rev, i_json) = (idx("id")?, idx("lane")?, idx("rev")?, idx("json")?);

    // A NULL `json` is a TOMBSTONE, not a row to skip — and getting that wrong resurrects the dead.
    //
    // The ledger is append-only, so a record is not deleted by removing rows: a new revision is added
    // whose body is NULL, carrying the reason ("superseded by `bsc-util--deny--mod.rs` — both claimed
    // module `deny`"). MEASURED against the live ledger 2026-09-09: 198 ids on `main` have exactly that
    // as their newest revision. An earlier version of this loop skipped NULL rows, which meant the
    // tombstone was ignored and the PREVIOUS revision won — so all 198 came back from the dead and the
    // materializer refused with `two records claim module …`. The store had already reconciled itself;
    // the reader was the thing that was wrong.
    //
    // So the newest revision is chosen over EVERY row, tombstones included, and an id whose winner is a
    // tombstone is omitted entirely.
    let mut best: std::collections::HashMap<String, (i64, Option<String>)> = std::collections::HashMap::new();
    for row in rows {
        if row.get(i_lane).and_then(Val::as_text) != Some(lane) {
            continue;
        }
        let (id, rev) = match (row.get(i_id).and_then(Val::as_text), row.get(i_rev).and_then(Val::as_int)) {
            (Some(i), Some(r)) => (i.to_string(), r),
            _ => continue,
        };
        let json = row.get(i_json).and_then(Val::as_text).map(str::to_string);
        match best.get(&id) {
            Some((have, _)) if *have >= rev => {}
            _ => {
                best.insert(id, (rev, json));
            }
        }
    }
    best.retain(|_, (_, json)| json.is_some());

    // Sorted by id so the emitted store is DETERMINISTIC — the JSON path sorts its record files, and
    // a build whose output depends on hash-map order is a build that cannot be diffed.
    let mut ids: Vec<&String> = best.keys().collect();
    ids.sort();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let json = best[id].1.as_deref().expect("tombstones were retained out above");
        out.push(
            serde_json::from_str(json)
                .map_err(|e| format!("record `{id}` on lane `{lane}` holds invalid JSON: {e}"))?,
        );
    }
    Ok(out)
}

impl Db {
    /// The column names of a table, parsed from its `CREATE TABLE` in sqlite_master.
    ///
    /// Deliberately positional-by-name rather than trusting a fixed order: the reader is pinned to the
    /// SCHEMA, so adding a column to `record_revs` cannot silently re-point `json` at another field.
    pub fn columns_of(&self, table: &str) -> Result<Vec<String>, String> {
        for row in self.rows(1)? {
            let kind = row.first().and_then(Val::as_text).unwrap_or("");
            let name = row.get(1).and_then(Val::as_text).unwrap_or("");
            if kind != "table" || name != table {
                continue;
            }
            let sql = row.get(4).and_then(Val::as_text).unwrap_or("");
            // STRIP SQL COMMENTS FIRST. The real ledger's `CREATE TABLE` documents its columns inline,
            // and without this each `-- …` line splits on its own commas and becomes phantom columns
            // named `--`, `so`, `which`. MEASURED against the live ledger: 26 "columns" found, `lane`
            // not among them. Every fixture written by `rusqlite` in the tests is comment-free, so this
            // is exactly the class of bug only the real store could surface.
            let sql = strip_sql_comments(sql);
            let sql = sql.as_str();
            let open = sql.find('(').ok_or_else(|| format!("`{table}` DDL has no column list"))?;
            let close = sql.rfind(')').ok_or_else(|| format!("`{table}` DDL is unterminated"))?;
            let mut cols = Vec::new();
            let mut depth = 0i32;
            let mut cur = String::new();
            for ch in sql[open + 1..close].chars() {
                match ch {
                    '(' => {
                        depth += 1;
                        cur.push(ch);
                    }
                    ')' => {
                        depth -= 1;
                        cur.push(ch);
                    }
                    ',' if depth == 0 => {
                        cols.push(std::mem::take(&mut cur));
                    }
                    _ => cur.push(ch),
                }
            }
            cols.push(cur);
            return Ok(cols
                .iter()
                .filter_map(|c| {
                    let t = c.trim();
                    // Skip table-level constraints, which are not columns.
                    let first = t.split_whitespace().next()?.to_ascii_uppercase();
                    if matches!(first.as_str(), "PRIMARY" | "UNIQUE" | "CHECK" | "FOREIGN" | "CONSTRAINT") {
                        return None;
                    }
                    Some(t.split_whitespace().next()?.trim_matches(['"', '`', '[', ']']).to_string())
                })
                .collect());
        }
        Err(format!("no table named `{table}` in this database"))
    }
}

/// Remove `-- line` and `/* block */` comments from DDL, leaving the structure intact.
///
/// String literals are respected: a `--` inside `'…'` is data, not a comment, and eating it would
/// corrupt a DEFAULT. Nothing here needs to understand SQL beyond that.
fn strip_sql_comments(sql: &str) -> String {
    let b: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0usize;
    while i < b.len() {
        // A single-quoted literal passes through whole, including any `--` inside it.
        if b[i] == '\'' {
            out.push(b[i]);
            i += 1;
            while i < b.len() {
                out.push(b[i]);
                if b[i] == '\'' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if b[i] == '-' && i + 1 < b.len() && b[i + 1] == '-' {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
            // Keep the newline so a comment cannot glue two column definitions together.
            continue;
        }
        if b[i] == '/' && i + 1 < b.len() && b[i + 1] == '*' {
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(b.len());
            out.push(' ');
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}
