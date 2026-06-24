//! Read-only Zendesk connector (native first-party, #1197).
//!
//! Zendesk's Support REST API. Transport injected as a closure (path → parsed JSON); the
//! token/basic auth lives only in the closure (never stored/logged, #782 / #1194).
//!
//! - **Data:** standard resources (tickets, users, organizations) → objects, sampled columns
//!   + rows (each `{resource}.json` wraps records under the resource name).
//! - **Behavior:** **triggers** and **automations** → [`AutomationKind::Workflow`].

use serde_json::Value;

use crate::behavior::{Automation, AutomationKind, PlatformScan};
use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

const STANDARD_RESOURCES: &[&str] = &["tickets", "users", "organizations"];

/// Read-only Zendesk connector.
pub struct ZendeskConnector {
    name: String,
    resources: Vec<String>,
    fetch: FetchFn,
}

impl ZendeskConnector {
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
        ZendeskConnector { name: name.into(), resources, fetch: Box::new(fetch) }
    }

    fn get(&self, path: &str) -> Result<Value> {
        (self.fetch)(path)
    }

    /// Records for a resource (Zendesk wraps them under the resource name).
    fn records(&self, resource: &str) -> Result<Vec<Value>> {
        Ok(self.get(&format!("{resource}.json"))?[resource].as_array().cloned().unwrap_or_default())
    }

    /// Map a trigger/automation record to a workflow automation.
    fn rule_to_automation(&self, r: &Value) -> Option<Automation> {
        let name = r["title"].as_str()?.to_string();
        Some(Automation {
            source: self.name.clone(),
            kind: AutomationKind::Workflow,
            name,
            object: "ticket".to_string(),
            active: r["active"].as_bool().unwrap_or(false),
            trigger: "ticket".to_string(),
            condition: String::new(),
            actions: r["actions"]
                .as_array()
                .map(|a| a.iter().filter_map(|x| x["field"].as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        })
    }
}

impl Connector for ZendeskConnector {
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

    /// Capture triggers + automations as workflow automations.
    fn scan_platform(&self) -> Result<PlatformScan> {
        let mut automations = Vec::new();
        for endpoint in ["triggers", "automations"] {
            let rules = self.get(&format!("{endpoint}.json"))?[endpoint].as_array().cloned().unwrap_or_default();
            automations.extend(rules.iter().filter_map(|r| self.rule_to_automation(r)));
        }
        Ok(PlatformScan { automations, ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICKETS: &str = r#"{ "tickets": [
        {"id": 1, "subject": "Email down", "status": "open"},
        {"id": 2, "subject": "VPN slow",   "status": "pending"}
    ] }"#;
    const TRIGGERS: &str = r#"{ "triggers": [
        {"title": "Notify on urgent", "active": true, "actions": [{"field": "priority"}]}
    ] }"#;
    const AUTOMATIONS: &str = r#"{ "automations": [
        {"title": "Close stale", "active": false, "actions": [{"field": "status"}]}
    ] }"#;

    fn fixture_connector() -> ZendeskConnector {
        ZendeskConnector::with_resources("acme-zd", vec!["tickets".to_string()], move |path| {
            let body = if path.contains("triggers") {
                TRIGGERS
            } else if path.contains("automations") {
                AUTOMATIONS
            } else {
                TICKETS
            };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_and_read() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "tickets");
        assert_eq!(objs[0].columns, vec!["id", "status", "subject"]);
        assert_eq!(c.read("tickets").unwrap().rows.len(), 2);
    }

    #[test]
    fn scan_captures_triggers_and_automations() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.automations.len(), 2);
        assert!(scan.automations.iter().all(|a| a.kind == AutomationKind::Workflow));
        let trig = scan.automations.iter().find(|a| a.name == "Notify on urgent").unwrap();
        assert!(trig.active);
        assert_eq!(trig.actions, vec!["priority"]);
        assert!(scan.automations.iter().any(|a| a.name == "Close stale" && !a.active));
    }
}
