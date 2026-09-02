//! Which skills a session receives.
//!
//! # Rust owned everything around this decision and not the decision
//!
//! `crates/skilldb` IS the skills store and `bsc skill` its CLI;
//! `extensions::skills::write_session_skills` (still app-owned) writes the resolved list into
//! `.claude/skills`, taking an
//! already-chosen set. So the backend owned the store, owned the write, and could not answer "which".
//!
//! The cost of that split is recorded in the tree, though NARROWER than it was first written down as.
//! `ensure_session_settings` is indeed the only writer of `.claude/skills`, but the renderer calls it
//! on `launchesClaude || paneNeedsGate(paneId)`, and `paneNeedsGate` is harness-INDEPENDENT — true for
//! any `<a>:<b>` id that is not `man:`. So a bsc-agent FLEET pane already gets its skills written, and
//! `bsc-agent` already reads them: `compose_skills_from` falls back to scanning
//! `<cwd>/.claude/skills` whenever `$BSC_AGENT_SKILLS` is unset, which is always, since nothing in the
//! app sets it.
//!
//! What was genuinely receiving nothing is a bsc-agent MANUAL console (`man:`), where both arms of
//! that condition are false. Measured 2026-09-01 while wiring this; the original claim of "no skills
//! at all" is corrected on
//! `the-launch-resolves-its-own-skills-instead-of-receiving-them`. A caged session has a separate
//! problem of the same shape — it reads from a directory nothing wrote — filed as
//! `a-caged-session-reads-its-skills-from-a-directory-nothing-wrote`.
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

use crate::cfg::SkillCfg;
use std::path::Path;

/// Slug a skill name: lowercase, keep `[a-z0-9-]`, collapse any run of other chars to a single `-`,
/// and trim leading/trailing `-`. May return empty.
///
/// LIVES HERE, and `extensions::skills` re-exports it, because the resolution and the WRITER must
/// agree: this is the directory name `.claude/skills/<slug>/SKILL.md` is keyed on, so two copies
/// drifting would mean the resolution counting a skill the writer then dropped.
pub fn skill_slug(name: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() || c == '-' {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(c);
        } else {
            pending_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

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
    /// The wire spelling, and the ONLY caller is the parity test — which is the right caller: it is
    /// how this port's reason is compared against the TypeScript's string, case by case. Clippy sees
    /// no non-test use and calls it dead; deleting it would delete that comparison, and the reason is
    /// a layered precedence chain where a rung nothing checks is a rung that can silently rot.
    #[cfg_attr(not(test), allow(dead_code))]
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

/// The payloads `extensions::skills::write_session_skills` consumes.
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


/// The library, read from the store Rust already owns.
///
/// `crates/skilldb` IS the skills library — `bsc skill` is its CLI and
/// `extensions::skills::record_skill_uses` already opens it — so the resolution needs no
/// library on the wire, only the per-session facts the renderer holds. A missing or unreadable store
/// yields an EMPTY library, which resolves to no skills and lets the frontend's list stand; the
/// alternative (failing the launch) would make an unreadable `skills.db` fatal to every session.
pub fn library(path: &Path) -> Vec<SkillDef> {
    if !path.exists() {
        return Vec::new();
    }
    match skilldb::Store::open(path).and_then(|s| s.list()) {
        Ok(skills) => skills
            .into_iter()
            .map(|s| SkillDef {
                id: s.id,
                name: s.name,
                desc: s.desc,
                prompt: s.prompt,
                tools: s.tools,
                projects: s.projects,
                enabled: s.enabled,
                pinned: s.pinned,
            })
            .collect(),
        Err(e) => {
            log::warn!("skill resolution: reading the library failed ({e}) — resolving none");
            Vec::new()
        }
    }
}

/// Expand toggled-on skill GROUPS into the skill ids they carry.
///
/// Also read from the store rather than passed in: a group's membership is store state, and the
/// renderer holds only which groups are toggled ON for this session, which is the fact.
pub fn group_skill_ids(path: &Path, group_ids: &[String]) -> Vec<String> {
    if group_ids.is_empty() {
        return Vec::new();
    }
    if !path.exists() {
        return Vec::new();
    }
    let Ok(store) = skilldb::Store::open(path) else { return Vec::new() };
    let Ok(groups) = store.group_list() else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for g in groups.into_iter().filter(|g| group_ids.iter().any(|id| id == &g.id)) {
        for sid in g.skill_ids {
            if !out.contains(&sid) {
                out.push(sid);
            }
        }
    }
    out
}

/// What the launch will write, and what the resolution and the renderer disagreed on.
// `Clone` only: `SkillCfg` is a wire type with neither `Debug` nor `PartialEq`, and deriving them on
// it to satisfy a report struct would widen a payload type for a test's convenience. The two report
// lists are plain `String`s, which is what any assertion actually wants to read.
#[derive(Clone)]
pub struct SkillReconciliation {
    pub merged: Vec<SkillCfg>,
    /// Skills the RESOLUTION produced that the frontend omitted — added. On a Claude pane this is a
    /// defect; on a pane the frontend never resolved for, it is the fix landing. The caller knows
    /// which it is looking at and the log says so.
    pub added: Vec<String>,
    /// Skills the FRONTEND sent that the resolution did not produce — kept, and a defect either way.
    pub missing_from_resolution: Vec<String>,
}

/// Reconcile the resolved skills against the list the renderer sent.
///
/// # A union, and the two directions mean different things here
///
/// Everywhere else in this cutover "the frontend has extra" is expected and says nothing. Here it is
/// a DEFECT: both sides resolve from the same library against the same session, so neither has a
/// legitimate extra. The list is unioned rather than replaced anyway — a skill dropped in the cutover
/// is a session quietly missing instructions it was configured to have, and nothing downstream
/// notices a prompt that is merely shorter.
///
/// The other direction is where this flip differs from its siblings: a skill the RESOLUTION produced
/// and the frontend omitted is expected for a pane the renderer never resolved for at all, and is the
/// whole point of doing this. The caller distinguishes the two cases; this function only reports them.
///
/// Matched by NAME rather than id, because the name is what `write_session_skills` slugs into the
/// directory — two entries with different ids and the same name would collide on disk, so the name is
/// the identity that matters downstream.
pub fn reconcile_session_skills(
    from_frontend: Vec<SkillCfg>,
    resolved: Vec<SkillCfg>,
) -> SkillReconciliation {
    let added: Vec<SkillCfg> = resolved
        .iter()
        .filter(|r| !from_frontend.iter().any(|f| f.name == r.name))
        .cloned()
        .collect();
    let missing_from_resolution: Vec<String> = from_frontend
        .iter()
        .filter(|f| !resolved.iter().any(|r| r.name == f.name))
        .map(|f| f.name.clone())
        .collect();
    let added_names = added.iter().map(|s| s.name.clone()).collect();
    let mut merged = from_frontend;
    merged.extend(added);
    SkillReconciliation { merged, added: added_names, missing_from_resolution }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(name: &str) -> SkillCfg {
        SkillCfg {
            id: format!("id-{name}"),
            name: name.to_string(),
            description: String::new(),
            prompt: String::new(),
            tools: vec![],
        }
    }

    /// THE FIX LANDING: a pane the renderer never resolved for sends nothing, and the resolution
    /// supplies the set. This is the direction that is EXPECTED here and is a defect nowhere else in
    /// the cutover, which is why the two are reported separately rather than as one "difference".
    #[test]
    fn a_skill_the_resolution_produced_and_the_frontend_omitted_is_added() {
        let r = reconcile_session_skills(vec![], vec![cfg("review"), cfg("deploy")]);
        assert_eq!(r.merged.len(), 2, "the session gets the resolved set");
        assert_eq!(r.added, vec!["review".to_string(), "deploy".to_string()]);
        assert!(r.missing_from_resolution.is_empty());
    }

    /// THE DEFECT DIRECTION, which here is BOTH directions being meaningful: both sides resolve from
    /// the same library against the same session, so a skill only the frontend has is a disagreement
    /// rather than a legitimate extra. It is KEPT regardless — a dropped skill is a session quietly
    /// missing instructions, and nothing downstream notices a shorter prompt.
    #[test]
    fn a_skill_only_the_frontend_has_is_kept_and_reported() {
        let r = reconcile_session_skills(vec![cfg("review")], vec![]);
        assert_eq!(r.merged.len(), 1, "never dropped");
        assert_eq!(r.missing_from_resolution, vec!["review".to_string()]);
        assert!(r.added.is_empty());
    }

    /// Agreement is silent and changes nothing — the property that makes this safe on a Claude pane,
    /// where the flip must be behaviour-preserving.
    #[test]
    fn agreement_adds_nothing_and_reports_nothing() {
        let both = vec![cfg("review"), cfg("deploy")];
        let r = reconcile_session_skills(both.clone(), both);
        assert_eq!(r.merged.len(), 2);
        assert!(r.added.is_empty() && r.missing_from_resolution.is_empty());
    }

    /// MATCHED BY NAME, not id. The name is what `write_session_skills` slugs into the directory, so
    /// two entries with different ids and the same name collide on disk — the name is the identity
    /// that matters downstream, and matching on id would duplicate the directory instead of merging.
    #[test]
    fn matching_is_by_name_because_the_name_is_what_becomes_the_directory() {
        let front = vec![SkillCfg { id: "old-id".into(), ..cfg("review") }];
        let resolved = vec![SkillCfg { id: "new-id".into(), ..cfg("review") }];
        let r = reconcile_session_skills(front, resolved);
        assert_eq!(r.merged.len(), 1, "one directory, not two: {:?}", r.added);
        assert!(r.added.is_empty() && r.missing_from_resolution.is_empty());
    }

    // ── GATHERING, which only became testable when this left the app ────────────────────────────
    //
    // While `library()` called `crate::skills_db()` there was no way to point it at a store, so its
    // degradation path — the one the whole launch depends on being SAFE — was asserted nowhere. It
    // takes an explicit path now, so both directions can be pinned. Explicit path, never an env var:
    // env mutation behaves differently under `cargo test` (threads sharing one process) and
    // `cargo nextest` (a process per test), so an env-based fixture passes on the gate and races
    // locally, on exactly the code that decides what a session may do.
    //
    // NOTE the shadowing, because it produced three confusing type errors: this module defines its
    // own `library(&serde_json::Value)` helper for the parity fixture, and `use super::*` means a
    // bare `library(...)` resolves to THAT, not to the module's `library(&Path)`. These tests
    // therefore say `super::library` on purpose.

    /// A unique on-disk store for one test. No env, no shared location.
    fn scratch_db(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bsc-resolve-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir.join("skills.db")
    }

    /// The ids this module seeds, so an assertion can be scoped to them over the packaged baseline.
    const SEEDED: [&str; 4] = ["glob", "scoped", "off", "grouped"];

    fn seed(path: &std::path::Path) -> skilldb::Store {
        let store = skilldb::Store::open(path).expect("store opens");
        for (id, name, projects, enabled) in [
            ("glob", "Global One", vec![], true),
            ("scoped", "Scoped One", vec!["proj-a".to_string()], true),
            ("off", "Disabled One", vec![], false),
            ("grouped", "Grouped One", vec!["other".to_string()], true),
        ] {
            store
                .upsert(&skilldb::Skill {
                    id: id.into(),
                    name: name.into(),
                    projects,
                    enabled,
                    ..Default::default()
                })
                .expect("upsert");
        }
        store
            .group_add(&skilldb::SkillGroup {
                id: "g1".into(),
                name: "G1".into(),
                skill_ids: vec!["grouped".into()],
                ..Default::default()
            })
            .expect("group");
        store
    }

    /// THE DEGRADATION THE LAUNCH RIDES ON. An absent or unreadable store resolves to NO skills, and
    /// that is only safe because the caller UNIONS with what the renderer sent. Pinned so a future
    /// change cannot quietly make it fatal, nor quietly make it silent on a store that IS there.
    #[test]
    fn an_absent_store_degrades_to_an_empty_library_rather_than_failing() {
        let missing = scratch_db("absent");
        assert!(!missing.exists());
        assert!(super::library(&missing).is_empty(), "absent must degrade, not panic");
        assert!(group_skill_ids(&missing, &["g1".to_string()]).is_empty());
    }

    /// A FRESH ON-DISK STORE IS NOT EMPTY, which cost a red test to learn: `Store::open` seeds the
    /// PACKAGED skill set into an empty db (#1715), and only `open_in_memory` gives a blank one.
    /// `library` takes a path, so these tests cannot use the in-memory door and must assert about
    /// their OWN ids over that baseline rather than about totals. That is also the honest shape —
    /// a real caller sees the packaged skills too.
    #[test]
    fn the_library_and_its_groups_are_read_from_the_store_at_the_given_path() {
        let db = scratch_db("read");
        let _store = seed(&db);
        let lib = super::library(&db);
        let mine: Vec<&str> =
            lib.iter().map(|s| s.id.as_str()).filter(|id| SEEDED.contains(id)).collect();
        assert_eq!(mine.len(), 4, "every seeded row is read, disabled included: {mine:?}");
        assert!(lib.len() > 4, "and the packaged set is there too — open() seeds it");
        assert_eq!(group_skill_ids(&db, &["g1".to_string()]), vec!["grouped".to_string()]);
        // An unrelated group id expands to nothing rather than to everything.
        assert!(group_skill_ids(&db, &["nope".to_string()]).is_empty());
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

    /// The precedence chain end-to-end over a REAL store, which is what the CLI does. The outcomes
    /// have to DIFFER from each other, or the resolution is not discriminating and a count would
    /// hide it — the live library has no project-scoped skills, so only a seeded store can show this.
    #[test]
    fn resolution_over_a_real_store_discriminates_by_project_and_group() {
        let db = scratch_db("resolve");
        let _store = seed(&db);
        let lib = super::library(&db);
        // Only OUR ids: `Store::open` seeds the packaged library, which is real but is not what
        // this test is about.
        let ids = |v: Vec<&SkillDef>| {
            let mut n: Vec<String> = v
                .into_iter()
                .map(|s| s.id.clone())
                .filter(|id| SEEDED.contains(&id.as_str()))
                .collect();
            n.sort();
            n
        };
        // No project: globals only. `scoped` and `grouped` are out of scope, `off` is disabled.
        assert_eq!(ids(effective_session_skills(&lib, "", None, &[])), vec!["glob"]);
        // In its project: the scoped one joins.
        assert_eq!(ids(effective_session_skills(&lib, "proj-a", None, &[])), vec!["glob", "scoped"]);
        // A toggled-on GROUP carries a skill that is out of scope for this project.
        let groups = group_skill_ids(&db, &["g1".to_string()]);
        assert_eq!(
            ids(effective_session_skills(&lib, "proj-a", None, &groups)),
            vec!["glob", "grouped", "scoped"]
        );
        // ...and nothing turns the DISABLED one on, not even an explicit add.
        let force = SessionSkillOverride { add: vec!["off".into()], remove: vec![] };
        assert!(
            !ids(effective_session_skills(&lib, "proj-a", Some(&force), &groups)).contains(&"off".to_string()),
            "a disabled skill must stay off however it is forced"
        );
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

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
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
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
