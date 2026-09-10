// A READ-ONLY SQLite reader, in pure Rust, with NO DEPENDENCIES (`retire-the-committed-json-record-store`).
//
// ── WHY A CRATE OF ITS OWN, AND WHY std-ONLY ────────────────────────────────────────────────────────
// TWO consumers need to read a record store without being allowed to link `rusqlite`, and they cannot
// share it any other way:
//
//   `graph-materialize` is a BUILD-DEPENDENCY of 75 crates and its manifest states the contract —
//   "LEAN ON PURPOSE: `serde_json` and nothing else … anything added here is compiled before any of
//   them can start". `rusqlite` there would put the SQLite C amalgamation at the very front of every
//   cold build, serialized ahead of all 75.
//
//   `bsc-util` is stricter still: "Leaf crate: std only, no dependencies, so any CLI can pull it in
//   for free". Even its JSON reader is held to a DEV-dependency to keep that property. It needs this
//   because `packaged::read` is the ONE funnel every Rust reader of a packaged seed goes through, so
//   moving those reads into the store is one function here and zero call-site changes everywhere else.
//
// So this crate takes NOTHING. Its whole dependency closure is `std`, which is what lets `bsc-util`
// depend on it and still cost a consumer no third-party compilation at all.
//
// ── WHY NOT `rusqlite` ──────────────────────────────────────────────────────────────────────────────
// Both callers only ever READ, and they read one table. None of `rusqlite`'s write, transaction,
// statement-cache or extension surface is reachable from here, so the honest trade is a few hundred
// lines of format parsing against a file format that is contractually stable ("SQLite format 3" has
// not changed since 2004 and the on-disk format is a documented compatibility promise).
//
// ── HOW IT IS PROVED, GIVEN IT CANNOT LINK THE ENGINE ───────────────────────────────────────────────
// A hand-rolled parser checked only against its own output is a claim, not evidence
// (`a-byte-identical-roundtrip-does-not-prove-the-parse`), and the failure mode is the bad one: a
// mis-parse returns plausible data rather than an error. The fixtures under `testdata/` were WRITTEN
// by the real SQLite engine and are committed as BYTES, so the differential property holds with two
// implementations and no dependency — `rusqlite` cannot even be a DEV-dependency, because a dev edge
// still lands in the Cargo.lock closure of every dependent and the sensor binaries'
// `the_sensor_binary_pulls_in_nothing_heavy` guard reads it as a real one. 106 KB of fixture buys it.
//
// ── WHAT IT REFUSES ─────────────────────────────────────────────────────────────────────────────────
// WAL. If the header says write-version 2, committed data can live in the `-wal` sidecar that this
// reader does not read, so it would return STALE ROWS while looking perfectly healthy — the worst
// failure this code could have. It refuses instead, naming the fix. MEASURED 2026-09-09 the ledger is
// in rollback-journal mode (write/read version 1, no `-wal`/`-shm` beside it), so this costs nothing
// today and catches the day someone flips it.

// NO `use` HERE. This file is `include!`d — by this crate's own root, and by `graph-materialize`'s
// `build.rs` and `src/lib.rs`, where it lands in the same module as `emit.rs` and a second `use` of a
// name that file already imports would be E0252. Paths below are fully qualified.

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

/// One TOP-LEVEL string field out of a JSON object, unescaped — without a JSON library.
///
/// ## Why this exists rather than `serde_json`
///
/// `bsc-util` is the std-only leaf every CLI pulls in for free, and the thing it needs from a record
/// store is exactly one shape: the `text` of a seed row. Taking `serde_json` to reach it would spend
/// the crate's whole defining property on a single field access.
///
/// ## Why it is not "a second JSON parser"
///
/// It parses NOTHING structural. It scans for a top-level key at depth 1 and unescapes the string
/// that follows — no numbers, no nesting, no objects, no arrays. Anything it cannot answer for is
/// `None`, which the caller reads as "not a seed row I can serve" and falls through to the file. It is
/// a string decoder that happens to be pointed at JSON, and the reason that is safe is that its output
/// is checked against the real library: `the_field_reader_agrees_with_serde_json` runs both over the
/// awkward corpus (escapes, surrogate pairs, a `\"` inside a value, a decoy key nested one level down)
/// and fails if they ever disagree. `serde_json` is a DEV-dependency, which no dependent compiles.
///
/// Depth tracking is what makes the decoy case work: `{"a":{"text":"inner"},"text":"outer"}` must
/// return `outer`, and a scanner that took the first match would silently return the wrong file.
pub fn json_string_field(json: &str, field: &str) -> Option<String> {
    let b = json.as_bytes();
    let mut i = 0usize;
    let mut depth = 0i32;
    let mut in_str = false;
    // Where the string currently being scanned began, so a key can be compared without allocating.
    let mut str_start = 0usize;
    while i < b.len() {
        let c = b[i];
        if in_str {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == b'"' {
                in_str = false;
                // A key is a string at depth 1 followed by a colon.
                if depth == 1 && &json[str_start..i] == field {
                    let mut j = i + 1;
                    while j < b.len() && (b[j] as char).is_ascii_whitespace() {
                        j += 1;
                    }
                    if j < b.len() && b[j] == b':' {
                        j += 1;
                        while j < b.len() && (b[j] as char).is_ascii_whitespace() {
                            j += 1;
                        }
                        // ONLY a string value. A number, object, array or null is not what the caller
                        // asked for, and guessing a rendering for one would be inventing data.
                        if j < b.len() && b[j] == b'"' {
                            return unescape_json_string(&b[j + 1..]);
                        }
                        return None;
                    }
                }
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                in_str = true;
                str_start = i + 1;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
}

/// Decode a JSON string body (everything after the opening quote) up to its closing quote.
///
/// Returns `None` on anything malformed rather than a partial value — a truncated seed would be
/// written to disk looking like a real one.
fn unescape_json_string(b: &[u8]) -> Option<String> {
    let mut out = String::new();
    let mut i = 0usize;
    while i < b.len() {
        match b[i] {
            b'"' => return Some(out),
            b'\\' => {
                i += 1;
                let e = *b.get(i)?;
                match e {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\u{8}'),
                    b'f' => out.push('\u{c}'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hi = hex4(b, i + 1)?;
                        i += 4;
                        // A SURROGATE PAIR is two \u escapes and one character. Decoding the halves
                        // separately yields two replacement chars, which is silent corruption of any
                        // non-BMP content — an emoji in a theme name is enough to hit it.
                        let ch = if (0xD800..0xDC00).contains(&hi) {
                            if b.get(i + 1) != Some(&b'\\') || b.get(i + 2) != Some(&b'u') {
                                return None;
                            }
                            let lo = hex4(b, i + 3)?;
                            if !(0xDC00..0xE000).contains(&lo) {
                                return None;
                            }
                            i += 6;
                            char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00))?
                        } else {
                            char::from_u32(hi)?
                        };
                        out.push(ch);
                    }
                    _ => return None,
                }
                i += 1;
            }
            _ => {
                // Multi-byte UTF-8 passes through whole: find the end of this scalar and copy it.
                let len = utf8_len(b[i]);
                let s = std::str::from_utf8(b.get(i..i + len)?).ok()?;
                out.push_str(s);
                i += len;
            }
        }
    }
    None
}

/// Four hex digits at `at`, as a code unit.
fn hex4(b: &[u8], at: usize) -> Option<u32> {
    let s = std::str::from_utf8(b.get(at..at + 4)?).ok()?;
    u32::from_str_radix(s, 16).ok()
}

/// The byte length of the UTF-8 scalar starting with `first`.
fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}
