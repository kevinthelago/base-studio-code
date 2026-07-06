//! Set-time validation for `bsc plan`'s structured JSON writes (#2395). Every blob a `set`/`add`
//! verb accepts used to be stored **opaquely**, so a malformed shape (the #2392 case: a
//! `mode:"local"` deploy service with a stray `workload` and no `localKind`) surfaced only much
//! later as a permanently-stuck gate with no visible cause. These validators run **before** the
//! store write, so a bad shape fails LOUDLY at set-time — non-zero exit + a field-level stderr
//! message an LLM author can self-correct from — and the previously-stored good blob is untouched.
//!
//! ## The rules mirror CONSUMPTION, not aspiration
//! Each rule is derived from what the frontend gate/readers actually do with the blob
//! (`deployServices.serviceChecks`/`deploymentDefined`, `deployCoerce.coerceDeployConfig`,
//! `planFleet.parseFleetFile`, `dependencyParse.parseDependencyManifest`,
//! `blueprintShare.coerceBlueprint`): we reject exactly the shapes that would be **silently
//! dropped or silently jam a gate** downstream, and accept anything the consumers handle
//! (e.g. a redundant `workload` on an otherwise-complete local service is inert — the gate never
//! reads it — so it does not reject). This keeps the validator and the consumers from drifting:
//! a rejected blob is one that provably misbehaves.
//!
//! The deploy enums (platform ids + their workload kinds, publish registries) come from the SAME
//! `src-tauri/data/deploy/taxonomy.json` the frontend loads as `@data/deploy/taxonomy.json` —
//! embedded at compile time (the `bsc-ui` pattern), so there is one source of truth for the
//! vocabulary. The readiness echoes mirror the frontend's coercion defaults (missing `envs`/
//! `pipeline` are seeded from the taxonomy's defaults before the gate reads them), so the CLI
//! reports the same "N of M deploy-ready" the pane shows.
//!
//! Every validator takes the raw `serde_json::Value` (the blobs are stored schemaless) and returns
//! `Err(message)` with the offending field, the problem, and a valid example. The `--force` flag
//! on the CLI skips validation for a deliberate work-in-progress store.

use crate::{is_valid_status, PlanFeature, PlanIssue, STATUSES};
use serde_json::Value;
use std::sync::OnceLock;

/// The deploy vocabulary — the same file the frontend imports as `@data/deploy/taxonomy.json`.
const DEPLOY_TAXONOMY_JSON: &str = include_str!("../../../src-tauri/data/deploy/taxonomy.json");

/// The slice of the deploy taxonomy validation needs: the enum vocabularies + the default
/// env/pipeline sizes the frontend coercion seeds when a service omits them.
struct DeployTaxonomy {
    /// `(platform id, its allowed workload kinds)`.
    platforms: Vec<(String, Vec<String>)>,
    /// Every known workload key (`static` / `serverless` / `container` / `service`).
    workloads: Vec<String>,
    /// The publish registries a `localKind:"library"` service may target.
    publish_registries: Vec<String>,
    /// How many envs the frontend seeds when a service has none (its envs check then passes).
    default_env_count: usize,
    /// How many pipeline stages the frontend seeds when a service has none.
    default_stage_count: usize,
}

fn taxonomy() -> &'static DeployTaxonomy {
    static TAX: OnceLock<DeployTaxonomy> = OnceLock::new();
    TAX.get_or_init(|| {
        let v: Value = serde_json::from_str(DEPLOY_TAXONOMY_JSON).unwrap_or(Value::Null);
        let platforms = v["platforms"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|p| {
                        let id = p["id"].as_str()?.to_string();
                        let kinds = p["kinds"]
                            .as_array()
                            .map(|k| k.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                            .unwrap_or_default();
                        Some((id, kinds))
                    })
                    .collect()
            })
            .unwrap_or_default();
        let workloads = v["workloads"]
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        let publish_registries = v["publishRegistries"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        DeployTaxonomy {
            platforms,
            workloads,
            publish_registries,
            default_env_count: v["defaults"]["envs"].as_array().map(|a| a.len()).unwrap_or(3),
            default_stage_count: v["defaults"]["pipeline"]["stages"].as_array().map(|a| a.len()).unwrap_or(3),
        }
    })
}

// ── small Value readers ───────────────────────────────────────────────────────────────────────

/// A non-empty trimmed string field, or `None` (missing / not a string / empty all read as unset —
/// the same "empty means absent" the frontend coercion applies).
fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// A field that is PRESENT with a non-null value (whatever its type) — for "this field must not be
/// set" rules where even a wrong-typed value signals intent.
fn present(v: &Value, key: &str) -> bool {
    v.get(key).map(|x| !x.is_null()).unwrap_or(false)
}

/// Format the shared rejection wrapper: what was rejected, each field-level error, the fix hint.
fn reject(noun: &str, errs: Vec<String>) -> String {
    let mut out = format!("invalid {noun} — rejected; the stored {noun} is unchanged:\n");
    for e in &errs {
        out.push_str(&format!("  - {e}\n"));
    }
    out.push_str("fix the JSON and re-run (or pass --force to store it unvalidated).");
    out
}

// ── deploy config (`bsc plan deploy set`) — the #2392 motivating shape ───────────────────────────

/// Validate a DeployConfig blob against what the Deployment gate + pane actually consume
/// (`serviceChecks`/`deploymentDefined` + `coerceDeployConfig`). Rejects the shapes that would
/// silently jam the `deploymentDefined` gate: a non-object root, a missing/non-array `services`,
/// a service without a `repo`, an unknown `mode`/`localKind`/`platform`/`workload` enum value, and
/// the mode-dependent target rules — `mode:"local"` requires `localKind` + its kind's fields
/// (application ⇒ `buildTargets`+`artifact`; library ⇒ `publishRegistry`+`packageName`); cloud
/// requires a known `platform`.
pub fn validate_deploy_config(v: &Value) -> Result<(), String> {
    let noun = "deploy config";
    let Some(obj) = v.as_object() else {
        return Err(reject(noun, vec![
            r#"the deploy config must be a JSON object: {"services": [...]} (one service per linked repo)"#.into(),
        ]));
    };
    let Some(services) = obj.get("services") else {
        return Err(reject(noun, vec![
            r#"missing "services" — the config is {"services": [...]} with ONE service per linked repo"#.into(),
        ]));
    };
    let Some(arr) = services.as_array() else {
        return Err(reject(noun, vec![r#""services" must be a JSON array of service objects"#.into()]));
    };
    let mut errs = Vec::new();
    for (i, s) in arr.iter().enumerate() {
        validate_service(i, s, &mut errs);
    }
    if errs.is_empty() { Ok(()) } else { Err(reject(noun, errs)) }
}

/// One service's mode-aware target rules (mirrors `serviceTargetDefined`/`localTargetDefined`).
fn validate_service(i: usize, s: &Value, errs: &mut Vec<String>) {
    let label = |s: &Value| -> String {
        match str_of(s, "id").or_else(|| str_of(s, "repo")) {
            Some(name) => format!("services[{i}] (\"{name}\")"),
            None => format!("services[{i}]"),
        }
    };
    if !s.is_object() {
        errs.push(format!("services[{i}]: each service must be a JSON object"));
        return;
    }
    let at = label(s);
    if str_of(s, "repo").is_none() {
        errs.push(format!(r#"{at}: missing "repo" (the linked "owner/repo" this service deploys)"#));
    }
    let tax = taxonomy();
    match str_of(s, "mode") {
        Some("local") => {
            // The #2392 shape: a stray cloud field is the tell that the author meant cloud —
            // name it in the error so the fix is obvious.
            let stray = str_of(s, "workload")
                .map(|w| format!(r#"; got a stray workload:"{w}" (workload is cloud-only — remove it)"#))
                .or_else(|| str_of(s, "platform").map(|p| format!(r#"; got a stray platform:"{p}" (platform is cloud-only — remove it, or use mode:"cloud")"#)))
                .unwrap_or_default();
            match str_of(s, "localKind") {
                None => errs.push(format!(
                    r#"{at}: mode:"local" requires "localKind" — "application" (built + run here: needs buildTargets + artifact) or "library" (published: needs publishRegistry + packageName){stray}"#
                )),
                Some("application") => {
                    if str_of(s, "buildTargets").is_none() {
                        errs.push(format!(
                            r#"{at}: localKind:"application" requires a non-empty "buildTargets" (e.g. "desktop installer (Windows · macOS · Linux)"){stray}"#
                        ));
                    }
                    if str_of(s, "artifact").is_none() {
                        errs.push(format!(
                            r#"{at}: localKind:"application" requires a non-empty "artifact" (the produced binary/installer, e.g. "src-tauri/target/release/bundle"){stray}"#
                        ));
                    }
                }
                Some("library") => {
                    match str_of(s, "publishRegistry") {
                        None => errs.push(format!(
                            r#"{at}: localKind:"library" requires "publishRegistry" ({}){stray}"#,
                            quote_list(&tax.publish_registries)
                        )),
                        Some(reg) if !tax.publish_registries.iter().any(|r| r == reg) => errs.push(format!(
                            r#"{at}: unknown publishRegistry "{reg}" — expected one of {}"#,
                            quote_list(&tax.publish_registries)
                        )),
                        Some(_) => {}
                    }
                    if str_of(s, "packageName").is_none() {
                        errs.push(format!(r#"{at}: localKind:"library" requires a non-empty "packageName" (the published package name)"#));
                    }
                }
                Some(other) => errs.push(format!(
                    r#"{at}: unknown localKind "{other}" — expected "application" or "library""#
                )),
            }
        }
        Some("cloud") | None => {
            match str_of(s, "platform") {
                None => {
                    // A cloud service with only local-target fields almost certainly meant mode:"local".
                    let hint = if present(s, "localKind") || present(s, "buildTargets") || present(s, "publishRegistry") {
                        r#" — this service carries local-only fields; did you mean mode:"local"?"#
                    } else {
                        ""
                    };
                    errs.push(format!(
                        r#"{at}: a cloud service (mode:"cloud", or no "mode") requires "platform" ({}){hint}"#,
                        quote_list(&platform_ids(tax))
                    ));
                }
                Some(p) if !tax.platforms.iter().any(|(id, _)| id == p) => errs.push(format!(
                    r#"{at}: unknown platform "{p}" — expected one of {}"#,
                    quote_list(&platform_ids(tax))
                )),
                Some(p) => {
                    // A known platform: a workload outside its kinds is silently swapped by the
                    // frontend coercion (to the platform's first kind) — surface it instead.
                    if let Some(w) = str_of(s, "workload") {
                        if !tax.workloads.iter().any(|k| k == w) {
                            errs.push(format!(
                                r#"{at}: unknown workload "{w}" — expected one of {}"#,
                                quote_list(&tax.workloads)
                            ));
                        } else if let Some((_, kinds)) = tax.platforms.iter().find(|(id, _)| id == p) {
                            if !kinds.iter().any(|k| k == w) {
                                errs.push(format!(
                                    r#"{at}: workload "{w}" is not available on platform "{p}" (its kinds: {})"#,
                                    quote_list(kinds)
                                ));
                            }
                        }
                    }
                }
            }
        }
        Some(other) => errs.push(format!(
            r#"{at}: unknown mode "{other}" — expected "cloud" (hosted platform) or "local" (library / build-and-run-here app); an unrecognized mode is read as cloud and jams the gate"#
        )),
    }
}

fn platform_ids(tax: &DeployTaxonomy) -> Vec<String> {
    tax.platforms.iter().map(|(id, _)| id.clone()).collect()
}

fn quote_list(items: &[String]) -> String {
    items.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(" | ")
}

// ── deploy readiness echo — mirrors the pane's "N of M repos deploy-ready" ──────────────────────

/// The non-fatal readiness suffix printed after a successful `deploy set` (#2395): mirrors the
/// frontend `serviceChecks` (target / envs≥2 / pipeline≥2 / prod secrets / cloud release) INCLUDING
/// its coercion defaults (missing envs/pipeline are seeded from the taxonomy defaults, an
/// unspecified secret counts as wired), so the CLI author sees the same signal the pane shows.
/// Returns e.g. ` — 1 of 2 deploy-ready (app: missing release)`, or `""` for a shape it can't read.
pub fn deploy_readiness(v: &Value) -> String {
    let Some(services) = v.get("services").and_then(Value::as_array) else {
        return String::new();
    };
    if services.is_empty() {
        return " — gate blocked: 0 services (the deploymentDefined gate needs ≥1)".into();
    }
    let mut not_ready = Vec::new();
    for s in services {
        let missing = service_missing_checks(s);
        if !missing.is_empty() {
            let name = str_of(s, "id").or_else(|| str_of(s, "repo")).unwrap_or("?");
            not_ready.push(format!("{name}: missing {}", missing.join(", ")));
        }
    }
    let ready = services.len() - not_ready.len();
    if not_ready.is_empty() {
        format!(" — {ready} of {} deploy-ready", services.len())
    } else {
        format!(" — {ready} of {} deploy-ready ({})", services.len(), not_ready.join("; "))
    }
}

/// The check ids ONE service fails (mirrors `serviceChecks` + the coercion defaults).
fn service_missing_checks(s: &Value) -> Vec<&'static str> {
    let tax = taxonomy();
    let mut missing = Vec::new();
    let local = str_of(s, "mode") == Some("local");
    let target_ok = if local {
        match str_of(s, "localKind") {
            Some("library") => str_of(s, "publishRegistry").is_some() && str_of(s, "packageName").is_some(),
            Some("application") => str_of(s, "buildTargets").is_some() && str_of(s, "artifact").is_some(),
            _ => false,
        }
    } else {
        str_of(s, "platform").is_some()
    };
    if !target_ok {
        missing.push("target");
    }
    // envs: `environments` or `envs`; a missing/empty ladder is seeded from the defaults (passes).
    let env_count = ["environments", "envs"]
        .iter()
        .find_map(|k| s.get(k).and_then(Value::as_array).filter(|a| !a.is_empty()).map(|a| a.len()))
        .unwrap_or(tax.default_env_count);
    if env_count < 2 {
        missing.push("envs (≥2)");
    }
    let stage_count = s
        .get("pipeline")
        .and_then(|p| p.get("stages"))
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .map(|a| a.len())
        .unwrap_or(tax.default_stage_count);
    if stage_count < 2 {
        missing.push("pipeline (≥2 stages)");
    }
    // secrets: every row wired for prod — a row lists envs (must include "prod"), carries a `prod`
    // boolean, or is unspecified (the coercion defaults it to wired-everywhere).
    let secrets_ok = s
        .get("config")
        .and_then(|c| c.get("secrets"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter().all(|r| {
                if let Some(envs) = r.get("envs").and_then(Value::as_array) {
                    envs.iter().any(|e| e.as_str() == Some("prod"))
                } else if let Some(b) = r.get("prod").and_then(Value::as_bool) {
                    b
                } else {
                    // string-valued per-env cells (the process.md example) or unspecified ⇒ wired
                    r.get("prod").map(|p| !p.is_null()).unwrap_or(true)
                }
            })
        })
        .unwrap_or(true);
    if !secrets_ok {
        missing.push("prod secrets");
    }
    if !local {
        // cloud-only: the release object must carry a non-empty `strategy` (mirrors coerceRelease,
        // which does NOT default it — a missing strategy fails the gate's release check).
        let strategy_ok = s.get("release").and_then(|r| str_of(r, "strategy")).is_some();
        if !strategy_ok {
            missing.push("release strategy");
        }
    }
    missing
}

// ── fleet plan (`bsc plan fleet set` / `fleet stream set` / `fleet meta set`) ────────────────────

/// Validate a whole FleetPlan blob against what `fleet_set` + the frontend `parseFleetFile` consume.
/// Rejects: a non-object root; a MISSING `streams` key (`fleet set` replaces the whole fleet, so a
/// meta-only blob would silently WIPE every stream — use `fleet meta set`); a stream without a
/// non-empty `id` + `repo` (both `fleet_set` and `parseFleetFile` silently drop it — its worker
/// never launches); and duplicate stream ids (the upsert makes the last one silently win).
pub fn validate_fleet_plan(v: &Value) -> Result<(), String> {
    let noun = "fleet plan";
    let Some(obj) = v.as_object() else {
        return Err(reject(noun, vec![r#"the fleet plan must be a JSON object: {"streams": [...], "recommended": N, ...}"#.into()]));
    };
    let Some(streams) = obj.get("streams") else {
        return Err(reject(noun, vec![
            r#"missing "streams" — `fleet set` replaces the WHOLE fleet, so a blob without "streams" would silently wipe every stream. Pass "streams": [] to clear deliberately, or use `bsc plan fleet meta set` to update only the meta"#.into(),
        ]));
    };
    let Some(arr) = streams.as_array() else {
        return Err(reject(noun, vec![r#""streams" must be a JSON array of stream objects"#.into()]));
    };
    let mut errs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (i, s) in arr.iter().enumerate() {
        validate_stream_fields(&format!("streams[{i}]"), s, &mut errs);
        if let Some(id) = str_of(s, "id") {
            if !seen.insert(id.to_string()) {
                errs.push(format!(
                    r#"streams[{i}]: duplicate stream id "{id}" — streams are keyed by id, so the later one silently overwrites the earlier"#
                ));
            }
        }
    }
    if errs.is_empty() { Ok(()) } else { Err(reject(noun, errs)) }
}

/// The per-stream floor: an object with a non-empty `id` and `repo` (anything less is silently
/// dropped by the store + the frontend parser, and that worker never launches).
fn validate_stream_fields(at: &str, s: &Value, errs: &mut Vec<String>) {
    if !s.is_object() {
        errs.push(format!("{at}: each stream must be a JSON object"));
        return;
    }
    let at = match str_of(s, "id") {
        Some(id) => format!("{at} (\"{id}\")"),
        None => at.to_string(),
    };
    if str_of(s, "id").is_none() {
        errs.push(format!(r#"{at}: missing non-empty "id" — a stream without an id is silently dropped and its worker never launches"#));
    }
    if str_of(s, "repo").is_none() {
        errs.push(format!(r#"{at}: missing non-empty "repo" ("owner/repo") — a stream without a repo is silently dropped by the fleet reader"#));
    }
}

/// Validate one stream blob for `fleet stream set <id>`: the object floor (`id` + `repo`), plus its
/// `"id"` must MATCH the `<id>` argument — the row is keyed by the argument but readers key off the
/// blob's `id`, so a mismatch makes the stream unreachable under either name.
pub fn validate_fleet_stream(arg_id: &str, v: &Value) -> Result<(), String> {
    let mut errs = Vec::new();
    validate_stream_fields("stream", v, &mut errs);
    if let Some(id) = str_of(v, "id") {
        if id != arg_id.trim() {
            errs.push(format!(
                r#"stream: the blob's id "{id}" does not match the argument "{arg_id}" — readers key off the blob's "id", so they must agree"#
            ));
        }
    }
    if errs.is_empty() { Ok(()) } else { Err(reject("stream", errs)) }
}

/// Validate a `fleet meta set` blob: an object WITHOUT `streams` (meta set leaves stream rows
/// intact by design; streams belong to `fleet set` / `fleet stream set`).
pub fn validate_fleet_meta(v: &Value) -> Result<(), String> {
    let noun = "fleet meta";
    if !v.is_object() {
        return Err(reject(noun, vec![r#"the fleet meta must be a JSON object (recommended / reasoning / director / topology / ...)"#.into()]));
    }
    if present(v, "streams") {
        return Err(reject(noun, vec![
            r#"the meta blob must not carry "streams" — `fleet meta set` updates only the meta and would silently ignore them. Use `bsc plan fleet set` (whole fleet) or `bsc plan fleet stream set <id>` (one stream)"#.into(),
        ]));
    }
    Ok(())
}

/// The non-fatal gate echo for `fleet set`: the streams gate needs ≥1 stream.
pub fn fleet_readiness(v: &Value) -> String {
    let n = v.get("streams").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
    if n == 0 {
        " — gate blocked: 0 streams (the streams gate needs ≥1)".into()
    } else {
        String::new()
    }
}

// ── dependency manifest (`bsc plan deps set`) ─────────────────────────────────────────────────────

/// Validate a DependencyManifest blob against `parseDependencyManifest`: the root is an object with
/// a `dependencies` array (or the legacy bare array); each dependency needs a non-empty `name` and
/// an `ecosystem` of `npm`/`cargo` (case-insensitive — anything else is silently dropped by the
/// manifest readers, sticking the `sharedDepsLocked` gate); each `registries` entry needs a `url`.
pub fn validate_deps_manifest(v: &Value) -> Result<(), String> {
    let noun = "dependency manifest";
    let deps: &Vec<Value> = if let Some(arr) = v.as_array() {
        arr // legacy bare-array form (#1111) — accepted by the readers
    } else if let Some(obj) = v.as_object() {
        match obj.get("dependencies").map(|d| d.as_array()) {
            Some(Some(arr)) => arr,
            Some(None) => return Err(reject(noun, vec![r#""dependencies" must be a JSON array"#.into()])),
            None => {
                return Err(reject(noun, vec![
                    r#"missing "dependencies" — the manifest is {"dependencies": [...], "registries": {...}}"#.into(),
                ]))
            }
        }
    } else {
        return Err(reject(noun, vec![
            r#"the manifest must be a JSON object {"dependencies": [...], "registries": {...}} (or a bare array of dependencies)"#.into(),
        ]));
    };
    let mut errs = Vec::new();
    for (i, d) in deps.iter().enumerate() {
        if !d.is_object() {
            errs.push(format!("dependencies[{i}]: each dependency must be a JSON object"));
            continue;
        }
        let at = match str_of(d, "name") {
            Some(n) => format!("dependencies[{i}] (\"{n}\")"),
            None => format!("dependencies[{i}]"),
        };
        if str_of(d, "name").is_none() {
            errs.push(format!(r#"{at}: missing non-empty "name" — a nameless dependency is silently dropped by the manifest readers"#));
        }
        match str_of(d, "ecosystem").map(str::to_ascii_lowercase) {
            Some(e) if e == "npm" || e == "cargo" => {}
            Some(e) => errs.push(format!(
                r#"{at}: unknown ecosystem "{e}" — expected "npm" or "cargo"; anything else is silently dropped and the locked set never includes it"#
            )),
            None => errs.push(format!(r#"{at}: missing "ecosystem" ("npm" or "cargo")"#)),
        }
    }
    if let Some(regs) = v.get("registries") {
        if let Some(map) = regs.as_object() {
            for (k, r) in map {
                if r.as_object().and_then(|o| o.get("url")).and_then(Value::as_str).map(str::trim).filter(|u| !u.is_empty()).is_none() {
                    errs.push(format!(
                        r#"registries["{k}"]: missing non-empty "url" — a registry without a url is silently dropped, so its deps can't resolve"#
                    ));
                }
            }
        } else if !regs.is_null() {
            errs.push(r#""registries" must be a JSON object map: {"internal": {"url": "...", "scope": "...", "auth": "..."}}"#.into());
        }
    }
    if errs.is_empty() { Ok(()) } else { Err(reject(noun, errs)) }
}

/// `(dependency count, registry count)` across both accepted manifest shapes — for the set echo.
pub fn deps_counts(v: &Value) -> (usize, usize) {
    let deps = v
        .as_array()
        .map(|a| a.len())
        .or_else(|| v.get("dependencies").and_then(Value::as_array).map(|a| a.len()))
        .unwrap_or(0);
    let regs = v.get("registries").and_then(Value::as_object).map(|o| o.len()).unwrap_or(0);
    (deps, regs)
}

// ── authored blueprint (`bsc plan blueprint set`) ────────────────────────────────────────────────

/// Validate an authored-blueprint blob against `coerceBlueprint` (the poll reads it with
/// `allowEmptySections: true`): a non-empty `id` + `name` are required (without them the WHOLE blob
/// is silently ignored and the authoring project can't gate); `stages`/`sections` (either name) if
/// present must be an array, and every entry needs a non-empty `key` + `name` (an entry missing
/// either is silently dropped).
pub fn validate_blueprint(v: &Value) -> Result<(), String> {
    let noun = "blueprint";
    if !v.is_object() {
        return Err(reject(noun, vec![r#"the blueprint must be a JSON object: {"id": "...", "name": "...", "stages": [...]}"#.into()]));
    }
    let mut errs = Vec::new();
    if str_of(v, "id").is_none() {
        errs.push(r#"missing non-empty "id" — without it the whole blueprint is silently ignored by the reader"#.into());
    }
    if str_of(v, "name").is_none() {
        errs.push(r#"missing non-empty "name" — without it the whole blueprint is silently ignored by the reader"#.into());
    }
    for key in ["stages", "sections"] {
        let Some(raw) = v.get(key) else { continue };
        let Some(arr) = raw.as_array() else {
            errs.push(format!(r#""{key}" must be a JSON array of stage objects"#));
            continue;
        };
        for (i, sec) in arr.iter().enumerate() {
            if !sec.is_object() {
                errs.push(format!("{key}[{i}]: each stage must be a JSON object"));
                continue;
            }
            if str_of(sec, "key").is_none() || str_of(sec, "name").is_none() {
                errs.push(format!(
                    r#"{key}[{i}]: each stage needs a non-empty "key" AND "name" — a stage missing either is silently dropped"#
                ));
            }
        }
    }
    if errs.is_empty() { Ok(()) } else { Err(reject(noun, errs)) }
}

/// Count the blueprint's stages under either accepted field name (for the set echo).
pub fn blueprint_stage_count(v: &Value) -> usize {
    ["stages", "sections"]
        .iter()
        .find_map(|k| v.get(k).and_then(Value::as_array).map(|a| a.len()))
        .unwrap_or(0)
}

// ── issues (`bsc plan add`) + features (`bsc plan feature add`) ──────────────────────────────────

/// Validate one issue for `plan add`: non-empty `ref` + `title` (the upsert key + the minimum a
/// worker needs — enforced EVEN under `--force`, since a keyless row is unusable), and — unless
/// `lenient` — a `status` (when set) from the known lifecycle, because an unknown status is
/// invisible to the board's exact-value queries.
pub fn validate_issue(issue: &PlanIssue, lenient: bool) -> Result<(), String> {
    if issue.r#ref.trim().is_empty() {
        return Err("add: each issue needs a non-empty \"ref\"".into());
    }
    if issue.title.trim().is_empty() {
        return Err(format!("add: issue '{}' needs a non-empty \"title\"", issue.r#ref));
    }
    if !lenient && !issue.status.is_empty() && !is_valid_status(&issue.status) {
        return Err(format!(
            "add: issue '{}' has unknown status \"{}\" — expected one of {STATUSES:?} (an unknown status is invisible to the board's queries)",
            issue.r#ref, issue.status
        ));
    }
    Ok(())
}

/// Whether a feature is fully defined (mirrors the frontend `featureDefined`: name + behavior +
/// ≥1 acceptance) — the Features gate needs EVERY feature defined.
fn feature_defined(f: &PlanFeature) -> bool {
    !f.name.trim().is_empty()
        && f.behavior.as_deref().map(|b| !b.trim().is_empty()).unwrap_or(false)
        && !f.acceptance.is_empty()
}

/// The non-fatal readiness echo after a feature write: `N of M features fully defined` (the
/// Features gate needs all M, plus the user's confirm).
pub fn feature_readiness(feats: &[PlanFeature]) -> String {
    let defined = feats.iter().filter(|f| feature_defined(f)).count();
    format!("{defined} of {} features fully defined", feats.len())
}

/// Validate a `fleet session set` row: `paneId` is the primary key the console + recovery join on,
/// so an empty one would store an unreachable row.
pub fn validate_fleet_session(pane_id: &str) -> Result<(), String> {
    if pane_id.trim().is_empty() {
        return Err(r#"fleet session set: the session needs a non-empty "paneId" (the identity pane id, e.g. "proj:stream")"#.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── deploy ───────────────────────────────────────────────────────────────────────────────

    /// A fully deploy-ready cloud service (the process.md example, condensed).
    fn good_cloud_service() -> Value {
        json!({
            "id": "web", "repo": "owner/web", "mode": "cloud", "platform": "vercel", "workload": "static",
            "envs": [{"name": "dev"}, {"name": "prod"}],
            "pipeline": {"provider": "GitHub Actions", "stages": [{"name": "build"}, {"name": "deploy"}]},
            "config": {"config": [], "secrets": [], "vault": "host vault"},
            "release": {"strategy": "blue-green"}
        })
    }

    /// A fully deploy-ready local desktop application.
    fn good_local_app() -> Value {
        json!({
            "id": "app", "repo": "owner/app", "mode": "local", "localKind": "application",
            "buildTargets": "desktop installer (Windows · macOS · Linux)",
            "artifact": "src-tauri/target/release/bundle",
            "build": "npm run tauri build", "runCmd": "npm run tauri dev"
        })
    }

    #[test]
    fn deploy_accepts_known_good_cloud_and_local_shapes() {
        let cfg = json!({ "services": [good_cloud_service(), good_local_app()] });
        assert!(validate_deploy_config(&cfg).is_ok());
        // a local library with its publish fields is also valid
        let lib = json!({ "services": [{
            "id": "pkg", "repo": "owner/pkg", "mode": "local", "localKind": "library",
            "publishRegistry": "npm", "packageName": "@you/pkg"
        }]});
        assert!(validate_deploy_config(&lib).is_ok());
    }

    #[test]
    fn deploy_rejects_the_2392_shape_with_a_field_level_message() {
        // The exact #2392 regression: mode:"local" + a stray "workload" + no "localKind".
        let cfg = json!({ "services": [{
            "id": "eno", "repo": "owner/eno", "mode": "local", "workload": "application"
        }]});
        let err = validate_deploy_config(&cfg).unwrap_err();
        assert!(err.contains(r#"services[0] ("eno")"#), "names the service: {err}");
        assert!(err.contains(r#"mode:"local" requires "localKind""#), "names the missing field: {err}");
        assert!(err.contains(r#"workload:"application""#), "names the stray field: {err}");
        assert!(err.contains("--force"), "documents the escape hatch: {err}");
    }

    #[test]
    fn deploy_rejects_incomplete_local_targets() {
        // application without buildTargets/artifact — what actually jammed the gate after coercion.
        let app = json!({ "services": [{ "id": "a", "repo": "o/a", "mode": "local", "localKind": "application" }]});
        let err = validate_deploy_config(&app).unwrap_err();
        assert!(err.contains("buildTargets") && err.contains("artifact"), "{err}");
        // library without registry/name, and a registry outside the taxonomy
        let lib = json!({ "services": [{ "id": "l", "repo": "o/l", "mode": "local", "localKind": "library", "publishRegistry": "homebrew" }]});
        let err = validate_deploy_config(&lib).unwrap_err();
        assert!(err.contains(r#"unknown publishRegistry "homebrew""#), "{err}");
        assert!(err.contains("packageName"), "{err}");
        // unknown localKind
        let k = json!({ "services": [{ "id": "k", "repo": "o/k", "mode": "local", "localKind": "app" }]});
        assert!(validate_deploy_config(&k).unwrap_err().contains(r#"unknown localKind "app""#));
    }

    #[test]
    fn deploy_rejects_cloud_shape_problems() {
        // missing platform
        let np = json!({ "services": [{ "id": "w", "repo": "o/w", "mode": "cloud" }]});
        assert!(validate_deploy_config(&np).unwrap_err().contains(r#"requires "platform""#));
        // missing platform + local-only fields ⇒ the "did you mean local" hint
        let hint = json!({ "services": [{ "id": "w", "repo": "o/w", "localKind": "application" }]});
        assert!(validate_deploy_config(&hint).unwrap_err().contains(r#"did you mean mode:"local""#));
        // unknown platform / workload / platform-workload mismatch / unknown mode
        let up = json!({ "services": [{ "id": "w", "repo": "o/w", "platform": "versel" }]});
        assert!(validate_deploy_config(&up).unwrap_err().contains(r#"unknown platform "versel""#));
        let uw = json!({ "services": [{ "id": "w", "repo": "o/w", "platform": "vercel", "workload": "bare-metal" }]});
        assert!(validate_deploy_config(&uw).unwrap_err().contains(r#"unknown workload "bare-metal""#));
        let mm = json!({ "services": [{ "id": "w", "repo": "o/w", "platform": "vercel", "workload": "container" }]});
        assert!(validate_deploy_config(&mm).unwrap_err().contains(r#"not available on platform "vercel""#));
        let um = json!({ "services": [{ "id": "w", "repo": "o/w", "mode": "Local" }]});
        assert!(validate_deploy_config(&um).unwrap_err().contains(r#"unknown mode "Local""#));
    }

    #[test]
    fn deploy_rejects_structural_problems_and_requires_repo() {
        assert!(validate_deploy_config(&json!("nope")).unwrap_err().contains("must be a JSON object"));
        assert!(validate_deploy_config(&json!({})).unwrap_err().contains(r#"missing "services""#));
        assert!(validate_deploy_config(&json!({ "services": "x" })).unwrap_err().contains("must be a JSON array"));
        let nr = json!({ "services": [{ "id": "w", "platform": "vercel" }]});
        assert!(validate_deploy_config(&nr).unwrap_err().contains(r#"missing "repo""#));
    }

    #[test]
    fn deploy_accepts_an_inert_stray_field_on_a_complete_service() {
        // Consumption never reads `workload` for a complete local service — a redundant one is
        // inert, so validation (which mirrors consumption) must not reject it.
        let mut app = good_local_app();
        app["workload"] = json!("container");
        assert!(validate_deploy_config(&json!({ "services": [app] })).is_ok());
        // …and localKind on a fully-valid cloud service is likewise inert.
        let mut web = good_cloud_service();
        web["localKind"] = json!("application");
        assert!(validate_deploy_config(&json!({ "services": [web] })).is_ok());
    }

    #[test]
    fn deploy_readiness_mirrors_service_checks_and_coercion_defaults() {
        // Fully ready (both modes).
        let ok = json!({ "services": [good_cloud_service(), good_local_app()] });
        assert_eq!(deploy_readiness(&ok), " — 2 of 2 deploy-ready");
        // A cloud service missing its release strategy: valid to STORE, but not deploy-ready —
        // and missing envs/pipeline are seeded from the defaults, so they do NOT count as missing.
        let mut svc = good_cloud_service();
        svc.as_object_mut().unwrap().remove("release");
        svc.as_object_mut().unwrap().remove("envs");
        svc.as_object_mut().unwrap().remove("pipeline");
        let cfg = json!({ "services": [svc] });
        assert!(validate_deploy_config(&cfg).is_ok(), "partial-but-valid stores fine");
        let echo = deploy_readiness(&cfg);
        assert_eq!(echo, " — 0 of 1 deploy-ready (web: missing release strategy)");
        // An unwired prod secret is called out; a wired one (or a listed prod env) passes.
        let mut sec = good_cloud_service();
        sec["config"]["secrets"] = json!([{ "key": "DB_URL", "envs": ["dev"] }]);
        assert!(deploy_readiness(&json!({ "services": [sec.clone()] })).contains("prod secrets"));
        sec["config"]["secrets"] = json!([{ "key": "DB_URL", "envs": ["dev", "prod"] }]);
        assert_eq!(deploy_readiness(&json!({ "services": [sec] })), " — 1 of 1 deploy-ready");
        // Zero services: the gate can never pass — say so.
        assert!(deploy_readiness(&json!({ "services": [] })).contains("gate blocked"));
    }

    // ── fleet ────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn fleet_accepts_a_good_plan_and_rejects_the_silent_drop_shapes() {
        let good = json!({ "recommended": 2, "streams": [
            { "id": "kernel", "repo": "o/r" }, { "id": "ui", "repo": "o/r", "dependsOn": ["kernel"] }
        ]});
        assert!(validate_fleet_plan(&good).is_ok());
        assert!(validate_fleet_plan(&json!({ "streams": [] })).is_ok(), "explicit empty = deliberate clear");
        // missing streams key would silently wipe the fleet
        let err = validate_fleet_plan(&json!({ "recommended": 2 })).unwrap_err();
        assert!(err.contains("silently wipe") && err.contains("fleet meta set"), "{err}");
        // a stream without id/repo is silently dropped → its worker never launches
        let err = validate_fleet_plan(&json!({ "streams": [{ "repo": "o/r" }] })).unwrap_err();
        assert!(err.contains(r#"missing non-empty "id""#), "{err}");
        let err = validate_fleet_plan(&json!({ "streams": [{ "id": "a" }] })).unwrap_err();
        assert!(err.contains(r#"missing non-empty "repo""#), "{err}");
        // duplicate ids silently collapse
        let err = validate_fleet_plan(&json!({ "streams": [{ "id": "a", "repo": "o/r" }, { "id": "a", "repo": "o/r" }] })).unwrap_err();
        assert!(err.contains(r#"duplicate stream id "a""#), "{err}");
        // non-object root / non-array streams
        assert!(validate_fleet_plan(&json!([1])).is_err());
        assert!(validate_fleet_plan(&json!({ "streams": "x" })).is_err());
    }

    #[test]
    fn fleet_stream_and_meta_validators_guard_their_granular_writes() {
        assert!(validate_fleet_stream("a", &json!({ "id": "a", "repo": "o/r" })).is_ok());
        // blob id must match the argument (readers key off the blob's id)
        let err = validate_fleet_stream("a", &json!({ "id": "b", "repo": "o/r" })).unwrap_err();
        assert!(err.contains(r#"does not match the argument "a""#), "{err}");
        assert!(validate_fleet_stream("a", &json!({ "id": "a" })).is_err(), "repo required");
        // meta must not smuggle streams (they'd be silently ignored)
        assert!(validate_fleet_meta(&json!({ "recommended": 3 })).is_ok());
        let err = validate_fleet_meta(&json!({ "recommended": 3, "streams": [] })).unwrap_err();
        assert!(err.contains(r#"must not carry "streams""#), "{err}");
        assert!(validate_fleet_meta(&json!(7)).is_err());
    }

    #[test]
    fn fleet_readiness_flags_an_empty_fleet() {
        assert!(fleet_readiness(&json!({ "streams": [] })).contains("gate blocked"));
        assert_eq!(fleet_readiness(&json!({ "streams": [{ "id": "a", "repo": "o/r" }] })), "");
    }

    // ── deps ─────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn deps_accepts_both_manifest_shapes_and_rejects_silently_dropped_deps() {
        let good = json!({
            "dependencies": [
                { "repo": "o/app", "ecosystem": "npm", "name": "zod", "version": "^3" },
                { "ecosystem": "CARGO", "name": "serde" }
            ],
            "registries": { "internal": { "url": "https://npm.internal/", "scope": "@acme" } }
        });
        assert!(validate_deps_manifest(&good).is_ok());
        assert!(validate_deps_manifest(&json!([{ "ecosystem": "npm", "name": "zod" }])).is_ok(), "legacy bare array");
        // unknown ecosystem / missing name are silently dropped by the readers → reject
        let err = validate_deps_manifest(&json!({ "dependencies": [{ "ecosystem": "pip", "name": "requests" }] })).unwrap_err();
        assert!(err.contains(r#"unknown ecosystem "pip""#), "{err}");
        let err = validate_deps_manifest(&json!({ "dependencies": [{ "ecosystem": "npm" }] })).unwrap_err();
        assert!(err.contains(r#"missing non-empty "name""#), "{err}");
        // registry without a url is silently dropped
        let err = validate_deps_manifest(&json!({ "dependencies": [], "registries": { "internal": { "scope": "@a" } } })).unwrap_err();
        assert!(err.contains(r#"registries["internal"]"#), "{err}");
        // structural
        assert!(validate_deps_manifest(&json!("x")).is_err());
        assert!(validate_deps_manifest(&json!({})).is_err());
        assert!(validate_deps_manifest(&json!({ "dependencies": "x" })).is_err());
    }

    #[test]
    fn deps_counts_reads_both_shapes() {
        assert_eq!(deps_counts(&json!({ "dependencies": [1, 2], "registries": { "a": {} } })), (2, 1));
        assert_eq!(deps_counts(&json!([1, 2, 3])), (3, 0));
    }

    // ── blueprint ────────────────────────────────────────────────────────────────────────────

    #[test]
    fn blueprint_requires_identity_and_well_formed_stages() {
        // identity-first authoring blob (no stages yet) is valid — the reader allows empty sections
        assert!(validate_blueprint(&json!({ "id": "bp1", "name": "API service" })).is_ok());
        assert!(validate_blueprint(&json!({ "id": "bp1", "name": "API", "stages": [{ "key": "discovery", "name": "Discovery" }] })).is_ok());
        // missing id/name means the reader silently ignores the WHOLE blob
        let err = validate_blueprint(&json!({ "name": "no id" })).unwrap_err();
        assert!(err.contains(r#"missing non-empty "id""#), "{err}");
        let err = validate_blueprint(&json!({ "id": "x" })).unwrap_err();
        assert!(err.contains(r#"missing non-empty "name""#), "{err}");
        // a stage missing key/name is silently dropped
        let err = validate_blueprint(&json!({ "id": "x", "name": "y", "sections": [{ "name": "no key" }] })).unwrap_err();
        assert!(err.contains("sections[0]"), "{err}");
        assert!(validate_blueprint(&json!({ "id": "x", "name": "y", "stages": "nope" })).is_err());
        assert!(validate_blueprint(&json!(3)).is_err());
    }

    #[test]
    fn blueprint_stage_count_reads_either_field_name() {
        assert_eq!(blueprint_stage_count(&json!({ "stages": [1, 2] })), 2);
        assert_eq!(blueprint_stage_count(&json!({ "sections": [1] })), 1);
        assert_eq!(blueprint_stage_count(&json!({})), 0);
    }

    // ── issues / features / sessions ─────────────────────────────────────────────────────────

    #[test]
    fn issue_validation_keeps_the_ref_title_floor_and_guards_status() {
        let ok = PlanIssue { r#ref: "F1".into(), title: "t".into(), status: "open".into(), ..Default::default() };
        assert!(validate_issue(&ok, false).is_ok());
        assert!(validate_issue(&PlanIssue { title: "t".into(), ..Default::default() }, false).unwrap_err().contains("\"ref\""));
        assert!(validate_issue(&PlanIssue { r#ref: "F1".into(), ..Default::default() }, false).unwrap_err().contains("\"title\""));
        let bad = PlanIssue { r#ref: "F1".into(), title: "t".into(), status: "done".into(), ..Default::default() };
        let err = validate_issue(&bad, false).unwrap_err();
        assert!(err.contains("unknown status \"done\"") && err.contains("open"), "{err}");
        // lenient (--force) skips the status-enum check but KEEPS the ref/title floor — a keyless
        // row is unusable, so even a deliberate WIP write can't create one.
        assert!(validate_issue(&bad, true).is_ok());
        assert!(validate_issue(&PlanIssue { title: "t".into(), ..Default::default() }, true).is_err());
    }

    #[test]
    fn feature_readiness_counts_fully_defined_features() {
        let full = PlanFeature { name: "A".into(), behavior: Some("does".into()), acceptance: vec!["ok".into()], ..Default::default() };
        let title_only = PlanFeature { name: "B".into(), ..Default::default() };
        assert_eq!(feature_readiness(&[full, title_only]), "1 of 2 features fully defined");
        assert_eq!(feature_readiness(&[]), "0 of 0 features fully defined");
    }

    #[test]
    fn fleet_session_requires_a_pane_id() {
        assert!(validate_fleet_session("proj:stream").is_ok());
        assert!(validate_fleet_session("  ").unwrap_err().contains("paneId"));
    }

    #[test]
    fn taxonomy_embeds_the_shared_deploy_vocabulary() {
        // The embedded file is the SAME @data/deploy/taxonomy.json the frontend loads — guard that
        // the fields validation depends on are actually there.
        let t = taxonomy();
        assert!(t.platforms.iter().any(|(id, _)| id == "vercel"));
        assert!(t.workloads.iter().any(|w| w == "container"));
        assert!(t.publish_registries.iter().any(|r| r == "npm"));
        assert!(t.default_env_count >= 2, "default env ladder must satisfy the ≥2 check");
        assert!(t.default_stage_count >= 2, "default pipeline must satisfy the ≥2 check");
    }
}
