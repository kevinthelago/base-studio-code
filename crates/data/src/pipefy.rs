//! Read-only Pipefy connector (native first-party, #1197).
//!
//! Pipefy is a BPM platform with a single GraphQL endpoint. The transport is injected as a
//! closure (query → parsed JSON) so tests replay fixtures with no network; production captures
//! the token in the closure — the connector never stores or logs it (#782 / #1194).
//!
//! - **Data:** pipes → objects, start-form fields → columns, cards → rows.
//! - **Behavior:** a pipe's **phases** are its workflow stages, captured as [`BusinessProcess`]
//!   steps — Pipefy is process-first, so this is its core behavior.

use serde_json::Value;

use crate::behavior::{BusinessProcess, PlatformScan};
use crate::connector::{Connector, RowSet, SourceObject};
use crate::{DataError, Result};

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// Read-only Pipefy connector.
pub struct PipefyConnector {
    name: String,
    fetch: FetchFn,
}

impl PipefyConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        PipefyConnector { name: name.into(), fetch: Box::new(fetch) }
    }

    fn query(&self, gql: &str) -> Result<Value> {
        (self.fetch)(gql)
    }

    /// All pipes with their phases + start-form fields.
    fn pipes(&self) -> Result<Vec<Value>> {
        let body = self
            .query("query { pipes { id name phases { name } start_form_fields { label } } }")?;
        Ok(body["data"]["pipes"].as_array().cloned().unwrap_or_default())
    }

    fn pipe_by_name(&self, name: &str) -> Result<Value> {
        self.pipes()?
            .into_iter()
            .find(|p| p["name"].as_str() == Some(name))
            .ok_or_else(|| DataError::Schema(format!("pipefy: pipe '{name}' not found")))
    }
}

/// Start-form field labels of a pipe (its source-side columns).
fn field_labels(pipe: &Value) -> Vec<String> {
    pipe["start_form_fields"]
        .as_array()
        .map(|fs| fs.iter().filter_map(|f| f["label"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

impl Connector for PipefyConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        Ok(self
            .pipes()?
            .iter()
            .filter_map(|p| {
                let name = p["name"].as_str()?.to_string();
                Some(SourceObject { name, columns: field_labels(p) })
            })
            .collect())
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let pipe = self.pipe_by_name(object)?;
        let id = pipe["id"].as_str().map(str::to_string).or_else(|| pipe["id"].as_i64().map(|n| n.to_string()))
            .ok_or_else(|| DataError::Schema(format!("pipefy: pipe '{object}' missing id")))?;
        let labels = field_labels(&pipe);
        let mut columns = vec!["title".to_string()];
        columns.extend(labels.iter().cloned());

        let body = self.query(&format!(
            "query {{ pipe(id: {id}) {{ cards(first: 50) {{ edges {{ node {{ title fields {{ name value }} }} }} }} }} }}"
        ))?;
        let edges = body["data"]["pipe"]["cards"]["edges"].as_array().cloned().unwrap_or_default();

        let rows = edges
            .iter()
            .map(|e| {
                let node = &e["node"];
                let mut row = vec![node["title"].as_str().unwrap_or("").to_string()];
                let fields = node["fields"].as_array().cloned().unwrap_or_default();
                for label in &labels {
                    let val = fields
                        .iter()
                        .find(|f| f["name"].as_str() == Some(label.as_str()))
                        .and_then(|f| f["value"].as_str())
                        .unwrap_or("")
                        .to_string();
                    row.push(val);
                }
                row
            })
            .collect();

        Ok(RowSet { columns, rows })
    }

    /// Each pipe's phases → a business process (its workflow stages).
    fn scan_platform(&self) -> Result<PlatformScan> {
        let processes = self
            .pipes()?
            .iter()
            .filter_map(|p| {
                let name = p["name"].as_str()?.to_string();
                let steps: Vec<String> = p["phases"]
                    .as_array()
                    .map(|ph| ph.iter().filter_map(|x| x["name"].as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                if steps.is_empty() {
                    return None;
                }
                Some(BusinessProcess {
                    source: self.name.clone(),
                    name: name.clone(),
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

    const PIPES: &str = r#"{ "data": { "pipes": [
        {"id": "301", "name": "Onboarding",
         "phases": [{"name": "Requested"}, {"name": "In Review"}, {"name": "Done"}],
         "start_form_fields": [{"label": "Employee"}, {"label": "Department"}]}
    ] } }"#;

    const CARDS: &str = r#"{ "data": { "pipe": { "cards": { "edges": [
        {"node": {"title": "Hire Ada", "fields": [
            {"name": "Employee", "value": "Ada Lovelace"},
            {"name": "Department", "value": "Engineering"}
        ]}},
        {"node": {"title": "Hire Grace", "fields": [
            {"name": "Employee", "value": "Grace Hopper"}
        ]}}
    ] } } } }"#;

    fn fixture_connector() -> PipefyConnector {
        PipefyConnector::new("acme-pipefy", move |gql| {
            let body = if gql.contains("cards") { CARDS } else { PIPES };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_pipes_with_field_labels() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "Onboarding");
        assert_eq!(objs[0].columns, vec!["Employee", "Department"]);
    }

    #[test]
    fn read_maps_cards_to_rows() {
        let c = fixture_connector();
        let rs = c.read("Onboarding").unwrap();
        assert_eq!(rs.columns, vec!["title", "Employee", "Department"]);
        assert_eq!(rs.rows[0], vec!["Hire Ada", "Ada Lovelace", "Engineering"]);
        // Missing Department on the second card → empty cell.
        assert_eq!(rs.rows[1], vec!["Hire Grace", "Grace Hopper", ""]);
    }

    #[test]
    fn scan_captures_phases_as_a_business_process() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.business_processes.len(), 1);
        let p = &scan.business_processes[0];
        assert_eq!(p.name, "Onboarding");
        assert_eq!(p.steps, vec!["Requested", "In Review", "Done"]);
        assert_eq!(p.source, "acme-pipefy");
    }
}
