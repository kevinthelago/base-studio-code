//! Read-only Jira connector (native first-party, #1197).
//!
//! Jira Cloud's REST API. Transport injected as a closure (path → parsed JSON); the basic/OAuth
//! auth lives only in the closure (never stored/logged, #782 / #1194).
//!
//! - **Data:** `project` (the project list) and `issue` (a JQL search) → objects, sampled
//!   columns + rows. Issue records keep the nested `fields` block as JSON for preview.
//! - **Behavior:** none generically — Jira automation rules live behind a separate product API
//!   (data-only).

use serde_json::Value;

use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// Read-only Jira connector.
pub struct JiraConnector {
    name: String,
    fetch: FetchFn,
}

impl JiraConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        JiraConnector { name: name.into(), fetch: Box::new(fetch) }
    }

    /// Records for an object. `project` is a bare array; `issue` is a JQL search wrapping
    /// records under `issues`.
    fn records(&self, object: &str) -> Result<Vec<Value>> {
        match object {
            "issue" => Ok((self.fetch)("search?maxResults=200")?["issues"]
                .as_array()
                .cloned()
                .unwrap_or_default()),
            other => Ok((self.fetch)(other)?.as_array().cloned().unwrap_or_default()),
        }
    }
}

impl Connector for JiraConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for object in ["project", "issue"] {
            let columns = self.records(object)?.first().map(sorted_record_columns).unwrap_or_default();
            out.push(SourceObject { name: object.to_string(), columns });
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

    const PROJECTS: &str = r#"[
        {"id": "10000", "key": "ENG", "name": "Engineering"},
        {"id": "10001", "key": "OPS", "name": "Operations"}
    ]"#;
    const ISSUES: &str = r#"{ "issues": [
        {"id": "1", "key": "ENG-1", "fields": {"summary": "Fix login", "status": {"name": "To Do"}}}
    ] }"#;

    fn fixture_connector() -> JiraConnector {
        JiraConnector::new("acme-jira", move |path| {
            let body = if path.contains("search") { ISSUES } else { PROJECTS };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_project_and_issue() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["project", "issue"]);
        let project = objs.iter().find(|o| o.name == "project").unwrap();
        assert_eq!(project.columns, vec!["id", "key", "name"]);
    }

    #[test]
    fn read_issue_keeps_nested_fields_as_json() {
        let c = fixture_connector();
        let rs = c.read("issue").unwrap();
        assert_eq!(rs.rows.len(), 1);
        let fields = rs.columns.iter().position(|c| c == "fields").unwrap();
        assert!(rs.rows[0][fields].contains("Fix login"));
    }
}
