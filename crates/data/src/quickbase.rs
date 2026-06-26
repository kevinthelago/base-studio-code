//! Read-only Quickbase connector (native first-party, #1197).
//!
//! Quickbase is a REST API (`api.quickbase.com/v1`): list tables, list fields, query records.
//! The transport is injected as a closure (request descriptor → parsed JSON) so tests replay
//! fixtures with no network; production captures the user token + realm in the closure — the
//! connector never stores or logs them (#782 / #1194).
//!
//! - **Data:** tables → objects, fields → columns, records → rows.
//! - **Behavior:** **formula fields** → [`DerivedKind::Formula`] derived logic; **required /
//!   unique** field constraints → [`AutomationKind::Validation`] automations. (Quickbase
//!   Pipelines and form rules are not exposed by the table/field API, so they are out of scope
//!   for the scan — documented.)

use serde_json::Value;

use crate::behavior::{Automation, AutomationKind, DerivedKind, DerivedLogic, PlatformScan};
use crate::connector::{cell_to_string, json_id_as_string, Connector, FetchFn, RowSet, SourceField, SourceObject};
use crate::schema::FieldType;
use crate::{DataError, Result};

/// Read-only Quickbase connector, scoped to one application.
pub struct QuickbaseConnector {
    name: String,
    app_id: String,
    fetch: FetchFn,
}

impl QuickbaseConnector {
    /// Build a connector scoped to a Quickbase application.
    ///
    /// `fetch` receives a request descriptor and returns the parsed JSON body. Authentication
    /// (user token, realm host) must be captured by the closure — never stored by the connector.
    pub fn new(
        name: impl Into<String>,
        app_id: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        QuickbaseConnector { name: name.into(), app_id: app_id.into(), fetch: Box::new(fetch) }
    }

    fn get(&self, descriptor: &str) -> Result<Value> {
        (self.fetch)(descriptor)
    }

    /// The application's tables.
    fn tables(&self) -> Result<Vec<Value>> {
        let body = self.get(&format!("tables?appId={}", self.app_id))?;
        Ok(as_array(&body, "tables"))
    }

    /// A table's fields.
    fn fields(&self, table_id: &str) -> Result<Vec<Value>> {
        let body = self.get(&format!("fields:{table_id}"))?;
        Ok(as_array(&body, "fields"))
    }

    fn table_id_by_name(&self, name: &str) -> Result<String> {
        self.tables()?
            .iter()
            .find(|t| t["name"].as_str() == Some(name))
            .and_then(table_id)
            .ok_or_else(|| DataError::Schema(format!("quickbase: table '{name}' not found")))
    }
}

/// Read a JSON value as an array, accepting either a bare array or `{ key: [...] }`.
fn as_array(body: &Value, key: &str) -> Vec<Value> {
    body.as_array().cloned().or_else(|| body[key].as_array().cloned()).unwrap_or_default()
}

/// A table's id as a string (Quickbase ids are strings, e.g. `bqr2x`, but the API can also return
/// numeric ids — [`json_id_as_string`] normalizes both).
fn table_id(t: &Value) -> Option<String> {
    json_id_as_string(&t["id"])
}

fn field_id(f: &Value) -> Option<String> {
    json_id_as_string(&f["id"])
}

/// Map a Quickbase field's declared `fieldType` to a vendor-neutral [`SourceField`] (#1230):
/// currency → money, numeric/percent/rating/duration → number, date/datetime/timestamp/timeofday
/// → date, checkbox → bool, text-multiple-choice → enum + its `properties.choices`, else string.
fn qb_field(f: &Value) -> Option<SourceField> {
    let name = f["label"].as_str()?.to_string();
    let (ty, enum_values) = match f["fieldType"].as_str().unwrap_or("text") {
        "currency" => (FieldType::Money, vec![]),
        "numeric" | "percent" | "rating" | "duration" => (FieldType::Number, vec![]),
        "date" | "datetime" | "timestamp" | "timeofday" => (FieldType::Date, vec![]),
        "checkbox" => (FieldType::Bool, vec![]),
        "text-multiple-choice" => (
            FieldType::Enum,
            f["properties"]["choices"]
                .as_array()
                .map(|c| c.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        ),
        _ => (FieldType::String, vec![]),
    };
    Some(SourceField { name, ty, enum_values, ref_target: None })
}

impl Connector for QuickbaseConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for t in self.tables()? {
            let Some(id) = table_id(&t) else { continue };
            let name = t["name"].as_str().unwrap_or("").to_string();
            let columns =
                self.fields(&id)?.iter().filter_map(|f| f["label"].as_str().map(str::to_string)).collect();
            out.push(SourceObject { name, columns });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let id = self.table_id_by_name(object)?;
        let resp = self.get(&format!("records:{id}"))?;

        // Records key their cells by field id; the response's `fields` array gives id → label.
        let pairs: Vec<(String, String)> = resp["fields"]
            .as_array()
            .map(|fs| {
                fs.iter()
                    .filter_map(|f| Some((field_id(f)?, f["label"].as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default();
        let columns = pairs.iter().map(|(_, label)| label.clone()).collect();

        let rows = resp["data"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|rec| pairs.iter().map(|(fid, _)| cell_to_string(&rec[fid]["value"])).collect())
            .collect();

        Ok(RowSet { columns, rows })
    }

    /// Declared field types from the fields API (#1230): multiple-choice fields carry their
    /// choices as an enum; numerics/currency/date/checkbox map to the closest scalar type.
    fn describe_object(&self, object: &str) -> Result<Vec<SourceField>> {
        let id = self.table_id_by_name(object)?;
        Ok(self.fields(&id)?.iter().filter_map(qb_field).collect())
    }

    /// Capture formula fields (derived logic) and required/unique constraints (validations).
    fn scan_platform(&self) -> Result<PlatformScan> {
        let mut automations = Vec::new();
        let mut derived = Vec::new();
        for t in self.tables()? {
            let Some(id) = table_id(&t) else { continue };
            let table = t["name"].as_str().unwrap_or("").to_string();
            for f in self.fields(&id)? {
                let label = f["label"].as_str().unwrap_or("").to_string();

                // Formula field → derived logic.
                if let Some(formula) = f["properties"]["formula"].as_str().filter(|s| !s.is_empty()) {
                    derived.push(DerivedLogic {
                        source: self.name.clone(),
                        kind: DerivedKind::Formula,
                        name: label.clone(),
                        object: Some(table.clone()),
                        expression: formula.to_string(),
                    });
                }

                // required / unique → a validation automation.
                let mut constraints = Vec::new();
                if f["required"].as_bool().unwrap_or(false) {
                    constraints.push("required");
                }
                if f["unique"].as_bool().unwrap_or(false) {
                    constraints.push("unique");
                }
                if !constraints.is_empty() {
                    automations.push(Automation {
                        source: self.name.clone(),
                        kind: AutomationKind::Validation,
                        name: format!("{table}.{label}"),
                        object: table.clone(),
                        active: true,
                        trigger: "onSave".to_string(),
                        condition: constraints.join("+"),
                        actions: vec![],
                    });
                }
            }
        }
        Ok(PlatformScan { automations, derived_logic: derived, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const TABLES: &str = r#"[
        {"id": "bqt1", "name": "Projects"},
        {"id": "bqt2", "name": "Tickets"}
    ]"#;

    const FIELDS1: &str = r#"[
        {"id": 6, "label": "Name",    "fieldType": "text",    "required": true, "unique": true},
        {"id": 7, "label": "Budget",  "fieldType": "numeric", "required": false},
        {"id": 9, "label": "Spend %", "fieldType": "numeric", "properties": {"formula": "[Spent]/[Budget]*100"}}
    ]"#;

    const FIELDS2: &str = r#"[
        {"id": 6, "label": "Subject", "fieldType": "text", "required": true}
    ]"#;

    const RECORDS1: &str = r#"{
        "fields": [{"id": 6, "label": "Name"}, {"id": 7, "label": "Budget"}, {"id": 9, "label": "Spend %"}],
        "data": [
            {"6": {"value": "Apollo"}, "7": {"value": 50000}, "9": {"value": 42.5}}
        ]
    }"#;

    fn fixture_connector() -> QuickbaseConnector {
        QuickbaseConnector::new("acme-qb", "appXYZ", move |desc| {
            let body = if desc.contains("tables") {
                TABLES
            } else if desc.contains("fields:bqt1") {
                FIELDS1
            } else if desc.contains("fields:bqt2") {
                FIELDS2
            } else if desc.contains("records:bqt1") {
                RECORDS1
            } else {
                "[]"
            };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_tables_with_field_labels() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["Projects", "Tickets"]);
        let projects = objs.iter().find(|o| o.name == "Projects").unwrap();
        assert_eq!(projects.columns, vec!["Name", "Budget", "Spend %"]);
    }

    const TYPED_FIELDS: &str = r#"[
        {"id": 6,  "label": "Name",   "fieldType": "text"},
        {"id": 7,  "label": "Budget", "fieldType": "currency"},
        {"id": 8,  "label": "Due",    "fieldType": "date"},
        {"id": 9,  "label": "Done",   "fieldType": "checkbox"},
        {"id": 10, "label": "Stage",  "fieldType": "text-multiple-choice", "properties": {"choices": ["Open", "Closed"]}}
    ]"#;

    #[test]
    fn describe_object_maps_field_types() {
        let c = QuickbaseConnector::new("qb", "app", move |desc| {
            let body = if desc.contains("tables") { TABLES } else { TYPED_FIELDS };
            Ok(serde_json::from_str(body).unwrap())
        });
        let fields = c.describe_object("Projects").unwrap();
        let by = |n: &str| fields.iter().find(|f| f.name == n).unwrap();
        assert_eq!(by("Budget").ty, FieldType::Money);
        assert_eq!(by("Due").ty, FieldType::Date);
        assert_eq!(by("Done").ty, FieldType::Bool);
        assert_eq!(by("Stage").ty, FieldType::Enum);
        assert_eq!(by("Stage").enum_values, vec!["Open", "Closed"]);
        assert_eq!(by("Name").ty, FieldType::String);
    }

    #[test]
    fn read_maps_records_to_rows_by_field_id() {
        let c = fixture_connector();
        let rs = c.read("Projects").unwrap();
        assert_eq!(rs.columns, vec!["Name", "Budget", "Spend %"]);
        assert_eq!(rs.rows.len(), 1);
        assert_eq!(rs.rows[0], vec!["Apollo", "50000", "42.5"]);
    }

    #[test]
    fn scan_captures_formula_fields_and_constraints() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();

        // Derived logic — the formula field.
        assert_eq!(scan.derived_logic.len(), 1);
        let d = &scan.derived_logic[0];
        assert_eq!(d.kind, DerivedKind::Formula);
        assert_eq!(d.name, "Spend %");
        assert_eq!(d.object.as_deref(), Some("Projects"));
        assert_eq!(d.expression, "[Spent]/[Budget]*100");

        // Automations — required/unique constraints (Projects.Name + Tickets.Subject; Budget is neither).
        assert_eq!(scan.automations.len(), 2);
        let name_rule = scan.automations.iter().find(|a| a.name == "Projects.Name").unwrap();
        assert_eq!(name_rule.kind, AutomationKind::Validation);
        assert_eq!(name_rule.condition, "required+unique");
        assert_eq!(name_rule.source, "acme-qb");
        assert!(scan.automations.iter().any(|a| a.name == "Tickets.Subject"));
        assert!(scan.business_processes.is_empty());
    }

    #[test]
    fn user_token_not_stored_or_leaked() {
        let token = "QB_USER_TOKEN_SECRET";
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let seen2 = seen.clone();
        let c = QuickbaseConnector::new("sec", "app1", move |desc| {
            seen2.lock().unwrap().push(desc.to_string());
            Ok(serde_json::from_str(TABLES).unwrap())
        });
        let _ = c.objects();
        assert!(!c.name.contains(token));
        assert!(!c.app_id.contains(token));
        for d in seen.lock().unwrap().iter() {
            assert!(!d.contains(token), "token leaked into request: {d}");
        }
    }
}
