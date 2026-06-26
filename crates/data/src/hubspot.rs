//! Read-only HubSpot connector (native first-party, #1197).
//!
//! HubSpot's CRM REST API. The transport is injected as a closure (path → parsed JSON) so
//! tests replay fixtures with no network; production captures the private-app / OAuth bearer
//! token in the closure — the connector never stores or logs it (#782 / #1194).
//!
//! - **Data:** CRM object types (contacts, companies, deals, tickets) → objects, their
//!   properties → fields, records → rows.
//! - **Behavior:** automation **workflows** → [`AutomationKind::Workflow`] automations.

use serde_json::Value;

use crate::behavior::{Automation, AutomationKind, PlatformScan};
use crate::connector::{cell_to_string, Connector, FetchFn, RowSet, SourceField, SourceObject};
use crate::schema::FieldType;
use crate::Result;

/// The standard HubSpot CRM object types worth inventorying by default.
const STANDARD_TYPES: &[&str] = &["contacts", "companies", "deals", "tickets"];

/// Read-only HubSpot connector.
pub struct HubSpotConnector {
    name: String,
    types: Vec<String>,
    fetch: FetchFn,
}

impl HubSpotConnector {
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self::with_types(name, STANDARD_TYPES.iter().map(|s| s.to_string()).collect(), fetch)
    }

    pub fn with_types(
        name: impl Into<String>,
        types: Vec<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        HubSpotConnector { name: name.into(), types, fetch: Box::new(fetch) }
    }

    fn get(&self, path: &str) -> Result<Value> {
        (self.fetch)(path)
    }

    /// Property (field) names for a CRM object type.
    fn property_names(&self, ty: &str) -> Result<Vec<String>> {
        let body = self.get(&format!("crm/v3/properties/{ty}"))?;
        Ok(body["results"]
            .as_array()
            .map(|r| r.iter().filter_map(|p| p["name"].as_str().map(str::to_string)).collect())
            .unwrap_or_default())
    }
}

/// Map a HubSpot property's declared `type` to a vendor-neutral [`SourceField`] (#1230):
/// enumeration → enum + its option values, number → number, date/datetime → date, bool → bool,
/// everything else (string, phone, etc.) → string.
fn hs_field(p: &Value) -> Option<SourceField> {
    let name = p["name"].as_str()?.to_string();
    let (ty, enum_values) = match p["type"].as_str().unwrap_or("string") {
        "enumeration" => (
            FieldType::Enum,
            p["options"]
                .as_array()
                .map(|o| o.iter().filter_map(|v| v["value"].as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        ),
        "number" => (FieldType::Number, vec![]),
        "date" | "datetime" => (FieldType::Date, vec![]),
        "bool" => (FieldType::Bool, vec![]),
        _ => (FieldType::String, vec![]),
    };
    Some(SourceField { name, ty, enum_values, ref_target: None })
}

impl Connector for HubSpotConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for ty in &self.types {
            out.push(SourceObject { name: ty.clone(), columns: self.property_names(ty)? });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let columns = self.property_names(object)?;
        let body = self.get(&format!("crm/v3/objects/{object}?limit=100"))?;
        let rows = body["results"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .map(|r| columns.iter().map(|c| cell_to_string(&r["properties"][c])).collect())
            .collect();
        Ok(RowSet { columns, rows })
    }

    /// Declared property types from the CRM properties API (#1230): enumerations carry their
    /// options as an enum; everything else maps to the closest scalar type.
    fn describe_object(&self, object: &str) -> Result<Vec<SourceField>> {
        let body = self.get(&format!("crm/v3/properties/{object}"))?;
        Ok(body["results"]
            .as_array()
            .map(|r| r.iter().filter_map(hs_field).collect())
            .unwrap_or_default())
    }

    /// Capture HubSpot automation workflows.
    fn scan_platform(&self) -> Result<PlatformScan> {
        let body = self.get("automation/v3/workflows")?;
        let automations = body["workflows"]
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
                    object: w["type"].as_str().unwrap_or("").to_string(),
                    active: w["enabled"].as_bool().unwrap_or(false),
                    trigger: w["type"].as_str().unwrap_or("").to_string(),
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

    const CONTACT_PROPS: &str = r#"{ "results": [
        {"name": "firstname", "label": "First Name", "type": "string"},
        {"name": "email",     "label": "Email",      "type": "string"}
    ] }"#;

    const CONTACTS: &str = r#"{ "results": [
        {"id": "1", "properties": {"firstname": "Ada",  "email": "ada@acme.com"}},
        {"id": "2", "properties": {"firstname": "Grace", "email": ""}}
    ] }"#;

    const WORKFLOWS: &str = r#"{ "workflows": [
        {"id": 11, "name": "Lead nurture", "type": "DRIP_DELAY", "enabled": true}
    ] }"#;

    fn fixture_connector() -> HubSpotConnector {
        HubSpotConnector::with_types("acme-hs", vec!["contacts".to_string()], move |path| {
            let body = if path.contains("automation") {
                WORKFLOWS
            } else if path.contains("properties/contacts") {
                CONTACT_PROPS
            } else {
                CONTACTS
            };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_types_with_property_columns() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs.len(), 1);
        assert_eq!(objs[0].name, "contacts");
        assert_eq!(objs[0].columns, vec!["firstname", "email"]);
    }

    #[test]
    fn read_returns_property_rows() {
        let c = fixture_connector();
        let rs = c.read("contacts").unwrap();
        assert_eq!(rs.columns, vec!["firstname", "email"]);
        assert_eq!(rs.rows[0], vec!["Ada", "ada@acme.com"]);
        assert_eq!(rs.rows[1], vec!["Grace", ""]);
    }

    const TYPED_PROPS: &str = r#"{ "results": [
        {"name": "amount",    "type": "number"},
        {"name": "closedate", "type": "date"},
        {"name": "stage",     "type": "enumeration", "options": [{"value": "new"}, {"value": "won"}]},
        {"name": "notes",     "type": "string"}
    ] }"#;

    #[test]
    fn describe_object_maps_property_types() {
        let c = HubSpotConnector::with_types("hs", vec!["deals".to_string()], move |_p| {
            Ok(serde_json::from_str(TYPED_PROPS).unwrap())
        });
        let fields = c.describe_object("deals").unwrap();
        let by = |n: &str| fields.iter().find(|f| f.name == n).unwrap();
        assert_eq!(by("amount").ty, FieldType::Number);
        assert_eq!(by("closedate").ty, FieldType::Date);
        assert_eq!(by("stage").ty, FieldType::Enum);
        assert_eq!(by("stage").enum_values, vec!["new", "won"]);
        assert_eq!(by("notes").ty, FieldType::String);
    }

    #[test]
    fn scan_captures_workflows() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.automations.len(), 1);
        assert_eq!(scan.automations[0].kind, AutomationKind::Workflow);
        assert_eq!(scan.automations[0].name, "Lead nurture");
        assert!(scan.automations[0].active);
        assert_eq!(scan.automations[0].source, "acme-hs");
    }
}
