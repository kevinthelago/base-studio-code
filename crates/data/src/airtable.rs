//! Read-only Airtable connector (native first-party, #1197).
//!
//! Airtable's REST API, scoped to one base. The transport is injected as a closure (path →
//! parsed JSON) so tests replay fixtures with no network; production captures the personal
//! access token in the closure — the connector never stores or logs it (#782 / #1194).
//!
//! - **Data:** tables → objects, fields → columns, records → rows.
//! - **Behavior:** **formula** (and rollup) fields → [`DerivedKind::Formula`] derived logic.

use serde_json::Value;

use crate::behavior::{DerivedKind, DerivedLogic, PlatformScan};
use crate::connector::{Connector, RowSet, SourceObject};
use crate::{DataError, Result};

/// A path → parsed-JSON closure. Owns the access token; the connector never sees it.
type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// Read-only Airtable connector, scoped to one base.
pub struct AirtableConnector {
    name: String,
    base_id: String,
    fetch: FetchFn,
}

impl AirtableConnector {
    pub fn new(
        name: impl Into<String>,
        base_id: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        AirtableConnector { name: name.into(), base_id: base_id.into(), fetch: Box::new(fetch) }
    }

    fn get(&self, path: &str) -> Result<Value> {
        (self.fetch)(path)
    }

    /// The base's tables (each with its `fields` metadata).
    fn tables(&self) -> Result<Vec<Value>> {
        let body = self.get(&format!("meta/bases/{}/tables", self.base_id))?;
        Ok(body["tables"].as_array().cloned().unwrap_or_default())
    }

    fn table_by_name(&self, name: &str) -> Result<Value> {
        self.tables()?
            .into_iter()
            .find(|t| t["name"].as_str() == Some(name))
            .ok_or_else(|| DataError::Schema(format!("airtable: table '{name}' not found")))
    }
}

fn field_names(table: &Value) -> Vec<String> {
    table["fields"]
        .as_array()
        .map(|fs| fs.iter().filter_map(|f| f["name"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn cell_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

impl Connector for AirtableConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        Ok(self
            .tables()?
            .iter()
            .filter_map(|t| {
                let name = t["name"].as_str()?.to_string();
                Some(SourceObject { name, columns: field_names(t) })
            })
            .collect())
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let table = self.table_by_name(object)?;
        let columns = field_names(&table);
        let body = self.get(&format!("{}/{}?maxRecords=100", self.base_id, object))?;
        let rows = body["records"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|rec| columns.iter().map(|c| cell_to_string(&rec["fields"][c])).collect())
            .collect();
        Ok(RowSet { columns, rows })
    }

    /// Capture formula / rollup fields as derived logic.
    fn scan_platform(&self) -> Result<PlatformScan> {
        let mut derived = Vec::new();
        for table in self.tables()? {
            let tname = table["name"].as_str().unwrap_or("").to_string();
            for f in table["fields"].as_array().cloned().unwrap_or_default() {
                let ftype = f["type"].as_str().unwrap_or("");
                if ftype != "formula" && ftype != "rollup" {
                    continue;
                }
                let name = f["name"].as_str().unwrap_or("").to_string();
                // The formula text lives in options when Airtable exposes it.
                let expression = f["options"]["formula"]
                    .as_str()
                    .or_else(|| f["options"]["referenceRollup"].as_str())
                    .unwrap_or("")
                    .to_string();
                derived.push(DerivedLogic {
                    source: self.name.clone(),
                    kind: DerivedKind::Formula,
                    name,
                    object: Some(tname.clone()),
                    expression,
                });
            }
        }
        Ok(PlatformScan { derived_logic: derived, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLES: &str = r#"{ "tables": [
        {"id": "tblA", "name": "Projects", "fields": [
            {"id": "f1", "name": "Name",   "type": "singleLineText"},
            {"id": "f2", "name": "Budget", "type": "currency"},
            {"id": "f3", "name": "Spent %","type": "formula", "options": {"formula": "{Spent}/{Budget}"}}
        ]}
    ] }"#;

    const RECORDS: &str = r#"{ "records": [
        {"id": "rec1", "fields": {"Name": "Apollo", "Budget": 50000, "Spent %": 0.42}},
        {"id": "rec2", "fields": {"Name": "Zephyr", "Budget": 12000}}
    ] }"#;

    fn fixture_connector() -> AirtableConnector {
        AirtableConnector::new("acme-at", "baseXYZ", move |path| {
            let body = if path.contains("meta/bases") { TABLES } else { RECORDS };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_tables_with_field_columns() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs.len(), 1);
        assert_eq!(objs[0].name, "Projects");
        assert_eq!(objs[0].columns, vec!["Name", "Budget", "Spent %"]);
    }

    #[test]
    fn read_maps_records_to_rows() {
        let c = fixture_connector();
        let rs = c.read("Projects").unwrap();
        assert_eq!(rs.columns, vec!["Name", "Budget", "Spent %"]);
        assert_eq!(rs.rows[0], vec!["Apollo", "50000", "0.42"]);
        // Missing formula cell on the second record is an empty string.
        assert_eq!(rs.rows[1], vec!["Zephyr", "12000", ""]);
    }

    #[test]
    fn scan_captures_formula_fields() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.derived_logic.len(), 1);
        let d = &scan.derived_logic[0];
        assert_eq!(d.kind, DerivedKind::Formula);
        assert_eq!(d.name, "Spent %");
        assert_eq!(d.object.as_deref(), Some("Projects"));
        assert_eq!(d.expression, "{Spent}/{Budget}");
        assert_eq!(d.source, "acme-at");
    }
}
