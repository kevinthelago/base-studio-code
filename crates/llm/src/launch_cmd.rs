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

/// Whether an argument is a bare, shell-safe token that needs no quoting.
///
/// Deliberately conservative and deliberately NARROW: the set is exactly what a real model name uses
/// — `qwen2.5-coder`, `llama3:70b`, `library/llama3`. Anything else gets quoted. Being wrong in the
/// "needs quoting" direction costs a pair of quotes; being wrong the other way is a shell injection.
fn is_bare_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':' | b'/'))
}

/// Quote `s` only when it is not already a bare token.
///
/// WHY NOT ALWAYS QUOTE, which would be simpler. The TypeScript copy of this builder is still live
/// and still answering real launches, and the reconciliation between the two is measured by
/// `bsc logs divergence`. Quoting unconditionally would make the two answers differ on EVERY launch —
/// `ollama run llama3` against `ollama run 'llama3'` — which turns the divergence channel into noise
/// and hides the disagreements that actually matter. Quoting only what is unsafe keeps every ordinary
/// launch byte-identical, so a firing divergence means something.
fn quote_if_needed(s: &str) -> String {
    if is_bare_token(s) {
        s.to_string()
    } else {
        sh_quote(s)
    }
}

/// The model Ollama runs when a pane names none.
pub const OLLAMA_DEFAULT_MODEL: &str = "llama3";

/// Build Ollama's launch command.
///
/// # TWO DELIBERATE DIVERGENCES FROM THE TYPESCRIPT, both fixes, both pinned by tests
///
/// The live TypeScript is ``ollama run ${config?.model ?? DEFAULT_MODEL}``. That is one line and it
/// has two defects, and the fixture records the TypeScript's real output for both so neither can be
/// mistaken for a porting slip:
///
/// 1. **UNQUOTED INTERPOLATION.** The model reaches a PTY as part of a shell command and can arrive
///    from a store record, a persona placement or argv. The TypeScript emits
///    `ollama run llama3; rm -rf /tmp/pwned` verbatim. This quotes anything that is not a bare token,
///    so the payload stays one argument. The module header already called exactly this shape "a
///    command injection in a string built from content the planner writes" — the guard existed and
///    the one interpolating provider never got it.
/// 2. **`??` DOES NOT CATCH AN EMPTY STRING.** `config.model = ""` is neither null nor undefined, so
///    the TypeScript falls through to `ollama run ` — a trailing space and no model, which is not a
///    runnable command. Found by GENERATING the fixture rather than by writing down what it ought to
///    say; the hand-written expectation on the plan item said "falls back to the default" and was
///    wrong. Here an absent-or-blank model means the default.
pub fn build_ollama_command(cfg: Option<&ProviderLaunchConfig>) -> String {
    let model = cfg
        .and_then(|c| c.model.as_deref())
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .unwrap_or(OLLAMA_DEFAULT_MODEL);
    format!("ollama run {}", quote_if_needed(model))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn fixture() -> serde_json::Value {
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

    pub(super) fn config_of(v: &serde_json::Value) -> Option<ProviderLaunchConfig> {
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
/// EVERY provider the console registry builds a command for is built here. This used to be Aider
/// alone, with a doc comment claiming the rest "bake their own prompt" — true of `claude` and
/// `bsc-agent`, false of `gemini`, `codex`, `amazonq` and `ollama`, which the TypeScript builds real
/// commands for. So the app asked the sidecar for a gemini pane, got `None`, and fell back to the
/// renderer's copy with nothing measuring the gap.
///
/// A prompt-baking harness and an unknown id both return `None` rather than an empty string: an empty
/// command is something a caller might execute, whereas absence is something it must handle.
pub fn launch_config(provider: &str, cfg: Option<&ProviderLaunchConfig>) -> LaunchConfig {
    let provider_command = match provider.trim().to_ascii_lowercase().as_str() {
        "aider" => Some(build_aider_command(cfg)),
        "ollama" => Some(build_ollama_command(cfg)),
        // Constants, but NOT interchangeable with their ids: `amazonq` runs the `q` binary, and this
        // table is the only place in Rust that records the difference.
        "gemini" => Some("gemini".to_string()),
        "codex" => Some("codex".to_string()),
        "amazonq" => Some("q".to_string()),
        // The prompt-BAKING harnesses, and an unknown id. `claude` and `bsc-agent` receive their
        // kickoff through `pty_create`, so a command here would be a second, conflicting channel.
        // Absence, never `""`: an empty command is something a caller might execute.
        _ => None,
    };
    LaunchConfig { provider_command }
}

#[cfg(test)]
mod launch_config_tests {
    use super::tests::config_of;
    use super::*;

    /// The `providers` half of the shared fixture: every REGISTERED console provider, captured by
    /// calling `getProvider(id).buildLaunchCmd(...)` in the live TypeScript.
    fn provider_cases() -> Vec<serde_json::Value> {
        super::tests::fixture()["providers"]
            .as_array()
            .expect("the fixture carries a `providers` array — regenerate with UPDATE_FIXTURES=1")
            .clone()
    }

    /// A case whose Rust answer is INTENDED to differ from the TypeScript, and what it must be
    /// instead. Enumerated rather than skipped: a skipped case is invisible, and "we meant that one"
    /// is exactly the sentence a real regression hides behind. Keyed on the fixture's own label.
    ///
    /// Both entries are FIXES, argued in `build_ollama_command`'s docs — an unquoted shell
    /// interpolation, and `??` failing to catch an empty string.
    const INTENDED_DIVERGENCES: &[(&str, &str)] = &[
        ("ollama — an empty model falls back to the default", "ollama run llama3"),
        ("ollama — a model with a SPACE", "ollama run 'my model'"),
        ("ollama — a model that tries to CHAIN a command", "ollama run 'llama3; rm -rf /tmp/pwned'"),
        ("ollama — a model with a backtick and a dollar", "ollama run 'a`date`$HOME'"),
    ];

    /// The harnesses that BAKE their own prompt. The TypeScript hands them a command string too, and
    /// Rust deliberately answers `None` instead — the kickoff reaches them through `pty_create`, so a
    /// command here would be a second, conflicting channel for the same thing. This asymmetry is the
    /// one place Rust returns LESS than the TypeScript on purpose, so it is named rather than implied.
    const PROMPT_BAKING: &[&str] = &["claude", "bsc-agent"];

    #[test]
    fn every_registered_provider_agrees_with_the_typescript() {
        let cases = provider_cases();
        assert!(cases.len() >= 14, "the provider corpus shrank to {} cases", cases.len());
        let mut matched_divergences = 0;
        let mut saw_baking = 0;

        for case in &cases {
            let id = case["id"].as_str().expect("id");
            let label = case["label"].as_str().expect("label");
            let ts = case["cmd"].as_str().expect("cmd");
            let cfg = config_of(&case["config"]);

            if PROMPT_BAKING.contains(&id) {
                assert!(!ts.is_empty(), "{label}: the TypeScript does build one, which is the point");
                assert_eq!(
                    launch_config(id, cfg.as_ref()).provider_command,
                    None,
                    "{label}: a prompt-baking harness must get ABSENCE, not a second prompt channel"
                );
                saw_baking += 1;
                continue;
            }

            let got = launch_config(id, cfg.as_ref())
                .provider_command
                .unwrap_or_else(|| panic!("{label}: every captured provider builds a command"));

            match INTENDED_DIVERGENCES.iter().find(|(l, _)| *l == label) {
                Some((_, want_rust)) => {
                    assert_eq!(got, *want_rust, "{label}: the intended Rust answer");
                    assert_ne!(
                        got, ts,
                        "{label}: listed as an intended divergence but it now AGREES — either the \
                         TypeScript was fixed (drop the entry) or the fix was lost"
                    );
                    matched_divergences += 1;
                }
                // WHOLE VALUES, and the whole command string: a `contains` check would pass on a
                // command that had grown an extra flag.
                None => assert_eq!(got, ts, "{label}: Rust and the TypeScript must agree byte for byte"),
            }
        }
        assert_eq!(saw_baking, PROMPT_BAKING.len(), "every prompt-baking harness must be in the corpus");
        assert_eq!(
            matched_divergences,
            INTENDED_DIVERGENCES.len(),
            "an intended-divergence label matched no fixture case — the label was renamed and the \
             entry silently stopped covering anything"
        );
    }

    #[test]
    fn amazonq_runs_the_q_binary_and_not_its_own_id() {
        // The one mapping nothing else in Rust records: the provider id is `amazonq`, the executable
        // is `q`. A port that assumed id == binary would produce a command that does not exist.
        assert_eq!(launch_config("amazonq", None).provider_command.as_deref(), Some("q"));
    }

    #[test]
    fn a_hostile_ollama_model_cannot_break_out_of_the_command() {
        // THE INJECTION CASE. The TypeScript emits this verbatim and unquoted; the fixture records
        // that. Here the payload must stay inside one quoted argument.
        let cmd = build_ollama_command(Some(&ProviderLaunchConfig {
            model: Some("llama3; rm -rf /tmp/pwned".into()),
            ..Default::default()
        }));
        assert_eq!(cmd, "ollama run 'llama3; rm -rf /tmp/pwned'");
        assert!(!cmd.contains("run llama3; rm"), "the payload escaped its quoting: {cmd}");

        // ...and a model that closes its own quote cannot reopen as shell.
        let evil = build_ollama_command(Some(&ProviderLaunchConfig {
            model: Some("x'; rm -rf /tmp/pwned; echo '".into()),
            ..Default::default()
        }));
        assert!(evil.contains("'\\''"), "an embedded quote must be escaped, not passed through: {evil}");
    }

    #[test]
    fn an_ordinary_model_is_emitted_bare_so_the_divergence_channel_stays_meaningful() {
        // Quoting unconditionally would make Rust and the TypeScript differ on every launch, which
        // would drown `bsc logs divergence` in noise. These are the shapes a real model name takes.
        for model in ["llama3", "qwen2.5-coder", "llama3:70b", "library/llama3"] {
            let cmd = build_ollama_command(Some(&ProviderLaunchConfig {
                model: Some(model.into()),
                ..Default::default()
            }));
            assert_eq!(cmd, format!("ollama run {model}"), "{model} needs no quoting");
        }
    }

    #[test]
    fn a_blank_ollama_model_is_the_default_not_a_trailing_space() {
        // The TypeScript's `??` does not catch `""`, so it emits `ollama run ` — not runnable. Found
        // by generating the fixture; the hand-written expectation had this wrong.
        for blank in ["", "   "] {
            let cmd = build_ollama_command(Some(&ProviderLaunchConfig {
                model: Some(blank.into()),
                ..Default::default()
            }));
            assert_eq!(cmd, "ollama run llama3", "a blank model must not produce a bare `ollama run `");
        }
        assert_eq!(build_ollama_command(None), "ollama run llama3");
    }

    #[test]
    fn aider_gets_a_command_and_a_prompt_baking_harness_gets_none() {
        let cfg = ProviderLaunchConfig { model: Some("gpt-4".into()), ..Default::default() };
        let aider = launch_config("aider", Some(&cfg));
        assert!(aider.provider_command.as_deref().unwrap().starts_with("aider "));

        // ONLY the prompt-baking harnesses and an unknown id. `gemini`, `codex`, `amazonq` and
        // `ollama` used to be covered by this loop's `_ => None` and were the bug.
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
