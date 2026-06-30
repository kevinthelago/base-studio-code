//! Connector dev-loop transport (#1963): the authed HTTP + OS-keychain glue + sample-inference the
//! `bsc data connector` dev-loop verbs (`probe` / `try` / `map`) use to author and test a REST
//! connector on the fly, secret-free.
//!
//! Two contracts MUST stay byte-identical with the desktop app so the CLI reads the same secret the
//! app stored and authenticates the same way the live scan does:
//! - the OS-keychain account scheme — see [`keychain_account`] / `src-tauri/src/sources/credentials.rs`;
//! - the per-auth-kind HTTP header — see [`build_fetch`] / `src-tauri/src/sources/data/data_scan.rs`.
//!
//! The pure inference helpers ([`draft_from_openapi`], [`report_sample_shape`], [`run_try`],
//! [`map_to_model`]) keep the network behind a small surface so the dev-loop logic is unit-tested
//! against a mock fetch / inline fixtures — never hitting the network.

use std::time::Duration;

use serde_json::{json, Value};

use crate::connector::{Connector, FetchFn};
use crate::{DataError, DataModel, Entity, Field, FieldType, Result, RuntimePreset, RuntimeResource};

/// Hard per-request timeout for the dev-loop transport — bounded so a `try` / `probe` can never hang.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

// ── OS keychain ────────────────────────────────────────────────────────────

/// Keychain service namespace for all source-connector secrets.
///
/// MUST match `src-tauri/src/sources/credentials.rs` — keychain account scheme. The desktop app
/// stores connector secrets under this exact service name with the [`keychain_account`] account
/// string; the CLI replicates both byte-for-byte to resolve the same secret.
const KEYCHAIN_SERVICE: &str = "base-studio-code.source";

/// The keychain account string for one connector secret field.
///
/// MUST match `src-tauri/src/sources/credentials.rs::account` (the `fn account` there):
/// `{project}\u{1f}{source_uid}\u{1f}{field}` — the parts joined by the ASCII unit-separator
/// (U+001F) so they can't collide at a part boundary (`a|bc` vs `ab|c`).
fn keychain_account(project: &str, source_uid: &str, field: &str) -> String {
    format!("{project}\u{1f}{source_uid}\u{1f}{field}")
}

/// Resolve a connector secret from the OS keychain — the same value the desktop Source pane stored
/// (#1194). Returns `None` when no secret is stored (or the platform store is unavailable). The
/// secret never leaves this process: only the [`build_fetch`] transport, on-device, ever reads it.
pub fn resolve_source_secret(project: &str, source_uid: &str, field: &str) -> Option<String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_account(project, source_uid, field))
        .ok()?
        .get_password()
        .ok()
}

/// Which keychain field holds a runtime preset's secret, keyed by its declared auth method.
///
/// MIRRORS `src-tauri/src/sources/data/data_scan.rs::runtime_secret_field` so the CLI resolves the
/// same keychain field the app's scan does.
pub fn runtime_secret_field(auth: &str) -> &'static str {
    match auth {
        "basic" => "password",
        "apikey" => "apiKey",
        "token" => "token",
        _ => "accessToken", // oauth
    }
}

// ── authed transport ───────────────────────────────────────────────────────

/// Join a request path onto a base URL — an already-absolute path passes through, an empty path maps
/// to the base root. MIRRORS `data_scan.rs::build_url`.
fn join_url(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        path.to_string()
    } else if path.is_empty() {
        format!("{}/", base.trim_end_matches('/'))
    } else {
        format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
    }
}

/// Build a read-only blocking [`FetchFn`] (`path` → parsed JSON) authenticating per `auth`.
///
/// The per-auth-kind header MIRRORS `src-tauri/src/sources/data/data_scan.rs`:
/// - `basic` → HTTP Basic (`Authorization: Basic`), via `basic_auth` (data_scan's `basic_fetch`);
/// - `token` / `apikey` / `oauth` → a bearer header (`Authorization: Bearer`), via `bearer_auth`
///   (data_scan's `bearer_fetch`; in `scan_rest_preset` every non-`basic` method rides the bearer
///   transport). An empty secret omits the header (same as `bearer_fetch`).
///
/// `basic` auth has no username available at this call site (data_scan reads `fields["user"]`, which
/// the dev-loop handle doesn't carry), so the secret is sent as the Basic password with an empty
/// username — sufficient for token-in-basic APIs; a user-scoped Basic source needs the desktop scan.
/// Bounded by a hard [`REQUEST_TIMEOUT`].
pub fn build_fetch(base_url: &str, auth: &str, secret: Option<String>) -> FetchFn {
    let base = base_url.trim_end_matches('/').to_string();
    let auth = auth.to_string();
    let secret = secret.unwrap_or_default();
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::blocking::Client::new());
    Box::new(move |path: &str| -> Result<Value> {
        let req = client.get(join_url(&base, path)).header("Accept", "application/json");
        let req = if auth == "basic" {
            req.basic_auth("", Some(&secret))
        } else if secret.is_empty() {
            req
        } else {
            req.bearer_auth(&secret)
        };
        req.send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| DataError::Io(e.to_string()))
    })
}

// ── field-type inference ───────────────────────────────────────────────────

/// The canonical lowercase string for a [`FieldType`] (matches the serde form + the frontend shape).
pub fn field_type_str(ty: FieldType) -> &'static str {
    match ty {
        FieldType::String => "string",
        FieldType::Number => "number",
        FieldType::Bool => "bool",
        FieldType::Date => "date",
        FieldType::Money => "money",
        FieldType::Enum => "enum",
        FieldType::Ref => "ref",
    }
}

/// Parse a [`FieldType`] from its lowercase string; anything unknown falls back to `String`.
pub fn field_type_from_str(s: &str) -> FieldType {
    match s {
        "number" => FieldType::Number,
        "bool" | "boolean" => FieldType::Bool,
        "date" => FieldType::Date,
        "money" => FieldType::Money,
        "enum" => FieldType::Enum,
        "ref" => FieldType::Ref,
        _ => FieldType::String,
    }
}

/// A `YYYY-MM-DD…` prefix — the cheap date heuristic used by [`infer_field_type`].
fn looks_like_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 10
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

/// Best-effort [`FieldType`] for a column from its sampled string cells (simple — the crate carries
/// no richer inference). Empty samples ⇒ `String`; all-bool ⇒ `Bool`; all-numeric ⇒ `Number`;
/// all date-shaped ⇒ `Date`; else `String`.
pub fn infer_field_type(samples: &[&str]) -> FieldType {
    let vals: Vec<&str> = samples.iter().copied().filter(|s| !s.is_empty()).collect();
    if vals.is_empty() {
        return FieldType::String;
    }
    if vals.iter().all(|s| matches!(s.to_ascii_lowercase().as_str(), "true" | "false")) {
        return FieldType::Bool;
    }
    if vals.iter().all(|s| s.parse::<f64>().is_ok()) {
        return FieldType::Number;
    }
    if vals.iter().all(|s| looks_like_date(s)) {
        return FieldType::Date;
    }
    FieldType::String
}

// ── probe: OpenAPI / sample-shape inference ────────────────────────────────

/// The last non-templated segment of a request path (`/api/v1/customers/{id}` → `customers`), the
/// connector object name guess. Falls back to `root` for an empty/all-templated path.
fn resource_name_from_path(path: &str) -> String {
    path.split('/')
        .rfind(|seg| !seg.is_empty() && !seg.starts_with('{'))
        .unwrap_or("root")
        .to_string()
}

/// Does a JSON-response schema return an array, and where does that array live? `(true, None)` for a
/// bare array schema; `(true, Some(prop))` for an object with an array-typed property; `(false, _)`
/// otherwise.
fn schema_array_shape(schema: &Value) -> (bool, Option<String>) {
    if schema.get("type").and_then(Value::as_str) == Some("array") {
        return (true, None);
    }
    if let Some(props) = schema.get("properties").and_then(Value::as_object) {
        for (k, v) in props {
            if v.get("type").and_then(Value::as_str) == Some("array") {
                return (true, Some(k.clone()));
            }
        }
    }
    (false, None)
}

/// The array shape of a GET operation's `200`/`201`/`default` JSON response schema.
fn openapi_get_array_shape(get: &Value) -> (bool, Option<String>) {
    let responses = match get.get("responses").and_then(Value::as_object) {
        Some(r) => r,
        None => return (false, None),
    };
    let schema = responses
        .get("200")
        .or_else(|| responses.get("201"))
        .or_else(|| responses.get("default"))
        .and_then(|r| r.get("content"))
        .and_then(|c| c.get("application/json"))
        .and_then(|j| j.get("schema"));
    match schema {
        Some(s) => schema_array_shape(s),
        None => (false, None),
    }
}

/// Guess the runtime auth kind from an OpenAPI doc's `components.securitySchemes` (HTTP basic →
/// `basic`, HTTP bearer → `token`, `apiKey` → `apikey`, `oauth2` → `oauth`); defaults to `token`.
fn openapi_guess_auth(spec: &Value) -> String {
    let schemes = spec.get("components").and_then(|c| c.get("securitySchemes")).and_then(Value::as_object);
    if let Some(schemes) = schemes {
        for s in schemes.values() {
            match s.get("type").and_then(Value::as_str).unwrap_or("") {
                "http" => {
                    let scheme = s.get("scheme").and_then(Value::as_str).unwrap_or("");
                    return if scheme.eq_ignore_ascii_case("basic") { "basic".into() } else { "token".into() };
                }
                "apiKey" => return "apikey".into(),
                "oauth2" => return "oauth".into(),
                _ => {}
            }
        }
    }
    "token".into()
}

/// Build a draft [`RuntimePreset`] from an OpenAPI / Swagger doc: id/label placeholders (label from
/// `info.title` when present), auth guessed from `securitySchemes`, and one resource per GET path
/// whose JSON response is an array (with an `array_key` guess for an enveloped array). `base_url` is
/// the probe's `--base-url` (the doc's first `servers[].url` is the fallback). Read-only / pure.
pub fn draft_from_openapi(spec: &Value, base_url: &str) -> RuntimePreset {
    let mut resources = Vec::new();
    if let Some(paths) = spec.get("paths").and_then(Value::as_object) {
        for (path, item) in paths {
            let get = match item.get("get") {
                Some(g) => g,
                None => continue,
            };
            let (returns_array, array_key) = openapi_get_array_shape(get);
            if !returns_array {
                continue;
            }
            resources.push(RuntimeResource {
                name: resource_name_from_path(path),
                path: path.trim_start_matches('/').to_string(),
                array_key,
            });
        }
    }
    resources.sort_by(|a, b| a.path.cmp(&b.path));
    let base = if base_url.trim().is_empty() {
        spec.get("servers")
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(|s| s.get("url"))
            .and_then(Value::as_str)
            .map(|s| s.trim_end_matches('/').to_string())
    } else {
        Some(base_url.trim_end_matches('/').to_string())
    };
    RuntimePreset {
        id: "draft-connector".into(),
        label: spec
            .get("info")
            .and_then(|i| i.get("title"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Draft connector")
            .to_string(),
        category: String::new(),
        base_url: base,
        auth: openapi_guess_auth(spec),
        oauth: None,
        resources,
    }
}

/// Report the JSON shape of a single sampled response + a draft manifest: top-level keys, the
/// detected record-array location (`arrayKey`), and the sample field names, plus a one-resource
/// [`RuntimePreset`] draft. Read-only / pure.
pub fn report_sample_shape(body: &Value, base_url: &str, path: &str) -> Value {
    let (array_key, sample): (Option<String>, Option<&Value>) = if body.is_array() {
        (None, body.as_array().and_then(|a| a.first()))
    } else if let Some(map) = body.as_object() {
        match map.iter().find(|(_, v)| v.is_array()).map(|(k, _)| k.clone()) {
            Some(k) => {
                let first = map.get(&k).and_then(Value::as_array).and_then(|a| a.first());
                (Some(k), first)
            }
            None => (None, Some(body)),
        }
    } else {
        (None, None)
    };
    let top_keys: Vec<String> =
        body.as_object().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let sample_fields: Vec<String> = sample
        .and_then(Value::as_object)
        .map(|m| {
            let mut v: Vec<String> = m.keys().cloned().collect();
            v.sort();
            v
        })
        .unwrap_or_default();
    let manifest = RuntimePreset {
        id: "draft-connector".into(),
        label: "Draft connector".into(),
        category: String::new(),
        base_url: if base_url.trim().is_empty() {
            None
        } else {
            Some(base_url.trim_end_matches('/').to_string())
        },
        auth: "token".into(),
        oauth: None,
        resources: vec![RuntimeResource {
            name: resource_name_from_path(path),
            path: path.trim_start_matches('/').to_string(),
            array_key: array_key.clone(),
        }],
    };
    json!({
        "baseUrl": base_url,
        "path": path,
        "topLevelKeys": top_keys,
        "arrayKey": array_key,
        "sampleFields": sample_fields,
        "manifest": manifest,
    })
}

// ── try: sample-reads-only dry run ─────────────────────────────────────────

/// Sample-read a built connector and report its resources — **persists nothing**. Caps at `obj_cap`
/// objects; each object is read once and capped to `row_cap` rows, with fields (name + inferred
/// type) derived from the sample. Returns
/// `{ "live": bool, "resources": [ { "name", "count", "fields": [{"name","type"}…] }… ], "error"? }`.
/// Pure over the [`Connector`] — tests inject a mock fetch in place of the network.
pub fn run_try(conn: &dyn Connector, obj_cap: usize, row_cap: usize) -> Value {
    let objs = match conn.objects() {
        Ok(o) => o,
        Err(e) => return json!({ "live": false, "resources": [], "error": e.to_string() }),
    };
    let mut resources = Vec::new();
    for o in objs.into_iter().take(obj_cap) {
        let rs = match conn.read(&o.name) {
            Ok(r) => r,
            Err(_) => {
                resources.push(json!({ "name": o.name, "count": 0, "fields": [] }));
                continue;
            }
        };
        let sample: Vec<&Vec<String>> = rs.rows.iter().take(row_cap).collect();
        let fields: Vec<Value> = rs
            .columns
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let samples: Vec<&str> =
                    sample.iter().filter_map(|r| r.get(i).map(String::as_str)).collect();
                json!({ "name": name, "type": field_type_str(infer_field_type(&samples)) })
            })
            .collect();
        resources.push(json!({ "name": o.name, "count": sample.len(), "fields": fields }));
    }
    json!({ "live": true, "resources": resources })
}

// ── map: starter canonical Data Model ──────────────────────────────────────

/// Build a starter canonical [`DataModel`] from a `try`-style result (or a manifest) JSON: one
/// [`Entity`] per `resources[]` element, [`Field`]s from each element's `fields[]` (name + a
/// best-effort [`FieldType`]). Identities/refs are left for the agent to refine. Pure.
pub fn map_to_model(input: &Value) -> DataModel {
    let resources = input.get("resources").and_then(Value::as_array).cloned().unwrap_or_default();
    let entities = resources
        .iter()
        .map(|r| {
            let key = r.get("name").and_then(Value::as_str).unwrap_or("entity").to_string();
            let fields = r
                .get("fields")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|f| {
                            let fkey = f.get("name").and_then(Value::as_str).unwrap_or("field").to_string();
                            let ty = f
                                .get("type")
                                .and_then(Value::as_str)
                                .map(field_type_from_str)
                                .unwrap_or(FieldType::String);
                            Field {
                                key: fkey,
                                label: String::new(),
                                ty,
                                required: false,
                                reference: None,
                                enum_values: vec![],
                                validate: None,
                            }
                        })
                        .collect()
                })
                .unwrap_or_default();
            Entity { key: key.clone(), label: key, fields, identity: vec![] }
        })
        .collect();
    DataModel { name: "Draft model".into(), version: 1, entities }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rest::{RestConnector, RestResource};

    /// DRIFT-GUARD: the keychain account string MUST match
    /// `src-tauri/src/sources/credentials.rs::account` byte-for-byte, or the CLI resolves a different
    /// (missing) secret than the app stored. Asserts the literal format + the unit-separator byte.
    #[test]
    fn keychain_account_matches_the_documented_scheme() {
        assert_eq!(KEYCHAIN_SERVICE, "base-studio-code.source");
        assert_eq!(keychain_account("proj", "src-1", "token"), "proj\u{1f}src-1\u{1f}token");
        // The separator is exactly the ASCII unit-separator (0x1F) between each part.
        assert_eq!(keychain_account("a", "bc", "f").as_bytes(), &[b'a', 0x1f, b'b', b'c', 0x1f, b'f']);
        // The separator prevents a part-boundary collision (a|bc vs ab|c).
        assert_ne!(keychain_account("a", "bc", "f"), keychain_account("ab", "c", "f"));
    }

    #[test]
    fn runtime_secret_field_mirrors_data_scan() {
        assert_eq!(runtime_secret_field("basic"), "password");
        assert_eq!(runtime_secret_field("apikey"), "apiKey");
        assert_eq!(runtime_secret_field("token"), "token");
        assert_eq!(runtime_secret_field("oauth"), "accessToken");
    }

    #[test]
    fn join_url_handles_absolute_empty_and_relative_paths() {
        assert_eq!(join_url("https://x.example.com", "contacts"), "https://x.example.com/contacts");
        assert_eq!(join_url("https://x.example.com/", "/contacts"), "https://x.example.com/contacts");
        assert_eq!(join_url("https://x.example.com", ""), "https://x.example.com/");
        assert_eq!(join_url("https://x.example.com", "https://other/abs"), "https://other/abs");
    }

    #[test]
    fn infer_field_type_classifies_samples() {
        assert_eq!(infer_field_type(&["1", "2", "3"]), FieldType::Number);
        assert_eq!(infer_field_type(&["true", "False"]), FieldType::Bool);
        assert_eq!(infer_field_type(&["2024-01-15", "2025-06-01"]), FieldType::Date);
        assert_eq!(infer_field_type(&["Acme", "Globex"]), FieldType::String);
        assert_eq!(infer_field_type(&[]), FieldType::String);
        assert_eq!(infer_field_type(&["", ""]), FieldType::String);
    }

    #[test]
    fn draft_from_openapi_picks_array_returning_gets() {
        let spec = json!({
            "info": { "title": "Acme API" },
            "components": { "securitySchemes": { "bearer": { "type": "http", "scheme": "bearer" } } },
            "paths": {
                "/customers": { "get": { "responses": { "200": { "content": { "application/json": { "schema": { "type": "array" } } } } } } },
                "/orders": { "get": { "responses": { "200": { "content": { "application/json": { "schema": { "type": "object", "properties": { "items": { "type": "array" } } } } } } } } },
                "/health": { "get": { "responses": { "200": { "content": { "application/json": { "schema": { "type": "object", "properties": { "ok": { "type": "boolean" } } } } } } } } },
                "/customers/{id}": { "get": { "responses": { "200": { "content": { "application/json": { "schema": { "type": "object" } } } } } } }
            }
        });
        let draft = draft_from_openapi(&spec, "https://acme.example.com/api");
        assert_eq!(draft.auth, "token");
        assert_eq!(draft.label, "Acme API");
        assert_eq!(draft.base_url.as_deref(), Some("https://acme.example.com/api"));
        let names: Vec<&str> = draft.resources.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"customers"), "{names:?}");
        assert!(names.contains(&"orders"), "{names:?}");
        assert!(!names.contains(&"health"), "non-array GET excluded: {names:?}");
        let orders = draft.resources.iter().find(|r| r.name == "orders").unwrap();
        assert_eq!(orders.array_key.as_deref(), Some("items"));
        let customers = draft.resources.iter().find(|r| r.name == "customers").unwrap();
        assert_eq!(customers.array_key, None);
        // The draft is a well-formed, secret-free preset.
        assert!(draft.validate().is_ok(), "{:?}", draft.validate());
    }

    #[test]
    fn openapi_guess_auth_reads_security_schemes() {
        let basic = json!({ "components": { "securitySchemes": { "b": { "type": "http", "scheme": "basic" } } } });
        assert_eq!(openapi_guess_auth(&basic), "basic");
        let key = json!({ "components": { "securitySchemes": { "k": { "type": "apiKey", "in": "header", "name": "X-Key" } } } });
        assert_eq!(openapi_guess_auth(&key), "apikey");
        let oauth = json!({ "components": { "securitySchemes": { "o": { "type": "oauth2" } } } });
        assert_eq!(openapi_guess_auth(&oauth), "oauth");
        assert_eq!(openapi_guess_auth(&json!({})), "token");
    }

    #[test]
    fn report_sample_shape_detects_array_key_and_fields() {
        let body = json!({ "data": [ { "id": 1, "name": "Acme" } ], "page": 1 });
        let r = report_sample_shape(&body, "https://x.example.com", "contacts");
        assert_eq!(r["arrayKey"], json!("data"));
        assert_eq!(r["sampleFields"], json!(["id", "name"]));
        assert_eq!(r["manifest"]["resources"][0]["array_key"], json!("data"));
        assert_eq!(r["manifest"]["resources"][0]["name"], json!("contacts"));

        // A bare top-level array → no envelope key.
        let bare = json!([ { "sku": "A1", "qty": 5 } ]);
        let r2 = report_sample_shape(&bare, "https://x", "stock");
        assert_eq!(r2["arrayKey"], Value::Null);
        assert_eq!(r2["sampleFields"], json!(["qty", "sku"]));
    }

    #[test]
    fn run_try_caps_objects_and_rows_infers_fields_and_persists_nothing() {
        // 15 resources (> the 12 object cap); each returns 50 rows (> the 20 row cap).
        let resources: Vec<RestResource> =
            (0..15).map(|i| RestResource::new(format!("r{i}"), format!("r{i}"), Some("data"))).collect();
        let conn = RestConnector::new("mock", resources, |_path: &str| {
            let rows: Vec<Value> = (0..50)
                .map(|i| json!({ "id": i, "active": true, "name": format!("w{i}") }))
                .collect();
            Ok(json!({ "data": rows }))
        });
        let out = run_try(&conn, 12, 20);
        assert_eq!(out["live"], json!(true));
        let res = out["resources"].as_array().unwrap();
        assert_eq!(res.len(), 12, "object cap applied");
        assert_eq!(res[0]["count"], json!(20), "row cap applied");
        let fields = res[0]["fields"].as_array().unwrap();
        let ty = |n: &str| {
            fields.iter().find(|f| f["name"] == json!(n)).unwrap()["type"].as_str().unwrap().to_string()
        };
        assert_eq!(ty("id"), "number");
        assert_eq!(ty("active"), "bool");
        assert_eq!(ty("name"), "string");
        // run_try is pure over the connector — no store handle exists to write to; nothing persisted.
    }

    #[test]
    fn run_try_reports_an_error_when_the_fetch_fails() {
        let conn = RestConnector::new(
            "bad",
            vec![RestResource::new("x", "x", None)],
            |_p: &str| Err(DataError::Io("boom".into())),
        );
        let out = run_try(&conn, 12, 20);
        assert_eq!(out["live"], json!(false));
        assert!(out["error"].as_str().unwrap().contains("boom"));
    }

    #[test]
    fn map_builds_one_entity_per_resource() {
        let input = json!({ "resources": [
            { "name": "account", "count": 2, "fields": [ { "name": "id", "type": "number" }, { "name": "name", "type": "string" } ] },
            { "name": "contact", "count": 1, "fields": [ { "name": "email", "type": "string" } ] },
        ] });
        let m = map_to_model(&input);
        assert_eq!(m.entities.len(), 2);
        assert_eq!(m.entities[0].key, "account");
        assert_eq!(m.entities[0].label, "account");
        assert_eq!(m.entities[0].fields.len(), 2);
        assert_eq!(m.entities[0].fields[0].ty, FieldType::Number);
        assert_eq!(m.entities[1].key, "contact");
        assert_eq!(m.entities[1].fields[0].ty, FieldType::String);
        // A manifest (resources without `fields`) maps to entities with no fields, not a panic.
        let manifest = json!({ "resources": [ { "name": "lead", "path": "leads" } ] });
        let m2 = map_to_model(&manifest);
        assert_eq!(m2.entities.len(), 1);
        assert_eq!(m2.entities[0].key, "lead");
        assert!(m2.entities[0].fields.is_empty());
    }
}
