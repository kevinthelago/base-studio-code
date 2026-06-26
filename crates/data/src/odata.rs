//! Read-only OData connector (native first-party, #1197).
//!
//! A generic OData v4 connector — covers **SAP** (Gateway/S4 OData services) and **Microsoft
//! Dynamics 365** (the Web API is OData) for the data layer. The transport is injected as a
//! closure (path → parsed JSON) so tests replay fixtures with no network; production captures
//! the auth (basic / OAuth) in the closure — the connector never stores or logs it (#782 /
//! #1194).
//!
//! - **Data:** entity sets (from the service document) → objects, properties (sampled from a
//!   record) → columns, entities → rows.
//! - **Behavior:** none generically — OData exposes data, not automations, so `scan_platform`
//!   inherits the empty default. Vendor-specific behavior (e.g. a Dynamics process query) is a
//!   separate connector concern.

use serde_json::Value;

use crate::connector::{cell_to_string, union_record_columns, Connector, FetchFn, RowSet, SourceObject};
use crate::{DataError, Result};

/// Drop OData's `@odata.*` control annotations (etag, context, …) from a record's columns,
/// keeping only the entity's own properties.
fn is_data_property(key: &str) -> bool {
    !key.starts_with('@')
}

/// Read-only OData v4 connector.
pub struct ODataConnector {
    name: String,
    fetch: FetchFn,
}

impl ODataConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        ODataConnector { name: name.into(), fetch: Box::new(fetch) }
    }

    fn get(&self, path: &str) -> Result<Value> {
        (self.fetch)(path)
    }

    /// Entity-set names from the service document (`GET /`).
    fn entity_sets(&self) -> Result<Vec<String>> {
        let body = self.get("")?;
        Ok(body["value"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|e| e["kind"].as_str().map(|k| k == "EntitySet").unwrap_or(true))
                    .filter_map(|e| e["name"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }
}

impl Connector for ODataConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for set in self.entity_sets()? {
            let sample = self.get(&format!("{set}?$top=1"))?;
            let columns =
                union_record_columns(sample["value"].as_array().and_then(|a| a.first()), is_data_property);
            out.push(SourceObject { name: set, columns });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let body = self.get(&format!("{object}?$top=200"))?;
        let records = body["value"]
            .as_array()
            .cloned()
            .ok_or_else(|| DataError::Schema(format!("odata: {object} response missing 'value'")))?;
        // Union across all rows (#1620), still dropping `@odata.*` annotations.
        let columns = union_record_columns(&records, is_data_property);
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

    const SERVICE_DOC: &str = r#"{ "value": [
        {"name": "Customers", "kind": "EntitySet", "url": "Customers"},
        {"name": "Orders",    "kind": "EntitySet", "url": "Orders"}
    ] }"#;

    const CUSTOMERS: &str = r#"{ "@odata.context": "$metadata#Customers", "value": [
        {"@odata.etag": "W/\"1\"", "CustomerID": "ACME", "CompanyName": "Acme Co",   "Country": "US"},
        {"@odata.etag": "W/\"2\"", "CustomerID": "GLOB", "CompanyName": "Globex Inc", "Country": null}
    ] }"#;

    fn fixture_connector() -> ODataConnector {
        ODataConnector::new("sap-svc", move |path| {
            let body = if path.is_empty() { SERVICE_DOC } else { CUSTOMERS };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_entity_sets_with_columns_minus_annotations() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["Customers", "Orders"]);
        // @odata.etag is dropped; remaining properties are sorted.
        assert_eq!(objs[0].columns, vec!["CompanyName", "Country", "CustomerID"]);
    }

    #[test]
    fn read_returns_rows_without_annotations() {
        let c = fixture_connector();
        let rs = c.read("Customers").unwrap();
        assert_eq!(rs.columns, vec!["CompanyName", "Country", "CustomerID"]);
        assert_eq!(rs.rows.len(), 2);
        let country = rs.columns.iter().position(|c| c == "Country").unwrap();
        assert_eq!(rs.rows[1][country], ""); // null → empty
    }

    #[test]
    fn scan_is_empty_data_only_connector() {
        let c = fixture_connector();
        // OData exposes no automations generically — the trait's empty default applies.
        assert!(c.scan_platform().unwrap().is_empty());
    }
}
