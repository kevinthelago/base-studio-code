//! Read-only Xero connector (native first-party, #1197).
//!
//! Xero's accounting REST API. Transport injected as a closure (path → parsed JSON); the OAuth
//! token + tenant id live only in the closure (never stored/logged, #782 / #1194).
//!
//! - **Data:** standard resources (Contacts, Invoices, Accounts, …) → objects, sampled columns
//!   + rows. Each Xero response wraps its records under the resource name (`{ "Invoices": [..] }`).
//! - **Behavior:** none generically — Xero exposes no automation read API (data-only).

use serde_json::Value;

use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

const STANDARD_RESOURCES: &[&str] = &["Contacts", "Invoices", "Accounts", "Payments", "Items"];

/// Read-only Xero connector.
pub struct XeroConnector {
    name: String,
    resources: Vec<String>,
    fetch: FetchFn,
}

impl XeroConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self::with_resources(name, STANDARD_RESOURCES.iter().map(|s| s.to_string()).collect(), fetch)
    }

    pub fn with_resources(
        name: impl Into<String>,
        resources: Vec<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        XeroConnector { name: name.into(), resources, fetch: Box::new(fetch) }
    }

    /// Records for a resource (Xero wraps them under the resource name).
    fn records(&self, resource: &str) -> Result<Vec<Value>> {
        Ok((self.fetch)(resource)?[resource].as_array().cloned().unwrap_or_default())
    }
}

impl Connector for XeroConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for r in &self.resources {
            let columns = self.records(r)?.first().map(sorted_record_columns).unwrap_or_default();
            out.push(SourceObject { name: r.clone(), columns });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let records = self.records(object)?;
        let columns = records.first().map(sorted_record_columns).unwrap_or_default();
        let rows = records
            .iter()
            .map(|r| columns.iter().map(|c| cell_to_string(&r[c])).collect())
            .collect();
        Ok(RowSet { columns, rows })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INVOICES: &str = r#"{ "Invoices": [
        {"InvoiceID": "abc", "Total": 500.0, "Status": "AUTHORISED"},
        {"InvoiceID": "def", "Total": 0,     "Status": "DRAFT"}
    ] }"#;

    fn fixture_connector() -> XeroConnector {
        XeroConnector::with_resources("acme-xero", vec!["Invoices".to_string()], move |_p| {
            Ok(serde_json::from_str(INVOICES).unwrap())
        })
    }

    #[test]
    fn objects_lists_resources_with_columns() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "Invoices");
        assert_eq!(objs[0].columns, vec!["InvoiceID", "Status", "Total"]);
    }

    #[test]
    fn read_returns_rows() {
        let c = fixture_connector();
        let rs = c.read("Invoices").unwrap();
        assert_eq!(rs.rows.len(), 2);
        let total = rs.columns.iter().position(|c| c == "Total").unwrap();
        assert_eq!(rs.rows[0][total], "500.0");
        assert!(c.scan_platform().unwrap().is_empty());
    }
}
