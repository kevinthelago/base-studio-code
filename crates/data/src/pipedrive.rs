//! Read-only Pipedrive connector (native first-party, #1197).
//!
//! Pipedrive's CRM REST API. Transport injected as a closure (path → parsed JSON); the API
//! token lives only in the closure (never stored/logged, #782 / #1194).
//!
//! - **Data:** standard resources (deals, persons, organizations, activities) → objects,
//!   sampled columns + rows (`{ "data": [..] }`).
//! - **Behavior:** none generically — Pipedrive's automations aren't enumerable via the read
//!   API (data-only).

use serde_json::Value;

use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

const STANDARD_RESOURCES: &[&str] = &["deals", "persons", "organizations", "activities"];

/// Read-only Pipedrive connector.
pub struct PipedriveConnector {
    name: String,
    resources: Vec<String>,
    fetch: FetchFn,
}

impl PipedriveConnector {
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
        PipedriveConnector { name: name.into(), resources, fetch: Box::new(fetch) }
    }

    fn records(&self, resource: &str) -> Result<Vec<Value>> {
        Ok((self.fetch)(resource)?["data"].as_array().cloned().unwrap_or_default())
    }
}

impl Connector for PipedriveConnector {
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

    const DEALS: &str = r#"{ "data": [
        {"id": 1, "title": "Acme renewal", "value": 12000, "status": "open"},
        {"id": 2, "title": "Globex new",   "value": 5000,  "status": "won"}
    ] }"#;

    fn fixture_connector() -> PipedriveConnector {
        PipedriveConnector::with_resources("acme-pd", vec!["deals".to_string()], move |_p| {
            Ok(serde_json::from_str(DEALS).unwrap())
        })
    }

    #[test]
    fn objects_lists_resources_with_columns() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "deals");
        assert_eq!(objs[0].columns, vec!["id", "status", "title", "value"]);
    }

    #[test]
    fn read_returns_rows() {
        let c = fixture_connector();
        let rs = c.read("deals").unwrap();
        assert_eq!(rs.rows.len(), 2);
        let title = rs.columns.iter().position(|c| c == "title").unwrap();
        assert_eq!(rs.rows[0][title], "Acme renewal");
    }
}
