//! Read-only Stripe connector (native first-party, #1197).
//!
//! Stripe's REST API. Transport injected as a closure (path → parsed JSON); the secret key
//! lives only in the closure (never stored/logged, #782 / #1194).
//!
//! - **Data:** standard resources (customers, invoices, charges, subscriptions, products,
//!   prices) → objects, sampled columns + rows (`{ "data": [..] }`).
//! - **Behavior:** none generically — Stripe billing automation is configuration, not a
//!   queryable rule set (data-only).

use serde_json::Value;

use crate::connector::{cell_to_string, sorted_record_columns, Connector, RowSet, SourceObject};
use crate::Result;

type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

const STANDARD_RESOURCES: &[&str] =
    &["customers", "invoices", "charges", "subscriptions", "products", "prices"];

/// Read-only Stripe connector.
pub struct StripeConnector {
    name: String,
    resources: Vec<String>,
    fetch: FetchFn,
}

impl StripeConnector {
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
        StripeConnector { name: name.into(), resources, fetch: Box::new(fetch) }
    }

    fn records(&self, resource: &str) -> Result<Vec<Value>> {
        Ok((self.fetch)(resource)?["data"].as_array().cloned().unwrap_or_default())
    }
}

impl Connector for StripeConnector {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    const CUSTOMERS: &str = r#"{ "object": "list", "data": [
        {"id": "cus_1", "email": "a@acme.com", "balance": 0},
        {"id": "cus_2", "email": "b@globex.com", "balance": -500}
    ] }"#;

    fn fixture_connector() -> StripeConnector {
        StripeConnector::with_resources("acme-stripe", vec!["customers".to_string()], move |_p| {
            Ok(serde_json::from_str(CUSTOMERS).unwrap())
        })
    }

    #[test]
    fn objects_and_read() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        assert_eq!(objs[0].name, "customers");
        assert_eq!(objs[0].columns, vec!["balance", "email", "id"]);
        let rs = c.read("customers").unwrap();
        assert_eq!(rs.rows.len(), 2);
        let email = rs.columns.iter().position(|c| c == "email").unwrap();
        assert_eq!(rs.rows[0][email], "a@acme.com");
    }
}
