//! Read-only Airtable connector (native first-party, #1197).
//!
//! Airtable's REST API, scoped to one base. The transport is injected as a closure (path →
//! parsed JSON) so tests replay fixtures with no network; production captures the personal
//! access token in the closure — the connector never stores or logs it (#782 / #1194).
//!
//! - **Data:** tables → objects, fields → columns, records → rows.
//! - **Behavior:** **formula** (and rollup) fields → [`DerivedKind::Formula`] derived logic.

use std::collections::HashMap;

use serde_json::Value;

use crate::behavior::{DerivedKind, DerivedLogic, PlatformScan};
use crate::connector::{Connector, RowSet, SourceField, SourceObject};
use crate::schema::FieldType;
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

/// Map an Airtable field's declared `type` to a vendor-neutral [`SourceField`] (#1230):
/// currency → money, numeric kinds → number, date kinds → date, checkbox → bool, single/multiple
/// selects → enum + their choice names, record links → ref (resolving `linkedTableId` to the
/// table name via `id_to_name`, falling back to a plain field when unresolved), else string.
fn at_field(f: &Value, id_to_name: &HashMap<&str, &str>) -> Option<SourceField> {
    let name = f["name"].as_str()?.to_string();
    let (ty, enum_values, ref_target) = match f["type"].as_str().unwrap_or("singleLineText") {
        "currency" => (FieldType::Money, vec![], None),
        "number" | "percent" | "duration" | "rating" | "count" | "autoNumber" => {
            (FieldType::Number, vec![], None)
        }
        "date" | "dateTime" | "createdTime" | "lastModifiedTime" => (FieldType::Date, vec![], None),
        "checkbox" => (FieldType::Bool, vec![], None),
        "singleSelect" | "multipleSelects" => (
            FieldType::Enum,
            f["options"]["choices"]
                .as_array()
                .map(|c| c.iter().filter_map(|v| v["name"].as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            None,
        ),
        "multipleRecordLinks" | "singleRecordLink" => {
            match f["options"]["linkedTableId"].as_str().and_then(|id| id_to_name.get(id).copied()) {
                Some(target) => (FieldType::Ref, vec![], Some(target.to_string())),
                None => (FieldType::String, vec![], None),
            }
        }
        _ => (FieldType::String, vec![], None),
    };
    Some(SourceField { name, ty, enum_values, ref_target })
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

    /// Declared field types from the base schema (#1230): selects carry their choices as an enum
    /// and record links resolve to a ref on the linked table — the link target is a `tbl…` id, so
    /// it's mapped back to the table name here using the full base schema.
    fn describe_object(&self, object: &str) -> Result<Vec<SourceField>> {
        let tables = self.tables()?;
        let id_to_name: HashMap<&str, &str> = tables
            .iter()
            .filter_map(|t| Some((t["id"].as_str()?, t["name"].as_str()?)))
            .collect();
        let table = tables
            .iter()
            .find(|t| t["name"].as_str() == Some(object))
            .ok_or_else(|| DataError::Schema(format!("airtable: table '{object}' not found")))?;
        Ok(table["fields"]
            .as_array()
            .map(|fs| fs.iter().filter_map(|f| at_field(f, &id_to_name)).collect())
            .unwrap_or_default())
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

    const TYPED_TABLES: &str = r#"{ "tables": [
        {"id": "tblP", "name": "Projects", "fields": [
            {"id": "f1", "name": "Name",   "type": "singleLineText"},
            {"id": "f2", "name": "Budget", "type": "currency"},
            {"id": "f3", "name": "Due",    "type": "date"},
            {"id": "f4", "name": "Active", "type": "checkbox"},
            {"id": "f5", "name": "Stage",  "type": "singleSelect", "options": {"choices": [{"name": "Open"}, {"name": "Closed"}]}},
            {"id": "f6", "name": "Owner",  "type": "multipleRecordLinks", "options": {"linkedTableId": "tblO"}}
        ]},
        {"id": "tblO", "name": "Owners", "fields": [
            {"id": "o1", "name": "Name", "type": "singleLineText"}
        ]}
    ] }"#;

    #[test]
    fn describe_object_maps_field_types_and_resolves_links() {
        let c = AirtableConnector::new("at", "base", move |_p| {
            Ok(serde_json::from_str(TYPED_TABLES).unwrap())
        });
        let fields = c.describe_object("Projects").unwrap();
        let by = |n: &str| fields.iter().find(|f| f.name == n).unwrap();
        assert_eq!(by("Budget").ty, FieldType::Money);
        assert_eq!(by("Due").ty, FieldType::Date);
        assert_eq!(by("Active").ty, FieldType::Bool);
        assert_eq!(by("Stage").ty, FieldType::Enum);
        assert_eq!(by("Stage").enum_values, vec!["Open", "Closed"]);
        // record link → ref, with the linkedTableId resolved back to the table name
        assert_eq!(by("Owner").ty, FieldType::Ref);
        assert_eq!(by("Owner").ref_target.as_deref(), Some("Owners"));
        assert_eq!(by("Name").ty, FieldType::String);
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
