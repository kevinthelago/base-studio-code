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

// ── market assessment (`bsc plan market set`) — the marketDefined gate's artifact (#2430) ───────

/// The market-stage rubric — the same file the frontend imports as `@data/market/rubric.json`
/// (#2430), embedded at compile time (the deploy-taxonomy pattern) so the validator and the
/// frontend's weighted-total computation share one dimension vocabulary.
const MARKET_RUBRIC_JSON: &str = include_str!("../../../src-tauri/data/market/rubric.json");

/// The rubric's dimension ids (problemSeverity … moat), in rubric order.
fn market_dimensions() -> &'static Vec<String> {
    static DIMS: OnceLock<Vec<String>> = OnceLock::new();
    DIMS.get_or_init(|| {
        let v: Value = serde_json::from_str(MARKET_RUBRIC_JSON).unwrap_or(Value::Null);
        v["dimensions"]
            .as_array()
            .map(|arr| arr.iter().filter_map(|d| d["id"].as_str().map(String::from)).collect())
            .unwrap_or_default()
    })
}

/// The verdict vocabulary the frontend gate reads.
const MARKET_RECOMMENDATIONS: &[&str] = &["go", "caution", "no-go"];

/// Validate a market assessment blob (`bsc plan market set`) against the #2430 contract — the
/// structured artifact behind the `marketDefined` gate. Required: a non-empty `summary`; a `scores`
/// object with EXACTLY the six rubric dimensions, each `{score: integer 1-5, rationale: non-empty,
/// sources: non-empty array of non-empty strings}` (citation discipline — an uncited score is
/// confident fiction); a `verdict` with `recommendation` ∈ go|caution|no-go and a non-empty
/// `rationale`. `sizing`/`competitors` are optional — shape-checked only when present. Rejections
/// are field-level (#2395) so an LLM author can self-correct.
pub fn validate_market_config(v: &Value) -> Result<(), String> {
    let noun = "market assessment";
    if !v.is_object() {
        return Err(reject(noun, vec![
            r#"the market assessment must be a JSON object: {"summary": "...", "scores": {...}, "verdict": {...}}"#.into(),
        ]));
    }
    let mut errs = Vec::new();
    if str_of(v, "summary").is_none() {
        errs.push(r#"missing non-empty "summary" — one or two sentences: the problem, who has it, and the market's shape"#.into());
    }
    validate_market_scores(v, &mut errs);
    validate_market_verdict(v, &mut errs);
    // sizing / competitors are OPTIONAL — validate shape only when present.
    if let Some(sizing) = v.get("sizing") {
        if !sizing.is_null() && !sizing.is_object() {
            errs.push(r#""sizing" must be a JSON object when present (e.g. {"tam": "...", "sam": "...", "som": "...", "method": "bottom-up: buyers x price x penetration"})"#.into());
        }
    }
    match v.get("competitors") {
        None => {}
        Some(comps) if comps.is_null() => {}
        Some(comps) => match comps.as_array() {
            Some(arr) => {
                for (i, c) in arr.iter().enumerate() {
                    if !c.is_object() {
                        errs.push(format!("competitors[{i}]: each competitor must be a JSON object (name / pricing / segment / gap)"));
                    } else if str_of(c, "name").is_none() {
                        errs.push(format!(r#"competitors[{i}]: missing non-empty "name""#));
                    }
                }
            }
            None => errs.push(r#""competitors" must be a JSON array of competitor objects when present"#.into()),
        },
    }
    if errs.is_empty() { Ok(()) } else { Err(reject(noun, errs)) }
}

/// The `scores` object: EXACTLY the six rubric dimensions, each fully scored + cited.
fn validate_market_scores(v: &Value, errs: &mut Vec<String>) {
    let dims = market_dimensions();
    let Some(scores) = v.get("scores") else {
        errs.push(format!(
            r#"missing "scores" — an object with EXACTLY the six rubric dimensions: {}"#,
            quote_list(dims)
        ));
        return;
    };
    let Some(map) = scores.as_object() else {
        errs.push(r#""scores" must be a JSON object keyed by dimension id"#.into());
        return;
    };
    for dim in dims {
        let at = format!("scores.{dim}");
        let Some(cell) = map.get(dim) else {
            errs.push(format!(
                "{at}: missing — all six rubric dimensions must be scored (a partial rubric jams the marketDefined gate)"
            ));
            continue;
        };
        if !cell.is_object() {
            errs.push(format!(r#"{at}: must be an object {{"score": 1-5, "rationale": "...", "sources": ["..."]}}"#));
            continue;
        }
        match cell.get("score").and_then(Value::as_i64) {
            Some(n) if (1..=5).contains(&n) => {}
            Some(n) => errs.push(format!("{at}.score: {n} is out of range — an integer 1 to 5")),
            None => errs.push(format!("{at}.score: missing or not an integer — an integer 1 to 5")),
        }
        if str_of(cell, "rationale").is_none() {
            errs.push(format!("{at}.rationale: missing non-empty rationale — say WHY this score, from the evidence"));
        }
        match cell.get("sources").and_then(Value::as_array) {
            Some(arr) if !arr.is_empty() => {
                if !arr.iter().all(|s| s.as_str().map(str::trim).filter(|x| !x.is_empty()).is_some()) {
                    errs.push(format!("{at}.sources: every source must be a non-empty string (the fetched URL)"));
                }
            }
            Some(_) => errs.push(format!(
                "{at}.sources: must be a NON-EMPTY array of fetched source URLs — an uncited score is confident fiction (citation discipline)"
            )),
            None => errs.push(format!("{at}.sources: missing — a non-empty array of fetched source URLs")),
        }
    }
    for key in map.keys() {
        if !dims.iter().any(|d| d == key) {
            errs.push(format!(
                "scores.{key}: unknown dimension — the rubric has EXACTLY {}",
                quote_list(dims)
            ));
        }
    }
}

/// The `verdict`: `recommendation` from the fixed vocabulary + a non-empty `rationale`.
fn validate_market_verdict(v: &Value, errs: &mut Vec<String>) {
    let Some(verdict) = v.get("verdict") else {
        errs.push(r#"missing "verdict" — {"recommendation": "go" | "caution" | "no-go", "rationale": "..."}"#.into());
        return;
    };
    if !verdict.is_object() {
        errs.push(r#""verdict" must be a JSON object: {"recommendation": ..., "rationale": ...}"#.into());
        return;
    }
    match str_of(verdict, "recommendation") {
        Some(r) if MARKET_RECOMMENDATIONS.contains(&r) => {}
        Some(r) => errs.push(format!(
            r#"verdict.recommendation: unknown value "{r}" — expected "go" | "caution" | "no-go""#
        )),
        None => errs.push(r#"verdict.recommendation: missing — "go" | "caution" | "no-go""#.into()),
    }
    if str_of(verdict, "rationale").is_none() {
        errs.push(r#"verdict.rationale: missing non-empty rationale — why this recommendation follows from the scores"#.into());
    }
}

/// Whether one dimension cell is fully scored + cited (score 1-5, rationale, ≥1 source).
fn market_dimension_scored(v: &Value, dim: &str) -> bool {
    let Some(cell) = v.get("scores").and_then(|s| s.get(dim)) else {
        return false;
    };
    cell.get("score").and_then(Value::as_i64).map(|n| (1..=5).contains(&n)).unwrap_or(false)
        && str_of(cell, "rationale").is_some()
        && cell.get("sources").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false)
}

/// The non-fatal readiness suffix printed after a successful `market set` (mirrors
/// [`deploy_readiness`]): `N of 6 dimensions scored, cited` + the verdict — so a `--force`-stored
/// partial assessment shows exactly which dimensions still block the `marketDefined` gate.
pub fn market_readiness(v: &Value) -> String {
    let dims = market_dimensions();
    if dims.is_empty() {
        return String::new();
    }
    let missing: Vec<&str> =
        dims.iter().filter(|d| !market_dimension_scored(v, d)).map(String::as_str).collect();
    let scored = dims.len() - missing.len();
    let verdict = v
        .get("verdict")
        .and_then(|w| w.get("recommendation"))
        .and_then(Value::as_str)
        .unwrap_or("unset");
    if missing.is_empty() {
        format!(" — {scored} of {} dimensions scored, cited (verdict: {verdict})", dims.len())
    } else {
        format!(
            " — {scored} of {} dimensions scored ({} missing) — gate blocked: the marketDefined gate needs all {}, cited",
            dims.len(),
            missing.join(", "),
            dims.len()
        )
    }
}

/// The application-architecture taxonomy (#3784) — the axis that selects which stages run. Mirrors
/// `APP_TYPES` in `src/features/planner/lib/classifyConfig.ts`; keep the two in lockstep.
pub const APP_TYPES: [&str; 9] = [
    "application", "api", "serverless", "static", "desktop", "mobile", "cli", "library", "mcp-server",
];

/// The lifecycle-intent taxonomy (#3784) — what the planning run is FOR. Lifecycle left the
/// blueprint model in #3785, so discovery is its only home. Mirrors `LIFECYCLES` in
/// `src/features/planner/lib/classifyConfig.ts`; keep the two in lockstep, or the planner can write
/// a value this validator accepts and the app cannot render (or the reverse).
///
/// `harvest` (#4062) — the project exists to EXTRACT DATA FROM SOURCES.
pub const LIFECYCLES: [&str; 5] = ["greenfield", "transform", "harden", "maintain", "harvest"];

/// Where a class of the project's artifacts comes from (#4115) — the vocabulary shared by BOTH system
/// axes: `uiSystem` (who renders) and `algorithmSystem` (where the computation comes from).
///
/// `studio` = our data-driven stores are the source, and our host TAKES IN and runs the project's
/// artifacts — component code rendered in a frame, stored `vizCode` compiled and executed. That is
/// LLM-authored code inside our blast radius, so these axes are a SECURITY boundary, not a routing
/// preference: isolate-before-render is owed exactly where the answer is `studio`. `own` = the project
/// keeps its own stack, and nothing of it is fetched or executed here.
///
/// Mirrors `SYSTEM_SOURCES` in `src/features/planner/lib/classifyConfig.ts`; keep the two in lockstep,
/// or the planner can write a value this validator accepts and the app cannot read (or the reverse).
pub const SYSTEM_SOURCES: [&str; 2] = ["studio", "own"];

/// Validate a project classification blob (#3783/#3784/#3806/#4115): a JSON object whose optional
/// `uiMode` is "custom"|"external", whose optional `appType`/`lifecycle`/`uiSystem` are taxonomy tokens, and whose
/// optional `needsMarket`/`needsSource`/`needsMcp`/`needsSkills`/`needsAutomations` are booleans.
/// Every field is optional (a partial or empty classification is valid); only a present-but-mistyped
/// field is rejected, field-level (#2395) so an LLM author can self-correct.
pub fn validate_classify_config(v: &Value) -> Result<(), String> {
    let noun = "classification";
    if !v.is_object() {
        return Err(reject(noun, vec![
            r#"the classification must be a JSON object, e.g. {"uiMode": "custom", "needsSource": false}"#.into(),
        ]));
    }
    let mut errs = Vec::new();
    if let Some(m) = v.get("uiMode") {
        if !matches!(m.as_str(), Some("custom") | Some("external")) {
            errs.push(r#""uiMode" must be "custom" (in-app designer preview) or "external" (bring design files)"#.into());
        }
    }
    // The taxonomy axes. An unknown token is rejected with the full vocabulary, so the planner can
    // correct itself without reading the source.
    for (key, allowed) in [
        ("appType", &APP_TYPES[..]),
        ("lifecycle", &LIFECYCLES[..]),
        ("uiSystem", &SYSTEM_SOURCES[..]),
        ("algorithmSystem", &SYSTEM_SOURCES[..]),
    ] {
        if let Some(t) = v.get(key) {
            if !t.as_str().is_some_and(|s| allowed.contains(&s)) {
                errs.push(format!(r#""{key}" must be one of: {}"#, allowed.join(", ")));
            }
        }
    }
    for k in ["needsMarket", "needsSource", "needsMcp", "needsSkills", "needsAutomations"] {
        if let Some(b) = v.get(k) {
            if !b.is_boolean() {
                errs.push(format!(r#""{k}" must be a boolean (true/false) when present"#));
            }
        }
    }
    if errs.is_empty() { Ok(()) } else { Err(reject(noun, errs)) }
}

/// The readiness suffix printed after a successful `classify set` (mirrors [`market_readiness`]):
/// the discovered lifecycle + app type, the chosen UI mode, and which optional stages the
/// classification turns on. Unset axes report their read-as default, so the planner sees exactly
/// what the plan will do rather than a blank.
pub fn classify_readiness(v: &Value) -> String {
    let ui = v.get("uiMode").and_then(Value::as_str).unwrap_or("custom");
    let app_type = v.get("appType").and_then(Value::as_str).unwrap_or("application");
    let lifecycle = v.get("lifecycle").and_then(Value::as_str).unwrap_or("greenfield");
    let ui_system = v.get("uiSystem").and_then(Value::as_str).unwrap_or("studio");
    let algo_system = v.get("algorithmSystem").and_then(Value::as_str).unwrap_or("studio");
    let on = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
    let mut stages = Vec::new();
    if on("needsMarket") { stages.push("market"); }
    if on("needsSource") { stages.push("source"); }
    if on("needsMcp") { stages.push("mcp"); }
    if on("needsSkills") { stages.push("skills"); }
    if on("needsAutomations") { stages.push("automations"); }
    let list = if stages.is_empty() { "none".to_string() } else { stages.join(", ") };
    // #4115: both system axes are echoed BEFORE `uiMode`, because they govern whether uiMode means
    // anything — for an `own` project our pipeline never renders, whichever surface the designs came
    // from — and because they are the security-relevant answer the planner must be able to re-read.
    format!(
        " — {lifecycle} {app_type}; uiSystem {ui_system}; algorithmSystem {algo_system}; \
         uiMode {ui}; optional stages: {list}"
    )
}

// ── transformations (`bsc plan transformation add/update`) — the modification list (#2509) ──────

/// The transformation taxonomy — the same file the frontend imports as
/// `@data/transformations/taxonomy.json` (#2509 slice b), embedded at compile time (the
/// `DEPLOY_TAXONOMY_JSON`/`MARKET_RUBRIC_JSON` pattern) so the verb + recipe vocabularies have one
/// source of truth. Each verb carries a known recipe + verification pattern; the recipes are the
/// composite transforms that GENERATE list entries (the codified refactor workflow + the
/// migrate-to-kit flagship).
const TRANSFORMATION_TAXONOMY_JSON: &str =
    include_str!("../../../src-tauri/data/transformations/taxonomy.json");

/// The `id`s of one taxonomy section (`verbs` / `recipes`), in file order.
fn transformation_taxonomy_ids(key: &str) -> Vec<String> {
    let v: Value = serde_json::from_str(TRANSFORMATION_TAXONOMY_JSON).unwrap_or(Value::Null);
    v[key]
        .as_array()
        .map(|arr| arr.iter().filter_map(|x| x["id"].as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// The taxonomy's verb ids (rename … harden) a transformation's `verb` must name.
fn transformation_verbs() -> &'static Vec<String> {
    static VERBS: OnceLock<Vec<String>> = OnceLock::new();
    VERBS.get_or_init(|| transformation_taxonomy_ids("verbs"))
}

/// The taxonomy's recipe ids a transformation's `provenance.recipe` may name.
fn transformation_recipes() -> &'static Vec<String> {
    static RECIPES: OnceLock<Vec<String>> = OnceLock::new();
    RECIPES.get_or_init(|| transformation_taxonomy_ids("recipes"))
}

/// Validate ONE transformation row against the #2509 contract — the unit behind the bottom-up
/// confirm queue. Required: `verb` from the taxonomy; a non-empty `title`; a `target` object with a
/// non-empty `description` (targets are DISCOVERED by scanning, never invented) and optional `files`
/// (non-empty strings); a non-empty `delta` (from-state → to-state); non-empty `invariants` (what
/// must NOT change) and `owns` (the blast radius); an integer `tier >= 0` (the composition tier the
/// confirm queue orders by). Optional: `id` (non-empty when present), `dependsOn` (strings),
/// `provenance` (`recipe` from the recipe set, `evidence` strings), `kitContribution`/`confirmed`
/// (booleans), `spec` (an object — the render spec the pane previews; REQUIRED when
/// `kitContribution` is true, since a gap-fill row proposes a NEW component the user decides on by
/// SEEING its live preview). Rejections are field-level (#2395) so an LLM author can self-correct.
pub fn validate_transformation(v: &Value) -> Result<(), String> {
    let mut errs = Vec::new();
    transformation_errors("", v, &mut errs);
    if errs.is_empty() { Ok(()) } else { Err(reject("transformation", errs)) }
}

/// Validate a whole `transformation add` batch (already normalized to a slice — one stdin object or
/// an array). The batch is rejected WHOLE (nothing is written) with each error naming its row.
pub fn validate_transformations(rows: &[Value]) -> Result<(), String> {
    let mut errs = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        transformation_errors(&format!("transformations[{i}]."), row, &mut errs);
    }
    if errs.is_empty() { Ok(()) } else { Err(reject("transformation batch", errs)) }
}

/// Validate a `transformation update <id>` blob: the row contract, plus its `"id"` (when present)
/// must MATCH the `<id>` argument — the row is keyed by the argument but readers (and other rows'
/// `dependsOn`) key off the blob's `id`, so a mismatch makes the item unreachable under either name.
pub fn validate_transformation_update(arg_id: &str, v: &Value) -> Result<(), String> {
    let mut errs = Vec::new();
    transformation_errors("", v, &mut errs);
    if let Some(id) = str_of(v, "id") {
        if id != arg_id.trim() {
            errs.push(format!(
                r#"id: the blob's id "{id}" does not match the argument "{arg_id}" — readers and dependsOn key off the row's "id", so they must agree"#
            ));
        }
    }
    if errs.is_empty() { Ok(()) } else { Err(reject("transformation", errs)) }
}

/// One row's field-level errors, each prefixed with `at` (`""` for a single row,
/// `"transformations[i]."` in a batch).
fn transformation_errors(at: &str, v: &Value, errs: &mut Vec<String>) {
    if !v.is_object() {
        errs.push(format!(
            "{}: each transformation must be a JSON object (verb / title / target / delta / invariants / owns / tier)",
            if at.is_empty() { "transformation" } else { at.trim_end_matches('.') }
        ));
        return;
    }
    match str_of(v, "verb") {
        Some(verb) if transformation_verbs().iter().any(|w| w == verb) => {}
        Some(verb) => errs.push(format!(
            r#"{at}verb: unknown verb "{verb}" — the taxonomy is {}"#,
            quote_list(transformation_verbs())
        )),
        None => {
            errs.push(format!(r#"{at}verb: missing — one of {}"#, quote_list(transformation_verbs())))
        }
    }
    if str_of(v, "title").is_none() {
        errs.push(format!("{at}title: missing non-empty title — the queue item's one-line name"));
    }
    if present(v, "id") && str_of(v, "id").is_none() {
        errs.push(format!(
            "{at}id: must be a non-empty string when present (the row key; derived from the title when omitted)"
        ));
    }
    match v.get("target") {
        Some(t) if t.is_object() => {
            if str_of(t, "description").is_none() {
                errs.push(format!(
                    "{at}target.description: missing non-empty description — the identified piece of the EXISTING system (discovered by scanning, never invented)"
                ));
            }
            if present(t, "files") {
                nonempty_string_list(&format!("{at}target.files"), t.get("files").unwrap_or(&Value::Null), false, errs);
            }
        }
        Some(_) => errs.push(format!(r#"{at}target: must be an object {{"description": "...", "files": ["..."]}}"#)),
        None => errs.push(format!(
            r#"{at}target: missing — {{"description": "the scanned target"}}; targets are discovered by scanning the linked repos, never invented"#
        )),
    }
    if str_of(v, "delta").is_none() {
        errs.push(format!("{at}delta: missing non-empty delta — the from-state → to-state"));
    }
    nonempty_string_list(&format!("{at}invariants"), v.get("invariants").unwrap_or(&Value::Null), true, errs);
    nonempty_string_list(&format!("{at}owns"), v.get("owns").unwrap_or(&Value::Null), true, errs);
    match v.get("tier") {
        Some(t) => match t.as_i64() {
            Some(n) if n >= 0 => {}
            Some(n) => errs.push(format!(
                "{at}tier: {n} is negative — the composition tier is an integer >= 0 (0 = primitives … N = pages)"
            )),
            None => errs.push(format!(
                "{at}tier: not an integer — the composition tier is an integer >= 0 (0 = primitives … N = pages)"
            )),
        },
        None => errs.push(format!(
            "{at}tier: missing — the composition tier the bottom-up confirm queue orders by (an integer >= 0: 0 = primitives … N = pages)"
        )),
    }
    if present(v, "dependsOn") {
        nonempty_string_list(&format!("{at}dependsOn"), v.get("dependsOn").unwrap_or(&Value::Null), false, errs);
    }
    if let Some(p) = v.get("provenance").filter(|p| !p.is_null()) {
        if !p.is_object() {
            errs.push(format!(r#"{at}provenance: must be an object {{"recipe": ..., "evidence": ["..."]}} when present"#));
        } else {
            if present(p, "recipe") {
                match str_of(p, "recipe") {
                    Some(r) if transformation_recipes().iter().any(|k| k == r) => {}
                    _ => errs.push(format!(
                        "{at}provenance.recipe: unknown recipe — expected {}",
                        quote_list(transformation_recipes())
                    )),
                }
            }
            if present(p, "evidence") {
                nonempty_string_list(&format!("{at}provenance.evidence"), p.get("evidence").unwrap_or(&Value::Null), false, errs);
            }
        }
    }
    for key in ["kitContribution", "confirmed"] {
        if present(v, key) && !v.get(key).map(Value::is_boolean).unwrap_or(false) {
            errs.push(format!("{at}{key}: must be a boolean when present"));
        }
    }
    if present(v, "spec") && !v.get("spec").map(Value::is_object).unwrap_or(false) {
        errs.push(format!(
            "{at}spec: must be an object when present (the render spec the pane previews — the full node contract stays in the frontend / `bsc ui validate`)"
        ));
    }
    // A gap-fill row (kitContribution: true) proposes a NEW component the user decides on by SEEING
    // it, so the confirm-queue card needs a live preview: require a `spec`. (Presence + object shape
    // only — the full node contract is enforced in the frontend / `bsc ui`, not duplicated here.)
    if v.get("kitContribution").and_then(Value::as_bool).unwrap_or(false) && !present(v, "spec") {
        errs.push(format!(
            "{at}spec: a gap-fill row (kitContribution: true) needs a preview spec — the render spec the pane previews live so the user can SEE the proposed component"
        ));
    }
}

/// Require `val` to be an array of non-empty strings; when `required`, it must also be present and
/// non-empty. Pushes one field-level error naming `at` on any failure.
fn nonempty_string_list(at: &str, val: &Value, required: bool, errs: &mut Vec<String>) {
    match val.as_array() {
        Some(arr) => {
            if required && arr.is_empty() {
                errs.push(format!("{at}: must be a NON-EMPTY array of strings"));
            } else if !arr.iter().all(|s| s.as_str().map(str::trim).filter(|x| !x.is_empty()).is_some()) {
                errs.push(format!("{at}: every entry must be a non-empty string"));
            }
        }
        None if required => errs.push(format!("{at}: missing — a non-empty array of strings")),
        None => errs.push(format!("{at}: must be an array of strings when present")),
    }
}

/// The non-fatal readiness echo after a transformation write (mirrors [`deploy_readiness`]):
/// `N transformations · M confirmed · tiers 0-K` — so the author (and the pane) see how far the
/// bottom-up confirm queue is from the `transformationsConfirmed` gate (every item confirmed).
pub fn transformations_readiness(rows: &[Value]) -> String {
    if rows.is_empty() {
        return "0 transformations — gate blocked: decompose the modification request first (the transformationsConfirmed gate needs the list, every item confirmed)".into();
    }
    let confirmed = rows
        .iter()
        .filter(|r| r.get("confirmed").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let max_tier = rows.iter().filter_map(|r| r.get("tier").and_then(Value::as_i64)).max().unwrap_or(0).max(0);
    let base = format!("{} transformations · {confirmed} confirmed · tiers 0-{max_tier}", rows.len());
    if confirmed == rows.len() {
        format!("{base} — all confirmed")
    } else {
        format!(
            "{base} — gate blocked: {} pending (the USER confirms each item in the pane, bottom-up)",
            rows.len() - confirmed
        )
    }
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

// ── ui pairing (`bsc plan ui set`) — the planned app's {kit, theme} pair (#2489) ─────────────────

/// Validate the UI pairing blob: `{ "kit": { "id", "version" }, "themeId" }`, both halves optional
/// but not both absent. Mirrors consumption: the emission path (`bsc ui emit-css --theme <id>`) and
/// the worker context read `themeId` (an empty one silently falls back to `default`, hiding the
/// choice), and the kit half is only usable with a non-empty `id` + `version` (the store ref).
pub fn validate_ui_pairing(v: &Value) -> Result<(), String> {
    let noun = "ui pairing";
    if !v.is_object() {
        return Err(reject(noun, vec![
            r#"the pairing must be a JSON object: {"kit": {"id": "bsc/react-ui", "version": "1.0.0"}, "themeId": "soft"}"#.into(),
        ]));
    }
    let mut errs = Vec::new();
    if let Some(kit) = v.get("kit").filter(|k| !k.is_null()) {
        if !kit.is_object() {
            errs.push(r#""kit" must be a JSON object: {"id": "bsc/react-ui", "version": "1.0.0"}"#.into());
        } else if str_of(kit, "id").is_none() || str_of(kit, "version").is_none() {
            errs.push(r#""kit" needs a non-empty "id" AND "version" — the id@version ref into the released-kit store; without both the pin is unusable"#.into());
        }
    }
    if present(v, "themeId") && str_of(v, "themeId").is_none() {
        errs.push(r#""themeId" must be a non-empty string — a `bsc ui theme list` id (an empty one silently falls back to "default", hiding the choice)"#.into());
    }
    if !present(v, "kit") && !present(v, "themeId") {
        errs.push(r#"an empty pairing records nothing — set at least a "kit" or a "themeId""#.into());
    }
    if errs.is_empty() { Ok(()) } else { Err(reject(noun, errs)) }
}

/// The pairing's human-mode set-echo halves: (`id@version` or `(none)`, themeId or `default`).
pub fn ui_pairing_echo(v: &Value) -> (String, String) {
    let kit = v
        .get("kit")
        .and_then(|k| Some(format!("{}@{}", str_of(k, "id")?, str_of(k, "version")?)))
        .unwrap_or_else(|| "(none)".into());
    let theme = str_of(v, "themeId").unwrap_or("default").to_string();
    (kit, theme)
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

    // ── market ───────────────────────────────────────────────────────────────────────────────

    /// A fully scored + cited market assessment (the #2430 contract shape).
    fn good_market() -> Value {
        let cell = |score: i64| {
            json!({ "score": score, "rationale": "cited evidence", "sources": ["https://example.com/source"] })
        };
        json!({
            "summary": "Real, cited pain in a reachable niche.",
            "scores": {
                "problemSeverity": cell(4), "problemFrequency": cell(3), "reachableMarket": cell(4),
                "competitiveGap": cell(3), "timing": cell(3), "moat": cell(2)
            },
            "sizing": { "tam": "$4B", "sam": "$480M", "som": "$2M ARR", "method": "bottom-up" },
            "competitors": [{ "name": "FreshBooks", "pricing": "$19-60/mo", "gap": "chasing is buried" }],
            "verdict": { "recommendation": "caution", "rationale": "thin moat" }
        })
    }

    #[test]
    fn market_accepts_the_contract_shape_with_and_without_optionals() {
        assert!(validate_market_config(&good_market()).is_ok());
        // sizing/competitors are optional — a payload without them is still valid.
        let mut lean = good_market();
        lean.as_object_mut().unwrap().remove("sizing");
        lean.as_object_mut().unwrap().remove("competitors");
        assert!(validate_market_config(&lean).is_ok());
    }

    #[test]
    fn market_rejects_each_broken_dimension_shape_with_a_field_level_message() {
        // missing dimension — named
        let mut m = good_market();
        m["scores"].as_object_mut().unwrap().remove("timing");
        let err = validate_market_config(&m).unwrap_err();
        assert!(err.contains("scores.timing: missing"), "names the missing dimension: {err}");
        // score 0 (below range) — named
        let mut m = good_market();
        m["scores"]["moat"]["score"] = json!(0);
        let err = validate_market_config(&m).unwrap_err();
        assert!(err.contains("scores.moat.score: 0 is out of range"), "{err}");
        // score 6 (above range) — named
        let mut m = good_market();
        m["scores"]["problemSeverity"]["score"] = json!(6);
        let err = validate_market_config(&m).unwrap_err();
        assert!(err.contains("scores.problemSeverity.score: 6 is out of range"), "{err}");
        // non-integer score
        let mut m = good_market();
        m["scores"]["timing"]["score"] = json!(3.5);
        assert!(validate_market_config(&m).unwrap_err().contains("scores.timing.score: missing or not an integer"));
        // empty rationale — named
        let mut m = good_market();
        m["scores"]["competitiveGap"]["rationale"] = json!("  ");
        let err = validate_market_config(&m).unwrap_err();
        assert!(err.contains("scores.competitiveGap.rationale"), "{err}");
        // empty sources — the citation-discipline rejection, named
        let mut m = good_market();
        m["scores"]["reachableMarket"]["sources"] = json!([]);
        let err = validate_market_config(&m).unwrap_err();
        assert!(err.contains("scores.reachableMarket.sources") && err.contains("NON-EMPTY"), "{err}");
        // a blank source string inside the array
        let mut m = good_market();
        m["scores"]["problemFrequency"]["sources"] = json!(["https://ok.example", ""]);
        assert!(validate_market_config(&m).unwrap_err().contains("scores.problemFrequency.sources"));
        // an unknown seventh dimension — EXACTLY six
        let mut m = good_market();
        m["scores"]["brandStrength"] = json!({ "score": 3, "rationale": "r", "sources": ["https://x"] });
        let err = validate_market_config(&m).unwrap_err();
        assert!(err.contains("scores.brandStrength: unknown dimension"), "{err}");
    }

    #[test]
    fn market_rejects_summary_verdict_and_structural_problems() {
        // bad recommendation — named, with the vocabulary
        let mut m = good_market();
        m["verdict"]["recommendation"] = json!("maybe");
        let err = validate_market_config(&m).unwrap_err();
        assert!(err.contains(r#"verdict.recommendation: unknown value "maybe""#) && err.contains("no-go"), "{err}");
        // missing verdict / empty verdict rationale
        let mut m = good_market();
        m.as_object_mut().unwrap().remove("verdict");
        assert!(validate_market_config(&m).unwrap_err().contains(r#"missing "verdict""#));
        let mut m = good_market();
        m["verdict"]["rationale"] = json!("");
        assert!(validate_market_config(&m).unwrap_err().contains("verdict.rationale"));
        // missing summary / scores / root shape
        let mut m = good_market();
        m.as_object_mut().unwrap().remove("summary");
        assert!(validate_market_config(&m).unwrap_err().contains(r#"missing non-empty "summary""#));
        let mut m = good_market();
        m.as_object_mut().unwrap().remove("scores");
        assert!(validate_market_config(&m).unwrap_err().contains(r#"missing "scores""#));
        assert!(validate_market_config(&json!("nope")).unwrap_err().contains("must be a JSON object"));
        // optional fields shape-checked when present
        let mut m = good_market();
        m["sizing"] = json!("big");
        assert!(validate_market_config(&m).unwrap_err().contains(r#""sizing" must be a JSON object"#));
        let mut m = good_market();
        m["competitors"] = json!("many");
        assert!(validate_market_config(&m).unwrap_err().contains(r#""competitors" must be a JSON array"#));
        let mut m = good_market();
        m["competitors"] = json!([{ "pricing": "$9/mo" }]);
        assert!(validate_market_config(&m).unwrap_err().contains(r#"competitors[0]: missing non-empty "name""#));
        // the rejection wrapper documents the escape hatch
        assert!(validate_market_config(&json!({})).unwrap_err().contains("--force"));
    }

    #[test]
    fn market_readiness_mirrors_the_gate_and_names_missing_dimensions() {
        assert_eq!(
            market_readiness(&good_market()),
            " — 6 of 6 dimensions scored, cited (verdict: caution)"
        );
        // a partial (--force-stored) assessment names what still blocks the gate
        let mut m = good_market();
        m["scores"].as_object_mut().unwrap().remove("timing");
        m["scores"]["moat"]["sources"] = json!([]);
        let echo = market_readiness(&m);
        assert!(echo.contains("4 of 6 dimensions scored"), "{echo}");
        assert!(echo.contains("timing, moat missing"), "{echo}");
        assert!(echo.contains("gate blocked") && echo.contains("marketDefined"), "{echo}");
    }

    #[test]
    fn market_rubric_embeds_six_dimensions_and_unit_weights_per_category() {
        // The embedded file is the SAME @data/market/rubric.json the frontend loads for the
        // weighted total — guard the dimension set + that every category's weights cover exactly
        // those dimensions and sum to 1.
        let dims = market_dimensions();
        assert_eq!(
            dims.as_slice(),
            ["problemSeverity", "problemFrequency", "reachableMarket", "competitiveGap", "timing", "moat"]
        );
        let rubric: Value = serde_json::from_str(MARKET_RUBRIC_JSON).unwrap();
        let weights = rubric["weights"].as_object().expect("weights map");
        for cat in ["greenfield", "transform", "harden", "maintain"] {
            let w = weights[cat].as_object().unwrap_or_else(|| panic!("weights for {cat}"));
            let keys: std::collections::BTreeSet<&str> = w.keys().map(String::as_str).collect();
            let expected: std::collections::BTreeSet<&str> = dims.iter().map(String::as_str).collect();
            assert_eq!(keys, expected, "{cat} weights cover exactly the rubric dimensions");
            let sum: f64 = w.values().filter_map(Value::as_f64).sum();
            assert!((sum - 1.0).abs() < 1e-9, "{cat} weights sum to 1 (got {sum})");
        }
    }

    // ── transformations (#2509) ──────────────────────────────────────────────────────────────

    /// A fully specified transformation (the #2509 contract shape, every optional present).
    fn good_transformation() -> Value {
        json!({
            "id": "replace-bespoke-buttons",
            "verb": "replace",
            "title": "Replace the bespoke buttons with the kit Button",
            "target": {
                "description": "the hand-rolled button components across the dashboard",
                "files": ["src/components/SaveButton.tsx"]
            },
            "delta": "each bespoke button renders through the kit Button",
            "invariants": ["existing tests pass", "click handlers keep their behavior"],
            "owns": ["src/components/*Button*.tsx"],
            "dependsOn": [],
            "tier": 0,
            "provenance": { "recipe": "migrate-to-kit", "evidence": ["src/components/SaveButton.tsx"] },
            "kitContribution": false,
            "spec": { "type": "Button", "props": { "variant": "primary" } },
            "confirmed": false
        })
    }

    #[test]
    fn transformation_accepts_the_contract_shape_with_and_without_optionals() {
        assert!(validate_transformation(&good_transformation()).is_ok());
        // the minimal row: only the required fields
        let lean = json!({
            "verb": "extract", "title": "Extract the form field",
            "target": { "description": "the duplicated form scaffold" },
            "delta": "one shared FormField", "invariants": ["existing tests pass"],
            "owns": ["src/shared/"], "tier": 1
        });
        assert!(validate_transformation(&lean).is_ok());
        // a gap-fill row (kitContribution: true) is accepted WITH its preview spec (#2509 slice d)
        let mut gap = good_transformation();
        gap["kitContribution"] = json!(true);
        assert!(gap.get("spec").is_some());
        assert!(validate_transformation(&gap).is_ok());
    }

    #[test]
    fn transformation_rejects_each_broken_field_with_a_field_level_message() {
        // non-object row
        assert!(validate_transformation(&json!("nope")).unwrap_err().contains("must be a JSON object"));
        // unknown / missing verb — names the field + the taxonomy
        let mut t = good_transformation();
        t["verb"] = json!("polish");
        let err = validate_transformation(&t).unwrap_err();
        assert!(err.contains(r#"verb: unknown verb "polish""#) && err.contains("\"harden\""), "{err}");
        let mut t = good_transformation();
        t.as_object_mut().unwrap().remove("verb");
        assert!(validate_transformation(&t).unwrap_err().contains("verb: missing"));
        // title / delta
        let mut t = good_transformation();
        t["title"] = json!("  ");
        assert!(validate_transformation(&t).unwrap_err().contains("title: missing non-empty"));
        let mut t = good_transformation();
        t.as_object_mut().unwrap().remove("delta");
        assert!(validate_transformation(&t).unwrap_err().contains("delta: missing non-empty"));
        // target: missing / wrong shape / empty description / bad files
        let mut t = good_transformation();
        t.as_object_mut().unwrap().remove("target");
        assert!(validate_transformation(&t).unwrap_err().contains("target: missing"));
        let mut t = good_transformation();
        t["target"] = json!("the buttons");
        assert!(validate_transformation(&t).unwrap_err().contains("target: must be an object"));
        let mut t = good_transformation();
        t["target"] = json!({ "files": ["a.tsx"] });
        assert!(validate_transformation(&t).unwrap_err().contains("target.description"));
        let mut t = good_transformation();
        t["target"]["files"] = json!(["ok.tsx", ""]);
        assert!(validate_transformation(&t).unwrap_err().contains("target.files"));
        // invariants: missing / empty / blank entry
        let mut t = good_transformation();
        t.as_object_mut().unwrap().remove("invariants");
        assert!(validate_transformation(&t).unwrap_err().contains("invariants: missing"));
        let mut t = good_transformation();
        t["invariants"] = json!([]);
        assert!(validate_transformation(&t).unwrap_err().contains("invariants: must be a NON-EMPTY array"));
        let mut t = good_transformation();
        t["invariants"] = json!(["ok", " "]);
        assert!(validate_transformation(&t).unwrap_err().contains("invariants: every entry"));
        // owns (the blast radius): empty
        let mut t = good_transformation();
        t["owns"] = json!([]);
        assert!(validate_transformation(&t).unwrap_err().contains("owns: must be a NON-EMPTY array"));
        // tier: missing / negative / non-integer
        let mut t = good_transformation();
        t.as_object_mut().unwrap().remove("tier");
        assert!(validate_transformation(&t).unwrap_err().contains("tier: missing"));
        let mut t = good_transformation();
        t["tier"] = json!(-1);
        assert!(validate_transformation(&t).unwrap_err().contains("tier: -1 is negative"));
        let mut t = good_transformation();
        t["tier"] = json!(1.5);
        assert!(validate_transformation(&t).unwrap_err().contains("tier: not an integer"));
        // dependsOn entries must be non-empty strings
        let mut t = good_transformation();
        t["dependsOn"] = json!([7]);
        assert!(validate_transformation(&t).unwrap_err().contains("dependsOn"));
        // provenance: wrong shape / unknown recipe / bad evidence
        let mut t = good_transformation();
        t["provenance"] = json!("scan");
        assert!(validate_transformation(&t).unwrap_err().contains("provenance: must be an object"));
        let mut t = good_transformation();
        t["provenance"]["recipe"] = json!("copy-paste");
        let err = validate_transformation(&t).unwrap_err();
        assert!(err.contains("provenance.recipe: unknown recipe") && err.contains("extract-and-abstract"), "{err}");
        let mut t = good_transformation();
        t["provenance"]["evidence"] = json!([""]);
        assert!(validate_transformation(&t).unwrap_err().contains("provenance.evidence"));
        // booleans + spec + id
        let mut t = good_transformation();
        t["kitContribution"] = json!("yes");
        assert!(validate_transformation(&t).unwrap_err().contains("kitContribution: must be a boolean"));
        let mut t = good_transformation();
        t["confirmed"] = json!("true");
        assert!(validate_transformation(&t).unwrap_err().contains("confirmed: must be a boolean"));
        let mut t = good_transformation();
        t["spec"] = json!("Button");
        assert!(validate_transformation(&t).unwrap_err().contains("spec: must be an object"));
        // a gap-fill row (kitContribution: true) WITHOUT a spec is rejected — the user must SEE the
        // proposed component (#2509 slice d)
        let mut t = good_transformation();
        t["kitContribution"] = json!(true);
        t.as_object_mut().unwrap().remove("spec");
        let err = validate_transformation(&t).unwrap_err();
        assert!(err.contains("gap-fill row (kitContribution: true) needs a preview spec"), "{err}");
        let mut t = good_transformation();
        t["id"] = json!("  ");
        assert!(validate_transformation(&t).unwrap_err().contains("id: must be a non-empty string"));
        // the rejection wrapper documents the escape hatch
        assert!(validate_transformation(&json!({})).unwrap_err().contains("--force"));
    }

    #[test]
    fn transformation_batch_names_the_offending_row_and_update_checks_the_id() {
        // a batch error carries the row index so the author can find it
        let err = validate_transformations(&[good_transformation(), json!({ "verb": "extract" })]).unwrap_err();
        assert!(err.contains("transformations[1].title"), "{err}");
        assert!(!err.contains("transformations[0]"), "the good row raises nothing: {err}");
        assert!(validate_transformations(&[good_transformation()]).is_ok());
        // update: the blob id must match the argument (readers + dependsOn key off the blob's id)
        assert!(validate_transformation_update("replace-bespoke-buttons", &good_transformation()).is_ok());
        let err = validate_transformation_update("other-id", &good_transformation()).unwrap_err();
        assert!(err.contains(r#"does not match the argument "other-id""#), "{err}");
        // an id-less update blob is fine — the row is keyed by the argument
        let mut t = good_transformation();
        t.as_object_mut().unwrap().remove("id");
        assert!(validate_transformation_update("anything", &t).is_ok());
    }

    #[test]
    fn transformation_taxonomy_embeds_the_shared_vocabulary() {
        // The embedded file is the SAME @data/transformations/taxonomy.json the frontend loads for
        // verbMeta/tierLabel (#2509 slice b) — pin the vocabulary: 11 verbs (in enum order),
        // 2 recipes, 4 tiers (primitives → composites → layouts → pages), and that every verb
        // carries the display + verification metadata both sides read.
        assert_eq!(
            transformation_verbs().as_slice(),
            ["rename", "extract", "split", "merge", "move", "replace", "upgrade", "restyle", "remove", "optimize", "harden"]
        );
        assert_eq!(transformation_recipes().as_slice(), ["migrate-to-kit", "extract-and-abstract"]);
        let v: Value = serde_json::from_str(TRANSFORMATION_TAXONOMY_JSON).unwrap();
        for verb in v["verbs"].as_array().unwrap() {
            for field in ["label", "blurb", "verification"] {
                assert!(
                    verb[field].as_str().is_some_and(|s| !s.trim().is_empty()),
                    "verb {} carries a non-empty {field}",
                    verb["id"]
                );
            }
        }
        for recipe in v["recipes"].as_array().unwrap() {
            assert!(
                recipe["steps"].as_array().is_some_and(|s| !s.is_empty()),
                "recipe {} carries its canonical steps",
                recipe["id"]
            );
        }
        let tiers = v["tiers"].as_array().expect("tiers array");
        assert_eq!(tiers.len(), 4, "the four composition tiers");
        let labels: Vec<&str> = tiers.iter().filter_map(|t| t["label"].as_str()).collect();
        assert_eq!(labels, ["primitives", "composites", "layouts", "pages"]);
        for (i, t) in tiers.iter().enumerate() {
            assert_eq!(t["tier"].as_i64(), Some(i as i64), "tiers are 0..3 in order");
            assert!(t["blurb"].as_str().is_some_and(|s| !s.trim().is_empty()));
        }
    }

    #[test]
    fn transformations_readiness_reports_counts_tiers_and_the_gate() {
        // empty list: the gate can never pass — say so
        let echo = transformations_readiness(&[]);
        assert!(echo.contains("0 transformations") && echo.contains("gate blocked"), "{echo}");
        // partial: N · M · tiers 0-K + the pending count (and WHO confirms)
        let mut a = good_transformation();
        a["confirmed"] = json!(true);
        let mut b = good_transformation();
        b["tier"] = json!(2);
        b.as_object_mut().unwrap().remove("confirmed");
        let c = good_transformation(); // confirmed: false
        let echo = transformations_readiness(&[a.clone(), b.clone(), c]);
        assert!(echo.contains("3 transformations · 1 confirmed · tiers 0-2"), "{echo}");
        assert!(echo.contains("gate blocked: 2 pending") && echo.contains("USER confirms"), "{echo}");
        // all confirmed: the gate-ready branch
        b["confirmed"] = json!(true);
        let echo = transformations_readiness(&[a, b]);
        assert!(echo.contains("2 transformations · 2 confirmed · tiers 0-2"), "{echo}");
        assert!(echo.contains("all confirmed"), "{echo}");
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

    // ── ui pairing (#2489) ───────────────────────────────────────────────────────────────────

    #[test]
    fn ui_pairing_validation_accepts_the_pair_and_each_half_alone() {
        assert!(validate_ui_pairing(&json!({ "kit": { "id": "bsc/react-ui", "version": "1.0.0" }, "themeId": "soft" })).is_ok());
        assert!(validate_ui_pairing(&json!({ "themeId": "default" })).is_ok());
        assert!(validate_ui_pairing(&json!({ "kit": { "id": "acme/neon", "version": "2.0.0" } })).is_ok());
    }

    #[test]
    fn ui_pairing_validation_rejects_the_silently_misbehaving_shapes() {
        // Non-object / empty pairing — nothing downstream could read either.
        assert!(validate_ui_pairing(&json!("soft")).is_err());
        let err = validate_ui_pairing(&json!({})).unwrap_err();
        assert!(err.contains("at least"), "{err}");
        // A kit missing id/version is an unusable store ref.
        let err = validate_ui_pairing(&json!({ "kit": { "id": "bsc/react-ui" } })).unwrap_err();
        assert!(err.contains(r#""id" AND "version""#), "{err}");
        assert!(validate_ui_pairing(&json!({ "kit": "bsc/react-ui" })).is_err());
        // An empty themeId silently falls back to default downstream — reject it loudly.
        let err = validate_ui_pairing(&json!({ "themeId": "" })).unwrap_err();
        assert!(err.contains("non-empty string"), "{err}");
    }

    #[test]
    fn ui_pairing_echo_renders_both_halves_with_defaults() {
        let (kit, theme) = ui_pairing_echo(&json!({ "kit": { "id": "bsc/react-ui", "version": "1.0.0" }, "themeId": "soft" }));
        assert_eq!((kit.as_str(), theme.as_str()), ("bsc/react-ui@1.0.0", "soft"));
        let (kit, theme) = ui_pairing_echo(&json!({ "kit": { "id": "x" } }));
        assert_eq!((kit.as_str(), theme.as_str()), ("(none)", "default"));
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

    // ── classify (#3783/#3784/#3806) ─────────────────────────────────────────────────────────

    #[test]
    fn classify_accepts_an_empty_partial_or_full_classification() {
        // Every field is optional — an unclassified project is valid, and so is any subset.
        assert!(validate_classify_config(&json!({})).is_ok());
        assert!(validate_classify_config(&json!({ "uiMode": "external" })).is_ok());
        assert!(validate_classify_config(&json!({
            "lifecycle": "transform", "appType": "mcp-server", "uiMode": "custom",
            "needsMarket": false, "needsSource": true, "needsMcp": true,
            "needsSkills": false, "needsAutomations": false
        }))
        .is_ok());
    }

    #[test]
    fn classify_accepts_every_published_taxonomy_token() {
        for t in APP_TYPES {
            assert!(validate_classify_config(&json!({ "appType": t })).is_ok(), "appType {t}");
        }
        for l in LIFECYCLES {
            assert!(validate_classify_config(&json!({ "lifecycle": l })).is_ok(), "lifecycle {l}");
        }
    }

    #[test]
    fn classify_accepts_every_ui_system_and_rejects_a_near_miss() {
        // #4115. `uiSystem` answers WHO RENDERS the project's UI; `uiMode` only says where the
        // designs come from. Both tokens must validate…
        for s in SYSTEM_SOURCES {
            assert!(validate_classify_config(&json!({ "uiSystem": s })).is_ok(), "uiSystem {s}");
            assert!(validate_classify_config(&json!({ "algorithmSystem": s })).is_ok(), "algorithmSystem {s}");
        }
        assert!(SYSTEM_SOURCES.contains(&"studio") && SYSTEM_SOURCES.contains(&"own"));
        // …and the two axes must be independently settable, including the combination the axis
        // exists for: the user brings design files AND keeps their own rendering stack.
        assert!(validate_classify_config(&json!({ "uiSystem": "own", "uiMode": "external" })).is_ok());
        // A near-miss is REJECTED rather than coerced — the issue's rejected alternative was a third
        // `uiMode` value, so `"owned"` on the wrong field must not quietly pass.
        let err = validate_classify_config(&json!({ "uiSystem": "owned" })).unwrap_err();
        assert!(err.contains("uiSystem"), "{err}");
        assert!(err.contains("studio") && err.contains("own"), "the error must list the vocabulary: {err}");
        // Cross-contamination between the axes is rejected in both directions.
        assert!(validate_classify_config(&json!({ "uiSystem": "external" })).is_err());
        assert!(validate_classify_config(&json!({ "uiMode": "own" })).is_err());
        assert!(validate_classify_config(&json!({ "uiSystem": 1 })).is_err());
    }

    #[test]
    fn classify_takes_the_two_system_axes_independently() {
        // #4115: `uiSystem` and `algorithmSystem` are the two halves of the surface our host RUNS —
        // component code rendered in a frame, stored vizCode compiled and executed. They differ often
        // (own UI, studio algorithms is a normal project), so neither may imply the other.
        assert!(validate_classify_config(&json!({ "uiSystem": "own", "algorithmSystem": "studio" })).is_ok());
        assert!(validate_classify_config(&json!({ "uiSystem": "studio", "algorithmSystem": "own" })).is_ok());
        // Same rejection discipline as its twin — the vocabulary is named so the planner self-corrects.
        let err = validate_classify_config(&json!({ "algorithmSystem": "graph" })).unwrap_err();
        assert!(err.contains("algorithmSystem"), "{err}");
        assert!(err.contains("studio") && err.contains("own"), "{err}");
        assert!(validate_classify_config(&json!({ "algorithmSystem": false })).is_err());
    }

    #[test]
    fn classify_accepts_the_harvest_lifecycle_by_name() {
        // #4062. The loop above only proves the array validates itself; this pins the TOKEN, so
        // dropping `harvest` from LIFECYCLES fails here rather than silently shrinking the vocabulary
        // the planner is told to write.
        assert!(validate_classify_config(&json!({ "lifecycle": "harvest" })).is_ok());
        assert!(LIFECYCLES.contains(&"harvest"));
    }

    #[test]
    fn classify_rejects_an_unknown_taxonomy_token_and_names_the_vocabulary() {
        // The planner self-corrects from the error, so the message must carry the full list.
        let err = validate_classify_config(&json!({ "appType": "webapp" })).unwrap_err();
        assert!(err.contains("appType"), "{err}");
        assert!(err.contains("mcp-server"), "the error must list the vocabulary: {err}");

        let err = validate_classify_config(&json!({ "lifecycle": "rewrite" })).unwrap_err();
        assert!(err.contains("greenfield") && err.contains("maintain"), "{err}");
    }

    #[test]
    fn classify_rejects_a_mistyped_axis_that_is_not_a_string() {
        assert!(validate_classify_config(&json!({ "appType": 3 })).is_err());
        assert!(validate_classify_config(&json!({ "lifecycle": true })).is_err());
        assert!(validate_classify_config(&json!({ "needsSource": "yes" })).is_err());
        assert!(validate_classify_config(&json!("custom")).is_err());
    }

    #[test]
    fn classify_readiness_reports_the_axes_and_their_unset_defaults() {
        let full = classify_readiness(&json!({
            "lifecycle": "harden", "appType": "api", "uiMode": "external", "needsSource": true
        }));
        assert!(full.contains("harden api"), "{full}");
        assert!(full.contains("uiMode external"), "{full}");
        assert!(full.contains("source"), "{full}");

        // An unset axis reports what the plan will actually DO, not a blank.
        let bare = classify_readiness(&json!({}));
        assert!(bare.contains("greenfield application"), "{bare}");
        assert!(bare.contains("optional stages: none"), "{bare}");
    }

    #[test]
    fn classify_readiness_echoes_both_system_axes_ahead_of_the_ui_mode() {
        // #4115: the planner reads this line back to confirm what it just recorded, so the axes that
        // decide whether our platform renders and executes for this project at all have to be IN it —
        // and ahead of `uiMode`, which only means something when the UI answer is `studio`.
        let own = classify_readiness(&json!({
            "uiSystem": "own", "algorithmSystem": "studio", "uiMode": "external"
        }));
        assert!(own.contains("uiSystem own"), "{own}");
        assert!(own.contains("algorithmSystem studio"), "{own}");
        assert!(own.find("uiSystem") < own.find("uiMode"), "{own}");
        assert!(own.find("algorithmSystem") < own.find("uiMode"), "{own}");
        // Unset reports the read-as default rather than a blank, like every other axis — and BOTH
        // axes report, so a project that owns one half can never read as owning neither.
        let bare = classify_readiness(&json!({}));
        assert!(bare.contains("uiSystem studio") && bare.contains("algorithmSystem studio"), "{bare}");
    }
}
