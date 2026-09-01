//! Which provider and model a PANE actually launches against.
//!
//! # The inversion this closes
//!
//! `session/harness.rs` states it plainly: "provider/model/permissions come from env". Rust spawns the
//! agent process and consumes an already-resolved provider and model — it cannot derive them. So the
//! renderer decides which endpoint an agent talks to and the backend obeys, which is the same shape as
//! the role gate and the profile bridge before they moved.
//!
//! # The four rules, and why #4 is the one that matters
//!
//! 1. No per-pane model → the global config, untouched.
//! 2. The pane's model IS a shipped tier id → the global config. A tier is the global's business.
//! 3. The provider already needs `bsc-agent` (`local`/`ollama`) → the global config with the pane's model.
//! 4. Otherwise — a NON-tier model on a HOSTED provider — re-route to `ollama` at the configured local
//!    endpoint, dropping the hosted key.
//!
//! Rule 4 is #173. A pane only reaches this having already resolved its own harness to `bsc-agent`, which
//! `streamPaneWiring` sets PER STREAM, independently of the fleet-wide provider. So a non-tier model here
//! can only be a local model reached on a fleet whose global provider is still Anthropic/OpenAI/Gemini —
//! and that provider and key do not apply to this pane at all. Keeping them is how a `bsc-agent` process
//! gets launched with `BSC_AGENT_PROVIDER=anthropic` and a Claude-tier model when the stream was given a
//! local one. The API key is dropped rather than carried, because it belongs to a provider this pane is
//! no longer talking to.
//!
//! # Parity, faithfully
//!
//! `paneLlmRouting.fixtures.json` is generated from the live `paneLlmConfig` over the REAL shipped tiers
//! (`data/console/models.json`) and this module is asserted equal to it case by case.
//!
//! It used to reproduce a DEFECT, deliberately. The TypeScript wrote `cfg.baseUrl ||
//! DEFAULT_LOCAL_BASE_URL`, a FALSY test, so an empty string defaulted but a WHITESPACE-ONLY base URL
//! (`"   "`) was truthy and survived verbatim — an endpoint that cannot dial, reaching the agent as its
//! base URL and failing far from the Settings field that caused it. The port mirrored that, because
//! that slice's contract was parity and changing which endpoint a live session reaches wanted a revert
//! of its own.
//!
//! `a-whitespace-base-url-survives-the-pane-routing-and-cannot-dial` is that revert, and BOTH SIDES
//! MOVED TOGETHER: the TypeScript now writes `cfg.baseUrl.trim() || DEFAULT_LOCAL_BASE_URL`, this test
//! trims, and the fixture is regenerated so the two still agree. The value is trimmed as well as tested,
//! because `"  http://box:11434/v1  "` cannot dial either.
//!
//! The store's setter trims too (`setLocalBaseUrl`), which is where the item asked for the fix — a
//! stored `"   "` is the actual defect and every downstream `||` is a symptom. Trimming here as well is
//! NOT "trimming at every reader": it makes the ONE emptiness test on this path agree with
//! `resolve_base_url`, which has always trimmed, and it is what covers the values persisted before the
//! setter was fixed.
//!
//! One asymmetry inherited from the same source, worth naming so it is not read as a bug here: rule 3
//! does NOT default the base URL (an `ollama` pane with none configured keeps `""`), while rule 4 does.
//! Downstream, `resolve_base_url` supplies the default at provider-construction time, so the empty value
//! never reaches a request. Rule 3 also passes the configured URL through untrimmed; that is harmless
//! for the same reason, and the setter is what keeps an untrimmed one from being stored at all.

use crate::DEFAULT_LOCAL_BASE_URL;

/// A resolved LLM configuration — the shape the frontend's `LlmConfig` carries across the launch.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    /// Empty for `local`/`ollama`, which need no key.
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
    /// The context ceiling, when the user set one. `None` means "use the runtime's packaged ceiling".
    #[serde(default)]
    pub num_ctx: Option<u64>,
}

/// Providers the `claude` CLI cannot drive — it only ever speaks to Anthropic. A session on one of these
/// MUST run on the `bsc-agent` harness, so picking it implies `bsc-agent` regardless of the fleet toggle.
pub fn provider_needs_bsc_agent(provider: &str) -> bool {
    provider == "local" || provider == "ollama"
}

/// This pane's effective configuration. `tier_model_ids` is the shipped tier list
/// (`data/console/models.json`); a pane model matching one of those is a tier selection, not a local
/// model name.
pub fn pane_llm_config(global: &LlmConfig, pane_model: Option<&str>, tier_model_ids: &[String]) -> LlmConfig {
    // Rule 1. An empty string is falsy in the TypeScript and lands here too, not in rule 4.
    let Some(pane_model) = pane_model.filter(|m| !m.is_empty()) else {
        return global.clone();
    };
    // Rule 2.
    if tier_model_ids.iter().any(|id| id == pane_model) {
        return global.clone();
    }
    // Rule 3.
    if provider_needs_bsc_agent(&global.provider) {
        return LlmConfig { model: pane_model.to_string(), ..global.clone() };
    }
    // Rule 4 — #173. The emptiness test TRIMS, matching `llm::resolve_base_url` and the TypeScript this
    // is proved against — see the module docs.
    LlmConfig {
        provider: "ollama".to_string(),
        model: pane_model.to_string(),
        api_key: String::new(),
        base_url: if global.base_url.trim().is_empty() {
            DEFAULT_LOCAL_BASE_URL.to_string()
        } else {
            global.base_url.trim().to_string()
        },
        num_ctx: global.num_ctx,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture is GENERATED from the live `paneLlmConfig`, so this proves Rust equals what the
    /// renderer actually does — not what its author believed it did.
    fn fixture() -> serde_json::Value {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("paneLlmRouting.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one paneLlmRouting.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// Reports EVERY mismatch at once — a wrong port is usually wrong in a pattern, and one failing
    /// assertion hides the shape of it.
    #[test]
    fn the_routing_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let tiers: Vec<String> =
            doc["tierModelIds"].as_array().expect("tierModelIds").iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert!(
            tiers.len() >= 3,
            "only {} shipped tiers — rule 2 would be barely exercised and the fixture near-vacuous",
            tiers.len()
        );

        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 15, "fixture shrank to {} cases — regenerate it", cases.len());

        let mut mismatches = Vec::new();
        let mut rerouted = 0usize;
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let global: LlmConfig = serde_json::from_value(case["global"].clone())
                .unwrap_or_else(|e| panic!("{label}: global did not deserialize: {e}"));
            let want: LlmConfig = serde_json::from_value(case["expected"].clone())
                .unwrap_or_else(|e| panic!("{label}: expected did not deserialize: {e}"));
            let pane_model = case["paneModel"].as_str();

            let got = pane_llm_config(&global, pane_model, &tiers);
            if got != want {
                mismatches.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
            if want.provider != global.provider {
                rerouted += 1;
            }
        }
        assert!(
            rerouted >= 4,
            "only {rerouted} cases actually changed provider — rule 4 is the reason this exists and the \
             fixture must exercise it"
        );
        assert!(
            mismatches.is_empty(),
            "the Rust routing disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }

    fn cfg(provider: &str, model: &str, key: &str, url: &str) -> LlmConfig {
        LlmConfig {
            provider: provider.into(),
            model: model.into(),
            api_key: key.into(),
            base_url: url.into(),
            num_ctx: None,
        }
    }

    const TIERS: [&str; 3] = ["haiku-4.5", "sonnet-4.5", "opus-4.5"];
    fn tiers() -> Vec<String> {
        TIERS.iter().map(|s| s.to_string()).collect()
    }

    /// RULE 4, stated directly — the reason this module exists. A hosted provider plus a non-tier model
    /// means the stream handed this pane a local model, and the hosted endpoint does not apply to it.
    #[test]
    fn a_non_tier_model_on_a_hosted_provider_reroutes_and_drops_the_key() {
        let global = cfg("anthropic", "opus-4.5", "sk-secret", "");
        let got = pane_llm_config(&global, Some("qwen2.5-coder"), &tiers());
        assert_eq!(got.provider, "ollama", "#173: a hosted provider must not survive a local model");
        assert_eq!(got.model, "qwen2.5-coder");
        assert_eq!(got.api_key, "", "the hosted key belongs to a provider this pane no longer talks to");
        assert_eq!(got.base_url, DEFAULT_LOCAL_BASE_URL, "no endpoint configured → the crate's default");
    }

    /// RULE 2 — a tier id is the global's business and must NOT be mistaken for a local model name.
    #[test]
    fn every_shipped_tier_leaves_the_global_config_untouched() {
        let global = cfg("anthropic", "sonnet-4.5", "sk-secret", "");
        for tier in TIERS {
            assert_eq!(
                pane_llm_config(&global, Some(tier), &tiers()),
                global,
                "tier {tier} was treated as a local model name"
            );
        }
    }

    /// RULE 3 — an already-local provider keeps its endpoint and only swaps the model. Its base URL is
    /// deliberately NOT defaulted here; `resolve_base_url` does that at construction time.
    #[test]
    fn an_already_local_provider_keeps_its_endpoint_and_takes_the_pane_model() {
        for provider in ["local", "ollama"] {
            let global = cfg(provider, "llama3", "", "http://box:11434/v1");
            let got = pane_llm_config(&global, Some("qwen2.5-coder"), &tiers());
            assert_eq!(got.provider, provider, "an already-local provider must not be rewritten");
            assert_eq!(got.model, "qwen2.5-coder");
            assert_eq!(got.base_url, "http://box:11434/v1", "the configured endpoint is kept verbatim");
        }
        let no_url = pane_llm_config(&cfg("ollama", "llama3", "", ""), Some("q"), &tiers());
        assert_eq!(no_url.base_url, "", "rule 3 does not default the endpoint — resolve_base_url does");
    }

    /// RULE 1 — including the empty string, which is FALSY in the TypeScript and so lands here rather
    /// than being re-routed as a nameless local model.
    #[test]
    fn no_pane_model_or_an_empty_one_returns_the_global_untouched() {
        let global = cfg("anthropic", "opus-4.5", "sk-secret", "");
        assert_eq!(pane_llm_config(&global, None, &tiers()), global);
        assert_eq!(
            pane_llm_config(&global, Some(""), &tiers()),
            global,
            "an empty pane model is absence, not a local model called \"\""
        );
    }

    /// A whitespace-only endpoint resolves to the default, and a padded one is trimmed.
    ///
    /// THIS IS THE SAME TEST, UPDATED — not a new one, and not the old one deleted. It was written as
    /// `a_whitespace_base_url_survives_verbatim_matching_the_typescripts_falsy_test`, asserting that
    /// `"   "` survived, so that the ported defect could not change unnoticed. It is the test the fix
    /// was supposed to turn RED, and this is that flip. Reading the diff of this function IS the
    /// behaviour change.
    #[test]
    fn a_whitespace_base_url_resolves_to_the_default_instead_of_surviving_verbatim() {
        let got = pane_llm_config(&cfg("anthropic", "opus-4.5", "sk", "   "), Some("llama3.1"), &tiers());
        assert_eq!(
            got.base_url, DEFAULT_LOCAL_BASE_URL,
            "was \"   \" — a whitespace-only endpoint is not an endpoint, and it reached the agent as one"
        );

        let empty = pane_llm_config(&cfg("anthropic", "opus-4.5", "sk", ""), Some("llama3.1"), &tiers());
        assert_eq!(empty.base_url, DEFAULT_LOCAL_BASE_URL, "an EMPTY string still defaults, as it always did");

        // The value is TRIMMED, not merely tested: a padded URL cannot dial either.
        let padded =
            pane_llm_config(&cfg("anthropic", "opus-4.5", "sk", "  http://box:11434/v1  "), Some("llama3.1"), &tiers());
        assert_eq!(padded.base_url, "http://box:11434/v1");

        // …and a real endpoint is untouched, which is what a trim must not break.
        let real =
            pane_llm_config(&cfg("anthropic", "opus-4.5", "sk", "http://box:11434/v1"), Some("llama3.1"), &tiers());
        assert_eq!(real.base_url, "http://box:11434/v1");
    }

    /// The context ceiling is a property of the user's configuration, not of the provider, so it must
    /// survive a re-route — a local model getting the packaged ceiling instead of the configured one is
    /// exactly the class of context bug this fleet has been chasing.
    #[test]
    fn num_ctx_survives_every_rule() {
        let global = LlmConfig { num_ctx: Some(65536), ..cfg("anthropic", "opus-4.5", "sk", "") };
        assert_eq!(pane_llm_config(&global, Some("llama3.1"), &tiers()).num_ctx, Some(65536), "rule 4");
        assert_eq!(pane_llm_config(&global, Some("opus-4.5"), &tiers()).num_ctx, Some(65536), "rule 2");
        let local = LlmConfig { num_ctx: Some(4096), ..cfg("ollama", "llama3", "", "") };
        assert_eq!(pane_llm_config(&local, Some("q"), &tiers()).num_ctx, Some(4096), "rule 3");
    }

    /// An unknown provider is NOT a hosted-provider special case — it falls to rule 4 like any other
    /// non-local provider, rather than being passed through with a local model it cannot serve.
    #[test]
    fn an_unknown_provider_still_reroutes() {
        let got = pane_llm_config(&cfg("some-new-vendor", "x", "sk", ""), Some("llama3.1"), &tiers());
        assert_eq!(got.provider, "ollama");
        assert!(!provider_needs_bsc_agent("some-new-vendor"));
        assert!(provider_needs_bsc_agent("local") && provider_needs_bsc_agent("ollama"));
    }
}
