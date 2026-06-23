//! Read-only ServiceNow connector (native first-party, #1197).
//!
//! ServiceNow's Table API. The transport is injected as a closure (path → parsed JSON) so
//! tests replay fixtures with no network; production captures the basic/OAuth auth in the
//! closure — the connector never stores or logs it (#782 / #1194).
//!
//! - **Data:** standard tables (incident, problem, change_request, …) → objects, sampled
//!   columns + rows.
//! - **Behavior:** **business rules** (`sys_script`) → [`DerivedKind::Code`] derived logic;
//!   **Flow Designer flows** (`sys_hub_flow`) → [`AutomationKind::Flow`] automations.

use serde_json::Value;

use crate::behavior::{Automation, AutomationKind, DerivedKind, DerivedLogic, PlatformScan};
use crate::connector::{Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

const STANDARD_TABLES: &[&str] = &["incident", "problem", "change_request", "task", "sc_request"];

/// Read-only ServiceNow connector.
pub struct ServiceNowConnector {
    name: String,
    tables: Vec<String>,
    fetch: FetchFn,
}

impl ServiceNowConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self::with_tables(name, STANDARD_TABLES.iter().map(|s| s.to_string()).collect(), fetch)
    }

    pub fn with_tables(
        name: impl Into<String>,
        tables: Vec<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        ServiceNowConnector { name: name.into(), tables, fetch: Box::new(fetch) }
    }

    fn get(&self, path: &str) -> Result<Value> {
        (self.fetch)(path)
    }

    fn result(&self, path: &str) -> Result<Vec<Value>> {
        Ok(self.get(path)?["result"].as_array().cloned().unwrap_or_default())
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

impl Connector for ServiceNowConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for t in &self.tables {
            let sample = self.result(&format!("table/{t}?sysparm_limit=1"))?;
            let columns = sample.first().map(record_columns).unwrap_or_default();
            out.push(SourceObject { name: t.clone(), columns });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let records = self.result(&format!("table/{object}?sysparm_limit=200"))?;
        let columns = records.first().map(record_columns).unwrap_or_default();
        let rows = records
            .iter()
            .map(|r| columns.iter().map(|c| cell_to_string(&r[c])).collect())
            .collect();
        Ok(RowSet { columns, rows })
    }

    fn scan_platform(&self) -> Result<PlatformScan> {
        // Business rules → imperative derived logic.
        let derived = self
            .result("table/sys_script?sysparm_limit=1000")?
            .iter()
            .filter_map(|r| {
                let name = r["name"].as_str()?.to_string();
                Some(DerivedLogic {
                    source: self.name.clone(),
                    kind: DerivedKind::Code,
                    name,
                    object: r["collection"].as_str().map(str::to_string),
                    expression: r["script"].as_str().unwrap_or("").to_string(),
                })
            })
            .collect();

        // Flow Designer flows → automations.
        let automations = self
            .result("table/sys_hub_flow?sysparm_limit=1000")?
            .iter()
            .filter_map(|r| {
                let name = r["name"].as_str()?.to_string();
                Some(Automation {
                    source: self.name.clone(),
                    kind: AutomationKind::Flow,
                    name,
                    object: String::new(),
                    active: r["active"].as_bool().unwrap_or(false)
                        || r["active"].as_str() == Some("true"),
                    trigger: "flow".to_string(),
                    condition: String::new(),
                    actions: vec![],
                })
            })
            .collect();

        Ok(PlatformScan { automations, derived_logic: derived, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INCIDENTS: &str = r#"{ "result": [
        {"number": "INC001", "short_description": "Email down", "priority": "1"},
        {"number": "INC002", "short_description": "VPN slow",   "priority": "3"}
    ] }"#;
    const RULES: &str = r#"{ "result": [
        {"name": "Set priority", "collection": "incident", "script": "current.priority = 1;"}
    ] }"#;
    const FLOWS: &str = r#"{ "result": [
        {"name": "Auto-assign incident", "active": "true"}
    ] }"#;

    fn fixture_connector() -> ServiceNowConnector {
        ServiceNowConnector::with_tables("acme-snow", vec!["incident".to_string()], move |path| {
            let body = if path.contains("sys_script") {
                RULES
            } else if path.contains("sys_hub_flow") {
                FLOWS
            } else {
                INCIDENTS
            };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_and_read_cover_the_data_layer() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "incident");
        assert_eq!(objs[0].columns, vec!["number", "priority", "short_description"]);
        let rs = c.read("incident").unwrap();
        assert_eq!(rs.rows.len(), 2);
    }

    #[test]
    fn scan_captures_business_rules_and_flows() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.derived_logic.len(), 1);
        assert_eq!(scan.derived_logic[0].kind, DerivedKind::Code);
        assert_eq!(scan.derived_logic[0].object.as_deref(), Some("incident"));
        assert_eq!(scan.automations.len(), 1);
        assert_eq!(scan.automations[0].kind, AutomationKind::Flow);
        assert!(scan.automations[0].active);
    }
}
