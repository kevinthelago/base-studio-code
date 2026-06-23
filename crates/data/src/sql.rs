//! Read-only SQL database connector (native first-party, #1197).
//!
//! A generic connector for any `information_schema`-speaking RDBMS — PostgreSQL, MySQL,
//! SQL Server. The transport is injected as a closure (SQL → tabular JSON
//! `{ "columns": [..], "rows": [[..]] }`) so tests replay fixtures with no driver; production
//! captures the connection string in the closure — the connector never stores or logs it
//! (#782 / #1194).
//!
//! - **Data:** base tables → objects, columns via `information_schema.columns`, rows via
//!   `SELECT *`.
//! - **Behavior:** CHECK constraints → [`AutomationKind::Validation`]; triggers →
//!   [`DerivedKind::Code`] derived logic.

use serde_json::Value;

use crate::behavior::{Automation, AutomationKind, DerivedKind, DerivedLogic, PlatformScan};
use crate::connector::{Connector, RowSet, SourceObject};
use crate::Result;

/// A SQL → tabular-JSON closure. Owns the connection credentials; the connector never sees them.
type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// Read-only SQL connector, scoped to one schema.
pub struct SqlConnector {
    name: String,
    schema: String,
    fetch: FetchFn,
}

impl SqlConnector {
    /// Build a connector scoped to a schema (e.g. `public` for Postgres).
    pub fn new(
        name: impl Into<String>,
        schema: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        SqlConnector { name: name.into(), schema: schema.into(), fetch: Box::new(fetch) }
    }

    fn query(&self, sql: &str) -> Result<Value> {
        (self.fetch)(sql)
    }
}

/// A tabular `{ "columns": [..], "rows": [[..]] }` response, with column lookups.
struct Table {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

impl Table {
    fn from(v: &Value) -> Table {
        let columns = v["columns"]
            .as_array()
            .map(|a| a.iter().filter_map(|c| c.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let rows = v["rows"]
            .as_array()
            .map(|a| a.iter().map(|r| r.as_array().cloned().unwrap_or_default()).collect())
            .unwrap_or_default();
        Table { columns, rows }
    }

    fn index(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|c| c == name)
    }

    /// First column's cells as strings — for single-column lists (table/column names).
    fn first_col(&self) -> Vec<String> {
        self.rows.iter().filter_map(|r| r.first().map(cell_to_string)).collect()
    }

    /// Cell `(row, column-name)` as a string, empty if absent.
    fn cell(&self, row: &[Value], col: &str) -> String {
        self.index(col).and_then(|i| row.get(i)).map(cell_to_string).unwrap_or_default()
    }
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

impl Connector for SqlConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let tables = Table::from(&self.query(&format!(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = '{}' AND table_type = 'BASE TABLE'",
            self.schema
        ))?);
        let mut out = Vec::new();
        for name in tables.first_col() {
            let cols = Table::from(&self.query(&format!(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = '{}' AND table_name = '{}' ORDER BY ordinal_position",
                self.schema, name
            ))?);
            out.push(SourceObject { name, columns: cols.first_col() });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let t = Table::from(&self.query(&format!("SELECT * FROM {object} LIMIT 200"))?);
        let rows = t.rows.iter().map(|r| r.iter().map(cell_to_string).collect()).collect();
        Ok(RowSet { columns: t.columns, rows })
    }

    /// CHECK constraints → validation automations; triggers → derived (code) logic.
    fn scan_platform(&self) -> Result<PlatformScan> {
        // CHECK constraints joined to their table.
        let checks = Table::from(&self.query(
            "SELECT constraint_name, table_name, check_clause FROM information_schema.check_constraints",
        )?);
        let automations = checks
            .rows
            .iter()
            .filter_map(|r| {
                let name = checks.cell(r, "constraint_name");
                if name.is_empty() {
                    return None;
                }
                Some(Automation {
                    source: self.name.clone(),
                    kind: AutomationKind::Validation,
                    name,
                    object: checks.cell(r, "table_name"),
                    active: true,
                    trigger: "onWrite".to_string(),
                    condition: checks.cell(r, "check_clause"),
                    actions: vec![],
                })
            })
            .collect();

        // Triggers → imperative derived logic.
        let triggers = Table::from(&self.query(
            "SELECT trigger_name, event_object_table, action_statement FROM information_schema.triggers",
        )?);
        let derived = triggers
            .rows
            .iter()
            .filter_map(|r| {
                let name = triggers.cell(r, "trigger_name");
                if name.is_empty() {
                    return None;
                }
                Some(DerivedLogic {
                    source: self.name.clone(),
                    kind: DerivedKind::Code,
                    name,
                    object: Some(triggers.cell(r, "event_object_table")),
                    expression: triggers.cell(r, "action_statement"),
                })
            })
            .collect();

        Ok(PlatformScan { automations, derived_logic: derived, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLES: &str = r#"{ "columns": ["table_name"], "rows": [["customers"], ["orders"]] }"#;
    const CUSTOMER_COLS: &str =
        r#"{ "columns": ["column_name"], "rows": [["id"], ["name"], ["email"]] }"#;
    const CUSTOMER_ROWS: &str = r#"{ "columns": ["id", "name", "email"],
        "rows": [[1, "Acme", "a@acme.com"], [2, "Globex", null]] }"#;
    const CHECKS: &str = r#"{ "columns": ["constraint_name", "table_name", "check_clause"],
        "rows": [["orders_amount_positive", "orders", "amount > 0"]] }"#;
    const TRIGGERS: &str = r#"{ "columns": ["trigger_name", "event_object_table", "action_statement"],
        "rows": [["audit_orders", "orders", "EXECUTE FUNCTION log_change()"]] }"#;

    fn fixture_connector() -> SqlConnector {
        SqlConnector::new("warehouse", "public", move |sql| {
            let body = if sql.contains("check_constraints") {
                CHECKS
            } else if sql.contains("information_schema.triggers") {
                TRIGGERS
            } else if sql.contains("information_schema.tables") {
                TABLES
            } else if sql.contains("information_schema.columns") {
                CUSTOMER_COLS
            } else {
                CUSTOMER_ROWS
            };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_tables_with_columns() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["customers", "orders"]);
        assert_eq!(objs[0].columns, vec!["id", "name", "email"]);
    }

    #[test]
    fn read_returns_rows_with_nulls_as_empty() {
        let c = fixture_connector();
        let rs = c.read("customers").unwrap();
        assert_eq!(rs.columns, vec!["id", "name", "email"]);
        assert_eq!(rs.rows[0], vec!["1", "Acme", "a@acme.com"]);
        assert_eq!(rs.rows[1], vec!["2", "Globex", ""]);
    }

    #[test]
    fn scan_captures_checks_and_triggers() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();

        assert_eq!(scan.automations.len(), 1);
        let a = &scan.automations[0];
        assert_eq!(a.kind, AutomationKind::Validation);
        assert_eq!(a.name, "orders_amount_positive");
        assert_eq!(a.object, "orders");
        assert_eq!(a.condition, "amount > 0");

        assert_eq!(scan.derived_logic.len(), 1);
        let d = &scan.derived_logic[0];
        assert_eq!(d.kind, DerivedKind::Code);
        assert_eq!(d.name, "audit_orders");
        assert_eq!(d.object.as_deref(), Some("orders"));
        assert!(d.expression.contains("log_change"));
    }
}
