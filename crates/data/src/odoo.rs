//! Read-only Odoo connector (native first-party, #1197).
//!
//! Odoo's external API (JSON-RPC `call_kw`). The transport is injected as a closure
//! (descriptor → parsed JSON) so tests replay fixtures with no network; production captures the
//! db/uid/password in the closure — the connector never stores or logs it (#782 / #1194).
//! Descriptors: `fields:{model}` (a `fields_get` map) and `read:{model}` (a `search_read` array).
//!
//! - **Data:** standard models (res.partner, sale.order, …) → objects, fields → columns,
//!   records → rows.
//! - **Behavior:** **Automation Rules** (`base.automation`) → [`AutomationKind::Workflow`].

use serde_json::Value;

use crate::behavior::{Automation, AutomationKind, PlatformScan};
use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

const STANDARD_MODELS: &[&str] =
    &["res.partner", "sale.order", "product.product", "account.move", "crm.lead", "stock.picking"];

/// Read-only Odoo connector.
pub struct OdooConnector {
    name: String,
    models: Vec<String>,
    fetch: FetchFn,
}

impl OdooConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self::with_models(name, STANDARD_MODELS.iter().map(|s| s.to_string()).collect(), fetch)
    }

    pub fn with_models(
        name: impl Into<String>,
        models: Vec<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        OdooConnector { name: name.into(), models, fetch: Box::new(fetch) }
    }

    fn call(&self, descriptor: &str) -> Result<Value> {
        (self.fetch)(descriptor)
    }

    /// Field names of a model (`fields_get` returns a map keyed by field name).
    fn field_names(&self, model: &str) -> Result<Vec<String>> {
        Ok(sorted_record_columns(&self.call(&format!("fields:{model}"))?))
    }

    /// Records of a model (`search_read`).
    fn records(&self, model: &str) -> Result<Vec<Value>> {
        Ok(self.call(&format!("read:{model}"))?.as_array().cloned().unwrap_or_default())
    }
}

impl Connector for OdooConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for m in &self.models {
            out.push(SourceObject { name: m.clone(), columns: self.field_names(m)? });
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

    /// Capture Odoo Automation Rules (`base.automation`).
    fn scan_platform(&self) -> Result<PlatformScan> {
        let automations = self
            .records("base.automation")?
            .iter()
            .filter_map(|r| parse_automation_rule(r, &self.name))
            .collect();
        Ok(PlatformScan { automations, ..Default::default() })
    }
}

fn parse_automation_rule(r: &Value, source: &str) -> Option<Automation> {
    let name = r["name"].as_str()?.to_string();
    // `model_id` is `[id, "display name"]`; `model_name` may also be present.
    let object = r["model_name"]
        .as_str()
        .or_else(|| r["model_id"][1].as_str())
        .unwrap_or("")
        .to_string();
    Some(Automation {
        source: source.to_string(),
        kind: AutomationKind::Workflow,
        name,
        object,
        active: r["active"].as_bool().unwrap_or(false),
        trigger: r["trigger"].as_str().unwrap_or("").to_string(),
        condition: String::new(),
        actions: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARTNER_FIELDS: &str = r#"{ "name": {"type": "char"}, "email": {"type": "char"}, "vat": {"type": "char"} }"#;
    const PARTNERS: &str = r#"[
        {"name": "Acme Co", "email": "a@acme.com", "vat": "US123"},
        {"name": "Globex",  "email": null,         "vat": ""}
    ]"#;
    const AUTOMATIONS: &str = r#"[
        {"name": "Tag hot leads", "model_name": "crm.lead", "model_id": [42, "crm.lead"],
         "trigger": "on_create", "active": true}
    ]"#;

    fn fixture_connector() -> OdooConnector {
        OdooConnector::with_models("acme-odoo", vec!["res.partner".to_string()], move |desc| {
            let body = if desc.contains("base.automation") {
                AUTOMATIONS
            } else if desc.starts_with("fields:") {
                PARTNER_FIELDS
            } else {
                PARTNERS
            };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_uses_fields_get_for_columns() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "res.partner");
        assert_eq!(objs[0].columns, vec!["email", "name", "vat"]);
    }

    #[test]
    fn read_returns_records() {
        let c = fixture_connector();
        let rs = c.read("res.partner").unwrap();
        assert_eq!(rs.rows.len(), 2);
        let email = rs.columns.iter().position(|c| c == "email").unwrap();
        assert_eq!(rs.rows[1][email], ""); // null → empty
    }

    #[test]
    fn scan_captures_automation_rules() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.automations.len(), 1);
        let a = &scan.automations[0];
        assert_eq!(a.kind, AutomationKind::Workflow);
        assert_eq!(a.name, "Tag hot leads");
        assert_eq!(a.object, "crm.lead");
        assert_eq!(a.trigger, "on_create");
        assert!(a.active);
    }
}
