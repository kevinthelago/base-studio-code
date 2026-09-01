//! Live-socket integration tests for the agent-authored connector chain
//! (`the-connector-chain-has-never-been-run-against-a-real-socket`).
//!
//! # The gap these close
//!
//! This crate carries 52 tests across the connector path — transport, rest, runtime, connector,
//! shape — and before this module **not one of them opened a socket**. Every one is a pure unit test
//! over a `serde_json::Value` the test itself constructed. So the only part that talks to a real
//! system had no coverage at all: `build_fetch` → reqwest → a server → a real body →
//! `report_sample_shape` / `run_try`.
//!
//! That is the failure shape this repo keeps paying for — a green suite that structurally cannot
//! observe the defect. A connector that mis-joins its URL, sends a request the server rejects, or
//! cannot reach anything passes all 52 of them.
//!
//! These drive the GENUINE path: the real `build_fetch` closure, the real reqwest blocking client,
//! over a real TCP connection to a localhost server. Nothing is stubbed or injected.
//!
//! # Why a local server, and no new dependency
//!
//! Deterministic, offline, no rate limit and no vendor drift, so it runs in the gate on every
//! machine rather than only where the network allows. The precedent is `crates/llm/src/http_it.rs`,
//! which binds `127.0.0.1:0`, answers from a background thread and stops on drop; no mock-HTTP crate
//! is declared anywhere in this workspace and none is added here. The one thing the connector case
//! needs that the precedent lacks is **routing** — a connector reads several resources by path, and
//! a single canned response cannot tell a correct path join from a broken one.
//!
//! # Why these pass on Linux despite the broken keychain
//!
//! `the-keychain-has-no-linux-backend-so-every-source-secret-is-lost` means no credential resolves on
//! Linux at all: `keyring` falls back to an in-process mock that is empty in the next process. These
//! tests are unaffected BY CONSTRUCTION, not by luck — [`build_fetch`] omits the `Authorization`
//! header entirely when the secret is empty, so a credential-free fixture server exercises the whole
//! real path with the keychain never consulted. The preset still declares a sanctioned `auth` kind
//! because `auth` is required and has no `none` variant; it simply resolves no secret.
//!
//! **Do not read a pass here as evidence the keychain works.** It is evidence the transport works.

use crate::descriptor::RestPreset;
use crate::transport::{build_fetch, report_sample_shape, run_try};
use crate::{RuntimePreset, RuntimeResource};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ── the fixture server ──────────────────────────────────────────────────────────────────────────

/// A routed localhost JSON API on an ephemeral port, serving a fixed route table over a real socket.
///
/// Routing is what makes this more than the `llm` precedent: an unknown path answers **404**, so a
/// wrong URL join fails loudly here instead of quietly receiving the one canned body it would get
/// from a single-response mock. That distinction is the point — `join_url` is exactly the kind of
/// string handling that is wrong in one direction and invisible in a unit test.
///
/// Requires no credential, by design: see the module note.
struct MockApi {
    base: String,
    shutdown: Arc<AtomicBool>,
}

impl Drop for MockApi {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }
}

impl MockApi {
    /// Serve `routes` — `(path, json body)` pairs, matched on the request target exactly.
    fn start(routes: Vec<(&'static str, String)>) -> Self {
        Self::start_counting(routes, Arc::new(std::sync::atomic::AtomicUsize::new(0)))
    }

    /// As [`start`], counting every request it answers — so a test can assert how many round trips a
    /// verb actually makes, which no unit test over a `Value` can see.
    fn start_counting(routes: Vec<(&'static str, String)>, hits: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let sd = shutdown.clone();
        std::thread::spawn(move || {
            while !sd.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut s, _)) => {
                        s.set_nonblocking(false).ok();
                        s.set_read_timeout(Some(Duration::from_millis(200))).ok();
                        // Read the request head. These are GETs, so the head is the whole request —
                        // but drain to the blank line anyway so the client's write always completes
                        // before we answer and close.
                        let mut data: Vec<u8> = Vec::new();
                        let mut chunk = [0u8; 4096];
                        loop {
                            match s.read(&mut chunk) {
                                Ok(0) => break,
                                Ok(k) => {
                                    data.extend_from_slice(&chunk[..k]);
                                    if data.windows(4).any(|w| w == b"\r\n\r\n") {
                                        break;
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        let head = String::from_utf8_lossy(&data);
                        // "GET /users HTTP/1.1" → "/users"
                        let target = head
                            .lines()
                            .next()
                            .and_then(|l| l.split_whitespace().nth(1))
                            .unwrap_or("/")
                            .to_string();
                        hits.fetch_add(1, Ordering::Relaxed);
                        let (status, body) = match routes.iter().find(|(p, _)| *p == target) {
                            Some((_, b)) => ("200 OK", b.clone()),
                            None => ("404 Not Found", format!("{{\"error\":\"no route {target}\"}}")),
                        };
                        let _ = write!(
                            s,
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        );
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(4))
                    }
                    Err(_) => break,
                }
            }
        });
        MockApi { base: format!("http://{addr}"), shutdown }
    }
}

/// The fixture the server serves — deliberately shaped to cover the three response layouts a real
/// REST API mixes, because they are what `array_key` exists to tell apart:
///   - `/users`  — the body IS the array (no `array_key`);
///   - `/orders` — records nested under `data` (an `array_key`);
///   - `/regions` — a single-record array, so a count of 1 is distinguishable from a broken read.
fn fixture_routes() -> Vec<(&'static str, String)> {
    vec![
        (
            "/users",
            serde_json::json!([
                { "id": "u1", "email": "ada@example.test", "age": 36, "active": true },
                { "id": "u2", "email": "grace@example.test", "age": 45, "active": false },
            ])
            .to_string(),
        ),
        (
            "/orders",
            serde_json::json!({
                "data": [
                    { "id": "o1", "user_id": "u1", "total": "12.50" },
                    { "id": "o2", "user_id": "u2", "total": "99.00" },
                    { "id": "o3", "user_id": "u1", "total": "3.25" },
                ],
                "next": null
            })
            .to_string(),
        ),
        ("/regions", serde_json::json!([{ "id": "r1", "name": "eu-west" }]).to_string()),
    ]
}

/// The preset an agent would author for [`fixture_routes`], as `bsc data connector add` would store
/// it: secret-free, a sanctioned auth kind, one resource per route.
fn fixture_preset(base: &str) -> RuntimePreset {
    RuntimePreset {
        id: "fixture-api".into(),
        label: "Fixture API".into(),
        category: "test".into(),
        base_url: Some(base.to_string()),
        auth: "token".into(),
        oauth: None,
        resources: vec![
            RuntimeResource { name: "users".into(), path: "users".into(), array_key: None },
            RuntimeResource {
                name: "orders".into(),
                path: "orders".into(),
                array_key: Some("data".into()),
            },
            RuntimeResource { name: "regions".into(), path: "regions".into(), array_key: None },
        ],
    }
}

// ── probe: the real fetch, against a real server ────────────────────────────────────────────────

/// `bsc data connector probe` end to end: the genuine `build_fetch` closure reaches the server, and
/// the body it actually received becomes the shape report.
#[test]
fn probe_reads_a_live_endpoint_and_reports_its_real_shape() {
    let api = MockApi::start(fixture_routes());
    // Exactly what `cmd_connector_probe` builds — no secret, so no Authorization header is sent.
    let fetch = build_fetch(&api.base, "token", None);
    let body = (fetch)("users").expect("the fixture server must answer /users");
    let report = report_sample_shape(&body, &api.base, "users");

    // The body IS the array here, so there is no array_key to report.
    assert_eq!(report["arrayKey"], serde_json::Value::Null, "report: {report}");
    let fields = report["sampleFields"].as_array().expect("a shape report names its sample fields");
    let names: Vec<&str> = fields.iter().filter_map(serde_json::Value::as_str).collect();
    for expected in ["active", "age", "email", "id"] {
        assert!(names.contains(&expected), "probe must report `{expected}` — got {names:?}");
    }

    // The draft manifest is the part an agent actually keeps: it must already point at this server
    // and name the resource after the path, or `probe | validate | add` is not a usable loop.
    //
    // NOTE THE KEY CASING, because it will trip the next reader as it tripped this test: the report's
    // OWN keys are camelCase (`baseUrl`, `arrayKey`, `topLevelKeys`, `sampleFields`) while the
    // manifest nested inside it is the serde form of `RuntimePreset` and is snake_case (`base_url`).
    // One document, two conventions, and an agent is asked to read both. Pinned here rather than
    // quietly worked around, so that changing it is a decision and this test is what fails.
    assert_eq!(report["manifest"]["base_url"], api.base.as_str(), "{report}");
    assert_eq!(report["manifest"]["resources"][0]["name"], "users", "{report}");
    assert!(report["manifest"]["baseUrl"].is_null(), "the manifest is snake_case, not camel: {report}");
}

/// The nested case, which is the one a single-response mock cannot distinguish: records under a key.
#[test]
fn probe_finds_the_array_key_when_records_are_nested() {
    let api = MockApi::start(fixture_routes());
    let fetch = build_fetch(&api.base, "token", None);
    let body = (fetch)("orders").expect("the fixture server must answer /orders");
    let report = report_sample_shape(&body, &api.base, "orders");
    assert_eq!(report["arrayKey"], "data", "the records live under `data`: {report}");
}

/// THE URL JOIN, which is why the server routes rather than answering everything.
///
/// `join_url` trims and re-joins a base and a path. A mock that returns one canned body for every
/// request cannot tell a correct join from a broken one — both "succeed". Here a wrong path gets a
/// real 404 and `error_for_status` turns it into an error, so the join is genuinely under test.
#[test]
fn a_path_that_does_not_exist_is_an_error_not_an_empty_success() {
    let api = MockApi::start(fixture_routes());
    let fetch = build_fetch(&api.base, "token", None);
    let err = (fetch)("no-such-resource").expect_err("a 404 must surface as an error");
    let msg = err.to_string();
    assert!(msg.contains("404"), "the error must carry the status: {msg}");
}

/// A leading slash and a trailing slash must join to the same place — the asymmetry `join_url`
/// exists to absorb, verified against a server that will 404 if it gets it wrong.
#[test]
fn the_base_and_path_join_the_same_way_however_they_are_spelled() {
    let api = MockApi::start(fixture_routes());
    for (base, path) in [
        (api.base.clone(), "users"),
        (format!("{}/", api.base), "users"),
        (api.base.clone(), "/users"),
        (format!("{}/", api.base), "/users"),
    ] {
        let fetch = build_fetch(&base, "token", None);
        let body = (fetch)(path).unwrap_or_else(|e| panic!("base {base:?} + path {path:?}: {e}"));
        assert!(body.is_array(), "base {base:?} + path {path:?} must reach /users");
    }
}

// ── try: validate, then read every resource over the socket ─────────────────────────────────────

/// The hand-authored preset — the shape `bsc data connector add` would store — is registrable.
#[test]
fn the_fixture_preset_validates_unmodified() {
    let api = MockApi::start(fixture_routes());
    fixture_preset(&api.base).validate().expect("the authored preset must be registrable as-is");
}

/// THE LOOP CLOSES: the draft `probe` ACTUALLY EMITTED must itself validate, with no human repair.
///
/// This is a different claim from the test above and the one the charter's `probe → validate → add`
/// sequence depends on. A draft that reads correctly but cannot be stored makes the documented loop
/// a lie at step three, and nothing else in this crate checks it: `report_sample_shape` builds the
/// manifest by hand, and `validate` has only ever been run against presets a test wrote.
#[test]
fn the_draft_probe_emits_is_itself_registrable() {
    let api = MockApi::start(fixture_routes());
    let fetch = build_fetch(&api.base, "token", None);
    let body = (fetch)("orders").expect("the fixture server must answer /orders");
    let report = report_sample_shape(&body, &api.base, "orders");

    // Round-trip the emitted manifest through the very type `add` deserializes into — not a
    // hand-copied equivalent, so a serde-shape change breaks this rather than sliding past.
    let draft: RuntimePreset = serde_json::from_value(report["manifest"].clone())
        .expect("probe's manifest must deserialize as the type `add` stores");
    draft.validate().expect("probe must emit a registrable draft, not one a human has to repair");

    // And it must have carried the nesting it just discovered, or `add` stores a connector that
    // reads zero rows from the resource probe was pointed at.
    assert_eq!(draft.resources.len(), 1, "one resource, for the path probed");
    assert_eq!(draft.resources[0].array_key.as_deref(), Some("data"), "draft: {draft:?}");
    assert_eq!(draft.base_url.as_deref(), Some(api.base.as_str()));
}

/// `bsc data connector try` end to end — the whole point of the slice.
///
/// This is the first time in this crate's history that `run_try` has read from anything but a
/// hand-built `Value`: a real connector, a real fetch closure, three real HTTP round trips.
#[test]
fn try_reads_every_resource_live_with_real_counts_and_fields() {
    let api = MockApi::start(fixture_routes());
    let preset = fixture_preset(&api.base);
    preset.validate().expect("precondition: the preset is valid");

    // Exactly `cmd_connector_try`'s construction, minus the keychain lookup that returns None here.
    let fetch = build_fetch(&api.base, &preset.auth, None);
    let conn = preset.connector(preset.id.clone(), fetch);
    let result = run_try(&conn, 12, 20);

    assert_eq!(result["live"], true, "the connector must reach the fixture server: {result}");
    let resources = result["resources"].as_array().expect("try reports its resources");
    let by_name: std::collections::HashMap<&str, &serde_json::Value> = resources
        .iter()
        .filter_map(|r| r["name"].as_str().map(|n| (n, r)))
        .collect();

    // The counts are the fixture's, which is what says the rows were really read rather than the
    // request merely succeeding. `orders` is the nested one — a broken array_key reads as 0.
    //
    // NOTE for whoever derives an integration node's health from this: `count` is the SAMPLED row
    // count, capped at `row_cap` (20 here, 20 in the CLI) — it is not a total, and must never be
    // rendered as one.
    assert_eq!(by_name["users"]["count"], 2, "{result}");
    assert_eq!(by_name["orders"]["count"], 3, "a nested array_key must still yield rows: {result}");
    assert_eq!(by_name["regions"]["count"], 1, "{result}");

    // `fields` are {name, type} objects — the inferred type is derived from the sampled values, so
    // this also proves the ROWS came back parsed, not just that the request returned 200.
    let user_fields = by_name["users"]["fields"].as_array().expect("fields per resource");
    let names: Vec<&str> = user_fields.iter().filter_map(|f| f["name"].as_str()).collect();
    assert!(names.contains(&"email"), "read must surface real field names — got {names:?}");
    let age = user_fields.iter().find(|f| f["name"] == "age").expect("an `age` field: {user_fields:?}");
    assert_eq!(age["type"], "number", "the type must be INFERRED from the sampled values: {age}");
}

/// A dead endpoint must report `live: false` WITH the reason, not an empty success.
///
/// The distinction matters beyond tidiness: an integration node's health is derived from this, and
/// "reached nothing" rendering the same as "reached something with no rows" would make the node lie.
#[test]
fn a_closed_port_is_reported_as_not_live_rather_than_empty() {
    // Bind and immediately drop, so the port is real but nothing is listening on it.
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    let base = format!("http://{dead}");
    let preset = fixture_preset(&base);
    let fetch = build_fetch(&base, &preset.auth, None);
    let conn = preset.connector(preset.id.clone(), fetch);
    let result = run_try(&conn, 12, 20);

    // The MECHANISM, stated because it is not obvious and the health signal depends on it:
    // `RestConnector::objects()` calls `records()` per resource, so it FETCHES. On a dead endpoint it
    // errors, and `run_try` short-circuits to `{live:false, resources:[], error}` — it does not fall
    // through to the `live: true` tail. Assert the real contract, not merely "not true".
    assert_eq!(result["live"], false, "a connector that reached nothing is not live: {result}");
    assert_eq!(
        result["resources"].as_array().map(Vec::len),
        Some(0),
        "no resource may be reported when nothing was reachable: {result}"
    );
    let err = result["error"].as_str().unwrap_or_default();
    assert!(!err.is_empty(), "the failure must carry a reason a human can act on: {result}");
}

/// A CONSEQUENCE of the mechanism above, pinned because whatever derives an integration's health
/// will be tempted to call `try` on a schedule: `objects()` fetches every resource to union its
/// columns, and `run_try` then calls `read()` on each one again. So one `try` costs **two** requests
/// per resource, not one. Against a rate-limited vendor that is the difference between a health check
/// that is polite and one that gets the integration throttled.
#[test]
fn one_try_costs_two_requests_per_resource() {
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = hits.clone();
    let api = MockApi::start_counting(fixture_routes(), counted);
    let preset = fixture_preset(&api.base);
    let fetch = build_fetch(&api.base, &preset.auth, None);
    let conn = preset.connector(preset.id.clone(), fetch);
    let result = run_try(&conn, 12, 20);
    assert_eq!(result["live"], true, "precondition: the read succeeded: {result}");

    let n = hits.load(Ordering::Relaxed);
    assert_eq!(
        n,
        preset.resources.len() * 2,
        "expected 2 requests per resource (objects() unions columns, then read() re-fetches) — got {n}"
    );
}


// ── check: the verdict, recorded and invalidated ────────────────────────────────────────────────

/// A scratch checks store that removes itself, so a verdict cannot leak between tests.
struct Checks(std::path::PathBuf);
impl Drop for Checks {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
impl Checks {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("bsc-checks-{tag}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        Checks(p)
    }
}

/// Run the same read `check` runs, over a real socket, and build the record from it.
///
/// Mirrors `cmd_connector_check`'s construction rather than calling the CLI, because the CLI resolves
/// the REGISTERED store from `$HOME`; the point here is the verdict, not the argument plumbing.
fn check_against(preset: &RuntimePreset, base: &str, secret: Option<String>) -> crate::checks::ConnectorCheck {
    let authenticated = secret.is_some();
    let fetch = build_fetch(base, &preset.auth, secret);
    let conn = preset.connector(preset.id.clone(), fetch);
    let result = run_try(&conn, 12, 20);
    let resources = result["resources"]
        .as_array()
        .map(|rs| {
            rs.iter()
                .map(|r| crate::checks::CheckedResource {
                    name: r["name"].as_str().unwrap_or_default().to_string(),
                    sampled_count: r["count"].as_u64().unwrap_or(0) as usize,
                    fields: r["fields"]
                        .as_array()
                        .map(|fs| fs.iter().filter_map(|f| f["name"].as_str().map(str::to_string)).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    crate::checks::ConnectorCheck {
        id: preset.id.clone(),
        at: 1_788_300_000,
        live: result["live"].as_bool().unwrap_or(false),
        authenticated,
        resources,
        error: result["error"].as_str().map(str::to_string),
        manifest_fingerprint: crate::checks::manifest_fingerprint(preset),
    }
}

/// A passing check records what it actually observed — over a real socket, not a constructed value.
#[test]
fn a_passing_check_records_the_resources_it_really_read() {
    let api = MockApi::start(fixture_routes());
    let preset = fixture_preset(&api.base);
    let c = check_against(&preset, &api.base, None);

    assert!(c.live, "{c:?}");
    assert!(c.error.is_none(), "{c:?}");
    assert_eq!(c.resources.len(), 3);
    let orders = c.resources.iter().find(|r| r.name == "orders").expect("orders");
    // The SAMPLED count, matching the fixture — proof the rows were read, not that a 200 came back.
    assert_eq!(orders.sampled_count, 3, "{c:?}");
    assert!(orders.fields.contains(&"total".to_string()), "{:?}", orders.fields);
}

/// A failing check records the REASON, and says a credential was never resolved.
///
/// That second half is what keeps a keychain-less machine from reading as a dead vendor — on Linux
/// today every credentialed connector fails this way, and the record has to be able to say so.
#[test]
fn a_failing_check_records_why_and_whether_it_was_authenticated() {
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    let base = format!("http://{dead}");
    let c = check_against(&fixture_preset(&base), &base, None);

    assert!(!c.live, "{c:?}");
    assert!(!c.authenticated, "no secret was resolved, and the record must say so: {c:?}");
    assert!(c.error.is_some_and(|e| !e.is_empty()), "a failure must carry a reason");
}

/// THE INVALIDATION, and the reason this slice is more than "write the try result to a file".
///
/// A `live: true` recorded against one manifest must NOT read as live once the manifest changes —
/// otherwise an edit silently inherits a green light for a shape nobody ran.
#[test]
fn editing_the_manifest_makes_a_green_verdict_read_stale() {
    let api = MockApi::start(fixture_routes());
    let preset = fixture_preset(&api.base);
    let recorded = check_against(&preset, &api.base, None);
    assert_eq!(
        crate::checks::check_state(Some(&recorded), &preset),
        crate::checks::CheckState::Live,
        "precondition: it verified against this very manifest",
    );

    // The kind of edit that genuinely changes what a read returns.
    let mut edited = preset.clone();
    edited.resources.push(RuntimeResource {
        name: "invoices".into(),
        path: "invoices".into(),
        array_key: None,
    });
    assert_eq!(
        crate::checks::check_state(Some(&recorded), &edited),
        crate::checks::CheckState::Stale,
        "a manifest edit must invalidate the verdict",
    );

    // ...and a path change too, which a coarser fingerprint would miss.
    let mut repathed = preset.clone();
    repathed.resources[0].path = "people".into();
    assert_eq!(
        crate::checks::check_state(Some(&recorded), &repathed),
        crate::checks::CheckState::Stale,
    );
}

/// NEVER CHECKED IS NOT HEALTHY, and it is not failing either. Both would be claims nobody earned —
/// the same rule that makes a surface node say `off` rather than assert a health nobody measured.
#[test]
fn a_connector_nobody_has_checked_reads_as_no_signal() {
    let api = MockApi::start(fixture_routes());
    let preset = fixture_preset(&api.base);
    assert_eq!(crate::checks::check_state(None, &preset), crate::checks::CheckState::NeverChecked);
}

/// A failing verdict about the CURRENT manifest is `failing`, distinct from `stale`. Collapsing the
/// two would make "we know it is broken" indistinguishable from "we do not know".
#[test]
fn a_failure_against_the_current_manifest_is_failing_not_stale() {
    let dead = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    let base = format!("http://{dead}");
    let preset = fixture_preset(&base);
    let c = check_against(&preset, &base, None);
    assert_eq!(crate::checks::check_state(Some(&c), &preset), crate::checks::CheckState::Failing);
}

/// The store keeps ONE row per connector — the current state, not a history — and round-trips.
#[test]
fn recording_replaces_the_previous_verdict_and_round_trips() {
    let api = MockApi::start(fixture_routes());
    let store = Checks::new("record");
    let preset = fixture_preset(&api.base);

    crate::checks::record_check(&store.0, check_against(&preset, &api.base, None)).unwrap();
    let mut second = check_against(&preset, &api.base, None);
    second.at = 1_788_400_000;
    crate::checks::record_check(&store.0, second.clone()).unwrap();

    let all = crate::checks::load_checks(&store.0).unwrap();
    assert_eq!(all.len(), 1, "one row per connector, not a log: {all:?}");
    assert_eq!(all[0], second, "the later verdict wins and survives the round trip");
    assert_eq!(crate::checks::find_check(&store.0, "fixture-api").unwrap(), Some(second));
    assert_eq!(crate::checks::find_check(&store.0, "nope").unwrap(), None);
}

/// An absent store is "nothing checked yet" — the normal state on every machine today.
#[test]
fn an_absent_checks_store_is_empty_not_an_error() {
    let p = std::env::temp_dir().join("bsc-checks-does-not-exist.json");
    let _ = std::fs::remove_file(&p);
    assert_eq!(crate::checks::load_checks(&p).unwrap(), vec![]);
}

/// The stored row count is the SAMPLED one and is named so. Pinned on the wire, because the field an
/// integration node renders is the one that must not be mistaken for a total.
#[test]
fn the_wire_names_the_count_as_sampled() {
    let api = MockApi::start(fixture_routes());
    let preset = fixture_preset(&api.base);
    let v = serde_json::to_value(check_against(&preset, &api.base, None)).unwrap();
    assert!(v["resources"][0]["sampledCount"].is_number(), "{v}");
    assert!(v["resources"][0]["count"].is_null(), "a bare `count` invites being read as a total: {v}");
    assert!(v["manifestFingerprint"].as_str().is_some_and(|f| !f.is_empty()), "{v}");
}
