//! Read-only Zoho CRM connector (native first-party, #1197).
//!
//! Zoho CRM's REST API. The transport is injected as a closure (path → parsed JSON) so tests
//! replay fixtures with no network; production captures the OAuth token in the closure — the
//! connector never stores or logs it (#782 / #1194).
//!
//! - **Data:** modules → objects, fields → columns, records → rows.
//! - **Behavior:** **workflow rules** → [`AutomationKind::Workflow`] automations.

use serde_json::Value;

use crate::behavior::{Automation, AutomationKind, PlatformScan};
use crate::connector::{Connector, RowSet, SourceObject};
use crate::{DataError, Result};

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// Read-only Zoho CRM connector.
pub struct ZohoConnector {
    name: String,
    fetch: FetchFn,
}

impl ZohoConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        ZohoConnector { name: name.into(), fetch: Box::new(fetch) }
    }

    fn get(&self, path: &str) -> Result<Value> {
        (self.fetch)(path)
    }

    /// API names of the org's modules.
    fn modules(&self) -> Result<Vec<String>> {
        Ok(self.get("settings/modules")?["modules"]
            .as_array()
            .map(|a| a.iter().filter_map(|m| m["api_name"].as_str().map(str::to_string)).collect())
            .unwrap_or_default())
    }

    /// Field API names for a module.
    fn field_names(&self, module: &str) -> Result<Vec<String>> {
        Ok(self.get(&format!("settings/fields?module={module}"))?["fields"]
            .as_array()
            .map(|a| a.iter().filter_map(|f| f["api_name"].as_str().map(str::to_string)).collect())
            .unwrap_or_default())
    }
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

impl Connector for ZohoConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for m in self.modules()? {
            let columns = self.field_names(&m)?;
            out.push(SourceObject { name: m, columns });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let columns = self.field_names(object)?;
        let body = self.get(object)?;
        let records = body["data"]
            .as_array()
            .cloned()
            .ok_or_else(|| DataError::Schema(format!("zoho: {object} response missing 'data'")))?;
        let rows = records
            .iter()
            .map(|r| columns.iter().map(|c| cell_to_string(&r[c])).collect())
            .collect();
        Ok(RowSet { columns, rows })
    }

    /// Capture Zoho workflow rules.
    fn scan_platform(&self) -> Result<PlatformScan> {
        let automations = self.get("settings/automation/workflow_rules")?["workflow_rules"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|w| {
                let name = w["name"].as_str()?.to_string();
                Some(Automation {
                    source: self.name.clone(),
                    kind: AutomationKind::Workflow,
                    name,
                    object: w["module"]["api_name"]
                        .as_str()
                        .or_else(|| w["module"].as_str())
                        .unwrap_or("")
                        .to_string(),
                    active: w["active"].as_bool().unwrap_or(false),
                    trigger: w["execution"]["type"].as_str().unwrap_or("").to_string(),
                    condition: String::new(),
                    actions: vec![],
                })
            })
            .collect();
        Ok(PlatformScan { automations, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODULES: &str = r#"{ "modules": [{"api_name": "Leads"}, {"api_name": "Deals"}] }"#;
    const FIELDS: &str = r#"{ "fields": [
        {"api_name": "Last_Name", "field_label": "Last Name"},
        {"api_name": "Company",   "field_label": "Company"}
    ] }"#;
    const RECORDS: &str = r#"{ "data": [
        {"Last_Name": "Lovelace", "Company": "Acme"},
        {"Last_Name": "Hopper",   "Company": "Globex"}
    ] }"#;
    const WORKFLOWS: &str = r#"{ "workflow_rules": [
        {"name": "Assign new lead", "module": {"api_name": "Leads"}, "active": true,
         "execution": {"type": "create"}}
    ] }"#;

    fn fixture_connector() -> ZohoConnector {
        ZohoConnector::new("acme-zoho", move |path| {
            let body = if path.contains("workflow_rules") {
                WORKFLOWS
            } else if path.contains("settings/modules") {
                MODULES
            } else if path.contains("settings/fields") {
                FIELDS
            } else {
                RECORDS
            };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_modules_with_fields() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["Leads", "Deals"]);
        assert_eq!(objs[0].columns, vec!["Last_Name", "Company"]);
    }

    #[test]
    fn read_returns_records() {
        let c = fixture_connector();
        let rs = c.read("Leads").unwrap();
        assert_eq!(rs.columns, vec!["Last_Name", "Company"]);
        assert_eq!(rs.rows[0], vec!["Lovelace", "Acme"]);
    }

    #[test]
    fn scan_captures_workflow_rules() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.automations.len(), 1);
        assert_eq!(scan.automations[0].kind, AutomationKind::Workflow);
        assert_eq!(scan.automations[0].name, "Assign new lead");
        assert_eq!(scan.automations[0].object, "Leads");
        assert!(scan.automations[0].active);
    }
}
