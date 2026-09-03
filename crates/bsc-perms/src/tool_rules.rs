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

use crate::profile_settings::ProfileSessionSettings;
use crate::role_gate::{
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


/// A scalar the two sides disagreed on, and which value won.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScalarDisagreement<T> {
    pub from_frontend: T,
    pub derived: T,
    pub chosen: T,
}

/// The permission block to write, and every way the two sides disagreed producing it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolRulesReconciliation {
    pub merged: SessionToolRules,
    /// Per list field, the values the composition derived that the frontend omitted — appended.
    pub missing: Vec<(&'static str, Vec<String>)>,
    /// `bash_posture`, when they differed. The NARROWER won.
    pub posture: Option<ScalarDisagreement<String>>,
    /// `bypass`, when they differed. The RESTRICTIVE value won.
    pub bypass: Option<ScalarDisagreement<bool>>,
    /// `restricted_allow`, when they differed. See the docs on why this one is not "restrictive wins".
    pub restricted_allow: Option<ScalarDisagreement<bool>>,
}

/// Union one list, frontend order first, recording what the composition added.
fn union_field(
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

/// How wide a shell posture is, as `settings::build_allow_rules` actually treats it — anything that is
/// not `deny` or `ask` falls through to the `allow` arm, so an unrecognised tier is the WIDEST.
fn posture_breadth(tier: &str) -> u8 {
    match tier {
        "deny" => 0,
        "ask" => 1,
        _ => 2,
    }
}

/// Reconcile the composed permission block against the one the renderer sent.
///
/// # The lists union; the scalars do not, and each one is decided separately
///
/// A list can be unioned because "one side has more" is meaningful. A scalar cannot, so each of the
/// three below is decided on what its two failure directions actually cost — and they do not all point
/// the same way, which is why they are not folded into one rule.
///
/// **`bypass` takes the RESTRICTIVE value (`false`).** It decides whether `permissions.deny` is
/// honoured AT ALL, so getting it wrong in the permissive direction stops every deny in this block —
/// and the ones from the denies and write-scope flips — applying at once, leaving only the hook chain.
/// A session that prompts more than intended is a complaint; one that prompts less is a hole.
///
/// **`bash_posture` takes the NARROWER value**, ranked by [`posture_breadth`] rather than by the three
/// names: the fall-through arm means an unrecognised tier is the widest, so a typo must not win a
/// tie-break and then be obeyed as `allow` anyway.
///
/// **`restricted_allow` takes the DERIVED value when a capability arrived**, and that is deliberately
/// NOT "restrictive wins". It is a pure function of `cap.allow` — a role either carries a fixed command
/// surface or it does not — so with the capability in hand the composition is simply right, and there
/// is no user-supplied component for the frontend to be carrying on top. "Restrictive wins" would read
/// as safer and would be worse: `true` confines the session to exactly the enumerated commands, so a
/// spurious `true` strands an ordinary worker with no build tier at all. With no capability the
/// frontend's value stands, because then nothing was derived to prefer.
pub fn reconcile_session_tool_rules(
    from_frontend: SessionToolRules,
    derived: SessionToolRules,
    had_capability: bool,
) -> ToolRulesReconciliation {
    let mut missing = Vec::new();

    let posture = (from_frontend.bash_posture != derived.bash_posture).then(|| {
        let narrower = if posture_breadth(&derived.bash_posture) < posture_breadth(&from_frontend.bash_posture) {
            derived.bash_posture.clone()
        } else {
            from_frontend.bash_posture.clone()
        };
        ScalarDisagreement {
            from_frontend: from_frontend.bash_posture.clone(),
            derived: derived.bash_posture.clone(),
            chosen: narrower,
        }
    });
    let bypass = (from_frontend.bypass != derived.bypass).then_some(ScalarDisagreement {
        from_frontend: from_frontend.bypass,
        derived: derived.bypass,
        // The restrictive value, which for a bypass flag is `false`.
        chosen: false,
    });
    let restricted_allow =
        (from_frontend.restricted_allow != derived.restricted_allow).then_some(ScalarDisagreement {
            from_frontend: from_frontend.restricted_allow,
            derived: derived.restricted_allow,
            chosen: if had_capability {
                derived.restricted_allow
            } else {
                from_frontend.restricted_allow
            },
        });

    let merged = SessionToolRules {
        allowed_commands: union_field(
            "allowedCommands",
            from_frontend.allowed_commands,
            &derived.allowed_commands,
            &mut missing,
        ),
        allow_tool_rules: union_field(
            "allowToolRules",
            from_frontend.allow_tool_rules,
            &derived.allow_tool_rules,
            &mut missing,
        ),
        deny_tool_rules: union_field(
            "denyToolRules",
            from_frontend.deny_tool_rules,
            &derived.deny_tool_rules,
            &mut missing,
        ),
        ask_tool_rules: union_field(
            "askToolRules",
            from_frontend.ask_tool_rules,
            &derived.ask_tool_rules,
            &mut missing,
        ),
        bash_posture: posture
            .as_ref()
            .map(|d| d.chosen.clone())
            .unwrap_or(from_frontend.bash_posture),
        restricted_allow: restricted_allow
            .as_ref()
            .map(|d| d.chosen)
            .unwrap_or(from_frontend.restricted_allow),
        bypass: bypass.as_ref().map(|d| d.chosen).unwrap_or(from_frontend.bypass),
    };
    ToolRulesReconciliation { merged, missing, posture, bypass, restricted_allow }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::role_gate::{RoleCapability, Tier};


    fn cap_tr(role: &str, code: Tier, globs: Vec<String>, allow: Vec<String>) -> RoleCapability {
        RoleCapability {
            role: role.into(),
            github: Tier::Read,
            git: Tier::Read,
            code,
            net: Tier::None,
            ui: Tier::Read,
            graph: Tier::Read,
            write_globs: globs,
            allow,
            surfaces: None,
            harvest_roots: vec![],
        }
    }
    fn empty_block() -> SessionToolRules {
        SessionToolRules {
            allowed_commands: vec![],
            allow_tool_rules: vec![],
            deny_tool_rules: vec![],
            ask_tool_rules: vec![],
            bash_posture: "allow".into(),
            restricted_allow: false,
            bypass: false,
        }
    }

    /// EVERY GRANT THE FRONTEND SENT SURVIVES, in order. Ported from `reconcile_tool_rules`, which
    /// this supersedes — the casualties when an earlier version INTERSECTED were a restricted role's
    /// `Read` (so a designer prompted on every file read) and every path a profile granted.
    #[test]
    fn every_allow_the_frontend_sent_survives_in_order() {
        let designer = cap_tr("designer", Tier::None, vec!["scratch/**".into()], vec![]);
        let derived = session_tool_rules(Some(&designer), None, None, None, "p", false);
        let sent = SessionToolRules {
            allow_tool_rules: vec![
                "Edit(scratch/**)".into(), // the role's own
                "Read".into(),             // a bare tool name the role's set can never contain
                "Grep".into(),             // a profile tool grant
                "Edit(assets/**)".into(),  // a profile PATH grant
            ],
            ..empty_block()
        };
        let r = reconcile_session_tool_rules(sent, derived, true);
        assert_eq!(
            &r.merged.allow_tool_rules[..4],
            &[
                "Edit(scratch/**)".to_string(),
                "Read".to_string(),
                "Grep".to_string(),
                "Edit(assets/**)".to_string(),
            ],
            "every grant survives, in its position"
        );
    }

    /// A DELIBERATE REVERSAL, and the condition for it is now met. `reconcile_tool_rules` REPORTED a
    /// missing allow and never added it, because "Rust can only intersect against a set it fully
    /// derives" — it derived `Edit(<role glob>)` and nothing else, so a bare tool name or a profile
    /// path could not be in it.
    ///
    /// `session_tool_rules` derives the WHOLE list: the role's write rules, the profile's grants, and
    /// the restricted-role `Read`. Its own doc named this as the moment the reversal becomes correct.
    /// So a value the composition derived and the frontend omitted is now RESTORED rather than only
    /// named — the worker below would otherwise prompt inside its own lane.
    #[test]
    fn an_allow_the_composition_derived_is_now_restored_not_merely_reported() {
        let worker = cap_tr("worker", Tier::Write, vec!["src/**".into()], vec![]);
        let derived = session_tool_rules(Some(&worker), None, None, None, "p", false);
        let r = reconcile_session_tool_rules(
            SessionToolRules { allow_tool_rules: vec!["Read".into()], ..empty_block() },
            derived,
            true,
        );
        assert!(
            r.merged.allow_tool_rules.iter().any(|a| a == "Edit(src/**)"),
            "the worker's own boundary is restored: {:?}",
            r.merged.allow_tool_rules
        );
        assert!(r.merged.allow_tool_rules.iter().any(|a| a == "Read"), "and what was sent is kept");
        assert!(r.missing.iter().any(|(f, v)| *f == "allowToolRules" && v.contains(&"Edit(src/**)".to_string())));
    }

    /// The `.claude/**` deny is FIRST, and stays first. A session able to edit its own `.claude/` can
    /// rewrite every other rule in this block, so its position is the one that cannot be incidental.
    #[test]
    fn the_claude_deny_is_first_in_the_composed_block() {
        let worker = cap_tr("worker", Tier::Write, vec!["src/**".into()], vec![]);
        let derived = session_tool_rules(Some(&worker), None, None, None, "p", false);
        assert_eq!(derived.deny_tool_rules.first().map(String::as_str), Some("Edit(.claude/**)"));
        // …and the union preserves the frontend's own first position too, which in practice is the
        // same rule — so the merged list still opens with it.
        let r = reconcile_session_tool_rules(
            SessionToolRules { deny_tool_rules: vec!["Edit(.claude/**)".into()], ..empty_block() },
            derived,
            true,
        );
        assert_eq!(r.merged.deny_tool_rules.first().map(String::as_str), Some("Edit(.claude/**)"));
    }

    /// BYPASS TAKES THE RESTRICTIVE VALUE, in both directions. It decides whether `permissions.deny`
    /// is honoured AT ALL: prompting less than intended is a hole, prompting more is a complaint.
    #[test]
    fn bypass_disagreements_resolve_to_false_whichever_side_asked_for_it() {
        let worker = cap_tr("worker", Tier::Write, vec!["src/**".into()], vec![]);
        // The composition says bypass; the frontend did not.
        let derived = session_tool_rules(Some(&worker), None, None, None, "p", true);
        assert!(derived.bypass, "an ordinary role follows the global toggle");
        let r = reconcile_session_tool_rules(empty_block(), derived, true);
        assert!(!r.merged.bypass, "the restrictive value wins");
        let d = r.bypass.expect("and the disagreement is never silent");
        assert_eq!((d.from_frontend, d.derived, d.chosen), (false, true, false));

        // The reverse: the FRONTEND asked for bypass and the composition did not.
        let designer = cap_tr("designer", Tier::None, vec!["scratch/**".into()], vec!["bsc ui".into()]);
        let derived = session_tool_rules(Some(&designer), None, None, None, "p", true);
        assert!(!derived.bypass, "a restricted role is NEVER bypass, whatever the toggle says");
        let r = reconcile_session_tool_rules(
            SessionToolRules { bypass: true, ..empty_block() },
            derived,
            true,
        );
        assert!(!r.merged.bypass);
    }

    /// The debug studio is always bypass — the one arm that must survive a "restrictive wins" rule,
    /// and it does, because both sides derive it from the same pane id.
    #[test]
    fn the_debug_studio_stays_bypass_because_both_sides_agree_on_it() {
        let derived = session_tool_rules(None, None, None, None, "debug-studio:req-7", false);
        assert!(derived.bypass, "the full-capability session is bypass by definition");
        let r = reconcile_session_tool_rules(
            SessionToolRules { bypass: true, ..empty_block() },
            derived,
            false,
        );
        assert!(r.merged.bypass, "agreement means the restrictive rule never fires");
        assert!(r.bypass.is_none());
    }

    /// `restricted_allow` takes the DERIVED value when a capability arrived — deliberately not
    /// "restrictive wins". `true` confines the session to exactly the enumerated commands, so a
    /// spurious `true` strands an ordinary worker with no build tier at all.
    #[test]
    fn restricted_allow_follows_the_capability_rather_than_the_stricter_value() {
        let worker = cap_tr("worker", Tier::Write, vec!["src/**".into()], vec![]);
        let derived = session_tool_rules(Some(&worker), None, None, None, "p", false);
        assert!(!derived.restricted_allow, "a worker carries no fixed surface");
        let r = reconcile_session_tool_rules(
            SessionToolRules { restricted_allow: true, ..empty_block() },
            derived.clone(),
            true,
        );
        assert!(!r.merged.restricted_allow, "the capability is the authority, not the stricter value");

        // With NO capability there is nothing derived to prefer, so the frontend's value stands.
        let r = reconcile_session_tool_rules(
            SessionToolRules { restricted_allow: true, ..empty_block() },
            derived,
            false,
        );
        assert!(r.merged.restricted_allow);
    }

    /// Agreement is a no-op in every field — the property that makes this safe to land, since parity
    /// says the two sides do agree.
    #[test]
    fn agreement_changes_nothing_at_all() {
        let documentor = cap_tr("documentor", Tier::None, vec!["docs/**".into()], vec![]);
        let derived = session_tool_rules(Some(&documentor), None, None, None, "p", false);
        let r = reconcile_session_tool_rules(derived.clone(), derived.clone(), true);
        assert_eq!(r.merged, derived);
        assert!(r.missing.is_empty() && r.posture.is_none() && r.bypass.is_none());
        assert!(r.restricted_allow.is_none());
    }


    /// THE POSTURE TIE-BREAK, in both directions. Ported from `reconcile_profile_settings`, which this
    /// supersedes. `bash_posture` scales the WHOLE auto-approve baseline, so the two failures are not
    /// symmetric: taking the wider value hands a session a shell surface nothing granted it and
    /// nothing downstream can notice, while taking the narrower at worst makes a doer PROMPT for
    /// something it could have auto-run — visible, one click to clear, and logged.
    #[test]
    fn the_narrower_bash_posture_wins_from_either_side() {
        let ask = crate::profile_settings::ProfileSessionSettings {
            allowed_commands: vec![],
            denied_commands: vec![],
            allow_tool_rules: vec![],
            deny_tool_rules: vec![],
            bash_posture: "ask".into(),
        };
        let derived = session_tool_rules(None, Some(&ask), None, None, "p", false);
        assert_eq!(derived.bash_posture, "ask");

        // Rust derived the narrower one.
        let r = reconcile_session_tool_rules(
            SessionToolRules { bash_posture: "allow".into(), ..empty_block() },
            derived.clone(),
            false,
        );
        assert_eq!(r.merged.bash_posture, "ask");
        let d = r.posture.expect("a disagreement is always reported");
        assert_eq!((d.from_frontend.as_str(), d.derived.as_str(), d.chosen.as_str()), ("allow", "ask", "ask"));

        // The FRONTEND held the narrower one — and it still wins.
        let r = reconcile_session_tool_rules(
            SessionToolRules { bash_posture: "deny".into(), ..empty_block() },
            derived,
            false,
        );
        assert_eq!(r.merged.bash_posture, "deny", "the composition must not widen a posture the frontend narrowed");
    }

    /// An UNRECOGNISED tier is the WIDEST posture in effect — `build_allow_rules` falls through to the
    /// `allow` arm for anything that is not `deny`/`ask`. Ranking it anywhere else would let a typo win
    /// the tie-break and then be obeyed as `allow` anyway: a narrowing that narrows nothing.
    #[test]
    fn an_unrecognised_posture_ranks_as_the_widest_not_as_a_fourth_tier() {
        assert_eq!(posture_breadth("permissive"), posture_breadth("allow"));
        assert!(posture_breadth("deny") < posture_breadth("ask"));
        assert!(posture_breadth("ask") < posture_breadth("allow"));
    }

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
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
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
