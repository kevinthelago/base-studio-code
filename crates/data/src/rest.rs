//! Read-only generic REST / OpenAPI connector (native first-party, #1197).
//!
//! The catch-all for any JSON REST API without a dedicated connector. The caller declares a set
//! of [`RestResource`]s (a name, a path, and where the record array lives in the response); the
//! connector reads each one. Transport injected as a closure (path → parsed JSON); auth lives
//! only in the closure (never stored/logged, #782 / #1194).
//!
//! - **Data:** each declared resource → an object, sampled columns + rows.
//! - **Behavior:** none — a generic API exposes no machine-readable automation model
//!   (data-only). A dedicated connector should be written when a system's behavior matters.

use serde_json::Value;

use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::{DataError, Result};

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// A configured REST resource: its object name, the path to fetch, and where its records live.
#[derive(Debug, Clone)]
pub struct RestResource {
    /// Object name exposed to the platform.
    pub name: String,
    /// Request path/descriptor handed to the fetch closure.
    pub path: String,
    /// Where the record array lives in the response: a dot-separated path (e.g. `data`, or
    /// `_embedded.leads` for a nested envelope), or `None` if the body *is* the array.
    pub array_key: Option<String>,
}

impl RestResource {
    pub fn new(
        name: impl Into<String>,
        path: impl Into<String>,
        array_key: Option<&str>,
    ) -> Self {
        RestResource {
            name: name.into(),
            path: path.into(),
            array_key: array_key.map(str::to_string),
        }
    }
}

/// Read-only generic REST connector.
pub struct RestConnector {
    name: String,
    resources: Vec<RestResource>,
    fetch: FetchFn,
}

impl RestConnector {
    pub fn new(
        name: impl Into<String>,
        resources: Vec<RestResource>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        RestConnector { name: name.into(), resources, fetch: Box::new(fetch) }
    }

    fn resource(&self, name: &str) -> Result<&RestResource> {
        self.resources
            .iter()
            .find(|r| r.name == name)
            .ok_or_else(|| DataError::Schema(format!("rest: resource '{name}' not configured")))
    }

    fn records(&self, res: &RestResource) -> Result<Vec<Value>> {
        let body = (self.fetch)(&res.path)?;
        let arr = match &res.array_key {
            // Walk a dot-separated path so nested envelopes (`_embedded.leads`, `d.results`) resolve.
            Some(k) => {
                let mut cur = &body;
                for seg in k.split('.') {
                    cur = &cur[seg];
                }
                cur.as_array().cloned()
            }
            None => body.as_array().cloned(),
        };
        Ok(arr.unwrap_or_default())
    }
}

impl Connector for RestConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for res in &self.resources {
            let columns = self.records(res)?.first().map(sorted_record_columns).unwrap_or_default();
            out.push(SourceObject { name: res.name.clone(), columns });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let res = self.resource(object)?;
        let records = self.records(res)?;
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

    const WRAPPED: &str = r#"{ "results": [
        {"id": 1, "name": "Alpha"}, {"id": 2, "name": "Beta"}
    ] }"#;
    const BARE: &str = r#"[ {"sku": "A1", "qty": 5}, {"sku": "B2", "qty": 0} ]"#;

    fn fixture_connector() -> RestConnector {
        let resources = vec![
            RestResource::new("widgets", "api/widgets", Some("results")),
            RestResource::new("stock", "api/stock", None),
        ];
        RestConnector::new("acme-rest", resources, move |path| {
            let body = if path.contains("stock") { BARE } else { WRAPPED };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_covers_each_configured_resource() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["widgets", "stock"]);
        assert_eq!(objs[0].columns, vec!["id", "name"]);
    }

    #[test]
    fn read_handles_wrapped_and_bare_arrays() {
        let c = fixture_connector();
        let wrapped = c.read("widgets").unwrap();
        assert_eq!(wrapped.rows.len(), 2);
        // `stock` is a bare top-level array (array_key = None).
        let bare = c.read("stock").unwrap();
        assert_eq!(bare.columns, vec!["qty", "sku"]);
        assert_eq!(bare.rows.len(), 2);
    }

    #[test]
    fn unknown_resource_errors() {
        assert!(fixture_connector().read("nope").is_err());
    }

    #[test]
    fn nested_array_key_resolves_a_dotted_path() {
        let resources = vec![RestResource::new("leads", "leads", Some("_embedded.leads"))];
        let c = RestConnector::new("nested", resources, move |_p| {
            Ok(serde_json::json!({ "_embedded": { "leads": [{"id": 1, "name": "Acme"}] } }))
        });
        let rs = c.read("leads").unwrap();
        assert_eq!(rs.rows.len(), 1);
        assert_eq!(rs.columns, vec!["id", "name"]);
    }
}
