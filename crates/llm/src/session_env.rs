//! The environment a session needs to REACH its model.
//!
//! # Everything downstream of this is already Rust
//!
//! `crates/bsc-agent/src/main.rs` reads `BSC_AGENT_PROVIDER`, `BSC_AGENT_MODEL` and the key; this
//! crate reads `BSC_AGENT_NUM_CTX` and clamps `num_ctx` by it (#1829); `crates/llm/src/cli.rs`
//! documents it as the context the app requests per slot. So the entire model-reaching configuration
//! is consumed in Rust and was composed in a renderer.
//!
//! # `num_ctx` is a PRESENCE test, never a truthiness test
//!
//! `Some(0)` MEANS "do not set num_ctx" — a real instruction, not an absence — and `None` means "say
//! nothing, let the runtime use its packaged ceiling". A truthy test collapses those two into one and
//! silently drops the instruction while looking correct.
//!
//! That matters more than it reads. `build_provider` has honoured `$BSC_AGENT_NUM_CTX` since #1829,
//! and for a long time NOTHING SET IT — the Settings control was an uncontrolled placeholder input —
//! so the one escape hatch for a prompt that overflows its window existed and was unreachable. A port
//! that gets the `0` case wrong re-breaks that hatch in a way no type checker sees.
//!
//! # The Aider local path needs a key it does not use
//!
//! A local / OpenAI-compatible endpoint wants no credential, but the OpenAI client refuses to
//! initialise without a non-empty `OPENAI_API_KEY`, so a placeholder is substituted. Dropping it as
//! "the local server needs no key" is the obvious simplification and breaks every local Aider session
//! at client init.

use std::collections::BTreeMap;

use crate::routing::LlmConfig;

/// The placeholder a keyless local endpoint still needs, so the OpenAI client will initialise.
pub const LOCAL_KEY_PLACEHOLDER: &str = "sk-local-none";

/// Is this an OpenAI-compatible local endpoint?
fn is_local(provider: &str) -> bool {
    provider == "local" || provider == "ollama"
}

/// The `BSC_AGENT_*` environment a `bsc-agent` session needs.
///
/// An empty key or base URL contributes NO variable rather than an empty one — an empty
/// `BSC_AGENT_API_KEY` reads downstream as a present-but-invalid credential.
pub fn bsc_agent_env(cfg: &LlmConfig) -> BTreeMap<String, String> {
    let mut e = BTreeMap::new();
    e.insert("BSC_AGENT_PROVIDER".to_string(), cfg.provider.clone());
    e.insert("BSC_AGENT_MODEL".to_string(), cfg.model.clone());
    if !cfg.api_key.is_empty() {
        e.insert("BSC_AGENT_API_KEY".to_string(), cfg.api_key.clone());
    }
    if !cfg.base_url.is_empty() {
        e.insert("BSC_AGENT_BASE_URL".to_string(), cfg.base_url.clone());
    }
    // PRESENCE, not truthiness — see the module docs. `Some(0)` is an instruction.
    if let Some(n) = cfg.num_ctx {
        e.insert("BSC_AGENT_NUM_CTX".to_string(), n.to_string());
    }
    e
}

/// Aider's `--model` selector. litellm namespaces models by provider, takes OpenAI models bare, and
/// reaches a local endpoint through the `openai/` namespace. A model that already carries a namespace
/// passes through untouched.
pub fn aider_model_arg(cfg: &LlmConfig) -> String {
    let m = cfg.model.trim();
    if m.contains('/') {
        return m.to_string();
    }
    match cfg.provider.as_str() {
        "anthropic" => format!("anthropic/{m}"),
        "gemini" => format!("gemini/{m}"),
        "openai" => m.to_string(),
        _ if is_local(&cfg.provider) => format!("openai/{m}"),
        // An unknown provider gets the model verbatim: guessing a namespace for a vendor nobody has
        // added would produce a selector litellm cannot resolve, and the bare name at least fails with
        // the model's real name in the error.
        _ => m.to_string(),
    }
}

/// The environment an Aider session needs, under the variables Aider/litellm reads.
pub fn aider_env(cfg: &LlmConfig) -> BTreeMap<String, String> {
    let mut e = BTreeMap::new();
    match cfg.provider.as_str() {
        "anthropic" => {
            if !cfg.api_key.is_empty() {
                e.insert("ANTHROPIC_API_KEY".to_string(), cfg.api_key.clone());
            }
        }
        "openai" => {
            if !cfg.api_key.is_empty() {
                e.insert("OPENAI_API_KEY".to_string(), cfg.api_key.clone());
            }
        }
        "gemini" => {
            if !cfg.api_key.is_empty() {
                e.insert("GEMINI_API_KEY".to_string(), cfg.api_key.clone());
            }
        }
        p if is_local(p) => {
            if !cfg.base_url.is_empty() {
                e.insert("OPENAI_API_BASE".to_string(), cfg.base_url.clone());
            }
            // ALWAYS non-empty — see the module docs.
            let key = if cfg.api_key.is_empty() { LOCAL_KEY_PLACEHOLDER } else { &cfg.api_key };
            e.insert("OPENAI_API_KEY".to_string(), key.to_string());
        }
        // An unknown provider contributes nothing rather than guessing which variable it reads.
        _ => {}
    }
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("providerEnv.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one providerEnv.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn map(v: &serde_json::Value) -> BTreeMap<String, String> {
        v.as_object()
            .unwrap()
            .iter()
            .map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string()))
            .collect()
    }

    /// Reports every mismatch at once, and compares the WHOLE map — an extra variable is as much a
    /// defect as a missing one, since an empty `BSC_AGENT_API_KEY` reads as a present-but-invalid
    /// credential downstream.
    #[test]
    fn the_provider_env_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 18, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut with_ctx, mut local_n, mut keyless) = (0usize, 0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let cfg: LlmConfig = serde_json::from_value(case["config"].clone())
                .unwrap_or_else(|e| panic!("{label}: config did not deserialize: {e}"));
            if cfg.num_ctx.is_some() {
                with_ctx += 1;
            }
            if is_local(&cfg.provider) {
                local_n += 1;
            }
            if cfg.api_key.is_empty() {
                keyless += 1;
            }

            for (what, got, want) in [
                ("bscAgent", bsc_agent_env(&cfg), map(&case["bscAgent"])),
                ("aider", aider_env(&cfg), map(&case["aider"])),
            ] {
                if got != want {
                    mismatches.push(format!("  {label} [{what}]\n    ts   {want:?}\n    rust {got:?}"));
                }
            }
            let want_model = case["aiderModel"].as_str().unwrap();
            let got_model = aider_model_arg(&cfg);
            if got_model != want_model {
                mismatches.push(format!("  {label} [model] ts={want_model:?} rust={got_model:?}"));
            }
        }
        assert!(with_ctx >= 4, "only {with_ctx} cases carried a num_ctx");
        assert!(local_n >= 5, "only {local_n} local-provider cases");
        assert!(keyless >= 5, "only {keyless} keyless cases");
        assert!(
            mismatches.is_empty(),
            "the Rust mapping disagrees with the live TypeScript on {} point(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    fn cfg(provider: &str, model: &str, key: &str, url: &str, num_ctx: Option<u64>) -> LlmConfig {
        LlmConfig {
            provider: provider.into(),
            model: model.into(),
            api_key: key.into(),
            base_url: url.into(),
            num_ctx,
        }
    }

    /// THE CASE A TRUTHY TEST DESTROYS. `Some(0)` is an instruction; `None` is an absence.
    #[test]
    fn num_ctx_zero_is_emitted_and_absent_is_not() {
        let zero = bsc_agent_env(&cfg("ollama", "q", "", "", Some(0)));
        assert_eq!(
            zero.get("BSC_AGENT_NUM_CTX").map(String::as_str),
            Some("0"),
            "0 MEANS do-not-set-num_ctx and must reach the runtime as such"
        );
        let absent = bsc_agent_env(&cfg("ollama", "q", "", "", None));
        assert!(
            !absent.contains_key("BSC_AGENT_NUM_CTX"),
            "absent says nothing and lets the runtime use its packaged ceiling"
        );
        assert_eq!(
            bsc_agent_env(&cfg("ollama", "q", "", "", Some(65536))).get("BSC_AGENT_NUM_CTX").map(String::as_str),
            Some("65536")
        );
    }

    /// An empty value contributes NO variable — never an empty one.
    #[test]
    fn an_empty_key_or_base_url_emits_nothing() {
        let e = bsc_agent_env(&cfg("anthropic", "opus-4.5", "", "", None));
        assert!(!e.contains_key("BSC_AGENT_API_KEY"), "an empty key reads as present-but-invalid");
        assert!(!e.contains_key("BSC_AGENT_BASE_URL"));
        assert_eq!(e.len(), 2, "provider and model only: {e:?}");
    }

    /// The local endpoint always gets a NON-EMPTY key, and a real one wins over the placeholder.
    #[test]
    fn the_local_aider_path_always_supplies_a_non_empty_key() {
        for p in ["local", "ollama"] {
            let e = aider_env(&cfg(p, "llama3", "", "http://b:1/v1", None));
            assert_eq!(
                e.get("OPENAI_API_KEY").map(String::as_str),
                Some(LOCAL_KEY_PLACEHOLDER),
                "{p}: the client will not initialise without one"
            );
            assert_eq!(e.get("OPENAI_API_BASE").map(String::as_str), Some("http://b:1/v1"));

            let keyed = aider_env(&cfg(p, "llama3", "sk-real", "http://b:1/v1", None));
            assert_eq!(keyed.get("OPENAI_API_KEY").map(String::as_str), Some("sk-real"), "a real key wins");
        }
    }

    /// The model selector namespaces by provider and passes an already-namespaced model through.
    #[test]
    fn the_model_selector_namespaces_by_provider() {
        assert_eq!(aider_model_arg(&cfg("anthropic", "opus-4.5", "", "", None)), "anthropic/opus-4.5");
        assert_eq!(aider_model_arg(&cfg("gemini", "flash", "", "", None)), "gemini/flash");
        assert_eq!(aider_model_arg(&cfg("openai", "gpt-4o", "", "", None)), "gpt-4o", "OpenAI is bare");
        assert_eq!(aider_model_arg(&cfg("ollama", "qwen", "", "", None)), "openai/qwen");
        assert_eq!(
            aider_model_arg(&cfg("anthropic", "vendor/already", "", "", None)),
            "vendor/already",
            "an already-namespaced model is not double-namespaced"
        );
        assert_eq!(aider_model_arg(&cfg("openai", "  gpt-4o  ", "", "", None)), "gpt-4o", "trimmed");
    }

    /// An unknown provider contributes nothing rather than guessing which variable it reads — and the
    /// bsc-agent env still carries it, because that runtime resolves the provider itself and reports a
    /// real "unknown provider" error rather than silently defaulting.
    #[test]
    fn an_unknown_provider_guesses_nothing() {
        assert!(aider_env(&cfg("some-new-vendor", "m", "sk-x", "", None)).is_empty());
        let agent = bsc_agent_env(&cfg("some-new-vendor", "m", "sk-x", "", None));
        assert_eq!(agent.get("BSC_AGENT_PROVIDER").map(String::as_str), Some("some-new-vendor"));
        assert_eq!(aider_model_arg(&cfg("some-new-vendor", "m", "", "", None)), "m", "no invented namespace");
    }
}
