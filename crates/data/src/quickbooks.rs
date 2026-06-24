//! Read-only QuickBooks Online connector (native first-party, #1197).
//!
//! QuickBooks Online is a REST API queried with a SQL-like dialect
//! (`GET /v3/company/{realmId}/query?query=SELECT * FROM Customer`). The transport is injected
//! as a closure (query → parsed `QueryResponse` body) so tests replay fixtures with no network;
//! production captures the OAuth bearer token in the closure — the connector never stores or
//! logs it (#782 / #1194).
//!
//! - **Data:** the standard entities (Customer, Invoice, Item, Payment, …) → objects; a sample
//!   query gives columns + rows (top-level fields; nested sub-objects are kept as JSON).
//! - **Behavior:** **recurring transactions** → [`AutomationKind::Recurring`] automations.

use serde_json::Value;

use crate::behavior::{Automation, AutomationKind, PlatformScan};
use crate::connector::{Connector, RowSet, SourceObject};
use crate::Result;

/// A query → parsed-JSON closure. Owns the OAuth token; the connector never sees it.
type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// The standard QuickBooks Online entities worth inventorying by default.
const STANDARD_ENTITIES: &[&str] =
    &["Customer", "Invoice", "Item", "Payment", "Vendor", "Bill", "Account", "Employee"];

/// Read-only QuickBooks Online connector.
///
/// Credentials are owned exclusively by the `fetch` closure; the connector struct never stores,
/// logs, or persists the access token (#782).
pub struct QuickBooksConnector {
    name: String,
    entities: Vec<String>,
    fetch: FetchFn,
}

impl QuickBooksConnector {
    /// Build a connector over the standard entity set.
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        Self::with_entities(
            name,
            STANDARD_ENTITIES.iter().map(|s| s.to_string()).collect(),
            fetch,
        )
    }

    /// Build a connector over a caller-chosen entity set (used by tests).
    pub fn with_entities(
        name: impl Into<String>,
        entities: Vec<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        QuickBooksConnector { name: name.into(), entities, fetch: Box::new(fetch) }
    }

    /// Run a QuickBooks SQL query and return the parsed `QueryResponse` body.
    fn run_query(&self, query: &str) -> Result<Value> {
        (self.fetch)(query)
    }
}

/// Top-level field names of a record, sorted for a stable column order.
fn record_columns(rec: &Value) -> Vec<String> {
    let mut cols: Vec<String> =
        rec.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    cols.sort();
    cols
}

/// Render one cell: scalars as plain text, nested objects/arrays as compact JSON.
fn cell_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

impl Connector for QuickBooksConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::new();
        for e in &self.entities {
            let body = self.run_query(&format!("SELECT * FROM {e} MAXRESULTS 1"))?;
            let columns = body["QueryResponse"][e]
                .as_array()
                .and_then(|a| a.first())
                .map(record_columns)
                .unwrap_or_default();
            out.push(SourceObject { name: e.clone(), columns });
        }
        Ok(out)
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let body = self.run_query(&format!("SELECT * FROM {object} MAXRESULTS 200"))?;
        let records = body["QueryResponse"][object].as_array().cloned().unwrap_or_default();
        let columns = records.first().map(record_columns).unwrap_or_default();
        let rows = records
            .iter()
            .map(|r| columns.iter().map(|c| cell_to_string(&r[c])).collect())
            .collect();
        Ok(RowSet { columns, rows })
    }

    /// Capture recurring transactions as recurring automations.
    fn scan_platform(&self) -> Result<PlatformScan> {
        let body = self.run_query("SELECT * FROM RecurringTransaction MAXRESULTS 1000")?;
        let items =
            body["QueryResponse"]["RecurringTransaction"].as_array().cloned().unwrap_or_default();
        let automations = items.iter().filter_map(|it| parse_recurring(it, &self.name)).collect();
        Ok(PlatformScan { automations, ..Default::default() })
    }
}

/// Parse a `RecurringTransaction` record into a recurring automation.
///
/// Each record wraps a transaction entity (Invoice, Bill, …) that carries a `RecurringInfo`
/// block with the schedule.
fn parse_recurring(item: &Value, source: &str) -> Option<Automation> {
    let obj = item.as_object()?;
    let (entity, body) = obj.iter().find(|(_, v)| v.get("RecurringInfo").is_some())?;
    let info = &body["RecurringInfo"];
    let name = info["Name"].as_str()?.to_string();
    let active = info["Active"].as_bool().unwrap_or(false);
    let recur_type = info["RecurType"].as_str().unwrap_or("").to_string();
    let interval = info["ScheduleInfo"]["IntervalType"].as_str().unwrap_or("").to_string();
    let trigger =
        if interval.is_empty() { "recurring".to_string() } else { format!("recurring:{interval}") };
    let actions = if recur_type.is_empty() { vec![] } else { vec![recur_type] };
    Some(Automation {
        source: source.to_string(),
        kind: AutomationKind::Recurring,
        name,
        object: entity.clone(),
        active,
        trigger,
        condition: String::new(),
        actions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const CUSTOMER_Q: &str = r#"{ "QueryResponse": { "Customer": [
        {"Id": "1", "DisplayName": "Acme Co",  "Balance": 1200.5, "Active": true},
        {"Id": "2", "DisplayName": "Globex",   "Balance": 0,      "Active": true}
    ] } }"#;

    const INVOICE_Q: &str = r#"{ "QueryResponse": { "Invoice": [
        {"Id": "7", "DocNumber": "1001", "TotalAmt": 500.0,
         "CustomerRef": {"value": "1", "name": "Acme Co"}}
    ] } }"#;

    const RECURRING_Q: &str = r#"{ "QueryResponse": { "RecurringTransaction": [
        {"Invoice": {"RecurringInfo": {
            "Name": "Monthly Acme Retainer", "Active": true, "RecurType": "Automated",
            "ScheduleInfo": {"IntervalType": "Monthly", "NumInterval": "1"}
        }}}
    ] } }"#;

    fn fixture_connector() -> QuickBooksConnector {
        QuickBooksConnector::with_entities(
            "acme-qbo",
            vec!["Customer".to_string(), "Invoice".to_string()],
            move |q| {
                let body = if q.contains("FROM RecurringTransaction") {
                    RECURRING_Q
                } else if q.contains("FROM Invoice") {
                    INVOICE_Q
                } else {
                    CUSTOMER_Q
                };
                Ok(serde_json::from_str(body).unwrap())
            },
        )
    }

    #[test]
    fn objects_lists_entities_with_sampled_columns() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, vec!["Customer", "Invoice"]);
        let cust = objs.iter().find(|o| o.name == "Customer").unwrap();
        // Columns are the record's top-level fields, sorted.
        assert_eq!(cust.columns, vec!["Active", "Balance", "DisplayName", "Id"]);
    }

    #[test]
    fn read_returns_rows_with_nested_objects_as_json() {
        let c = fixture_connector();
        let rs = c.read("Invoice").unwrap();
        assert_eq!(rs.rows.len(), 1);
        let ref_idx = rs.columns.iter().position(|c| c == "CustomerRef").unwrap();
        // Nested sub-object preserved as compact JSON, not dropped.
        assert!(rs.rows[0][ref_idx].contains("Acme Co"));
        let amt_idx = rs.columns.iter().position(|c| c == "TotalAmt").unwrap();
        assert_eq!(rs.rows[0][amt_idx], "500.0");
    }

    #[test]
    fn scan_captures_recurring_transactions_as_automations() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();
        assert_eq!(scan.automations.len(), 1);
        let a = &scan.automations[0];
        assert_eq!(a.kind, AutomationKind::Recurring);
        assert_eq!(a.name, "Monthly Acme Retainer");
        assert_eq!(a.object, "Invoice");
        assert_eq!(a.source, "acme-qbo");
        assert!(a.active);
        assert_eq!(a.trigger, "recurring:Monthly");
        assert_eq!(a.actions, vec!["Automated"]);
        // QuickBooks exposes no validation rules / formulas — those stay empty.
        assert!(scan.business_processes.is_empty());
        assert!(scan.derived_logic.is_empty());
    }

    #[test]
    fn access_token_not_stored_or_leaked_into_queries() {
        let token = "QBO_BEARER_SECRET";
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let seen2 = seen.clone();
        let c = QuickBooksConnector::with_entities("sec", vec!["Customer".to_string()], move |q| {
            seen2.lock().unwrap().push(q.to_string());
            Ok(serde_json::from_str(CUSTOMER_Q).unwrap())
        });
        let _ = c.objects();
        assert!(!c.name.contains(token));
        for q in seen.lock().unwrap().iter() {
            assert!(!q.contains(token), "token leaked into query: {q}");
        }
    }
}
