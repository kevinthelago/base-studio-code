//! The connector framework (#784).
//!
//! A connector **reads** from a source into a [`RowSet`] — it never writes back (#782).
//! Connectors are **native, in-process Rust** implementations of this trait (not MCP
//! servers): the reference [`CsvConnector`], the Salesforce connector, and further
//! first-party connectors (QuickBooks, Quickbase, monday.com, SQL, OData/SAP). Running in
//! the desktop host keeps credentials and bulk row data inside the host's trust boundary —
//! never in the planner's context (#1194).

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::behavior::PlatformScan;
use crate::error::Result;
use crate::schema::FieldType;

/// A readable object a connector exposes (a table, sheet, endpoint, or file) and its
/// column names — the source-side schema before any mapping to a Data Model.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceObject {
    pub name: String,
    pub columns: Vec<String>,
}

/// A column as **declared by the source system** — the connector's own field metadata, when
/// the API exposes it (#1219). More accurate than inferring a type from sampled values: a
/// Salesforce picklist becomes [`FieldType::Enum`] with its exact options, and a lookup
/// becomes [`FieldType::Ref`] with its target object — neither of which value sampling can
/// recover reliably. Connectors over schema-less sources (CSV, plain SQL text) don't override
/// [`Connector::describe_object`], so the scan falls back to value inference.
#[derive(Debug, Clone, PartialEq)]
pub struct SourceField {
    pub name: String,
    pub ty: FieldType,
    /// Allowed values when `ty` is [`FieldType::Enum`]; empty otherwise.
    pub enum_values: Vec<String>,
    /// Target object name when `ty` is [`FieldType::Ref`]; `None` otherwise.
    pub ref_target: Option<String>,
}

/// The result of reading one object: ordered column names + rows of raw string cells.
/// Everything is text at this layer; typing happens when the store coerces per the
/// Data Model field types.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RowSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl RowSet {
    /// Parse a CSV stream (first row = header) into a [`RowSet`]. Pure over a reader, so
    /// it's testable without touching the filesystem.
    pub fn from_csv_reader<R: Read>(reader: R) -> Result<RowSet> {
        let mut rdr = csv::ReaderBuilder::new().has_headers(true).flexible(true).from_reader(reader);
        let columns = rdr.headers()?.iter().map(|s| s.to_string()).collect();
        let mut rows = Vec::new();
        for rec in rdr.records() {
            let rec = rec?;
            rows.push(rec.iter().map(|s| s.to_string()).collect());
        }
        Ok(RowSet { columns, rows })
    }
}

/// A path/URL/query → parsed-JSON fetch closure that owns a source's transport **and** auth — the
/// connector never stores or sees the credentials it carries (#782 / #1194). The host supplies it
/// (built per the source's auth); tests pass a fixture closure in place of the network. Shared by
/// every native API connector so the type is defined exactly once.
pub type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// Render a JSON value as a flat cell: scalars as plain text, nested objects/arrays as compact
/// JSON. Shared by the native API connectors (#1197).
pub fn cell_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// A JSON `id` field rendered as a string, accepting either a JSON string or integer. Source APIs
/// disagree on the JSON type of an id (monday boards and Quickbase tables arrive as strings *or*
/// numbers depending on the endpoint), so connectors normalize through this single helper. Returns
/// `None` when the value is absent or is neither a string nor an integer.
pub fn json_id_as_string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string).or_else(|| v.as_i64().map(|n| n.to_string()))
}

/// Sorted top-level field names of a JSON object (empty if `rec` isn't an object). Connectors
/// that derive columns from a single sample record use this for a stable, deterministic column order.
pub fn sorted_record_columns(rec: &Value) -> Vec<String> {
    let mut cols: Vec<String> =
        rec.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    cols.sort();
    cols
}

/// Columns derived from a *set* of records: the sorted **union** of every record's top-level field
/// names, keeping only keys that pass `keep` (e.g. `|k| !k.starts_with('@')` drops OData's
/// `@odata.*` control annotations; `|_| true` keeps everything).
///
/// Standardized across the read paths of the API connectors (#1620): unlike first-record
/// derivation, the union never silently drops a column that only appears on a later record —
/// heterogeneous sources (sparse JSON, optional fields omitted when empty) are the common case.
/// The final `sort` keeps the column order deterministic regardless of record order.
pub fn union_record_columns<'a>(
    records: impl IntoIterator<Item = &'a Value>,
    keep: impl Fn(&str) -> bool,
) -> Vec<String> {
    let mut cols: Vec<String> = Vec::new();
    for rec in records {
        if let Some(map) = rec.as_object() {
            for k in map.keys() {
                if keep(k.as_str()) && !cols.iter().any(|c| c == k) {
                    cols.push(k.clone());
                }
            }
        }
    }
    cols.sort();
    cols
}

/// A read-only source of tabular data.
pub trait Connector {
    /// A stable name for this connector instance (recorded as lineage `source`).
    fn name(&self) -> &str;
    /// The objects this connector can read.
    fn objects(&self) -> Result<Vec<SourceObject>>;
    /// Read one object by name into a [`RowSet`].
    fn read(&self, object: &str) -> Result<RowSet>;

    /// Declared, typed schema for one object — the source system's own field types (#1219).
    /// Default: empty, meaning "no declared types", and the caller infers types from sampled
    /// values instead. Connectors whose API exposes field metadata (Salesforce picklists +
    /// lookups, Quickbase/HubSpot/Airtable field types) override this for accuracy.
    fn describe_object(&self, _object: &str) -> Result<Vec<SourceField>> {
        Ok(vec![])
    }

    /// Scan the source's behavioral layer — automations, business processes, and derived
    /// logic (#1193). Default: nothing. A data-only source (a CSV file, a plain table) has
    /// no behavior to carry; connectors over systems that do (Salesforce, Quickbase, …)
    /// override this. Read-only (#782).
    fn scan_platform(&self) -> Result<PlatformScan> {
        Ok(PlatformScan::default())
    }
}

/// Reference connector: reads a single CSV file. The object name is the file stem.
pub struct CsvConnector {
    name: String,
    path: PathBuf,
}

impl CsvConnector {
    pub fn new(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("csv").to_string();
        CsvConnector { name, path }
    }

    fn rowset(&self) -> Result<RowSet> {
        let file = std::fs::File::open(&self.path)?;
        RowSet::from_csv_reader(file)
    }
}

impl Connector for CsvConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let rs = self.rowset()?;
        Ok(vec![SourceObject { name: self.name.clone(), columns: rs.columns }])
    }

    fn read(&self, _object: &str) -> Result<RowSet> {
        // A single-file CSV connector ignores the object name — there's only one.
        self.rowset()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CSV: &str = "id,name,balance\n1,Acme,1200.50\n2,Globex,\n";

    #[test]
    fn parses_header_and_rows_from_a_reader() {
        let rs = RowSet::from_csv_reader(CSV.as_bytes()).unwrap();
        assert_eq!(rs.columns, vec!["id", "name", "balance"]);
        assert_eq!(rs.rows.len(), 2);
        assert_eq!(rs.rows[0], vec!["1", "Acme", "1200.50"]);
        assert_eq!(rs.rows[1], vec!["2", "Globex", ""]); // empty trailing cell preserved
    }

    #[test]
    fn json_id_as_string_accepts_string_or_integer() {
        use serde_json::json;
        assert_eq!(json_id_as_string(&json!("bqr2x")), Some("bqr2x".to_string()));
        assert_eq!(json_id_as_string(&json!(101)), Some("101".to_string()));
        assert_eq!(json_id_as_string(&json!(null)), None);
        assert_eq!(json_id_as_string(&json!(1.5)), None); // not an integer id
        assert_eq!(json_id_as_string(&Value::Null), None);
    }

    #[test]
    fn union_record_columns_is_the_sorted_union_across_records() {
        use serde_json::json;
        let records = vec![
            json!({ "id": 1, "name": "Acme" }),
            json!({ "id": 2, "city": "Reno" }), // `city` only on the second record
        ];
        // First-record derivation would drop `city`; the union keeps it, sorted.
        let cols = union_record_columns(&records, |_| true);
        assert_eq!(cols, vec!["city", "id", "name"]);
    }

    #[test]
    fn union_record_columns_applies_the_key_filter() {
        use serde_json::json;
        let records = vec![json!({ "@odata.etag": "W/\"1\"", "CustomerID": "ACME", "Country": "US" })];
        let cols = union_record_columns(&records, |k| !k.starts_with('@'));
        assert_eq!(cols, vec!["Country", "CustomerID"]); // @odata.etag dropped
    }

    #[test]
    fn csv_connector_reads_a_file() {
        let mut path = std::env::temp_dir();
        path.push(format!("bsc-data-test-{}.csv", std::process::id()));
        std::fs::write(&path, CSV).unwrap();

        let c = CsvConnector::new(&path);
        let objs = c.objects().unwrap();
        assert_eq!(objs.len(), 1);
        assert_eq!(objs[0].columns, vec!["id", "name", "balance"]);
        assert_eq!(c.read(&objs[0].name).unwrap().rows.len(), 2);
        // A data-only connector carries no behavior — it inherits the empty default.
        assert!(c.scan_platform().unwrap().is_empty());

        std::fs::remove_file(&path).ok();
    }
}
