//! The DuckDB-backed Data Model store (#781).
//!
//! Opens a per-project DuckDB database, materializes a [`DataModel`] as one typed table
//! per entity plus a lineage table, and loads a connector's [`RowSet`] into it — coercing
//! each cell per its field type and recording per-row lineage (source, when, license).
//! Read-only with respect to the *source*: the store only ever loads inward (#782).

use std::path::Path;

use duckdb::types::Value;
use duckdb::{params, params_from_iter, Connection};

use crate::connector::RowSet;
use crate::ddl::{self, Coerced};
use crate::error::{DataError, Result};
use crate::reconcile::Reconciled;
use crate::schema::{DataModel, Entity};

/// Where a load came from — recorded as lineage for every row it writes.
#[derive(Debug, Clone)]
pub struct LoadSource {
    pub source: String,
    pub license: String,
    /// Caller-supplied timestamp (the Tauri command stamps it) so loads are deterministic in tests.
    pub loaded_at: String,
}

/// A DuckDB database materializing one [`DataModel`].
pub struct DataStore {
    conn: Connection,
    model: DataModel,
}

impl DataStore {
    /// Open (or create) a store at `path` for `model`.
    pub fn open(path: impl AsRef<Path>, model: DataModel) -> Result<DataStore> {
        let conn = Connection::open(path)?;
        Self::init(conn, model)
    }

    /// Open an in-memory store — used by tests and ephemeral previews.
    pub fn open_in_memory(model: DataModel) -> Result<DataStore> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn, model)
    }

    fn init(conn: Connection, model: DataModel) -> Result<DataStore> {
        model.check()?;
        let store = DataStore { conn, model };
        store.apply_schema()?;
        Ok(store)
    }

    /// Create the entity tables + the lineage table (idempotent).
    fn apply_schema(&self) -> Result<()> {
        for e in &self.model.entities {
            self.conn.execute_batch(&ddl::create_table_sql(e)?)?;
        }
        self.conn.execute_batch(&ddl::lineage_ddl())?;
        self.conn.execute_batch(&ddl::field_lineage_ddl())?;
        Ok(())
    }

    /// Load a connector's rows into `entity_key`, mapping rowset columns onto entity
    /// fields by (case-insensitive) name. Cells coerce per field type; a row with no
    /// matching column for a field gets NULL there. Every row also writes a lineage
    /// record. Returns the number of rows loaded.
    pub fn load_rowset(&mut self, entity_key: &str, rs: &RowSet, src: &LoadSource) -> Result<usize> {
        let entity = self
            .model
            .entity(entity_key)
            .ok_or_else(|| DataError::Schema(format!("unknown entity `{entity_key}`")))?
            .clone();
        // identity field -> rowset column index, for the lineage row_key
        let id_cols: Vec<Option<usize>> = entity
            .identity
            .iter()
            .map(|id| rs.columns.iter().position(|c| c.eq_ignore_ascii_case(id)))
            .collect();
        let lineage_insert = format!(
            "INSERT INTO {} (entity, row_key, source, loaded_at, license) VALUES (?, ?, ?, ?, ?)",
            ddl::LINEAGE_TABLE
        );

        let tx = self.conn.transaction()?;
        insert_rowset(&tx, &entity, rs)?;
        {
            let mut lstmt = tx.prepare(&lineage_insert)?;
            for (i, row) in rs.rows.iter().enumerate() {
                let row_key = row_key(&id_cols, row, entity_key, i);
                lstmt.execute(params![entity_key, row_key, src.source, src.loaded_at, src.license])?;
            }
        }
        tx.commit()?;
        Ok(rs.rows.len())
    }

    /// Load a reconciled (merged) result into `entity_key` (#785): writes the canonical
    /// rows plus PER-FIELD lineage (which source won each field). Returns the record count.
    pub fn load_reconciled(&mut self, entity_key: &str, rec: &Reconciled, loaded_at: &str) -> Result<usize> {
        let entity = self
            .model
            .entity(entity_key)
            .ok_or_else(|| DataError::Schema(format!("unknown entity `{entity_key}`")))?
            .clone();
        let rs = rec.to_rowset(&entity);
        let field_insert = format!(
            "INSERT INTO {} (entity, identity, field, source, loaded_at) VALUES (?, ?, ?, ?, ?)",
            ddl::FIELD_LINEAGE_TABLE
        );

        let tx = self.conn.transaction()?;
        insert_rowset(&tx, &entity, &rs)?;
        {
            let mut fstmt = tx.prepare(&field_insert)?;
            for r in &rec.records {
                for (field, source) in &r.lineage {
                    fstmt.execute(params![entity_key, r.identity, field, source, loaded_at])?;
                }
            }
        }
        tx.commit()?;
        Ok(rec.records.len())
    }

    /// Row count for an entity.
    pub fn count(&self, entity_key: &str) -> Result<usize> {
        let table = ddl::quote_ident(entity_key)?;
        let n: i64 = self.conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        Ok(n as usize)
    }

    /// Total lineage records across all entities.
    pub fn lineage_count(&self) -> Result<usize> {
        let n: i64 = self
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {}", ddl::LINEAGE_TABLE), [], |r| r.get(0))?;
        Ok(n as usize)
    }

    /// Total per-field lineage records (reconciliation, #785).
    pub fn field_lineage_count(&self) -> Result<usize> {
        let n: i64 = self
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {}", ddl::FIELD_LINEAGE_TABLE), [], |r| r.get(0))?;
        Ok(n as usize)
    }

    /// How many rows have NULL in `field_key` — a cheap quality signal.
    pub fn null_count(&self, entity_key: &str, field_key: &str) -> Result<usize> {
        let table = ddl::quote_ident(entity_key)?;
        let col = ddl::quote_ident(field_key)?;
        let n: i64 = self
            .conn
            .query_row(&format!("SELECT COUNT(*) FROM {table} WHERE {col} IS NULL"), [], |r| r.get(0))?;
        Ok(n as usize)
    }

    /// How many rows have `field_key` equal (as text) to `value`.
    pub fn value_count(&self, entity_key: &str, field_key: &str, value: &str) -> Result<usize> {
        let table = ddl::quote_ident(entity_key)?;
        let col = ddl::quote_ident(field_key)?;
        let n: i64 = self.conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE CAST({col} AS VARCHAR) = ?"),
            params![value],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }
}

/// Insert a rowset into an entity's table, coercing each cell per its field type and
/// mapping columns onto fields by (case-insensitive) name. Shared by the per-row and the
/// reconciled load paths. Runs within the caller's transaction.
fn insert_rowset(conn: &Connection, entity: &Entity, rs: &RowSet) -> Result<()> {
    let col_for: Vec<Option<usize>> = entity
        .fields
        .iter()
        .map(|f| rs.columns.iter().position(|c| c.eq_ignore_ascii_case(&f.key)))
        .collect();
    let mut stmt = conn.prepare(&ddl::insert_sql(entity)?)?;
    for row in &rs.rows {
        let values: Vec<Value> = entity
            .fields
            .iter()
            .enumerate()
            .map(|(fi, f)| {
                let raw = col_for[fi].and_then(|ci| row.get(ci)).map(String::as_str).unwrap_or("");
                to_value(ddl::coerce(f.ty, raw))
            })
            .collect();
        stmt.execute(params_from_iter(values.iter()))?;
    }
    Ok(())
}

fn to_value(c: Coerced) -> Value {
    match c {
        Coerced::Null => Value::Null,
        Coerced::Text(s) => Value::Text(s),
        Coerced::Num(n) => Value::Double(n),
        Coerced::Bool(b) => Value::Boolean(b),
    }
}

/// Build the lineage `row_key`: the entity's identity values joined, or `entity#index`
/// when the entity has no identity.
fn row_key(id_cols: &[Option<usize>], row: &[String], entity_key: &str, index: usize) -> String {
    if id_cols.is_empty() {
        return format!("{entity_key}#{index}");
    }
    id_cols
        .iter()
        .map(|ci| ci.and_then(|i| row.get(i)).cloned().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("|")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::RowSet;
    use crate::schema::{Entity, Field, FieldType};

    fn f(key: &str, ty: FieldType) -> Field {
        Field { key: key.into(), label: String::new(), ty, required: false, reference: None, enum_values: vec![], validate: None }
    }

    fn model() -> DataModel {
        DataModel {
            name: "CRM".into(),
            version: 1,
            entities: vec![Entity {
                key: "account".into(),
                label: "Account".into(),
                fields: vec![f("id", FieldType::String), f("name", FieldType::String), f("balance", FieldType::Money)],
                identity: vec!["id".into()],
            }],
        }
    }

    fn src() -> LoadSource {
        LoadSource { source: "csv:test".into(), license: "internal".into(), loaded_at: "2026-06-13T00:00:00Z".into() }
    }

    #[test]
    fn loads_rows_typed_with_lineage() {
        let mut store = DataStore::open_in_memory(model()).unwrap();
        let rs = RowSet {
            columns: vec!["id".into(), "name".into(), "balance".into()],
            rows: vec![
                vec!["1".into(), "Acme".into(), "1,200.50".into()],
                vec!["2".into(), "Globex".into(), "".into()], // empty money → NULL
            ],
        };

        let n = store.load_rowset("account", &rs, &src()).unwrap();
        assert_eq!(n, 2);
        assert_eq!(store.count("account").unwrap(), 2);
        // lineage: one record per loaded row
        assert_eq!(store.lineage_count().unwrap(), 2);
        // coercion: the empty money cell became NULL; the parsed one did not
        assert_eq!(store.null_count("account", "balance").unwrap(), 1);
        assert_eq!(store.value_count("account", "name", "Acme").unwrap(), 1);
    }

    #[test]
    fn missing_source_column_loads_as_null() {
        let mut store = DataStore::open_in_memory(model()).unwrap();
        // no `balance` column in the source at all
        let rs = RowSet {
            columns: vec!["id".into(), "name".into()],
            rows: vec![vec!["1".into(), "Acme".into()]],
        };
        store.load_rowset("account", &rs, &src()).unwrap();
        assert_eq!(store.null_count("account", "balance").unwrap(), 1);
    }

    #[test]
    fn unknown_entity_is_rejected() {
        let mut store = DataStore::open_in_memory(model()).unwrap();
        let rs = RowSet::default();
        assert!(store.load_rowset("ghost", &rs, &src()).is_err());
    }

    #[test]
    fn load_reconciled_writes_canonical_rows_and_per_field_lineage() {
        use crate::reconcile::{reconcile, Precedence, SourceLoad};
        let mut store = DataStore::open_in_memory(model()).unwrap();

        // two sources for the same account id=1, complementary fields
        let crm = SourceLoad { source: "crm".into(), rows: RowSet {
            columns: vec!["id".into(), "name".into()], rows: vec![vec!["1".into(), "Acme".into()]] } };
        let books = SourceLoad { source: "books".into(), rows: RowSet {
            columns: vec!["id".into(), "balance".into()], rows: vec![vec!["1".into(), "999.00".into()]] } };
        let rec = reconcile(store.model.entity("account").unwrap(), &[crm, books], &Precedence(vec!["crm".into(), "books".into()]));

        let n = store.load_reconciled("account", &rec, "2026-06-13T00:00:00Z").unwrap();
        assert_eq!(n, 1); // merged into one canonical record
        assert_eq!(store.count("account").unwrap(), 1);
        assert_eq!(store.value_count("account", "name", "Acme").unwrap(), 1);
        // per-field lineage: id, name, balance each attributed to a source
        assert_eq!(store.field_lineage_count().unwrap(), 3);
    }
}
