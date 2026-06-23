//! Read-only Salesforce connector (sc-connector / #782 / #784).
//!
//! Implements [`Connector`] over the Salesforce REST Describe + SOQL APIs.
//! The HTTP transport is injected via a closure so tests can replay recorded
//! fixtures with no live network; production callers supply a reqwest-backed
//! closure that captures the bearer token — the connector never stores or logs it.

use serde_json::Value;

use crate::connector::{Connector, RowSet, SourceObject};
use crate::{DataError, Result};

// ── Richer field metadata ─────────────────────────────────────────────────

/// A Salesforce field as returned by the Describe API.
///
/// Carries the metadata that [`SourceObject`] columns (plain strings) cannot:
/// picklist options and lookup target object names.
#[derive(Debug, Clone, PartialEq)]
pub struct SalesforceField {
    /// API name, e.g. `AccountId`, `Status__c`.
    pub name: String,
    /// Salesforce field type string, e.g. `"string"`, `"picklist"`, `"reference"`.
    pub field_type: String,
    /// Active picklist options; non-empty only when `field_type` is `"picklist"` or
    /// `"multipicklist"`.
    pub picklist_values: Vec<String>,
    /// Object API names this field may point to; non-empty only when
    /// `field_type` is `"reference"`.
    pub lookup_targets: Vec<String>,
    /// The formula expression for a calculated/formula field, e.g. `Amount * 0.9`;
    /// `Some` only when the field is `calculated` in the describe (`calculatedFormula`).
    /// Captured so the behavior scan can carry derived logic into the new app (#1193).
    pub calculated_formula: Option<String>,
}

/// A Salesforce object with full field metadata, as returned by [`SalesforceConnector::describe`].
///
/// Used when richer column metadata (picklists, lookups) is needed beyond the plain
/// column list in [`SourceObject`].
#[derive(Debug, Clone, PartialEq)]
pub struct SalesforceObject {
    pub name: String,
    pub fields: Vec<SalesforceField>,
}

impl From<&SalesforceObject> for SourceObject {
    fn from(o: &SalesforceObject) -> Self {
        SourceObject {
            name: o.name.clone(),
            columns: o.fields.iter().map(|f| f.name.clone()).collect(),
        }
    }
}

// ── Connector ────────────────────────────────────────────────────────────

/// Read-only Salesforce connector.
///
/// Credentials are owned exclusively by the `fetch` closure supplied at
/// construction; the connector struct itself never stores, logs, or persists
/// an access token (decision #782).
///
/// # Example (test fixture)
///
/// ```rust,ignore
/// let c = SalesforceConnector::new(
///     "acme-org",
///     "https://acme.salesforce.com",
///     "v59.0",
///     |_url| Ok(serde_json::json!({"sobjects": []})),
/// );
/// ```
///
/// # Production usage
///
/// Bake the bearer token into the closure:
///
/// ```rust,ignore
/// let token = load_token();
/// let c = SalesforceConnector::new("acme", instance_url, "v59.0", move |url| {
///     let body = reqwest::blocking::Client::new()
///         .get(url)
///         .bearer_auth(&token)  // token lives only in this closure
///         .send()?
///         .json()?;
///     Ok(body)
/// });
/// ```
/// A URL → parsed-JSON fetch closure. Owns any auth (bearer token / API key); the connector
/// never sees or stores credentials.
type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

pub struct SalesforceConnector {
    name: String,
    instance_url: String,
    api_version: String,
    /// GET `url` → parsed JSON body. Owns the access token; the connector never sees it.
    fetch: FetchFn,
}

impl SalesforceConnector {
    /// Build a connector backed by a caller-supplied HTTP fetch closure.
    ///
    /// `fetch` receives a full URL and must return the parsed JSON response body.
    /// Any authentication (bearer token, API key) must be captured by the closure —
    /// the connector never stores or logs credentials.
    pub fn new(
        name: impl Into<String>,
        instance_url: impl Into<String>,
        api_version: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        SalesforceConnector {
            name: name.into(),
            instance_url: instance_url.into(),
            api_version: api_version.into(),
            fetch: Box::new(fetch),
        }
    }

    /// Describe a single Salesforce object, returning rich field metadata.
    ///
    /// Calls `GET /services/data/{api_version}/sobjects/{object}/describe/`.
    pub fn describe(&self, object: &str) -> Result<SalesforceObject> {
        let body = self.get(&format!("/sobjects/{object}/describe/"))?;
        let raw_fields = body["fields"].as_array().ok_or_else(|| {
            DataError::Schema(format!("{object}: describe response missing 'fields' array"))
        })?;
        let fields = raw_fields.iter().filter_map(parse_field).collect();
        Ok(SalesforceObject { name: object.to_string(), fields })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/services/data/{}{}", self.instance_url, self.api_version, path)
    }

    fn get(&self, path: &str) -> Result<Value> {
        (self.fetch)(&self.url(path))
    }

    /// List queryable object API names via the global describe endpoint.
    ///
    /// Keeps standard objects and custom `__c` objects; drops `__mdt`, `__e`,
    /// and non-queryable entries (History, Feed, Share, etc.).
    fn list_object_names(&self) -> Result<Vec<String>> {
        let body = self.get("/sobjects/")?;
        body["sobjects"]
            .as_array()
            .ok_or_else(|| DataError::Schema("describe-global: missing 'sobjects' array".into()))?
            .iter()
            .filter_map(|o| {
                let name = o["name"].as_str()?;
                let queryable = o["queryable"].as_bool().unwrap_or(false);
                if queryable && (is_standard_object(name) || name.ends_with("__c")) {
                    Some(Ok(name.to_string()))
                } else {
                    None
                }
            })
            .collect()
    }
}

/// Returns true for standard Salesforce object names (no `__` in the name).
fn is_standard_object(name: &str) -> bool {
    !name.contains("__")
}

/// Parse one element of the describe `fields` array into a [`SalesforceField`].
///
/// Returns `None` for compound/non-selectable types (address, location) that
/// cannot appear in a SOQL SELECT — their sub-fields are exposed individually.
fn parse_field(f: &Value) -> Option<SalesforceField> {
    let name = f["name"].as_str()?.to_string();
    let field_type = f["type"].as_str().unwrap_or("string").to_string();

    // Compound types aren't directly SELECT-able in SOQL; skip them.
    if matches!(field_type.as_str(), "address" | "location") {
        return None;
    }

    let picklist_values = if matches!(field_type.as_str(), "picklist" | "multipicklist") {
        f["picklistValues"]
            .as_array()
            .map(|vals| {
                vals.iter()
                    .filter(|v| v["active"].as_bool().unwrap_or(true))
                    .filter_map(|v| v["value"].as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        vec![]
    };

    let lookup_targets = if field_type == "reference" {
        f["referenceTo"]
            .as_array()
            .map(|refs| refs.iter().filter_map(|r| r.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    } else {
        vec![]
    };

    // Formula fields carry derived logic — capture the expression for the behavior scan (#1193).
    let calculated_formula = if f["calculated"].as_bool().unwrap_or(false) {
        f["calculatedFormula"].as_str().filter(|s| !s.is_empty()).map(str::to_string)
    } else {
        None
    };

    Some(SalesforceField { name, field_type, picklist_values, lookup_targets, calculated_formula })
}

/// Percent-encode a string for use in a URL query parameter (RFC 3986 unreserved chars pass
/// through; everything else is `%XX`-escaped).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

impl Connector for SalesforceConnector {
    fn name(&self) -> &str {
        &self.name
    }

    /// List all queryable standard and custom objects with their field column names.
    ///
    /// Makes one global describe call plus one per-object describe call, so latency
    /// scales with the number of objects in the org.
    fn objects(&self) -> Result<Vec<SourceObject>> {
        let names = self.list_object_names()?;
        names.iter().map(|n| self.describe(n).map(|o| SourceObject::from(&o))).collect()
    }

    /// Pull a representative sample (up to 200 rows) from a Salesforce object via SOQL.
    ///
    /// The field list is derived from a fresh describe call, so the returned [`RowSet`]
    /// columns match exactly what the describe reports.
    fn read(&self, object: &str) -> Result<RowSet> {
        let sf_obj = self.describe(object)?;
        let columns: Vec<String> = sf_obj.fields.iter().map(|f| f.name.clone()).collect();
        let soql = format!("SELECT {} FROM {} LIMIT 200", columns.join(","), object);
        let body = self.get(&format!("/query?q={}", percent_encode(&soql)))?;
        let records = body["records"].as_array().ok_or_else(|| {
            DataError::Schema(format!("{object}: query response missing 'records' array"))
        })?;
        let rows = records
            .iter()
            .map(|r| {
                columns
                    .iter()
                    .map(|col| match &r[col] {
                        Value::Null => String::new(),
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect()
            })
            .collect();
        Ok(RowSet { columns, rows })
    }
}

// ── Platform behavior scan (#1193) ─────────────────────────────────────────
//
// A data-only scan copies rows; to *replace* a system you must also carry its
// behavior. These types capture the source's behavioral layer — automations,
// business processes, and derived logic — read-only (#782); the planner
// summarizes them and the generated app reproduces them.

/// A validation rule — an automation that rejects a write unless a condition holds.
/// Maps to an app-level validation / `Field.validate` rule on the Data Model.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRule {
    pub object: String,
    pub name: String,
    pub active: bool,
    pub error_message: String,
    /// The error-condition formula (a write is blocked when this is true).
    pub formula: String,
}

/// A workflow rule — a trigger-on-write automation with field-update / task / alert actions.
/// Maps to a generated automation (a rule or job) in the new app.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRule {
    pub object: String,
    pub name: String,
    pub active: bool,
    /// `onCreateOnly` / `onCreateOrTriggeringUpdate` / `onAllChanges`.
    pub trigger_type: String,
    /// Action names attached to the rule (field updates, alerts, tasks).
    pub actions: Vec<String>,
}

/// A Flow / Process Builder process — declarative automation.
/// Maps to a generated automation (rule or scheduled job).
///
/// Salesforce stores **legacy Process Builder** processes as `Flow` records with
/// `ProcessType = "Workflow"` (vs `"Flow"` / `"AutoLaunchedFlow"` for true Flows), so the
/// `FROM Flow` Tooling query captures both — [`Self::is_process_builder`] tells them apart.
/// Process Builder is deprecated upstream, which makes capturing it for migration *more*
/// important: it's the automation users most need carried into the replacement (#1193).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSummary {
    pub name: String,
    pub label: String,
    /// e.g. `Workflow` (Process Builder), `Flow`, `AutoLaunchedFlow`.
    pub process_type: String,
    pub status: String,
    /// The object the flow is triggered on, when declared (record-triggered flows).
    pub trigger_object: Option<String>,
}

impl FlowSummary {
    /// True for a legacy Process Builder process (`ProcessType = "Workflow"`), as opposed to a
    /// true Flow. Process Builder is deprecated by Salesforce, so it must still be migrated.
    pub fn is_process_builder(&self) -> bool {
        self.process_type == "Workflow"
    }
}

/// An approval process — a multi-step business process gating a record's state.
/// Maps to a generated approval workflow.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalProcess {
    pub name: String,
    pub object: String,
    pub active: bool,
}

/// A formula field — derived logic that computes a value from other fields.
/// Maps to a computed field on the Data Model / app.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaField {
    pub object: String,
    pub field: String,
    /// The field's Salesforce return type (`currency`, `string`, …).
    pub return_type: String,
    pub formula: String,
}

/// The kind of Apex unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApexKind {
    Class,
    Trigger,
}

/// An Apex class or trigger — imperative logic.
/// Summarized for a worker to re-implement against the new stack (not auto-ported).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApexUnit {
    pub name: String,
    pub kind: ApexKind,
    /// The object a trigger fires on; `None` for classes.
    pub object: Option<String>,
    pub status: String,
    /// Source body, when retrieved — large, so optional.
    pub body: Option<String>,
}

/// A read-only capture of a source platform's behavioral layer (#1193).
///
/// Sibling to the inferred Data Model: the data scan answers "what rows exist",
/// this answers "what the system *does*". The planner distils it into the
/// Platform Behavior Summary and the generated app reproduces it.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformScan {
    pub validation_rules: Vec<ValidationRule>,
    pub workflow_rules: Vec<WorkflowRule>,
    pub flows: Vec<FlowSummary>,
    pub approval_processes: Vec<ApprovalProcess>,
    pub formula_fields: Vec<FormulaField>,
    pub apex: Vec<ApexUnit>,
}

impl SalesforceConnector {
    /// Scan the platform's behavioral layer: automations, business processes, derived logic.
    ///
    /// `described` is the objects already pulled by the data scan ([`Self::describe`] /
    /// [`Connector::objects`]); formula fields are harvested from them, and the remaining
    /// categories come from Tooling-API queries. Read-only — never writes back (#782).
    pub fn scan_platform(&self, described: &[SalesforceObject]) -> Result<PlatformScan> {
        Ok(PlatformScan {
            validation_rules: self.scan_validation_rules()?,
            workflow_rules: self.scan_workflow_rules()?,
            flows: self.scan_flows()?,
            approval_processes: self.scan_approval_processes()?,
            formula_fields: formula_fields_from(described),
            apex: self.scan_apex()?,
        })
    }

    /// Run a Tooling-API SOQL query and return its `records` array (empty if absent).
    fn tooling_query(&self, soql: &str) -> Result<Vec<Value>> {
        let body = self.get(&format!("/tooling/query?q={}", percent_encode(soql)))?;
        Ok(body["records"].as_array().cloned().unwrap_or_default())
    }

    fn scan_validation_rules(&self) -> Result<Vec<ValidationRule>> {
        let recs = self.tooling_query(
            "SELECT ValidationName, Active, ErrorMessage, EntityDefinition.QualifiedApiName, Metadata FROM ValidationRule",
        )?;
        Ok(recs.iter().filter_map(parse_validation_rule).collect())
    }

    fn scan_workflow_rules(&self) -> Result<Vec<WorkflowRule>> {
        let recs = self.tooling_query("SELECT Name, TableEnumOrId, Metadata FROM WorkflowRule")?;
        Ok(recs.iter().filter_map(parse_workflow_rule).collect())
    }

    fn scan_flows(&self) -> Result<Vec<FlowSummary>> {
        let recs =
            self.tooling_query("SELECT DeveloperName, MasterLabel, ProcessType, Status, Metadata FROM Flow")?;
        Ok(recs.iter().filter_map(parse_flow).collect())
    }

    fn scan_approval_processes(&self) -> Result<Vec<ApprovalProcess>> {
        let recs =
            self.tooling_query("SELECT Name, TableEnumOrId, State, Type FROM ProcessDefinition WHERE Type = 'Approval'")?;
        Ok(recs.iter().filter_map(parse_approval_process).collect())
    }

    fn scan_apex(&self) -> Result<Vec<ApexUnit>> {
        let mut units: Vec<ApexUnit> = self
            .tooling_query("SELECT Name, Status, Body FROM ApexClass")?
            .iter()
            .filter_map(|v| parse_apex(v, ApexKind::Class))
            .collect();
        units.extend(
            self.tooling_query("SELECT Name, TableEnumOrId, Status, Body FROM ApexTrigger")?
                .iter()
                .filter_map(|v| parse_apex(v, ApexKind::Trigger)),
        );
        Ok(units)
    }
}

/// Harvest formula fields from already-described objects (derived logic in the data layer).
fn formula_fields_from(objects: &[SalesforceObject]) -> Vec<FormulaField> {
    objects
        .iter()
        .flat_map(|o| {
            o.fields.iter().filter_map(move |f| {
                f.calculated_formula.as_ref().map(|formula| FormulaField {
                    object: o.name.clone(),
                    field: f.name.clone(),
                    return_type: f.field_type.clone(),
                    formula: formula.clone(),
                })
            })
        })
        .collect()
}

fn parse_validation_rule(v: &Value) -> Option<ValidationRule> {
    let name = v["ValidationName"].as_str()?.to_string();
    let object = v["EntityDefinition"]["QualifiedApiName"].as_str().unwrap_or("").to_string();
    let active = v["Active"].as_bool().or_else(|| v["Metadata"]["active"].as_bool()).unwrap_or(false);
    let error_message = v["ErrorMessage"]
        .as_str()
        .or_else(|| v["Metadata"]["errorMessage"].as_str())
        .unwrap_or("")
        .to_string();
    let formula = v["Metadata"]["errorConditionFormula"].as_str().unwrap_or("").to_string();
    Some(ValidationRule { object, name, active, error_message, formula })
}

fn parse_workflow_rule(v: &Value) -> Option<WorkflowRule> {
    let name = v["Name"].as_str()?.to_string();
    let object = v["TableEnumOrId"].as_str().unwrap_or("").to_string();
    let active = v["Metadata"]["active"].as_bool().unwrap_or(false);
    let trigger_type = v["Metadata"]["triggerType"].as_str().unwrap_or("").to_string();
    let actions = v["Metadata"]["actions"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|act| {
                    act["name"].as_str().or_else(|| act["type"].as_str()).map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    Some(WorkflowRule { object, name, active, trigger_type, actions })
}

fn parse_flow(v: &Value) -> Option<FlowSummary> {
    let label = v["MasterLabel"].as_str().unwrap_or("").to_string();
    // Flow rows favour DeveloperName; fall back to the label so a name is always present.
    let name = v["DeveloperName"].as_str().filter(|s| !s.is_empty()).unwrap_or(&label).to_string();
    if name.is_empty() {
        return None;
    }
    let process_type = v["ProcessType"].as_str().unwrap_or("").to_string();
    let status = v["Status"].as_str().unwrap_or("").to_string();
    let trigger_object = v["Metadata"]["start"]["object"].as_str().map(str::to_string);
    Some(FlowSummary { name, label, process_type, status, trigger_object })
}

fn parse_approval_process(v: &Value) -> Option<ApprovalProcess> {
    // Defensive: keep only Approval-type definitions even if the WHERE clause is ignored.
    if let Some(ty) = v["Type"].as_str() {
        if ty != "Approval" {
            return None;
        }
    }
    let name = v["Name"].as_str()?.to_string();
    let object = v["TableEnumOrId"].as_str().unwrap_or("").to_string();
    let active = v["State"].as_str().map(|s| s == "Active").unwrap_or(false);
    Some(ApprovalProcess { name, object, active })
}

fn parse_apex(v: &Value, kind: ApexKind) -> Option<ApexUnit> {
    let name = v["Name"].as_str()?.to_string();
    let status = v["Status"].as_str().unwrap_or("").to_string();
    let object = match kind {
        ApexKind::Trigger => v["TableEnumOrId"].as_str().map(str::to_string),
        ApexKind::Class => None,
    };
    let body = v["Body"].as_str().filter(|s| !s.is_empty() && *s != "(hidden)").map(str::to_string);
    Some(ApexUnit { name, kind, object, status, body })
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // ── Fixtures ──────────────────────────────────────────────────────

    const GLOBAL_DESCRIBE: &str = r#"{
        "sobjects": [
            {"name": "Account",          "queryable": true},
            {"name": "Contact",          "queryable": true},
            {"name": "AccountHistory",   "queryable": false},
            {"name": "SetupField__mdt",  "queryable": true},
            {"name": "PlatformEvent__e", "queryable": true},
            {"name": "Widget__c",        "queryable": true}
        ]
    }"#;

    const ACCOUNT_DESCRIBE: &str = r#"{
        "name": "Account",
        "fields": [
            {"name": "Id",             "type": "id"},
            {"name": "Name",           "type": "string"},
            {"name": "AnnualRevenue",  "type": "currency"},
            {"name": "BillingAddress", "type": "address"},
            {"name": "Type", "type": "picklist", "picklistValues": [
                {"value": "Prospect",    "active": true},
                {"value": "Customer",    "active": true},
                {"value": "OldStatus",   "active": false}
            ]},
            {"name": "OwnerId",  "type": "reference", "referenceTo": ["User"]},
            {"name": "ParentId", "type": "reference", "referenceTo": ["Account"]}
        ]
    }"#;

    const CONTACT_DESCRIBE: &str = r#"{
        "name": "Contact",
        "fields": [
            {"name": "Id",         "type": "id"},
            {"name": "FirstName",  "type": "string"},
            {"name": "LastName",   "type": "string"},
            {"name": "AccountId",  "type": "reference", "referenceTo": ["Account"]}
        ]
    }"#;

    const WIDGET_DESCRIBE: &str = r#"{
        "name": "Widget__c",
        "fields": [
            {"name": "Id",     "type": "id"},
            {"name": "Name",   "type": "string"},
            {"name": "Color__c", "type": "picklist", "picklistValues": [
                {"value": "Red",  "active": true},
                {"value": "Blue", "active": true}
            ]},
            {"name": "Price__c", "type": "currency"},
            {"name": "Discounted_Price__c", "type": "currency",
             "calculated": true, "calculatedFormula": "Price__c * 0.9"}
        ]
    }"#;

    const ACCOUNT_QUERY: &str = r#"{
        "totalSize": 2,
        "done": true,
        "records": [
            {"attributes": {"type": "Account"}, "Id": "001xx000001aaa", "Name": "Acme Corp",   "AnnualRevenue": "1200000", "Type": "Customer", "OwnerId": "005xx000001bbb", "ParentId": null},
            {"attributes": {"type": "Account"}, "Id": "001xx000001ccc", "Name": "Globex Inc",  "AnnualRevenue": null,      "Type": "Prospect", "OwnerId": "005xx000001bbb", "ParentId": null}
        ]
    }"#;

    // ── Tooling-API fixtures (behavior scan, #1193) ───────────────────
    // Each is a Tooling query response. Routed by the object name embedded in
    // the (percent-encoded) SOQL, so it must be matched before the data `/query`.

    const VALIDATION_RULES: &str = r#"{ "records": [
        {"ValidationName": "Account_Must_Have_Type", "Active": true,
         "ErrorMessage": "Type is required", "EntityDefinition": {"QualifiedApiName": "Account"},
         "Metadata": {"active": true, "errorConditionFormula": "ISBLANK(TEXT(Type))", "errorMessage": "Type is required"}}
    ]}"#;

    const WORKFLOW_RULES: &str = r#"{ "records": [
        {"Name": "Notify Owner On Big Deal", "TableEnumOrId": "Opportunity",
         "Metadata": {"active": true, "triggerType": "onCreateOrTriggeringUpdate",
                      "actions": [{"name": "Email_Owner", "type": "Alert"}]}}
    ]}"#;

    const FLOWS: &str = r#"{ "records": [
        {"DeveloperName": "Auto_Assign_Owner", "MasterLabel": "Auto Assign Owner",
         "ProcessType": "Workflow", "Status": "Active",
         "Metadata": {"start": {"object": "Lead"}}},
        {"DeveloperName": "New_Case_Intake", "MasterLabel": "New Case Intake",
         "ProcessType": "AutoLaunchedFlow", "Status": "Active",
         "Metadata": {"start": {"object": "Case"}}}
    ]}"#;

    const PROCESS_DEFS: &str = r#"{ "records": [
        {"Name": "Discount Approval", "TableEnumOrId": "Opportunity", "State": "Active", "Type": "Approval"}
    ]}"#;

    const APEX_CLASSES: &str = r#"{ "records": [
        {"Name": "AccountService", "Status": "Active", "Body": "public class AccountService {}"}
    ]}"#;

    const APEX_TRIGGERS: &str = r#"{ "records": [
        {"Name": "OpportunityTrigger", "TableEnumOrId": "Opportunity", "Status": "Active",
         "Body": "trigger OpportunityTrigger on Opportunity (before insert) {}"}
    ]}"#;

    /// Build a fixture-backed connector that routes by URL suffix.
    ///
    /// Routes are checked in declaration order — most-specific first so that
    /// `/sobjects/Account/describe/` is matched before the catch-all `/sobjects/`,
    /// and each Tooling query (matched by its object name) before the data `/query`.
    fn fixture_connector() -> SalesforceConnector {
        let routes: Vec<(&'static str, &'static str)> = vec![
            ("/sobjects/Account/describe/",   ACCOUNT_DESCRIBE),
            ("/sobjects/Contact/describe/",   CONTACT_DESCRIBE),
            ("/sobjects/Widget__c/describe/", WIDGET_DESCRIBE),
            // Tooling queries — matched by object name in the encoded SOQL, before `/query`.
            ("ValidationRule",                VALIDATION_RULES),
            ("WorkflowRule",                  WORKFLOW_RULES),
            ("ProcessDefinition",             PROCESS_DEFS),
            ("ApexClass",                     APEX_CLASSES),
            ("ApexTrigger",                   APEX_TRIGGERS),
            ("FROM%20Flow",                   FLOWS),
            ("/query",                        ACCOUNT_QUERY),
            ("/sobjects/",                    GLOBAL_DESCRIBE), // least-specific last
        ];

        SalesforceConnector::new(
            "test-org",
            "https://test.salesforce.com",
            "v59.0",
            move |url| {
                for (suffix, body) in &routes {
                    if url.contains(suffix) {
                        return Ok(serde_json::from_str(body).unwrap());
                    }
                }
                Err(DataError::Io(format!("fixture: no route for {url}")))
            },
        )
    }

    // ── Unit: object-name filtering ───────────────────────────────────

    #[test]
    fn list_object_names_keeps_standard_and_custom_drops_the_rest() {
        let c = fixture_connector();
        let names = c.list_object_names().unwrap();
        // Included: Account, Contact, Widget__c
        assert!(names.contains(&"Account".to_string()));
        assert!(names.contains(&"Contact".to_string()));
        assert!(names.contains(&"Widget__c".to_string()));
        // Excluded: AccountHistory (queryable=false), SetupField__mdt (__mdt), PlatformEvent__e (__e)
        assert!(!names.contains(&"AccountHistory".to_string()));
        assert!(!names.contains(&"SetupField__mdt".to_string()));
        assert!(!names.contains(&"PlatformEvent__e".to_string()));
    }

    // ── Unit: field parsing ───────────────────────────────────────────

    #[test]
    fn describe_parses_basic_fields() {
        let c = fixture_connector();
        let obj = c.describe("Account").unwrap();
        assert_eq!(obj.name, "Account");
        let names: Vec<&str> = obj.fields.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"Id"));
        assert!(names.contains(&"Name"));
        assert!(names.contains(&"AnnualRevenue"));
        assert!(names.contains(&"OwnerId"));
        // BillingAddress is type "address" — must be excluded
        assert!(!names.contains(&"BillingAddress"));
    }

    #[test]
    fn describe_parses_active_picklist_values_only() {
        let c = fixture_connector();
        let obj = c.describe("Account").unwrap();
        let type_field = obj.fields.iter().find(|f| f.name == "Type").unwrap();
        assert_eq!(type_field.field_type, "picklist");
        // Active: Prospect, Customer. Inactive: OldStatus — must not appear.
        assert_eq!(type_field.picklist_values, vec!["Prospect", "Customer"]);
    }

    #[test]
    fn describe_parses_lookup_targets() {
        let c = fixture_connector();
        let obj = c.describe("Account").unwrap();
        let owner = obj.fields.iter().find(|f| f.name == "OwnerId").unwrap();
        assert_eq!(owner.field_type, "reference");
        assert_eq!(owner.lookup_targets, vec!["User"]);
        let parent = obj.fields.iter().find(|f| f.name == "ParentId").unwrap();
        assert_eq!(parent.lookup_targets, vec!["Account"]);
    }

    #[test]
    fn describe_custom_object_includes_custom_fields() {
        let c = fixture_connector();
        let obj = c.describe("Widget__c").unwrap();
        let color = obj.fields.iter().find(|f| f.name == "Color__c").unwrap();
        assert_eq!(color.field_type, "picklist");
        assert_eq!(color.picklist_values, vec!["Red", "Blue"]);
    }

    // ── Unit: Connector trait ─────────────────────────────────────────

    #[test]
    fn objects_returns_source_objects_for_all_queryable() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert!(names.contains(&"Account"));
        assert!(names.contains(&"Contact"));
        assert!(names.contains(&"Widget__c"));
        // Compound BillingAddress excluded from Account's columns
        let account = objs.iter().find(|o| o.name == "Account").unwrap();
        assert!(!account.columns.contains(&"BillingAddress".to_string()));
    }

    #[test]
    fn read_returns_rowset_with_correct_columns_and_rows() {
        let c = fixture_connector();
        let rs = c.read("Account").unwrap();
        // Columns match describe output (excluding compound BillingAddress)
        assert!(rs.columns.contains(&"Id".to_string()));
        assert!(rs.columns.contains(&"Name".to_string()));
        assert!(!rs.columns.contains(&"BillingAddress".to_string()));
        assert_eq!(rs.rows.len(), 2);
        // First row: Name = "Acme Corp"
        let name_idx = rs.columns.iter().position(|c| c == "Name").unwrap();
        assert_eq!(rs.rows[0][name_idx], "Acme Corp");
        // Null field becomes empty string
        let revenue_idx = rs.columns.iter().position(|c| c == "AnnualRevenue").unwrap();
        assert_eq!(rs.rows[1][revenue_idx], "");
    }

    #[test]
    fn connector_name_is_preserved() {
        let c = fixture_connector();
        assert_eq!(c.name(), "test-org");
    }

    // ── Behavior scan (#1193) ─────────────────────────────────────────

    #[test]
    fn describe_captures_formula_field_expression() {
        let c = fixture_connector();
        let obj = c.describe("Widget__c").unwrap();
        let formula = obj.fields.iter().find(|f| f.name == "Discounted_Price__c").unwrap();
        assert_eq!(formula.calculated_formula.as_deref(), Some("Price__c * 0.9"));
        // A plain field carries no expression.
        let price = obj.fields.iter().find(|f| f.name == "Price__c").unwrap();
        assert_eq!(price.calculated_formula, None);
    }

    #[test]
    fn scan_platform_captures_all_behavior_categories() {
        let c = fixture_connector();
        let described = vec![c.describe("Widget__c").unwrap()];
        let scan = c.scan_platform(&described).unwrap();

        // Automations — validation rules.
        assert_eq!(scan.validation_rules.len(), 1);
        let vr = &scan.validation_rules[0];
        assert_eq!(vr.object, "Account");
        assert_eq!(vr.name, "Account_Must_Have_Type");
        assert!(vr.active);
        assert_eq!(vr.formula, "ISBLANK(TEXT(Type))");

        // Automations — workflow rules + their actions.
        assert_eq!(scan.workflow_rules.len(), 1);
        let wr = &scan.workflow_rules[0];
        assert_eq!(wr.object, "Opportunity");
        assert_eq!(wr.trigger_type, "onCreateOrTriggeringUpdate");
        assert_eq!(wr.actions, vec!["Email_Owner"]);

        // Automations — Flows AND legacy Process Builder (both are `Flow` records).
        assert_eq!(scan.flows.len(), 2);
        let pb = scan.flows.iter().find(|f| f.name == "Auto_Assign_Owner").unwrap();
        assert_eq!(pb.process_type, "Workflow");
        assert!(pb.is_process_builder(), "ProcessType=Workflow must be detected as Process Builder");
        assert_eq!(pb.trigger_object.as_deref(), Some("Lead"));
        let flow = scan.flows.iter().find(|f| f.name == "New_Case_Intake").unwrap();
        assert!(!flow.is_process_builder(), "AutoLaunchedFlow is a true Flow, not Process Builder");

        // Business processes — approval processes.
        assert_eq!(scan.approval_processes.len(), 1);
        assert_eq!(scan.approval_processes[0].name, "Discount Approval");
        assert_eq!(scan.approval_processes[0].object, "Opportunity");
        assert!(scan.approval_processes[0].active);

        // Derived logic — formula fields (harvested from described objects).
        assert_eq!(scan.formula_fields.len(), 1);
        assert_eq!(scan.formula_fields[0].field, "Discounted_Price__c");
        assert_eq!(scan.formula_fields[0].formula, "Price__c * 0.9");

        // Derived logic — Apex: one class + one trigger.
        assert_eq!(scan.apex.len(), 2);
        assert!(scan
            .apex
            .iter()
            .any(|a| a.kind == ApexKind::Class && a.name == "AccountService"));
        let trig = scan.apex.iter().find(|a| a.kind == ApexKind::Trigger).unwrap();
        assert_eq!(trig.name, "OpportunityTrigger");
        assert_eq!(trig.object.as_deref(), Some("Opportunity"));
    }

    // ── Security: credentials not stored or leaked ────────────────────

    #[test]
    fn access_token_not_stored_in_connector_struct_and_not_in_constructed_urls() {
        let token = "SUPER_SECRET_BEARER_TOKEN_XYZ";
        let urls_seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let urls_clone = urls_seen.clone();

        let c = SalesforceConnector::new(
            "security-test",
            "https://secure.salesforce.com",
            "v59.0",
            move |url| {
                // Record every URL the connector constructs
                urls_clone.lock().unwrap().push(url.to_string());
                // Bearer auth would be added here by the closure, not the connector
                Ok(serde_json::json!({"sobjects": []}))
            },
        );

        let _ = c.objects(); // drives URL construction

        // The connector struct fields must not contain the token
        assert!(!c.name.contains(token), "token leaked into name");
        assert!(!c.instance_url.contains(token), "token leaked into instance_url");
        assert!(!c.api_version.contains(token), "token leaked into api_version");

        // None of the constructed URLs must contain the token
        for url in urls_seen.lock().unwrap().iter() {
            assert!(!url.contains(token), "token appeared in URL: {url}");
        }
    }

    // ── Unit: URL helpers ─────────────────────────────────────────────

    #[test]
    fn percent_encode_encodes_soql_special_chars() {
        // Spaces → %20, commas → %2C, equals → %3D
        assert_eq!(percent_encode("SELECT Id FROM Account"), "SELECT%20Id%20FROM%20Account");
        assert_eq!(percent_encode("a,b"), "a%2Cb");
        assert_eq!(percent_encode("a=b"), "a%3Db");
        // Unreserved chars pass through
        assert_eq!(percent_encode("Id_123.Name~val-ok"), "Id_123.Name~val-ok");
    }

    #[test]
    fn read_constructs_soql_url_with_encoded_query() {
        let urls_seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let urls_clone = urls_seen.clone();

        // Single-field object to keep the SOQL simple
        let c = SalesforceConnector::new(
            "url-test",
            "https://t.salesforce.com",
            "v59.0",
            move |url| {
                urls_clone.lock().unwrap().push(url.to_string());
                if url.contains("/describe/") {
                    Ok(serde_json::json!({
                        "name": "Simple__c",
                        "fields": [{"name": "Id", "type": "id"}]
                    }))
                } else {
                    Ok(serde_json::json!({"records": []}))
                }
            },
        );

        c.read("Simple__c").unwrap();

        let query_url = urls_seen
            .lock()
            .unwrap()
            .iter()
            .find(|u| u.contains("/query"))
            .cloned()
            .expect("read() must call /query");

        // The SOQL should be percent-encoded in the URL
        assert!(query_url.contains("SELECT"), "SOQL missing from URL");
        assert!(!query_url.contains(' '), "unencoded space in query URL");
    }
}
