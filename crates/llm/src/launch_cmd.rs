//! The shell command a NON-Claude session launches with.
//!
//! # Why this lives in a crate rather than in the app
//!
//! It is reached by `bsc fleet launch-config`, which the app SPAWNS. The app's Rust half is a live
//! process behind a webview, so a derivation living inside it can only change by producing a new
//! binary — and a new binary restarts the window with a fleet running in it. On this side the same
//! change goes live by staging a binary, with no app downtime
//! (`a-resolved-request-goes-live-without-a-restart`).
//!
//! It sits in `crates/llm` specifically because it already depended on `routing::LlmConfig` and
//! `session_env::aider_model_arg`: moving it here removes a dependency edge rather than adding one.
//!
//! The PTY that runs this string is Rust; the string was assembled in the renderer. It reached the
//! backend as an opaque `init_cmd`, so nothing here could inspect, validate or quote it.
//!
//! # The quoting is the part that matters
//!
//! The kickoff prompt is interpolated as `--message <quoted>`, and that prompt is PLAN-AUTHORED text —
//! a stream kickoff the planner wrote, or a checkpoint note. [`sh_quote`] POSIX single-quotes it,
//! rendering an embedded `'` as `'\''` (close, escaped quote, reopen), so a prompt containing an
//! apostrophe cannot terminate the argument and what follows cannot become shell.
//!
//! A port that reaches for `format!("--message '{prompt}'")` is a command injection in a string built
//! from content the planner writes. `a_prompt_cannot_close_its_own_quote` is that case, and the fixture
//! carries apostrophes, a deliberate break-out attempt, backticks and `$HOME`.
//!
//! Newlines are legal inside single quotes, which is why a multi-line kickoff passes through intact
//! rather than needing to be flattened.
//!
//! # Two rules that are not derived from anything
//!
//! * FLEET-SAFE GIT ALWAYS. Every session, manual or fleet, starts `--no-auto-commits
//!   --no-dirty-commits`, so it never makes a surprise commit on the pane's branch. Unconditional —
//!   not a flow decision, and not something a caller may turn off.
//! * NO MODEL MEANS NO FLAG. With neither an LLM config nor a bare model, no `--model` is emitted at
//!   all and the tool falls back to its own default; an empty `--model ''` would be an error rather
//!   than a default.

use crate::routing::LlmConfig;
use crate::session_env::aider_model_arg;

/// POSIX single-quote a shell argument.
///
/// Wraps in `'…'` and renders an embedded `'` as `'\''` — close the quote, emit an escaped quote,
/// reopen. Everything else, INCLUDING newlines, `$`, backticks and double quotes, is literal inside
/// single quotes and needs no further treatment.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A provider's launch inputs. Every field is optional: a provider that ignores one gets nothing.
///
/// `Serialize`/`Deserialize` because this now crosses a PROCESS boundary: the app sends it to
/// `bsc fleet launch-config` and the sidecar derives from it. A type that only serializes is a one-way
/// contract, and the round trip is what the boundary actually needs.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderLaunchConfig {
    /// A bare model name, for providers that take one. Loses to `llm` when both are present.
    pub model: Option<String>,
    /// The pane's resolved LLM config. Mapped to the provider's own model selector.
    pub llm: Option<LlmConfig>,
    /// The composed kickoff. Providers whose harness BAKES the prompt (Claude, bsc-agent) do not use
    /// this — they receive it through `pty_create`.
    pub startup_prompt: Option<String>,
    /// Files loaded read-only at launch. A worker's `CLAUDE.local.md` rides here because Aider does no
    /// ancestor-`CLAUDE.md` walk and would otherwise never see the plan.
    pub read_files: Vec<String>,
}

/// Build Aider's launch command.
pub fn build_aider_command(cfg: Option<&ProviderLaunchConfig>) -> String {
    // Unconditional, and first — see the module docs.
    let mut parts: Vec<String> =
        vec!["aider".into(), "--no-auto-commits".into(), "--no-dirty-commits".into()];

    // The resolved LLM config WINS over a bare model string; with neither, no flag at all.
    let model = cfg.and_then(|c| {
        c.llm.as_ref().map(aider_model_arg).or_else(|| c.model.clone())
    });
    if let Some(m) = model.as_deref().filter(|m| !m.trim().is_empty()) {
        parts.push("--model".into());
        parts.push(sh_quote(m));
    }

    for f in cfg.map(|c| c.read_files.as_slice()).unwrap_or(&[]) {
        parts.push("--read".into());
        parts.push(sh_quote(f));
    }

    if let Some(p) = cfg.and_then(|c| c.startup_prompt.as_deref()).filter(|p| !p.trim().is_empty()) {
        parts.push("--message".into());
        parts.push(sh_quote(p));
    }
    parts.join(" ")
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
                } else if p.file_name().and_then(|n| n.to_str()) == Some("launchCommand.fixtures.json") {
                    out.push(p);
                }
            }
        }
        // `crates/llm` → repo root is TWO levels, where `src-tauri` was one. The fixture is the
        // cross-language contract and did not move; only this module did.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one launchCommand.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn config_of(v: &serde_json::Value) -> Option<ProviderLaunchConfig> {
        let o = v.as_object()?;
        Some(ProviderLaunchConfig {
            model: o.get("model").and_then(|m| m.as_str()).map(str::to_string),
            llm: o.get("llm").and_then(|l| serde_json::from_value(l.clone()).ok()),
            startup_prompt: o.get("startupPrompt").and_then(|p| p.as_str()).map(str::to_string),
            read_files: o
                .get("readFiles")
                .and_then(|f| f.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        })
    }

    /// Reports every mismatch at once. Compares the WHOLE command string — the quoting is the point,
    /// and a comparison of parsed arguments would hide exactly the bug this exists to prevent.
    #[test]
    fn the_launch_command_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 18, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut quoted, mut modelled, mut prompted) = (0usize, 0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let cfg = config_of(&case["config"]);
            let want = case["cmd"].as_str().unwrap();
            if want.contains("'\\''") {
                quoted += 1;
            }
            if want.contains("--model") {
                modelled += 1;
            }
            if want.contains("--message") {
                prompted += 1;
            }
            let got = build_aider_command(cfg.as_ref());
            if got != want {
                mismatches.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(quoted >= 3, "only {quoted} cases needed quote escaping — the corpus is too polite");
        assert!(modelled >= 3, "only {modelled} cases emitted a model");
        assert!(prompted >= 4, "only {prompted} cases emitted a prompt");
        assert!(
            mismatches.is_empty(),
            "the Rust builder disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }


    /// Read a POSIX single-quoted shell word back to its value, or `None` if it is not one well-formed
    /// word. Written here rather than pulled in so the test depends on the SHELL'S rule and not on the
    /// same escaping logic it is checking: a bug shared by quoter and unquoter would cancel out.
    fn posix_unquote(s: &str) -> Option<String> {
        let mut out = String::new();
        let mut chars = s.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                // A quoted run: everything up to the next quote is literal.
                '\'' => {
                    loop {
                        match chars.next() {
                            Some('\'') => break,
                            Some(ch) => out.push(ch),
                            None => return None, // unterminated
                        }
                    }
                }
                // A backslash-escaped character OUTSIDE any quoted run.
                '\\' => out.push(chars.next()?),
                // Bare whitespace would end the word — so this is not one argument.
                c if c.is_whitespace() => return None,
                c => out.push(c),
            }
        }
        Some(out)
    }
    /// THE INJECTION CASE. A prompt is plan-authored text; if it can close its own quote, everything
    /// after it is shell.
    #[test]
    fn a_prompt_cannot_close_its_own_quote() {
        let evil = "x'; rm -rf /tmp/pwned; echo '";
        let cmd = build_aider_command(Some(&ProviderLaunchConfig {
            startup_prompt: Some(evil.to_string()),
            ..Default::default()
        }));

        // A SUBSTRING TEST CANNOT ANSWER THIS. The correctly-quoted form legitimately CONTAINS
        // `'; rm -rf …` — inside quotes, where it is inert — so "does the dangerous text appear" is
        // the wrong question. The right one is whether the shell would see ONE argument, which is what
        // unquoting the tail and comparing it to the original prompt actually asks.
        let tail = cmd.split(" --message ").nth(1).expect("a --message argument");
        assert_eq!(
            posix_unquote(tail).as_deref(),
            Some(evil),
            "the payload must survive as ONE argument, byte for byte: {cmd}"
        );
    }

    /// Newlines are legal inside single quotes, so a multi-line kickoff needs no flattening.
    #[test]
    fn a_multi_line_prompt_survives_intact() {
        let cmd = build_aider_command(Some(&ProviderLaunchConfig {
            startup_prompt: Some("line one\nline two".to_string()),
            ..Default::default()
        }));
        assert!(cmd.contains("line one\nline two"), "{cmd:?}");
    }

    /// A `$`, a backtick and a double quote are all literal inside single quotes — no extra escaping,
    /// and no expansion.
    #[test]
    fn shell_metacharacters_are_literal_inside_single_quotes() {
        let q = sh_quote("cost is `date` and $HOME and \"x\"");
        assert_eq!(q, "'cost is `date` and $HOME and \"x\"'");
        assert_eq!(sh_quote(""), "''", "an empty argument still needs to BE an argument");
        assert_eq!(sh_quote("'"), "''\\'''", "a lone quote");
    }

    /// The fleet-safe flags are unconditional — not a flow decision, and not something a caller may
    /// turn off by supplying a config.
    #[test]
    fn the_fleet_safe_git_flags_are_always_present() {
        for cfg in [
            None,
            Some(ProviderLaunchConfig::default()),
            Some(ProviderLaunchConfig { startup_prompt: Some("go".into()), ..Default::default() }),
        ] {
            let cmd = build_aider_command(cfg.as_ref());
            assert!(cmd.contains("--no-auto-commits"), "a surprise commit on the pane's branch: {cmd}");
            assert!(cmd.contains("--no-dirty-commits"));
        }
    }

    /// The LLM config wins over a bare model, and with NEITHER no flag is emitted at all.
    #[test]
    fn the_llm_config_wins_and_no_model_means_no_flag() {
        let llm = LlmConfig {
            provider: "ollama".into(),
            model: "qwen".into(),
            api_key: String::new(),
            base_url: String::new(),
            num_ctx: None,
        };
        let both = build_aider_command(Some(&ProviderLaunchConfig {
            llm: Some(llm),
            model: Some("ignored".into()),
            ..Default::default()
        }));
        assert!(both.contains("openai/qwen"), "the llm config supplies the selector: {both}");
        assert!(!both.contains("ignored"), "the bare model must lose");

        assert!(!build_aider_command(None).contains("--model"), "no config ⇒ no flag");
        assert!(
            !build_aider_command(Some(&ProviderLaunchConfig { model: Some("   ".into()), ..Default::default() }))
                .contains("--model"),
            "an empty --model would be an error, not a default"
        );
    }
}


// ── The whole launch configuration, in ONE reply ──────────────────────────────────────────────

/// Everything a pane's launch needs from the sidecar, in a single round trip.
///
/// # Why this is a struct and not a bare string
///
/// A launch has FOUR derivations to make — the provider command, the stop ledger's shape, the skills
/// set and the MCP servers. Behind four calls that is ~39ms of spawn each; behind one it is ~39ms for
/// all of them. That is the same lesson #3908 and then #3954 were filed to teach: at ~39 panes a
/// per-item command saturated the command pool and `pty_write` measured 3280ms.
///
/// # The extension point, and why it is safe
///
/// `the-in-app-launch-resolutions-move-onto-the-one-call` folds skills and MCP onto this reply. Both
/// sides carry `#[serde(default)]`, so a field added here is read as absent by an older peer instead
/// of failing to parse — which matters precisely because the two halves are now separate binaries that
/// can be staged independently. Add fields; do not repurpose one.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchConfig {
    /// The provider's shell command. `None` when the harness BAKES its own prompt — Claude and
    /// `bsc-agent` receive theirs through `pty_create` and must not be handed a command here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_command: Option<String>,
}

/// Derive the whole launch configuration for `provider`.
///
/// The only provider with a command to build today is Aider. Every other harness returns `None`
/// rather than an empty string: an empty command is something a caller might execute, whereas absence
/// is something it must handle.
pub fn launch_config(provider: &str, cfg: Option<&ProviderLaunchConfig>) -> LaunchConfig {
    let provider_command = match provider.trim().to_ascii_lowercase().as_str() {
        "aider" => Some(build_aider_command(cfg)),
        _ => None,
    };
    LaunchConfig { provider_command }
}

#[cfg(test)]
mod launch_config_tests {
    use super::*;

    #[test]
    fn aider_gets_a_command_and_a_prompt_baking_harness_gets_none() {
        let cfg = ProviderLaunchConfig { model: Some("gpt-4".into()), ..Default::default() };
        let aider = launch_config("aider", Some(&cfg));
        assert!(aider.provider_command.as_deref().unwrap().starts_with("aider "));

        for baked in ["claude", "bsc-agent", "", "something-else"] {
            let c = launch_config(baked, Some(&cfg));
            assert_eq!(c.provider_command, None, "{baked:?} bakes its own prompt — absence, not \"\"");
        }
    }

    #[test]
    fn the_provider_match_is_case_and_space_insensitive() {
        for spelling in ["aider", "Aider", " AIDER "] {
            assert!(launch_config(spelling, None).provider_command.is_some(), "{spelling:?}");
        }
    }

    /// The reply must round-trip, because the two halves are separate binaries now.
    #[test]
    fn the_reply_round_trips_and_absence_stays_absent() {
        let c = launch_config("aider", None);
        let wire = serde_json::to_string(&c).unwrap();
        assert_eq!(serde_json::from_str::<LaunchConfig>(&wire).unwrap(), c);

        // A harness with no command serializes to an empty object, not to a null command.
        let none = launch_config("claude", None);
        assert_eq!(serde_json::to_string(&none).unwrap(), "{}");
        assert_eq!(serde_json::from_str::<LaunchConfig>("{}").unwrap(), none);
    }

    /// A field added later must be read as ABSENT by an older peer rather than failing to parse —
    /// the property that lets skills and MCP fold on without a lockstep deploy.
    #[test]
    fn an_unknown_field_from_a_newer_sidecar_does_not_break_an_older_reader() {
        let newer = r#"{"providerCommand":"aider --x","skills":["a"],"mcp":{"s":1}}"#;
        let got: LaunchConfig = serde_json::from_str(newer).expect("unknown fields are tolerated");
        assert_eq!(got.provider_command.as_deref(), Some("aider --x"));
    }
}
