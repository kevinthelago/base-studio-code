//! Project classification (#3783/#3784/#3806) — one JSON blob per project (single row): the planner's
//! discovery output that shapes the plan. The contract shape is `{ uiMode: "custom"|"external",
//! needsMarket?: bool, needsSource?: bool, needsMcp?: bool, needsSkills?: bool, needsAutomations?: bool }`
//! — `uiMode` selects the UI stage's surface (the in-app designer preview vs the external
//! Claude-Design drop-files intake), and the `needs*` booleans mark which optional stages (market /
//! source / mcp / skills / automations) the project shows. The planner records it as the closing step
//! of Discovery (there is no separate Configure stage, #3806). EVERY field is optional (an
//! unclassified project reads as absent, and each consumer applies its own non-regressing default),
//! validated at set-time by [`crate::validate::validate_classify_config`] so a mistyped value is
//! rejected loudly instead of silently mis-shaping the plan.

use crate::Store;

impl Store {
    /// Replace the project's classification (a single JSON blob — the full contract shape).
    pub fn classify_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("classify", data)
    }

    /// The stored classification, or None if unset.
    pub fn classify_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("classify")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.classify_get().unwrap().is_none());
        s.classify_set(&serde_json::json!({ "uiMode": "external", "needsSource": true }))
            .unwrap();
        let got = s.classify_get().unwrap().unwrap();
        assert_eq!(got["uiMode"], serde_json::json!("external"));
        assert_eq!(got["needsSource"], serde_json::json!(true));
        // a fresh set replaces the whole blob (single row)
        s.classify_set(&serde_json::json!({ "uiMode": "custom" })).unwrap();
        assert_eq!(s.classify_get().unwrap().unwrap()["uiMode"], serde_json::json!("custom"));
        s.clear().unwrap();
        assert!(s.classify_get().unwrap().is_none());
    }
}

// ── The classification's DERIVED PREDICATES ────────────────────────────────────────────────────
//
// `epic-frontend-logic-over-backend-resources-belongs-in-rust`. This module STORED a classification
// and `validate::validate_classify_config` VALIDATED it; neither ever asked anything OF it. Every
// question about what a classification MEANS lived in the renderer, while driving which stages a
// project needs, whether the designer is wired in, whether the host must isolate before rendering,
// and what the director is told. A worker could read the blob via `bsc plan classify get` and had no
// way to read its meaning.
//
// Ported from `classify-config.ts` and proved against `classifyPredicates.fixtures.json`, generated
// from it. The taxonomy these branch on is itself proved equal by `classifyTaxonomy.fixtures.json`,
// which is why this can walk every token rather than a sample.
//
// THE DEFAULTING IS THE CONTRACT, not an implementation detail. Every accessor returns a value for
// an absent field, so "absent" and "explicitly the default" are indistinguishable downstream — which
// is what makes every axis non-regressing for projects planned before it existed. Returning an
// `Option` here instead would change behaviour at every call site.

use crate::validate::{APP_TYPES, LIFECYCLES, SYSTEM_SOURCES};

/// The app types that carry a USER INTERFACE — the ones for which the `ui` stage is meaningful.
/// Everything else (an API, serverless functions, a CLI, a library, an MCP server) has no screens to
/// design. A private subset on the TypeScript side; named here so the fixture can pin it.
pub const UI_BEARING: [&str; 4] = ["application", "static", "desktop", "mobile"];

/// A classification as `classify_get` returns it. Fields are optional because every axis is, and
/// each has a documented read-as default — except [`ClassifyConfig::uses_github`], which has none.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClassifyConfig {
    pub ui_mode: Option<String>,
    pub ui_system: Option<String>,
    pub algorithm_system: Option<String>,
    pub app_type: Option<String>,
    pub lifecycle: Option<String>,
    /// UNDECIDED when absent, and deliberately never defaulted: every other axis has a safe read-as
    /// value, while this one is a question someone has to answer. Reading absent as `false` would
    /// look settled, so `bsc publish` refuses only on an explicit `false`.
    pub uses_github: Option<bool>,
    pub needs_market: Option<bool>,
    pub needs_source: Option<bool>,
    pub needs_mcp: Option<bool>,
    pub needs_skills: Option<bool>,
    pub needs_automations: Option<bool>,
}

/// One axis, defaulted. A token outside its vocabulary reads as the DEFAULT rather than passing
/// through: on the TypeScript side `coerceClassifyConfig` drops it before the accessor ever sees it,
/// so this is the composed behaviour of that pair, reached in one step here.
fn axis<'a>(value: Option<&'a str>, allowed: &[&str], default: &'a str) -> &'a str {
    match value {
        Some(v) if allowed.contains(&v) => v,
        _ => default,
    }
}

/// The project's app type, with the unclassified default applied.
pub fn app_type_of(cfg: Option<&ClassifyConfig>) -> &str {
    axis(cfg.and_then(|c| c.app_type.as_deref()), &APP_TYPES, "application")
}

/// The project's lifecycle intent, with the unclassified default applied.
pub fn lifecycle_of(cfg: Option<&ClassifyConfig>) -> &str {
    axis(cfg.and_then(|c| c.lifecycle.as_deref()), &LIFECYCLES, "greenfield")
}

/// Who renders this project's UI. Unset reads as `studio` — today's behaviour for every project that
/// exists — so the axis is non-regressing by construction and needs no backfill.
pub fn ui_system_of(cfg: Option<&ClassifyConfig>) -> &str {
    axis(cfg.and_then(|c| c.ui_system.as_deref()), &SYSTEM_SOURCES, "studio")
}

/// Where this project's algorithms come from — the twin of [`ui_system_of`], same default and same
/// non-regressing rule.
pub fn algorithm_system_of(cfg: Option<&ClassifyConfig>) -> &str {
    axis(cfg.and_then(|c| c.algorithm_system.as_deref()), &SYSTEM_SOURCES, "studio")
}

/// Does this project render from OUR component graph? The gate for everything that only applies to
/// studio-rendered projects — kit pinning, the graph vocabulary in worker context, the build/publish
/// pipeline, and the render isolation the preview frames owe LLM-authored code.
pub fn renders_from_studio(cfg: Option<&ClassifyConfig>) -> bool {
    ui_system_of(cfg) == "studio"
}

/// Does this project's computation come from OUR algorithms graph? The twin gate — the librarian,
/// `bsc graph impl` in worker context, and sandboxed `vizCode` execution.
pub fn computes_from_studio(cfg: Option<&ClassifyConfig>) -> bool {
    algorithm_system_of(cfg) == "studio"
}

/// Does our HOST take in and run any of this project's artifacts? True when EITHER system axis is
/// `studio`.
///
/// This is the isolate-before-render question and the OR is deliberate: isolation is owed if ANY one
/// surface hosts project code, and a project that owns its UI can still draw its algorithms from the
/// graph. Reading only `ui_system` answers it wrongly for exactly that project — and the algorithm
/// half is the more dangerous one to get wrong, since it RUNS code rather than rendering it.
pub fn host_runs_project_artifacts(cfg: Option<&ClassifyConfig>) -> bool {
    renders_from_studio(cfg) || computes_from_studio(cfg)
}

/// Does this project have screens to design? An UNCLASSIFIED project reads as `application` and so
/// as TRUE, which is what stops this hiding a `ui` stage that showed before the planner classified.
pub fn app_type_has_ui(cfg: Option<&ClassifyConfig>) -> bool {
    UI_BEARING.contains(&app_type_of(cfg))
}

/// Project the classification into the flat gate-signal bag — one boolean per token across the four
/// axes, plus the derived reads.
///
/// Exposed as signals rather than a single string because the stage-gate bag supports only
/// numbers and booleans, and because it lets a cloud-distributed stage key its `appliesWhen` on an
/// app type the app ships no code for. `uses_github` is deliberately NOT among them: it has no
/// default, and a signal bag has no way to say undecided.
pub fn classify_signals(cfg: Option<&ClassifyConfig>) -> std::collections::BTreeMap<String, bool> {
    let app_type = app_type_of(cfg);
    let lifecycle = lifecycle_of(cfg);
    let ui_system = ui_system_of(cfg);
    let algorithm_system = algorithm_system_of(cfg);
    let mut out = std::collections::BTreeMap::new();
    out.insert("hasUserInterface".to_string(), app_type_has_ui(cfg));
    out.insert("rendersFromStudio".to_string(), renders_from_studio(cfg));
    out.insert("computesFromStudio".to_string(), computes_from_studio(cfg));
    out.insert("hostRunsProjectArtifacts".to_string(), host_runs_project_artifacts(cfg));
    for t in APP_TYPES {
        out.insert(format!("appType:{t}"), t == app_type);
    }
    for l in LIFECYCLES {
        out.insert(format!("lifecycle:{l}"), l == lifecycle);
    }
    for s in SYSTEM_SOURCES {
        out.insert(format!("uiSystem:{s}"), s == ui_system);
    }
    for s in SYSTEM_SOURCES {
        out.insert(format!("algorithmSystem:{s}"), s == algorithm_system);
    }
    out
}

#[cfg(test)]
mod predicate_contract {
    use super::*;

    /// Resolved BY FILENAME under `src/`, the rule every cross-language contract here uses.
    fn fixture() -> serde_json::Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("classifyPredicates.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one classifyPredicates.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// `null` and `undefined` are two ways of saying nothing; both become `None`. A `config` input
    /// deserializes into the typed struct.
    fn input_of(v: &serde_json::Value) -> Option<ClassifyConfig> {
        match v["kind"].as_str() {
            Some("null") | Some("undefined") => None,
            Some("config") => Some(serde_json::from_value(v["value"].clone()).expect("fixture config")),
            other => panic!("unknown input kind {other:?}"),
        }
    }

    /// THE POINT: these predicates decide which stages a project needs and whether the host isolates
    /// before it renders. A port that answers one of them differently changes what the planner does,
    /// silently, for a class of project nobody is looking at.
    #[test]
    fn rust_derives_the_same_predicates_the_typescript_does() {
        let fx = fixture();
        let cases = fx["cases"].as_array().expect("fixture cases");
        assert!(cases.len() >= 20, "the corpus must walk the taxonomy: {}", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let owned = input_of(&c["input"]);
            let cfg = owned.as_ref();
            assert_eq!(app_type_of(cfg), c["appType"].as_str().unwrap(), "appType for {name:?}");
            assert_eq!(lifecycle_of(cfg), c["lifecycle"].as_str().unwrap(), "lifecycle for {name:?}");
            assert_eq!(ui_system_of(cfg), c["uiSystem"].as_str().unwrap(), "uiSystem for {name:?}");
            assert_eq!(algorithm_system_of(cfg), c["algorithmSystem"].as_str().unwrap(), "algorithmSystem for {name:?}");
            assert_eq!(renders_from_studio(cfg), c["rendersFromStudio"].as_bool().unwrap(), "rendersFromStudio for {name:?}");
            assert_eq!(computes_from_studio(cfg), c["computesFromStudio"].as_bool().unwrap(), "computesFromStudio for {name:?}");
            assert_eq!(host_runs_project_artifacts(cfg), c["hostRunsProjectArtifacts"].as_bool().unwrap(), "hostRunsProjectArtifacts for {name:?}");
            assert_eq!(app_type_has_ui(cfg), c["appTypeHasUi"].as_bool().unwrap(), "appTypeHasUi for {name:?}");

            let want: std::collections::BTreeMap<String, bool> =
                serde_json::from_value(c["signals"].clone()).expect("fixture signals");
            assert_eq!(classify_signals(cfg), want, "signal bag for {name:?}");
        }
    }

    /// The private `UI_BEARING` subset, pinned from the TypeScript's own answer rather than copied
    /// from its source — the subset is what decides whether the `ui` stage applies at all.
    #[test]
    fn the_ui_bearing_subset_matches_the_typescript() {
        let fx = fixture();
        let want: Vec<String> =
            serde_json::from_value(fx["uiBearing"].clone()).expect("fixture uiBearing");
        let mut got: Vec<String> = UI_BEARING.iter().map(|s| s.to_string()).collect();
        let mut want_sorted = want.clone();
        got.sort();
        want_sorted.sort();
        assert_eq!(got, want_sorted, "the UI-bearing app types drifted");
        assert!(!want.is_empty() && want.len() < APP_TYPES.len(), "it must be a proper SUBSET");
    }

    // ---------------------------------------------------------------------------------------------
    // Properties the fixture states only implicitly.
    // ---------------------------------------------------------------------------------------------

    /// The defaulting IS the contract. An unclassified project must read as a fully classified one,
    /// because that is what makes every axis non-regressing for projects planned before it existed.
    #[test]
    fn an_absent_config_reads_as_the_documented_defaults() {
        assert_eq!(app_type_of(None), "application");
        assert_eq!(lifecycle_of(None), "greenfield");
        assert_eq!(ui_system_of(None), "studio");
        assert_eq!(algorithm_system_of(None), "studio");
        assert!(app_type_has_ui(None), "an unclassified project still shows the ui stage");
        assert!(host_runs_project_artifacts(None), "and is still isolated before rendering");
        // An EMPTY config is a different input and must reach the same answers.
        let empty = ClassifyConfig::default();
        assert_eq!(app_type_of(Some(&empty)), app_type_of(None));
        assert_eq!(classify_signals(Some(&empty)), classify_signals(None));
    }

    /// A token outside its vocabulary reads as the DEFAULT, never passes through. On the TypeScript
    /// side `coerceClassifyConfig` drops it before an accessor sees it; this reaches the same place
    /// in one step. Without this an unknown appType would emit `appType:<junk>` into the signal bag
    /// and match no stage's `appliesWhen` at all.
    #[test]
    fn a_token_outside_the_taxonomy_reads_as_the_default() {
        let junk = ClassifyConfig {
            app_type: Some("not-an-app-type".into()),
            lifecycle: Some("".into()),
            ui_system: Some("elsewhere".into()),
            ..Default::default()
        };
        assert_eq!(app_type_of(Some(&junk)), "application");
        assert_eq!(lifecycle_of(Some(&junk)), "greenfield");
        assert_eq!(ui_system_of(Some(&junk)), "studio");
        assert_eq!(classify_signals(Some(&junk)), classify_signals(None));
    }

    /// `uses_github` has NO default and must never acquire one. Unset is UNDECIDED; only an explicit
    /// `false` is a decision, which is what `bsc publish` refuses on.
    #[test]
    fn uses_github_is_never_defaulted_and_never_a_signal() {
        assert_eq!(ClassifyConfig::default().uses_github, None, "absent stays absent");
        let no = ClassifyConfig { uses_github: Some(false), ..Default::default() };
        assert_eq!(no.uses_github, Some(false), "an explicit false is a decision, not an absence");
        for cfg in [None, Some(&ClassifyConfig::default()), Some(&no)] {
            assert!(
                !classify_signals(cfg).keys().any(|k| k.contains("usesGithub")),
                "a signal bag has no way to say undecided, so this axis must not appear in it"
            );
        }
    }

    /// The OR in `host_runs_project_artifacts`, stated exhaustively: only own/own is false. A port
    /// reading a single axis passes three of these four.
    #[test]
    fn the_host_runs_artifacts_or_is_exhaustive() {
        for (ui, algo, want) in [
            ("studio", "studio", true),
            ("studio", "own", true),
            ("own", "studio", true),
            ("own", "own", false),
        ] {
            let cfg = ClassifyConfig {
                ui_system: Some(ui.into()),
                algorithm_system: Some(algo.into()),
                ..Default::default()
            };
            assert_eq!(host_runs_project_artifacts(Some(&cfg)), want, "ui={ui} algorithm={algo}");
        }
    }
}
