//! Which skills a session receives.
//!
//! # Rust owned everything around this decision and not the decision
//!
//! `crates/skilldb` IS the skills store and `bsc skill` its CLI;
//! [`super::skills::write_session_skills`] writes the resolved list into `.claude/skills`, taking an
//! already-chosen set. So the backend owned the store, owned the write, and could not answer "which".
//!
//! The cost of that split is recorded in the tree: a `bsc-agent` session received NO skills at all,
//! because the only writer of `.claude/skills` is reached from `ensure_session_settings`, which the
//! frontend calls only for a CLAUDE pane. The runtime scanned a directory nothing had ever created for
//! it, found nothing, and looked exactly like a session that legitimately had none attached.
//!
//! # The precedence chain
//!
//! 1. a DISABLED skill is off, whatever anything else says — nothing can turn it on;
//! 2. IN SCOPE = the skill names no projects (global) or names this one;
//! 3. VIA GROUP = a toggled-on skill group carries it;
//! 4. the baseline is in-scope OR via-group;
//! 5. an explicit REMOVE beats the baseline, an explicit ADD beats that;
//! 6. `overridden` is `on != baseline`;
//! 7. `reason` is layered: added/removed when overridden, else pinned > global > project > group,
//!    else out-of-scope.
//!
//! STEP 6 IS THE ONE A PORT LOSES. It is tempting to set `overridden` from "an override mentions this
//! skill", which flags every REDUNDANT choice — an add for something already on — as a deviation. The
//! UI reads this field to mark a session as differing from its project baseline, so a redundant choice
//! showing as a deviation is a lie about what the user changed.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it.
#![allow(dead_code)] // wired by `the-launch-resolves-its-own-skills-instead-of-receiving-them`

use super::cfg::SkillCfg;
use super::skills::skill_slug;

/// A library skill, pared to what the resolution reads.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SkillDef {
    pub id: String,
    pub name: String,
    /// One-line description — the SKILL.md frontmatter `description`.
    #[serde(default)]
    pub desc: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub tools: Vec<String>,
    /// EMPTY means every project (global); otherwise the project ids it applies to.
    #[serde(default)]
    pub projects: Vec<String>,
    pub enabled: bool,
    #[serde(default)]
    pub pinned: bool,
}

/// A session's explicit per-skill choices.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct SessionSkillOverride {
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub remove: Vec<String>,
}

/// Why a skill is on or off. Ordered as the layering resolves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillReason {
    Disabled,
    Added,
    Removed,
    Pinned,
    Global,
    Project,
    Group,
    OutOfScope,
}

impl SkillReason {
    pub fn as_str(self) -> &'static str {
        match self {
            SkillReason::Disabled => "disabled",
            SkillReason::Added => "added",
            SkillReason::Removed => "removed",
            SkillReason::Pinned => "pinned",
            SkillReason::Global => "global",
            SkillReason::Project => "project",
            SkillReason::Group => "group",
            SkillReason::OutOfScope => "out-of-scope",
        }
    }
}

/// One skill's verdict for one session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSkillState {
    pub on: bool,
    pub reason: SkillReason,
    /// `on != baseline` — NOT "an override mentions it". See the module docs.
    pub overridden: bool,
}

/// Resolve one skill against this session.
pub fn session_skill_state(
    skill: &SkillDef,
    project_id: &str,
    over: Option<&SessionSkillOverride>,
    group_skill_ids: &[String],
) -> SessionSkillState {
    // Step 1, and it is absolute: nothing below can turn a disabled skill on.
    if !skill.enabled {
        return SessionSkillState { on: false, reason: SkillReason::Disabled, overridden: false };
    }
    let in_scope = skill.projects.is_empty()
        || (!project_id.is_empty() && skill.projects.iter().any(|p| p == project_id));
    let via_group = group_skill_ids.iter().any(|g| g == &skill.id);
    let base_on = in_scope || via_group;

    let removed = over.is_some_and(|o| o.remove.iter().any(|r| r == &skill.id));
    let added = over.is_some_and(|o| o.add.iter().any(|a| a == &skill.id));
    // REMOVE beats ADD.
    let on = if removed { false } else if added { true } else { base_on };
    let overridden = on != base_on;

    let reason = if overridden {
        if on { SkillReason::Added } else { SkillReason::Removed }
    } else if on {
        if in_scope {
            if skill.pinned {
                SkillReason::Pinned
            } else if skill.projects.is_empty() {
                SkillReason::Global
            } else {
                SkillReason::Project
            }
        } else {
            SkillReason::Group
        }
    } else {
        SkillReason::OutOfScope
    };
    SessionSkillState { on, reason, overridden }
}

/// The skills written into a session — every library skill whose state is `on`.
pub fn effective_session_skills<'a>(
    all: &'a [SkillDef],
    project_id: &str,
    over: Option<&SessionSkillOverride>,
    group_skill_ids: &[String],
) -> Vec<&'a SkillDef> {
    all.iter()
        .filter(|s| session_skill_state(s, project_id, over, group_skill_ids).on)
        .collect()
}

/// The payloads [`super::skills::write_session_skills`] consumes.
///
/// A skill whose name slugs to EMPTY is dropped: the slug is the directory name, so there is nothing
/// to key `.claude/skills/<slug>/SKILL.md` on. Silently skipping it matches the writer, which skips
/// the same case — doing it here as well keeps the count the caller sees honest.
pub fn to_skill_cfgs(defs: &[&SkillDef]) -> Vec<SkillCfg> {
    defs.iter()
        .filter(|s| !skill_slug(&s.name).is_empty())
        .map(|s| SkillCfg {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.desc.clone(),
            prompt: s.prompt.clone(),
            tools: s.tools.clone(),
        })
        .collect()
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
                } else if p.file_name().and_then(|n| n.to_str()) == Some("skillResolution.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one skillResolution.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn library(doc: &serde_json::Value) -> Vec<SkillDef> {
        serde_json::from_value(doc["library"].clone()).expect("library")
    }

    /// Reports every mismatch at once, per skill per case — a wrong precedence is wrong for a whole
    /// CLASS of skill, and one failing assertion would hide which class.
    #[test]
    fn the_skill_resolution_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let lib = library(&doc);
        assert!(lib.len() >= 8, "library shrank to {} skills", lib.len());
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 10, "fixture shrank to {} cases — regenerate it", cases.len());

        let mut reasons = std::collections::BTreeSet::new();
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let project = case["projectId"].as_str().unwrap();
            let over: Option<SessionSkillOverride> = match &case["override"] {
                serde_json::Value::Null => None,
                v => Some(serde_json::from_value(v.clone()).unwrap()),
            };
            let groups: Vec<String> =
                case["groupIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();

            for want in case["states"].as_array().unwrap() {
                let id = want["id"].as_str().unwrap();
                let skill = lib.iter().find(|s| s.id == id).unwrap();
                let got = session_skill_state(skill, project, over.as_ref(), &groups);
                reasons.insert(want["reason"].as_str().unwrap().to_string());
                if got.on != want["on"].as_bool().unwrap()
                    || got.reason.as_str() != want["reason"].as_str().unwrap()
                    || got.overridden != want["overridden"].as_bool().unwrap()
                {
                    mismatches.push(format!(
                        "  {label} [{id}]\n    ts   on={} reason={} overridden={}\n    rust on={} reason={} overridden={}",
                        want["on"], want["reason"], want["overridden"], got.on, got.reason.as_str(), got.overridden
                    ));
                }
            }

            let eff = effective_session_skills(&lib, project, over.as_ref(), &groups);
            let got_ids: Vec<&str> = eff.iter().map(|s| s.id.as_str()).collect();
            let want_ids: Vec<&str> =
                case["effective"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            if got_ids != want_ids {
                mismatches.push(format!("  {label} [effective]\n    ts   {want_ids:?}\n    rust {got_ids:?}"));
            }

            let got_payload = to_skill_cfgs(&eff);
            let want_payload = case["payload"].as_array().unwrap();
            if got_payload.len() != want_payload.len() {
                mismatches.push(format!(
                    "  {label} [payload] ts={} entries, rust={}",
                    want_payload.len(),
                    got_payload.len()
                ));
            } else {
                for (g, w) in got_payload.iter().zip(want_payload) {
                    if g.id != w["id"].as_str().unwrap()
                        || g.name != w["name"].as_str().unwrap()
                        || g.description != w["description"].as_str().unwrap()
                        || g.prompt != w["prompt"].as_str().unwrap()
                    {
                        mismatches.push(format!("  {label} [payload {}] fields differ", g.id));
                    }
                }
            }
        }
        // The precedence is layered, so a corpus that never reaches a rung proves nothing about it.
        for r in ["disabled", "added", "removed", "pinned", "global", "project", "group", "out-of-scope"] {
            assert!(reasons.contains(r), "the fixture never produced reason {r:?}");
        }
        assert!(
            mismatches.is_empty(),
            "the Rust resolution disagrees with the live TypeScript on {} point(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    fn skill(id: &str, enabled: bool, projects: &[&str], pinned: bool) -> SkillDef {
        SkillDef {
            id: id.into(),
            name: id.into(),
            desc: String::new(),
            prompt: String::new(),
            tools: Vec::new(),
            projects: projects.iter().map(|p| (*p).to_string()).collect(),
            enabled,
            pinned,
        }
    }

    /// THE STEP A PORT LOSES. An override that AGREES with the baseline is not a deviation — the UI
    /// reads this field to mark a session as differing from its project baseline.
    #[test]
    fn a_redundant_override_is_not_flagged_as_a_deviation() {
        let s = skill("g", true, &[], false);
        let add = SessionSkillOverride { add: vec!["g".into()], remove: vec![] };
        let st = session_skill_state(&s, "p", Some(&add), &[]);
        assert!(st.on);
        assert!(!st.overridden, "an add for something already on is redundant, not an override");
        assert_eq!(st.reason, SkillReason::Global, "and its reason is the baseline's, not `added`");

        let out = skill("o", true, &["other"], false);
        let rm = SessionSkillOverride { add: vec![], remove: vec!["o".into()] };
        let st = session_skill_state(&out, "p", Some(&rm), &[]);
        assert!(!st.on);
        assert!(!st.overridden, "a remove for something already off is redundant too");
    }

    /// Step 1 is absolute: nothing turns a disabled skill on.
    #[test]
    fn a_disabled_skill_cannot_be_enabled_by_anything() {
        let d = skill("d", false, &[], true);
        let add = SessionSkillOverride { add: vec!["d".into()], remove: vec![] };
        for (over, groups) in [
            (None, vec![]),
            (Some(&add), vec![]),
            (Some(&add), vec!["d".to_string()]),
        ] {
            let st = session_skill_state(&d, "p", over, &groups);
            assert!(!st.on, "a disabled skill stayed on");
            assert_eq!(st.reason, SkillReason::Disabled);
            assert!(!st.overridden);
        }
    }

    /// REMOVE beats ADD when both name the same skill.
    #[test]
    fn remove_beats_add() {
        let s = skill("g", true, &[], false);
        let both = SessionSkillOverride { add: vec!["g".into()], remove: vec!["g".into()] };
        let st = session_skill_state(&s, "p", Some(&both), &[]);
        assert!(!st.on);
        assert_eq!(st.reason, SkillReason::Removed);
        assert!(st.overridden, "this one IS a deviation — the baseline was on");
    }

    /// An empty project id leaves only globals in scope, and a group can still carry one in.
    #[test]
    fn an_empty_project_id_scopes_to_globals_only() {
        let scoped = skill("s", true, &["studio-code"], false);
        assert!(!session_skill_state(&scoped, "", None, &[]).on, "no project ⇒ a scoped skill is out");
        assert!(session_skill_state(&skill("g", true, &[], false), "", None, &[]).on, "globals stay in");

        let via = session_skill_state(&scoped, "", None, &["s".to_string()]);
        assert!(via.on && via.reason == SkillReason::Group, "a group carries it in regardless");
    }

    /// A name that slugs to nothing is dropped from the PAYLOAD but is still `on` — the two answers
    /// are different questions, and conflating them would under-report what the session has.
    #[test]
    fn an_unslugabble_name_is_on_but_carries_no_payload() {
        let odd = skill("odd", true, &[], false);
        let odd = SkillDef { name: "!!!".into(), ..odd };
        assert!(session_skill_state(&odd, "p", None, &[]).on, "it is still an enabled global skill");
        assert!(to_skill_cfgs(&[&odd]).is_empty(), "but there is no directory to key it on");
        assert!(skill_slug("!!!").is_empty(), "the slug really is empty");
    }
}
