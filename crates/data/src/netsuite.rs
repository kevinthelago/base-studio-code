//! Read-only NetSuite connector (native first-party, #1197).
//!
//! NetSuite's SuiteQL REST endpoint (`POST /services/rest/query/v1/suiteql`). The transport is
//! injected as a closure (SuiteQL → parsed JSON `{ "items": [..] }`) so tests replay fixtures
//! with no network; production captures the OAuth/TBA auth in the closure — the connector never
//! stores or logs it (#782 / #1194).
//!
//! - **Data:** standard record types (customer, salesorder, invoice, item, vendor) → objects,
//!   sampled columns + rows via SuiteQL.
//! - **Behavior:** none generically — SuiteFlow workflows aren't queryable through SuiteQL, so
//!   `scan_platform` inherits the empty default (data-only, documented).

use serde_json::Value;

use crate::connector::{Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

const STANDARD_RECORDS: &[&str] = &["customer", "salesorder", "invoice", "item", "vendor"];

/// Read-only NetSuite connector.
pub struct NetSuiteConnector {
    name: String,
    records: Vec<String>,
    fetch: FetchFn,
}

impl NetSuiteConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self::with_records(name, STANDARD_RECORDS.iter().map(|s| s.to_string()).collect(), fetch)
    }

    pub fn with_records(
        name: impl Into<String>,
        records: Vec<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        NetSuiteConnector { name: name.into(), records, fetch: Box::new(fetch) }
    }

    fn items(&self, suiteql: &str) -> Result<Vec<Value>> {
        Ok((self.fetch)(suiteql)?["items"].as_array().cloned().unwrap_or_default())
    }
}

fn record_columns(rec: &Value) -> Vec<String> {
    let mut cols: Vec<String> =
        rec.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    cols.sort();
    cols
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

impl Connector for NetSuiteConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for r in &self.records {
            let sample = self.items(&format!("SELECT * FROM {r} FETCH FIRST 1 ROWS ONLY"))?;
            let columns = sample.first().map(record_columns).unwrap_or_default();
            out.push(SourceObject { name: r.clone(), columns });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let items = self.items(&format!("SELECT * FROM {object} FETCH FIRST 200 ROWS ONLY"))?;
        let columns = items.first().map(record_columns).unwrap_or_default();
        let rows = items
            .iter()
            .map(|r| columns.iter().map(|c| cell_to_string(&r[c])).collect())
            .collect();
        Ok(RowSet { columns, rows })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CUSTOMERS: &str = r#"{ "items": [
        {"id": "1", "entityid": "Acme",   "balance": "1200.50"},
        {"id": "2", "entityid": "Globex", "balance": "0"}
    ] }"#;

    fn fixture_connector() -> NetSuiteConnector {
        NetSuiteConnector::with_records("acme-ns", vec!["customer".to_string()], move |_q| {
            Ok(serde_json::from_str(CUSTOMERS).unwrap())
        })
    }

    #[test]
    fn objects_lists_records_with_columns() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "customer");
        assert_eq!(objs[0].columns, vec!["balance", "entityid", "id"]);
    }

    #[test]
    fn read_returns_rows() {
        let c = fixture_connector();
        let rs = c.read("customer").unwrap();
        assert_eq!(rs.rows.len(), 2);
        let idx = rs.columns.iter().position(|c| c == "entityid").unwrap();
        assert_eq!(rs.rows[0][idx], "Acme");
    }

    #[test]
    fn scan_is_empty_data_only() {
        // SuiteFlow isn't queryable via SuiteQL — data-only, empty default applies.
        assert!(fixture_connector().scan_platform().unwrap().is_empty());
    }
}
