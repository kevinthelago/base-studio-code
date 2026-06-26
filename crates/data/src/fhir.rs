//! HL7 **FHIR** (R4) source connector (#1311) — the standards-first anchor for healthcare.
//!
//! A single FHIR connector reaches nearly every modern EHR (Epic, Oracle Health/Cerner,
//! Athenahealth, Allscripts) via the RESTful API, so it has far more leverage than per-vendor
//! connectors. Like every connector here it is **read-only** (#782) and **native in-process Rust**:
//! the desktop host owns the transport + credentials, so PHI/bulk data never reaches the planner's
//! context. HIPAA note: read-only scan first; the access token (SMART-on-FHIR) lives only in the
//! caller's fetch closure — this connector never sees or stores it.
//!
//! The connector is built around the FHIR REST conventions:
//!   * each clinical resource type (`Patient`, `Encounter`, `Observation`, …) is a readable object,
//!   * `GET {base}/{ResourceType}?_count=N` returns a **searchset `Bundle`**, and
//!   * pagination follows the Bundle's `link[relation = "next"]` absolute URL until exhausted.
//!
//! Each resource is flattened to its top-level elements (nested objects/arrays rendered as compact
//! JSON via [`cell_to_string`]); typing happens downstream when the store coerces to the Data Model.
//! A test injects fixture `Bundle`s through the fetch closure, so the whole connector is covered with
//! no live network (and no PHI).

use serde_json::Value;

use crate::connector::{
    cell_to_string, sorted_record_columns, union_record_columns, Connector, FetchFn, RowSet,
    SourceObject,
};
use crate::error::{DataError, Result};

/// The core FHIR R4 clinical resource types this connector reads, in a stable order. Covers the
/// migration targets in #1311 (demographics, encounters, observations/labs, conditions, medications,
/// procedures, imaging reports, plus providers + scheduling). Resource types a given server doesn't
/// hold simply read empty — they're still listed so the user sees the full clinical surface.
pub const FHIR_RESOURCE_TYPES: &[&str] = &[
    "Patient",
    "Practitioner",
    "Organization",
    "Encounter",
    "Observation",
    "Condition",
    "MedicationRequest",
    "Procedure",
    "DiagnosticReport",
    "AllergyIntolerance",
    "Immunization",
    "CarePlan",
    "Appointment",
];

/// Hard cap on pages followed per object, so a misbehaving `next` chain can't loop forever. A scan is
/// a sample, not a full extract; the load path pulls the rest.
const MAX_PAGES: usize = 50;

/// A read-only HL7 FHIR (R4) connector over one FHIR base URL.
pub struct FhirConnector {
    name: String,
    base_url: String,
    /// GET `url` → parsed JSON body. Owns the access token; the connector never sees it.
    fetch: FetchFn,
    /// `_count` page size requested from the server.
    page_size: usize,
}

impl FhirConnector {
    /// Build a connector over `base_url` (the FHIR service root, e.g. `https://server/fhir`) backed
    /// by a caller-supplied fetch closure. Any SMART-on-FHIR auth must be captured by the closure —
    /// the connector never stores or logs credentials. `base_url`'s trailing slash is trimmed.
    pub fn new(
        name: impl Into<String>,
        base_url: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        FhirConnector {
            name: name.into(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            fetch: Box::new(fetch),
            page_size: 50,
        }
    }

    /// Override the requested `_count` page size (default 50).
    pub fn with_page_size(mut self, n: usize) -> Self {
        self.page_size = n.max(1);
        self
    }

    /// The first-page search URL for a resource type.
    fn search_url(&self, resource_type: &str, count: usize) -> String {
        format!("{}/{}?_count={}", self.base_url, resource_type, count)
    }

    /// The resources carried by a searchset `Bundle` (the `entry[].resource` objects).
    fn bundle_resources(bundle: &Value) -> Vec<Value> {
        bundle["entry"]
            .as_array()
            .map(|entries| entries.iter().filter_map(|e| e.get("resource").cloned()).collect())
            .unwrap_or_default()
    }

    /// The absolute URL of the Bundle's `next` page link, if any (FHIR pagination).
    fn next_link(bundle: &Value) -> Option<String> {
        bundle["link"].as_array()?.iter().find_map(|l| {
            (l["relation"].as_str() == Some("next"))
                .then(|| l["url"].as_str().map(str::to_string))
                .flatten()
        })
    }

    /// Walk the `next` chain from `first_url`, collecting every resource (bounded by [`MAX_PAGES`]).
    fn collect_resources(&self, first_url: String) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        let mut url = Some(first_url);
        let mut pages = 0;
        while let Some(u) = url {
            if pages >= MAX_PAGES {
                break;
            }
            let bundle = (self.fetch)(&u)?;
            out.extend(Self::bundle_resources(&bundle));
            url = Self::next_link(&bundle);
            pages += 1;
        }
        Ok(out)
    }

    /// Flatten resources into a [`RowSet`]: columns are the sorted union of every resource's top-level
    /// element names (the shared #1620 derivation); each cell is the element rendered flat (nested
    /// values as compact JSON).
    fn rows_from_resources(resources: &[Value]) -> RowSet {
        let columns = union_record_columns(resources, |_| true);
        let rows = resources
            .iter()
            .map(|r| columns.iter().map(|c| r.get(c).map(cell_to_string).unwrap_or_default()).collect())
            .collect();
        RowSet { columns, rows }
    }
}

impl Connector for FhirConnector {
    fn name(&self) -> &str {
        &self.name
    }

    /// The clinical resource types, each with the columns of a one-record sample (`?_count=1`). A
    /// type the server doesn't hold falls back to the universal `id` element so it still appears.
    fn objects(&self) -> Result<Vec<SourceObject>> {
        let mut out = Vec::with_capacity(FHIR_RESOURCE_TYPES.len());
        for &rt in FHIR_RESOURCE_TYPES {
            let bundle = (self.fetch)(&self.search_url(rt, 1))?;
            let sample = Self::bundle_resources(&bundle);
            let columns = match sample.first() {
                Some(r) => sorted_record_columns(r),
                None => vec!["id".to_string()],
            };
            out.push(SourceObject { name: rt.to_string(), columns });
        }
        Ok(out)
    }

    /// Read every resource of `object` (the resource type), following Bundle pagination.
    fn read(&self, object: &str) -> Result<RowSet> {
        if !FHIR_RESOURCE_TYPES.contains(&object) {
            return Err(DataError::Schema(format!("unknown FHIR resource type '{object}'")));
        }
        let resources = self.collect_resources(self.search_url(object, self.page_size))?;
        Ok(Self::rows_from_resources(&resources))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A fetch closure that serves canned JSON keyed by URL substring, recording the URLs it saw.
    fn fixture_fetch(
        responses: Vec<(&'static str, Value)>,
        seen: std::sync::Arc<Mutex<Vec<String>>>,
    ) -> impl Fn(&str) -> Result<Value> + Send + Sync + 'static {
        move |url: &str| {
            seen.lock().unwrap().push(url.to_string());
            for (needle, body) in &responses {
                if url.contains(needle) {
                    return Ok(body.clone());
                }
            }
            Err(DataError::Io(format!("no fixture for {url}")))
        }
    }

    fn patient(id: &str, family: &str) -> Value {
        serde_json::json!({ "resourceType": "Patient", "id": id, "active": true, "name": [{ "family": family }] })
    }

    #[test]
    fn reads_a_resource_type_following_bundle_pagination() {
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let page1 = serde_json::json!({
            "resourceType": "Bundle",
            "entry": [{ "resource": patient("p1", "Smith") }],
            "link": [{ "relation": "next", "url": "https://fhir.test/Patient?page=2" }],
        });
        let page2 = serde_json::json!({
            "resourceType": "Bundle",
            "entry": [{ "resource": patient("p2", "Jones") }],
            "link": [{ "relation": "self", "url": "x" }],
        });
        let conn = FhirConnector::new(
            "fhir",
            "https://fhir.test/",
            fixture_fetch(vec![("page=2", page2), ("Patient", page1)], seen.clone()),
        );

        let rs = conn.read("Patient").unwrap();
        // Both pages' resources are collected; columns are the sorted union of top-level elements.
        assert_eq!(rs.rows.len(), 2);
        assert_eq!(rs.columns, vec!["active", "id", "name", "resourceType"]);
        let id_col = rs.columns.iter().position(|c| c == "id").unwrap();
        assert_eq!(rs.rows.iter().map(|r| r[id_col].as_str()).collect::<Vec<_>>(), vec!["p1", "p2"]);
        // The nested `name` array is rendered as compact JSON, not dropped.
        let name_col = rs.columns.iter().position(|c| c == "name").unwrap();
        assert!(rs.rows[0][name_col].contains("Smith"));
        // It followed the `next` link to the second page.
        assert!(seen.lock().unwrap().iter().any(|u| u.contains("page=2")));
    }

    #[test]
    fn objects_sample_columns_and_empty_type_falls_back_to_id() {
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let with_patient = serde_json::json!({ "resourceType": "Bundle", "entry": [{ "resource": patient("p1", "Smith") }] });
        let empty = serde_json::json!({ "resourceType": "Bundle", "entry": [] });
        // Patient has a sample; every other type returns an empty bundle.
        let conn = FhirConnector::new("fhir", "https://fhir.test/fhir", move |url: &str| {
            seen.lock().unwrap().push(url.to_string());
            Ok(if url.contains("/Patient?") { with_patient.clone() } else { empty.clone() })
        });
        let objs = conn.objects().unwrap();
        assert_eq!(objs.len(), FHIR_RESOURCE_TYPES.len());
        let pat = objs.iter().find(|o| o.name == "Patient").unwrap();
        assert_eq!(pat.columns, vec!["active", "id", "name", "resourceType"]);
        let enc = objs.iter().find(|o| o.name == "Encounter").unwrap();
        assert_eq!(enc.columns, vec!["id"]); // empty on this server → universal id fallback
    }

    #[test]
    fn unknown_resource_type_is_an_error() {
        let conn = FhirConnector::new("fhir", "https://fhir.test", |_: &str| Ok(Value::Null));
        assert!(conn.read("NotAResource").is_err());
    }
}
