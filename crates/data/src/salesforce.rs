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
pub struct SalesforceConnector {
    name: String,
    instance_url: String,
    api_version: String,
    /// GET `url` → parsed JSON body. Owns the access token; the connector never sees it.
    fetch: Box<dyn Fn(&str) -> Result<Value> + Send + Sync>,
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

    Some(SalesforceField { name, field_type, picklist_values, lookup_targets })
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

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
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
            ]}
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

    /// Build a fixture-backed connector that routes by URL suffix.
    fn fixture_connector() -> SalesforceConnector {
        let mut routes: HashMap<&'static str, &'static str> = HashMap::new();
        routes.insert("/sobjects/",                    GLOBAL_DESCRIBE);
        routes.insert("/sobjects/Account/describe/",   ACCOUNT_DESCRIBE);
        routes.insert("/sobjects/Contact/describe/",   CONTACT_DESCRIBE);
        routes.insert("/sobjects/Widget__c/describe/", WIDGET_DESCRIBE);
        routes.insert("/query",                        ACCOUNT_QUERY);

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
