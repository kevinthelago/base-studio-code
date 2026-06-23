//! Read-only Asana connector (native first-party, #1197).
//!
//! Asana's REST API. Transport injected as a closure (path → parsed JSON); the PAT lives only
//! in the closure (never stored/logged, #782 / #1194).
//!
//! - **Data:** standard resources (projects, tasks, users) → objects, sampled columns + rows
//!   (`{ "data": [..] }`).
//! - **Behavior:** none generically — Asana Rules aren't enumerable via the read API (data-only).

use serde_json::Value;

use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

const STANDARD_RESOURCES: &[&str] = &["projects", "tasks", "users"];

/// Read-only Asana connector.
pub struct AsanaConnector {
    name: String,
    resources: Vec<String>,
    fetch: FetchFn,
}

impl AsanaConnector {
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
        AsanaConnector { name: name.into(), resources, fetch: Box::new(fetch) }
    }

    fn records(&self, resource: &str) -> Result<Vec<Value>> {
        Ok((self.fetch)(resource)?["data"].as_array().cloned().unwrap_or_default())
    }
}

impl Connector for AsanaConnector {
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

    const TASKS: &str = r#"{ "data": [
        {"gid": "1", "name": "Write spec", "completed": false},
        {"gid": "2", "name": "Ship build", "completed": true}
    ] }"#;

    fn fixture_connector() -> AsanaConnector {
        AsanaConnector::with_resources("acme-asana", vec!["tasks".to_string()], move |_p| {
            Ok(serde_json::from_str(TASKS).unwrap())
        })
    }

    #[test]
    fn objects_and_read() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "tasks");
        assert_eq!(objs[0].columns, vec!["completed", "gid", "name"]);
        let rs = c.read("tasks").unwrap();
        assert_eq!(rs.rows.len(), 2);
        let name = rs.columns.iter().position(|c| c == "name").unwrap();
        assert_eq!(rs.rows[1][name], "Ship build");
    }
}
