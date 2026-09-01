//! The profile → session-settings bridge, derived in Rust.
//!
//! # The inversion this closes
//!
//! An [`AgentProfile`] is the editable permission unit a user assigns to a console pane: a base mode, a
//! shell-command allowlist, a tri-state per tool, and path globs. It has to become the exact inputs
//! `ensure_session_settings` consumes — the same channel the role gate uses — or assigning a profile
//! would change a UI and nothing else.
//!
//! That translation lived only in the renderer, and one of its outputs is not advisory:
//! [`ProfileSessionSettings::bash_posture`] is what `settings.rs` scales the ENTIRE auto-approve
//! baseline by. An `allow` doer gets the read-only *and* build command tiers; an `ask` coordinator gets
//! read-only only; `deny` gets neither. So the breadth of a session's shell surface was decided in a
//! renderer, handed to the backend, and obeyed — the same shape as the role gate before
//! `session/role_gate.rs`, one record over.
//!
//! # The three edges, each deliberate and each a defect if smoothed
//!
//! * **`bash` is never blanket-denied.** A bare `Bash` deny would also kill the `gh`/`git` the session
//!   guarantees, so shell control flows through the command allowlist and the role gate instead. A
//!   profile with `bash: "deny"` emits NO tool rule for it — only a `bash_posture` of `deny`, which is
//!   how the restriction is actually applied.
//! * **A path rule is `Edit(<glob>)` and nothing else** (#3534). Claude Code matches file-permission
//!   rules on the `Edit` tool alone, and that one rule covers every file-editing tool. `Write(<glob>)`
//!   was never enforced: a silent no-op as an allow, and — the half that matters — an UNENFORCED DENY.
//!   This reuses [`super::role_gate::edit_path_rule`] rather than restating the format, so the two
//!   cannot drift apart.
//! * **`mode` and `net` are advisory and produce no rule.** Every capability the gate can express is
//!   enumerated by the per-tool tiers and the paths, and host-level network limits are not expressible
//!   through `settings.json` at all. Emitting something for them would assert an enforcement that does
//!   not exist, which is worse than emitting nothing.
//!
//! # Parity, and the one intended divergence
//!
//! `profileEnforcement.fixtures.json` is generated from the live TypeScript over EVERY packaged role
//! under `src-tauri/data/roles/` plus synthetic cases for the edges above, and the tests below assert
//! equality case by case.
//!
//! The TypeScript iterates `Object.entries(profile.tools)`, so its output ORDER follows whatever order
//! the keys happen to be written in. This module iterates [`TOOL_KEYS`], a fixed canonical order, and
//! therefore produces the same SET in a different sequence for a profile whose keys are shuffled. That
//! is deliberate: rule order carries no meaning in `settings.json` (deny beats allow globally, not
//! positionally), so a canonical order is strictly more stable than "the order someone typed the JSON
//! in". Every packaged role already uses the canonical order, so nothing shipped changes — the fixture
//! carries a deliberately shuffled case precisely so that claim is tested rather than assumed.

use serde::{Deserialize, Serialize};

use super::role_gate::edit_path_rule;

/// A permission tier. `ask` is the absence of a rule — Claude Code prompts, which is its default.
pub type Tier = String;

/// The tools a profile can speak about, in the canonical order this module emits rules in.
pub const TOOL_KEYS: &[&str] = &["read", "grep", "glob", "edit", "write", "bash", "web", "task"];

/// The Claude Code tool name(s) each profile capability maps to, as whole-tool (bare) rules.
///
/// `edit` covers the in-place edit tools and `web` is both fetch and search, so one capability can
/// yield two rules. There is no `MultiEdit`: it was removed from Claude Code (#3534).
fn tool_names(key: &str) -> &'static [&'static str] {
    match key {
        "read" => &["Read"],
        "grep" => &["Grep"],
        "glob" => &["Glob"],
        "edit" => &["Edit", "NotebookEdit"],
        "write" => &["Write"],
        "bash" => &["Bash"],
        "web" => &["WebFetch", "WebSearch"],
        "task" => &["Task"],
        _ => &[],
    }
}

/// Path globs a profile scopes writes to.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Scope {
    #[serde(default)]
    pub allow: Vec<String>,
    #[serde(default)]
    pub deny: Vec<String>,
}

/// The editable permission unit assigned to a console pane. Only the fields the bridge reads are
/// modelled; the rest of the packaged JSON (colour, description, glyphs) is ignored by `serde`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    /// The base policy for anything not listed. ADVISORY here — see the module docs.
    ///
    /// Parsed rather than dropped from the struct on purpose: it is the one field a reader most
    /// expects to produce a rule, so the `allow` and this line are where they will look for the
    /// reason it does not.
    #[allow(dead_code)]
    #[serde(default)]
    pub mode: Tier,
    #[serde(default)]
    pub commands: Vec<String>,
    /// Capability → tier. A missing key is treated as `ask`, i.e. no rule.
    #[serde(default)]
    pub tools: std::collections::HashMap<String, Tier>,
    #[serde(default)]
    pub paths: Scope,
}

/// Settings-rule inputs for `ensure_session_settings`, identical in shape to the role gate's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSessionSettings {
    /// Shell prefixes auto-approved (wrapped as `Bash(<cmd> *)` by the backend).
    pub allowed_commands: Vec<String>,
    /// Always empty from a profile: the role gate is what supplies command denies.
    pub denied_commands: Vec<String>,
    /// Verbatim tool-permission allows (`Read`, `Edit(src/**)`, …).
    pub allow_tool_rules: Vec<String>,
    /// Verbatim tool-permission denies. Deny wins over allow.
    pub deny_tool_rules: Vec<String>,
    /// The catch-all shell disposition `settings.rs` scales the auto-approve baseline by (#1572).
    pub bash_posture: Tier,
}

/// Order-preserving de-duplication — the first occurrence wins, matching the TypeScript's `new Set`.
fn dedupe(xs: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    xs.into_iter().filter(|x| seen.insert(x.clone())).collect()
}

/// The tier a profile assigns a capability. An unlisted capability is `ask`, which emits no rule.
fn tier_of(profile: &AgentProfile, key: &str) -> String {
    profile.tools.get(key).cloned().unwrap_or_else(|| "ask".to_string())
}

/// Map a profile to the session settings it enforces.
pub fn resolve_profile_settings(profile: &AgentProfile) -> ProfileSessionSettings {
    let mut allow_tool_rules: Vec<String> = Vec::new();
    let mut deny_tool_rules: Vec<String> = Vec::new();

    for key in TOOL_KEYS {
        match tier_of(profile, key).as_str() {
            "deny" => {
                // See the module docs: never blanket-deny Bash.
                if *key == "bash" {
                    continue;
                }
                deny_tool_rules.extend(tool_names(key).iter().map(|s| s.to_string()));
            }
            "allow" => allow_tool_rules.extend(tool_names(key).iter().map(|s| s.to_string())),
            // `ask` (and anything unrecognised) is left unlisted so Claude Code prompts.
            _ => {}
        }
    }

    for g in &profile.paths.allow {
        allow_tool_rules.push(edit_path_rule(g));
    }
    for g in &profile.paths.deny {
        deny_tool_rules.push(edit_path_rule(g));
    }

    ProfileSessionSettings {
        allowed_commands: dedupe(profile.commands.clone()),
        denied_commands: Vec::new(),
        allow_tool_rules: dedupe(allow_tool_rules),
        deny_tool_rules: dedupe(deny_tool_rules),
        bash_posture: tier_of(profile, "bash"),
    }
}

/// The breadth of a shell posture, ranked by what [`super::settings::build_allow_rules`] ACTUALLY
/// does with it rather than by the three names: `deny` grants no command baseline, `ask` the
/// read-only one, and anything else — including a value neither side recognises — falls through to
/// the `allow` arm and gets the read-only *and* build tiers plus a bare `Bash`.
///
/// Ranking on the behaviour is the point. A fourth string ("permissive", a typo, a tier from a newer
/// build) is the WIDEST posture in effect, so it must score as the widest here too; scoring it as an
/// unknown that sorts below `allow` would let a garbage value win the tie-break below and then be
/// obeyed as `allow` anyway — a narrowing that narrows nothing.
fn posture_breadth(tier: &str) -> u8 {
    match tier {
        "deny" => 0,
        "ask" => 1,
        _ => 2,
    }
}

/// A shell posture the two sides did not agree on, and which value won.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostureDisagreement {
    /// What the renderer computed and sent.
    pub from_frontend: String,
    /// What this module derived from the same profile.
    pub derived: String,
    /// The winner, already applied to [`ProfileReconciliation::merged`].
    pub chosen: String,
}

/// The settings to write, plus every way the two sides disagreed while producing them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileReconciliation {
    /// What the launch actually writes.
    pub merged: ProfileSessionSettings,
    /// Per field, the values Rust DERIVED that the frontend OMITTED — already folded into `merged`.
    /// The one direction that is a defect; the other ("the frontend has extra") is expected and says
    /// nothing, because the frontend's lists carry the role gate, the restricted-role surface and the
    /// user's own entries alongside the profile's.
    pub missing: Vec<(&'static str, Vec<String>)>,
    /// `Some` when the two postures differed. `merged.bash_posture` already carries the winner.
    pub posture: Option<PostureDisagreement>,
}

/// Union one list field, recording what the frontend omitted.
fn union_reporting(
    field: &'static str,
    from_frontend: Vec<String>,
    derived: &[String],
    missing: &mut Vec<(&'static str, Vec<String>)>,
) -> Vec<String> {
    let omitted: Vec<String> =
        derived.iter().filter(|d| !from_frontend.iter().any(|f| f == *d)).cloned().collect();
    if omitted.is_empty() {
        return from_frontend;
    }
    let mut merged = from_frontend;
    merged.extend(omitted.iter().cloned());
    missing.push((field, omitted));
    merged
}

/// Reconcile the profile's contribution to the session settings against what the renderer sent.
///
/// # Why UNION here, when the ROLE's allow rules deliberately do not union
///
/// [`super::role_gate::reconcile_tool_rules`] passes the allow list through untouched and only
/// REPORTS what it derived and the frontend omitted, because an allow AUTO-APPROVES and Rust cannot
/// intersect against a set it does not fully derive: there it derives `Edit(<role glob>)` and nothing
/// else, so "Rust did not derive it" never meant "it does not belong".
///
/// The profile side is the case that argument does not cover, and the difference is checkable rather
/// than asserted: `buildSessionSettings` spreads `prof.allowToolRules` / `prof.allowedCommands`
/// WHOLESALE, with no filter of any kind, and this module derives that same contribution completely
/// from the same profile record. So the frontend never narrows the profile, and a value Rust derived
/// that the frontend omitted cannot be a deliberate narrowing — it can only be a renderer that lost
/// it. Adding it back restores the assignment the user made; it never widens past it.
///
/// That is also why the union is not a licence to add anything else. It holds for exactly the fields
/// derived from the profile the caller passed in, and `None` (a pane with no profile) derives nothing
/// and passes everything through.
///
/// # The scalar, which is where a silent weakening would actually happen
///
/// `bash_posture` is one value, so there is no union to take — and it is not advisory:
/// `settings.rs` scales the WHOLE auto-approve baseline by it. **The NARROWER posture wins**, ranked
/// by [`posture_breadth`].
///
/// The tie-break is decided in that direction because the two failures are not symmetric. Taking the
/// wider value on a disagreement hands a session a shell surface nothing granted it, silently, and
/// nothing downstream can notice. Taking the narrower one at worst makes a doer PROMPT for a command
/// it could have auto-run — visible, recoverable in one click, and loud in the log below. A
/// disagreement means one of the two copies is already wrong; the response to that is not to trust
/// whichever is more convenient.
pub fn reconcile_profile_settings(
    profile: Option<&AgentProfile>,
    from_frontend: ProfileSessionSettings,
) -> ProfileReconciliation {
    let Some(profile) = profile else {
        return ProfileReconciliation { merged: from_frontend, missing: Vec::new(), posture: None };
    };
    let derived = resolve_profile_settings(profile);
    let mut missing = Vec::new();

    let posture = if from_frontend.bash_posture == derived.bash_posture {
        None
    } else {
        let narrower = if posture_breadth(&derived.bash_posture) < posture_breadth(&from_frontend.bash_posture) {
            derived.bash_posture.clone()
        } else {
            from_frontend.bash_posture.clone()
        };
        Some(PostureDisagreement {
            from_frontend: from_frontend.bash_posture.clone(),
            derived: derived.bash_posture.clone(),
            chosen: narrower,
        })
    };

    let merged = ProfileSessionSettings {
        allowed_commands: union_reporting(
            "allowedCommands",
            from_frontend.allowed_commands,
            &derived.allowed_commands,
            &mut missing,
        ),
        denied_commands: union_reporting(
            "deniedCommands",
            from_frontend.denied_commands,
            &derived.denied_commands,
            &mut missing,
        ),
        allow_tool_rules: union_reporting(
            "allowToolRules",
            from_frontend.allow_tool_rules,
            &derived.allow_tool_rules,
            &mut missing,
        ),
        deny_tool_rules: union_reporting(
            "denyToolRules",
            from_frontend.deny_tool_rules,
            &derived.deny_tool_rules,
            &mut missing,
        ),
        bash_posture: posture
            .as_ref()
            .map(|d| d.chosen.clone())
            .unwrap_or(from_frontend.bash_posture),
    };
    ProfileReconciliation { merged, missing, posture }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fixture is GENERATED from the live TypeScript, so this proves Rust equals what the renderer
    /// actually does — not what its author believed it did. Located by filename under `src/`, the
    /// convention the tunnel and planner wire contracts already use.
    fn fixture() -> serde_json::Value {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("profileEnforcement.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one profileEnforcement.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// The one case whose ORDER this module deliberately does not reproduce. Named by its fixture label
    /// so the exemption cannot silently widen to a case it was never argued for.
    const ORDER_DIVERGENCE: &str = "tool keys in a SHUFFLED order — output order follows the input";

    /// Reports EVERY mismatch at once rather than dying on the first — a wrong port is usually wrong in
    /// a PATTERN, and one failing assertion hides the shape of it.
    #[test]
    fn the_bridge_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 12, "fixture shrank to {} cases — regenerate it", cases.len());

        let mut mismatches = Vec::new();
        let mut checked = 0usize;
        let mut packaged = 0usize;
        for case in cases {
            let label = case["label"].as_str().unwrap();
            if label == ORDER_DIVERGENCE {
                continue;
            }
            checked += 1;
            if label.starts_with("packaged: ") {
                packaged += 1;
            }
            let profile: AgentProfile = serde_json::from_value(case["profile"].clone())
                .unwrap_or_else(|e| panic!("{label}: profile did not deserialize: {e}"));
            let want: ProfileSessionSettings = serde_json::from_value(case["settings"].clone())
                .unwrap_or_else(|e| panic!("{label}: settings did not deserialize: {e}"));
            let got = resolve_profile_settings(&profile);
            if got != want {
                mismatches.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(
            packaged >= 5,
            "only {packaged} PACKAGED roles were compared — parity over invented inputs is not parity \
             over what ships"
        );
        assert!(
            mismatches.is_empty(),
            "the Rust bridge disagrees with the live TypeScript on {} of {checked} cases:\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    /// The exempted case must ACTUALLY diverge, and must diverge only in ORDER. Without this, the
    /// exemption is somewhere a real defect can hide: a port that dropped a rule entirely for that
    /// profile would be skipped by the parity test above and stay green.
    #[test]
    fn the_shuffled_case_diverges_in_order_only_and_rust_is_canonical() {
        let doc = fixture();
        let case = doc["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["label"].as_str() == Some(ORDER_DIVERGENCE))
            .expect("the shuffled fixture case is missing — the exemption is stale");

        let profile: AgentProfile = serde_json::from_value(case["profile"].clone()).unwrap();
        let ts: ProfileSessionSettings = serde_json::from_value(case["settings"].clone()).unwrap();
        let rust = resolve_profile_settings(&profile);

        assert_ne!(rust, ts, "expected an order divergence, but the two now agree exactly");

        let sorted = |mut v: Vec<String>| {
            v.sort();
            v
        };
        assert_eq!(
            sorted(rust.allow_tool_rules.clone()),
            sorted(ts.allow_tool_rules.clone()),
            "SAME SET: an order divergence must never be a missing or extra rule"
        );
        assert_eq!(sorted(rust.deny_tool_rules.clone()), sorted(ts.deny_tool_rules.clone()), "same set");
        assert_eq!(rust.bash_posture, ts.bash_posture, "the posture is not order-dependent");

        // And Rust's order is the canonical one, not merely some other order.
        // TOOL_KEYS order: read, grep, glob, edit, write, bash, web, task — so Write precedes Bash.
        assert_eq!(rust.allow_tool_rules, vec!["Read", "Grep", "Write", "Bash", "Task"]);
        assert_eq!(rust.deny_tool_rules, vec!["Glob", "Edit", "NotebookEdit", "WebFetch", "WebSearch"]);
    }

    fn profile(json: serde_json::Value) -> AgentProfile {
        serde_json::from_value(json).unwrap()
    }

    /// EDGE 1. A bare `Bash` deny would also kill the `gh`/`git` the session guarantees.
    #[test]
    fn bash_is_never_blanket_denied_only_its_posture_carries_the_restriction() {
        let p = profile(serde_json::json!({ "id": "x", "tools": { "bash": "deny", "read": "deny" } }));
        let s = resolve_profile_settings(&p);
        assert!(
            !s.deny_tool_rules.iter().any(|r| r == "Bash"),
            "a bare Bash deny would also kill the guaranteed gh/git: {:?}",
            s.deny_tool_rules
        );
        assert!(s.deny_tool_rules.contains(&"Read".to_string()), "every OTHER deny still lands");
        assert_eq!(s.bash_posture, "deny", "the restriction is carried by the posture, not by a rule");
    }

    /// EDGE 2. `Write(<glob>)` was never enforced — a silent no-op as an allow and an UNENFORCED DENY
    /// as a deny, which is the half that matters.
    #[test]
    fn a_path_rule_is_edit_only_and_reuses_the_role_gates_format() {
        let p = profile(serde_json::json!({
            "id": "x",
            "paths": { "allow": ["src/**"], "deny": ["**/*.env"] }
        }));
        let s = resolve_profile_settings(&p);
        assert_eq!(s.allow_tool_rules, vec!["Edit(src/**)"]);
        assert_eq!(s.deny_tool_rules, vec!["Edit(**/*.env)"]);
        assert!(
            !s.allow_tool_rules.iter().any(|r| r.starts_with("Write(")),
            "Write(<glob>) is not matched by Claude Code and must never be emitted (#3534)"
        );
        // The format comes from ONE place, so the two cannot drift apart.
        assert_eq!(s.allow_tool_rules[0], edit_path_rule("src/**"));
    }

    /// EDGE 3. Emitting a rule for these would assert an enforcement that does not exist.
    #[test]
    fn mode_and_net_are_advisory_and_produce_no_rule() {
        let permissive = resolve_profile_settings(&profile(serde_json::json!({
            "id": "x", "mode": "deny", "net": { "allow": ["api.example.com"] },
            "tools": { "read": "allow" }
        })));
        assert_eq!(permissive.allow_tool_rules, vec!["Read"], "mode did not suppress the tool tier");
        assert!(permissive.deny_tool_rules.is_empty(), "mode: deny emitted a rule it cannot enforce");
    }

    /// A profile's command list never denies anything — the role gate is what supplies command denies,
    /// and the two must not both claim that field.
    #[test]
    fn commands_are_deduped_in_order_and_denied_commands_stays_empty() {
        let s = resolve_profile_settings(&profile(serde_json::json!({
            "id": "x", "commands": ["git status", "npm test", "git status"]
        })));
        assert_eq!(s.allowed_commands, vec!["git status", "npm test"], "first occurrence wins");
        assert!(s.denied_commands.is_empty(), "command denies come from the role gate, not a profile");
    }


    /// The frontend's list legitimately carries MORE than the profile's — the role gate, the
    /// restricted-role surface and the user's own entries ride in the same argument — so the union
    /// must keep every one of them while adding back what the renderer dropped.
    #[test]
    fn the_union_restores_what_the_frontend_omitted_and_keeps_what_it_added() {
        let p = profile(serde_json::json!({
            "id": "x",
            "commands": ["cargo test"],
            "tools": { "read": "allow", "web": "deny" },
            "paths": { "allow": ["src/**"], "deny": ["**/*.env"] }
        }));
        // A renderer that computed the role half and lost the profile half.
        let sent = ProfileSessionSettings {
            allowed_commands: vec!["bsc ui".into()],
            denied_commands: vec!["curl".into()],
            allow_tool_rules: vec!["Edit(scratch/**)".into()],
            deny_tool_rules: vec!["Edit(.claude/**)".into()],
            bash_posture: "ask".into(),
        };
        let r = reconcile_profile_settings(Some(&p), sent);

        assert_eq!(r.merged.allowed_commands, vec!["bsc ui", "cargo test"]);
        assert_eq!(r.merged.allow_tool_rules, vec!["Edit(scratch/**)", "Read", "Edit(src/**)"]);
        assert_eq!(
            r.merged.deny_tool_rules,
            vec!["Edit(.claude/**)", "WebFetch", "WebSearch", "Edit(**/*.env)"]
        );
        assert_eq!(r.merged.denied_commands, vec!["curl"], "a profile contributes no command denies");
        assert_eq!(r.posture, None, "the postures agreed");

        // Reported per field, with the exact values — "some rules differed" is not actionable.
        let named: Vec<&str> = r.missing.iter().map(|(f, _)| *f).collect();
        assert_eq!(named, vec!["allowedCommands", "allowToolRules", "denyToolRules"]);
        assert_eq!(r.missing[0].1, vec!["cargo test"]);
        assert_eq!(r.missing[1].1, vec!["Read", "Edit(src/**)"]);
    }

    /// Agreement must be silent. A reconciliation that reported on every launch would train its only
    /// reader to ignore it, which costs exactly the signal it exists to carry.
    #[test]
    fn agreement_reports_nothing_and_changes_nothing() {
        let p = profile(serde_json::json!({
            "id": "x", "commands": ["cargo test"], "tools": { "read": "allow", "bash": "allow" }
        }));
        let derived = resolve_profile_settings(&p);
        let r = reconcile_profile_settings(Some(&p), derived.clone());
        assert_eq!(r.merged, derived);
        assert!(r.missing.is_empty() && r.posture.is_none());
    }

    /// No profile ⇒ nothing to derive. A role-less ad-hoc console must pass through untouched, or the
    /// flip would change every pane that never had a profile in the first place.
    #[test]
    fn no_profile_derives_nothing_and_passes_everything_through() {
        let sent = ProfileSessionSettings {
            allowed_commands: vec!["git".into()],
            denied_commands: vec!["curl".into()],
            allow_tool_rules: vec!["Read".into()],
            deny_tool_rules: vec!["Write".into()],
            bash_posture: "allow".into(),
        };
        let r = reconcile_profile_settings(None, sent.clone());
        assert_eq!(r.merged, sent);
        assert!(r.missing.is_empty() && r.posture.is_none());
    }

    /// THE SCALAR, in both directions. The narrower wins whichever side holds it, because the two
    /// failures are not symmetric: taking the wider value hands a session a shell surface nothing
    /// granted it, silently.
    #[test]
    fn the_narrower_bash_posture_wins_from_either_side() {
        let ask = profile(serde_json::json!({ "id": "x", "tools": { "bash": "ask" } }));
        let sent = |posture: &str| ProfileSessionSettings {
            allowed_commands: vec![],
            denied_commands: vec![],
            allow_tool_rules: vec![],
            deny_tool_rules: vec![],
            bash_posture: posture.to_string(),
        };

        // Rust derived the narrower one.
        let r = reconcile_profile_settings(Some(&ask), sent("allow"));
        assert_eq!(r.merged.bash_posture, "ask");
        let d = r.posture.expect("a disagreement is always reported");
        assert_eq!((d.from_frontend.as_str(), d.derived.as_str(), d.chosen.as_str()), ("allow", "ask", "ask"));

        // The FRONTEND held the narrower one — and it still wins. Rust reports rather than overrides.
        let r = reconcile_profile_settings(Some(&ask), sent("deny"));
        assert_eq!(r.merged.bash_posture, "deny", "Rust must not widen a posture the frontend narrowed");
        assert_eq!(r.posture.expect("reported").chosen, "deny");
    }

    /// An unrecognised tier is the WIDEST posture in effect — `build_allow_rules` falls through to the
    /// `allow` arm for anything that is not `deny`/`ask`. Ranking it anywhere else would let a typo win
    /// the tie-break and then be obeyed as `allow` anyway: a narrowing that narrows nothing.
    #[test]
    fn an_unrecognised_posture_ranks_as_the_widest_not_as_a_fourth_tier() {
        let weird = profile(serde_json::json!({ "id": "x", "tools": { "bash": "permissive" } }));
        let r = reconcile_profile_settings(
            Some(&weird),
            ProfileSessionSettings {
                allowed_commands: vec![],
                denied_commands: vec![],
                allow_tool_rules: vec![],
                deny_tool_rules: vec![],
                bash_posture: "ask".into(),
            },
        );
        assert_eq!(r.merged.bash_posture, "ask", "`ask` is narrower than an unknown, which acts as allow");
        assert_eq!(posture_breadth("permissive"), posture_breadth("allow"));
        assert!(posture_breadth("deny") < posture_breadth("ask"));
    }

    /// An unlisted capability is `ask` — no rule — rather than an error or a default deny. A profile
    /// written before a tool existed must not silently start denying it.
    #[test]
    fn a_missing_or_unrecognised_tier_emits_no_rule() {
        let s = resolve_profile_settings(&profile(serde_json::json!({ "id": "x", "tools": {} })));
        assert!(s.allow_tool_rules.is_empty() && s.deny_tool_rules.is_empty());
        assert_eq!(s.bash_posture, "ask", "an unlisted bash is ask, the prompting default");

        let weird = resolve_profile_settings(&profile(serde_json::json!({
            "id": "x", "tools": { "read": "nonsense" }
        })));
        assert!(weird.allow_tool_rules.is_empty() && weird.deny_tool_rules.is_empty());
    }
}
