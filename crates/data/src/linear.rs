//! Read-only Linear connector (native first-party, #1197).
//!
//! Linear has a single GraphQL endpoint. The transport is injected as a closure (query → parsed
//! JSON) so tests replay fixtures with no network; production captures the API key in the
//! closure — the connector never stores or logs it (#782 / #1194).
//!
//! - **Data:** `issue` and `project` → objects (GraphQL `nodes`), columns + rows.
//! - **Behavior:** a team's **workflow states** → [`BusinessProcess`] steps (the issue lifecycle).

use serde_json::Value;

use crate::behavior::{BusinessProcess, PlatformScan};
use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// Read-only Linear connector.
pub struct LinearConnector {
    name: String,
    fetch: FetchFn,
}

impl LinearConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        LinearConnector { name: name.into(), fetch: Box::new(fetch) }
    }

    fn query(&self, gql: &str) -> Result<Value> {
        (self.fetch)(gql)
    }

    /// The `nodes` array for an object's query.
    fn records(&self, object: &str) -> Result<Vec<Value>> {
        let (gql, key) = match object {
            "project" => ("query { projects(first: 50) { nodes { id name state } } }", "projects"),
            _ => ("query { issues(first: 50) { nodes { identifier title priority } } }", "issues"),
        };
        Ok(self.query(gql)?["data"][key]["nodes"].as_array().cloned().unwrap_or_default())
    }
}

impl Connector for LinearConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for object in ["issue", "project"] {
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

    /// Each team's workflow states → a business process (the issue lifecycle).
    fn scan_platform(&self) -> Result<PlatformScan> {
        let body = self.query("query { teams { nodes { name states { nodes { name } } } } }")?;
        let teams = body["data"]["teams"]["nodes"].as_array().cloned().unwrap_or_default();
        let processes = teams
            .iter()
            .filter_map(|t| {
                let name = t["name"].as_str()?.to_string();
                let steps: Vec<String> = t["states"]["nodes"]
                    .as_array()
                    .map(|ns| ns.iter().filter_map(|s| s["name"].as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                if steps.is_empty() {
                    return None;
                }
                Some(BusinessProcess {
                    source: self.name.clone(),
                    name: format!("{name} workflow"),
                    object: name,
                    active: true,
                    steps,
                })
            })
            .collect();
        Ok(PlatformScan { business_processes: processes, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ISSUES: &str = r#"{ "data": { "issues": { "nodes": [
        {"identifier": "ENG-1", "title": "Fix login", "priority": 1},
        {"identifier": "ENG-2", "title": "Add export", "priority": 2}
    ] } } }"#;
    const PROJECTS: &str = r#"{ "data": { "projects": { "nodes": [
        {"id": "p1", "name": "Q3 Launch", "state": "started"}
    ] } } }"#;
    const TEAMS: &str = r#"{ "data": { "teams": { "nodes": [
        {"name": "Engineering", "states": { "nodes": [
            {"name": "Backlog"}, {"name": "In Progress"}, {"name": "Done"}
        ] } }
    ] } } }"#;

    fn fixture_connector() -> LinearConnector {
        LinearConnector::new("acme-linear", move |gql| {
            let body = if gql.contains("teams") {
                TEAMS
            } else if gql.contains("projects") {
                PROJECTS
            } else {
                ISSUES
            };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_and_read() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["issue", "project"]);
        let rs = c.read("issue").unwrap();
        assert_eq!(rs.columns, vec!["identifier", "priority", "title"]);
        assert_eq!(rs.rows.len(), 2);
    }

    #[test]
    fn scan_captures_workflow_states() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.business_processes.len(), 1);
        let p = &scan.business_processes[0];
        assert_eq!(p.object, "Engineering");
        assert_eq!(p.steps, vec!["Backlog", "In Progress", "Done"]);
    }
}
