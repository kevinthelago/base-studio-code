//! The session's `permissions` block and its bypass posture.
//!
//! This is what `ensure_session_settings` writes as the session's permission rules, plus the flag that
//! decides whether the `deny` half of it is honoured AT ALL.
//!
//! # Bypass is the sharpest output here
//!
//! Under bypass, `permissions.deny` is IGNORED — every deny composed below stops applying, and the
//! only thing still gating is the PreToolUse hook chain. That is why the denies, the write scope and
//! the hook chain matter as much as they do, and it is why this flag is a THREE-WAY precedence rather
//! than a boolean:
//!
//! 1. a full-capability debug-studio session is ALWAYS bypass — it is the app's unrestricted
//!    maintenance session in its own source tree, and the control is the human reviewing its work;
//! 2. a RESTRICTED role is NEVER bypass, whatever the global toggle says;
//! 3. everything else follows the global toggle.
//!
//! Collapsing that into two cases either strips the debug studio of its reason for existing or hands
//! bypass to the app's most confined sessions.
//!
//! # The flow rule fails closed, and that is a fix rather than a style
//!
//! [`flow_permission_rules`] enumerates the policies that may reach a remote and DENIES in its
//! fallthrough. It used to be the other way round — an unrecognised push value produced no rules,
//! which under the broad Bash allow means push and PR are PERMITTED. Not hypothetical: `self-merge`
//! was never a case and reached the remote through exactly that branch. A port written the obvious way,
//! with a permissive `_ =>`, silently reintroduces it for the next value nobody has thought about.
//!
//! Note also that the gate is read as written: a flow of `{ push: "push-confirm" }` with NO gate does
//! not acquire the default `hard`, because the default flow is substituted only when the whole flow is
//! absent. So a partial flow asks for nothing.
//!
//! # Order is written through to settings.json
//!
//! The `.claude/**` confinement deny is FIRST, and that is not cosmetic — it is what stops a session
//! rewriting its own permission file.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it.
#![allow(dead_code)] // wired by `the-launch-composes-its-own-tool-rules-instead-of-receiving-them`

use super::profile_settings::ProfileSessionSettings;
use super::role_gate::{
    edit_path_rule, is_restricted_role, role_denied_tools, role_write_rules, write_locks,
    RoleCapability,
};

/// The pane-id prefix shared by every debug-studio session — the standing debugger and each
/// per-request one. A PREFIX here deliberately, unlike the fresh-only registry: every session in the
/// debug studio is the app's full-capability maintenance session, so the family is the right unit.
const DEBUG_STUDIO_PANE_PREFIX: &str = "debug-studio:";

/// The write rules a flow grants, as verbatim permission rules. `git push` covers branch pushes and
/// `gh pr create` covers opening PRs; merging is the director's job and is never granted here.
const PUSH_WRITE_RULES: &[&str] = &["Bash(git push *)", "Bash(gh pr create *)"];

/// What a pane's flow contributes to the permission block.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlowPermissionRules {
    pub ask_tool_rules: Vec<String>,
    pub deny_tool_rules: Vec<String>,
}

/// Whether this session is the app's full-capability maintenance session.
pub fn is_full_capability_session(pane_id: &str) -> bool {
    pane_id.starts_with(DEBUG_STUDIO_PANE_PREFIX)
}

/// The ask/deny rules a stream's flow contributes at launch.
///
/// FAILS CLOSED — see the module docs. `push` and `gate` are read exactly as the flow carries them; a
/// missing gate is not `hard`.
pub fn flow_permission_rules(push: Option<&str>, gate: Option<&str>) -> FlowPermissionRules {
    let push_rules = || PUSH_WRITE_RULES.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    // The absent-flow default is `local`, which denies.
    match push.unwrap_or("local") {
        "auto-pr" | "self-merge" => FlowPermissionRules::default(),
        "push-confirm" => {
            if gate == Some("hard") {
                FlowPermissionRules { ask_tool_rules: push_rules(), deny_tool_rules: Vec::new() }
            } else {
                FlowPermissionRules::default()
            }
        }
        // `local` / `commit-only` / `none` block push, and so does ANYTHING ELSE. The catch-all is the
        // point: a policy nobody has added yet must not reach a remote.
        _ => FlowPermissionRules { ask_tool_rules: Vec::new(), deny_tool_rules: push_rules() },
    }
}

/// The permission block a session launches with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionToolRules {
    pub allowed_commands: Vec<String>,
    pub allow_tool_rules: Vec<String>,
    pub deny_tool_rules: Vec<String>,
    pub ask_tool_rules: Vec<String>,
    pub bash_posture: String,
    /// True when the role carries its own fixed command surface — the session is confined to it.
    pub restricted_allow: bool,
    pub bypass: bool,
}

/// Compose the permission block.
///
/// `profile` is [`super::profile_settings::resolve_profile_settings`]'s output, absent when the pane
/// carries no profile. The role's own auto-runnable commands come from `cap.allow`, which IS the
/// role-defaults fact — not a second list beside it.
pub fn session_tool_rules(
    cap: Option<&RoleCapability>,
    profile: Option<&ProfileSessionSettings>,
    flow_push: Option<&str>,
    flow_gate: Option<&str>,
    pane_id: &str,
    global_bypass: bool,
) -> SessionToolRules {
    // `write_locks()` is the ONE loader for the plan-file and dependency-manifest lists; passing them
    // in is `role_write_rules`' own contract, so this reads them rather than restating either list.
    let (db_owned, dep_manifests) = write_locks();
    let write = cap.map(|c| role_write_rules(c, &db_owned, &dep_manifests)).unwrap_or_default();
    let flow = flow_permission_rules(flow_push, flow_gate);
    let restricted: Vec<String> = cap.map(|c| c.allow.clone()).unwrap_or_default();
    let restricted_allow = !restricted.is_empty();

    let mut allowed_commands: Vec<String> =
        profile.map(|p| p.allowed_commands.clone()).unwrap_or_default();
    allowed_commands.extend(restricted);

    let mut allow_tool_rules = write.allow.clone();
    if let Some(p) = profile {
        allow_tool_rules.extend(p.allow_tool_rules.iter().cloned());
    }
    if restricted_allow {
        // A confined session still reads; without this it could not see the files it curates.
        allow_tool_rules.push("Read".to_string());
    }

    // FIRST, deliberately: this is what stops a session rewriting its own permission file.
    let mut deny_tool_rules = vec![edit_path_rule(".claude/**")];
    deny_tool_rules.extend(write.deny.iter().cloned());
    if let Some(c) = cap {
        deny_tool_rules.extend(role_denied_tools(c));
    }
    if let Some(p) = profile {
        deny_tool_rules.extend(p.deny_tool_rules.iter().cloned());
    }
    deny_tool_rules.extend(flow.deny_tool_rules);

    SessionToolRules {
        allowed_commands,
        allow_tool_rules,
        deny_tool_rules,
        ask_tool_rules: flow.ask_tool_rules,
        bash_posture: profile.map(|p| p.bash_posture.clone()).unwrap_or_else(|| "allow".to_string()),
        restricted_allow,
        bypass: if is_full_capability_session(pane_id) {
            true
        } else if cap.map(is_restricted_role).unwrap_or(false) {
            false
        } else {
            global_bypass
        },
    }
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
                } else if p.file_name().and_then(|n| n.to_str()) == Some("toolRules.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one toolRules.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn strings(v: &serde_json::Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    /// The profile half is rebuilt from the SAME resolver the frontend used, so this proves the
    /// composition rather than re-proving `resolve_profile_settings` (already parity-proved elsewhere).
    fn profile_of(case: &serde_json::Value) -> Option<ProfileSessionSettings> {
        if !case["hasProfile"].as_bool().unwrap() {
            return None;
        }
        let p: super::super::profile_settings::AgentProfile = serde_json::from_value(serde_json::json!({
            "id": "pf_x", "mode": "ask", "commands": ["cargo test"],
            "tools": { "read": "allow", "write": "deny", "bash": "ask" },
            "paths": { "allow": ["src/**"], "deny": ["**/*.env"] }
        }))
        .unwrap();
        Some(super::super::profile_settings::resolve_profile_settings(&p))
    }

    /// Reports every mismatch at once, field by field and IN ORDER — these rules are written into
    /// settings.json in order.
    #[test]
    fn the_permission_block_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 25, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut restricted_n, mut bypass_n, mut asked_n) = (0usize, 0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let cap: Option<RoleCapability> = match &case["capability"] {
                serde_json::Value::Null => None,
                v => Some(serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{label}: {e}"))),
            };
            let got = session_tool_rules(
                cap.as_ref(),
                profile_of(case).as_ref(),
                case["push"].as_str(),
                case["gate"].as_str(),
                case["paneId"].as_str().unwrap(),
                case["globalBypass"].as_bool().unwrap(),
            );
            if case["restrictedAllow"].as_bool().unwrap() {
                restricted_n += 1;
            }
            if case["bypass"].as_bool().unwrap() {
                bypass_n += 1;
            }
            if !strings(&case["askToolRules"]).is_empty() {
                asked_n += 1;
            }

            for (what, g, w) in [
                ("allowedCommands", &got.allowed_commands, strings(&case["allowedCommands"])),
                ("allowToolRules", &got.allow_tool_rules, strings(&case["allowToolRules"])),
                ("denyToolRules", &got.deny_tool_rules, strings(&case["denyToolRules"])),
                ("askToolRules", &got.ask_tool_rules, strings(&case["askToolRules"])),
            ] {
                if *g != w {
                    let missing: Vec<_> = w.iter().filter(|x| !g.contains(x)).collect();
                    let extra: Vec<_> = g.iter().filter(|x| !w.contains(x)).collect();
                    mismatches.push(format!("  {label} [{what}]\n    missing {missing:?}\n    extra {extra:?}"));
                }
            }
            if got.bash_posture != case["bashPosture"].as_str().unwrap() {
                mismatches.push(format!("  {label} [bashPosture] ts={} rust={}", case["bashPosture"], got.bash_posture));
            }
            if got.restricted_allow != case["restrictedAllow"].as_bool().unwrap() {
                mismatches.push(format!("  {label} [restrictedAllow] rust={}", got.restricted_allow));
            }
            if got.bypass != case["bypass"].as_bool().unwrap() {
                mismatches.push(format!("  {label} [bypass] rust={}", got.bypass));
            }
        }
        assert!(restricted_n >= 3, "only {restricted_n} restricted-role cases");
        assert!(bypass_n >= 3, "only {bypass_n} bypass-true cases");
        assert!(asked_n >= 1, "no case produced an ASK rule — the push-confirm hard gate is untested");
        assert!(
            mismatches.is_empty(),
            "the Rust composition disagrees with the live TypeScript on {} point(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    /// THE FAIL-CLOSED DEFAULT. `self-merge` reached the remote through a permissive fallthrough; this
    /// is that regression, asserted for a value nobody has added yet.
    #[test]
    fn an_unrecognised_push_policy_denies_rather_than_permitting() {
        let r = flow_permission_rules(Some("a-policy-nobody-added-yet"), None);
        assert_eq!(r.deny_tool_rules, vec!["Bash(git push *)", "Bash(gh pr create *)"]);
        assert!(r.ask_tool_rules.is_empty());

        // And the two that DO reach a remote are enumerated, not inferred.
        for ok in ["auto-pr", "self-merge"] {
            assert_eq!(flow_permission_rules(Some(ok), None), FlowPermissionRules::default(), "{ok}");
        }
        // An ABSENT flow defaults to `local`, which denies.
        assert_eq!(flow_permission_rules(None, None).deny_tool_rules.len(), 2, "no flow ⇒ no remote");
    }

    /// The gate is read as written: a partial flow does NOT acquire the default `hard`.
    #[test]
    fn push_confirm_asks_only_under_a_hard_gate() {
        assert_eq!(flow_permission_rules(Some("push-confirm"), Some("hard")).ask_tool_rules.len(), 2);
        assert!(flow_permission_rules(Some("push-confirm"), Some("soft")).ask_tool_rules.is_empty());
        assert!(
            flow_permission_rules(Some("push-confirm"), None).ask_tool_rules.is_empty(),
            "a flow with no gate does not acquire the default one — only a wholly absent flow does"
        );
    }

    fn cap(role: &str, code: &str, allow: &[&str]) -> RoleCapability {
        serde_json::from_value(serde_json::json!({
            "role": role, "git": "none", "github": "none", "net": "none", "code": code,
            "writeGlobs": [], "ui": "read", "allow": allow
        }))
        .unwrap()
    }

    /// The three-way precedence, in all three directions.
    #[test]
    fn bypass_is_a_three_way_precedence() {
        let worker = cap("worker", "write", &[]);
        let designer = cap("designer", "none", &["bsc ui"]);

        assert!(
            session_tool_rules(Some(&designer), None, None, None, "debug-studio:req-1", false).bypass,
            "a full-capability session is bypass even when the role is restricted and the toggle is off"
        );
        assert!(
            !session_tool_rules(Some(&designer), None, None, None, "p1", true).bypass,
            "a restricted role is never bypass, whatever the toggle says"
        );
        assert!(session_tool_rules(Some(&worker), None, None, None, "p1", true).bypass, "else the toggle");
        assert!(!session_tool_rules(Some(&worker), None, None, None, "p1", false).bypass);
        assert!(
            !session_tool_rules(None, None, None, None, "p1", false).bypass,
            "an ungated pane follows the toggle too"
        );
    }

    /// The confinement deny leads, and that is what stops a session rewriting its own permissions.
    #[test]
    fn the_claude_dir_deny_is_first() {
        for c in [Some(&cap("worker", "write", &[])), Some(&cap("designer", "none", &["bsc ui"])), None] {
            let r = session_tool_rules(c, None, None, None, "p1", false);
            assert_eq!(r.deny_tool_rules.first().map(String::as_str), Some("Edit(.claude/**)"));
        }
    }

    /// A restricted role gets its own commands AND a Read allow — without which it could not see the
    /// files it curates.
    #[test]
    fn a_restricted_role_carries_its_commands_and_keeps_read() {
        let r = session_tool_rules(Some(&cap("designer", "none", &["bsc ui", "bsc shot preview"])), None, None, None, "p1", false);
        assert!(r.restricted_allow);
        assert_eq!(r.allowed_commands, vec!["bsc ui", "bsc shot preview"]);
        assert!(r.allow_tool_rules.contains(&"Read".to_string()), "a confined session still reads");

        let plain = session_tool_rules(Some(&cap("worker", "write", &[])), None, None, None, "p1", false);
        assert!(!plain.restricted_allow);
        assert!(!plain.allow_tool_rules.contains(&"Read".to_string()), "and an unconfined one needs no such rule");
    }
}
