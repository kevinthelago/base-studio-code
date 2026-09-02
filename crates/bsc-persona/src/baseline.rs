//! The role CAPABILITY TABLE projected from the packaged personas, and its frozen baseline.
//!
//! ## Why this module exists — a contract with one signatory
//!
//! `src/shared/lib/session/roleCapabilityBaseline.fixtures.json` is a FROZEN copy of the capability
//! table for every session role: the five access axes plus `writeGlobs`, `surfaces`, `allow` and
//! `harvestRoots`. Its own header explains the job it does:
//!
//! > The table's source inverted. It used to be `data/permissions/role-capabilities.json`, a single
//! > reviewable file whose diff showed every capability change; it is now projected from 18 separate
//! > persona records. That is the right shape — but it costs the property the old file had for free:
//! > a capability change used to be one obvious line in one obvious file, and it is now a field
//! > inside whichever persona happened to be edited.
//!
//! That fixture was read by exactly ONE test, in TypeScript. Meanwhile [`crate::floor`] — in this
//! crate — derives and clamps floors from the same persona records, and its header explains that the
//! clamp is a security boundary precisely because `bsc persona set` is reachable from the mandatory
//! command tier of any session. So the WIDENING the fixture exists to make visible was guarded on
//! the renderer side and unguarded on the side that enforces it.
//!
//! This module is the missing signatory. Nothing here is a second source of truth: the packaged
//! personas remain the only source, and the baseline remains the only frozen record of it. What is
//! added is a Rust-side projection that can be compared against both.
//!
//! ## ⚠️ WHEN THE TEST BELOW FAILS, THE FIXTURE IS NOT AUTOMATICALLY THE THING TO FIX
//!
//! Decide first whether the capability change was intended. Widening a role is the change the
//! baseline exists to make visible, so "update the fixture until it is green" is precisely the move
//! it is there to prevent. This restates the TypeScript's warning deliberately — a reader who hits
//! the Rust failure will not necessarily have read the TypeScript one.

use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// The five access axes, copied verbatim and ALWAYS present in a projected row.
///
/// Same order and meaning as [`crate::floor::AXES`]; restated rather than imported so that a change
/// to the clamp's axis list cannot silently redefine what the frozen baseline is compared on.
pub const AXES: [&str; 5] = ["github", "git", "code", "net", "ui"];

/// Always present in a projected row, defaulting to `[]` when the floor omits it.
pub const ALWAYS_LIST: &str = "writeGlobs";

/// Present in a projected row only when the floor carries a NON-EMPTY value.
///
/// This asymmetry is not a style choice — it is what the captured baseline actually records, derived
/// by comparing all 17 rows against the packaged set rather than assumed. `juror` has no `surfaces`
/// key at all while `worker` has five; had this been guessed as "always present, default `[]`", every
/// role without them would have mismatched.
pub const OPTIONAL_LISTS: [&str; 3] = ["surfaces", "allow", "harvestRoots"];

/// Two personas claiming one role with floors that DISAGREE.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleConflict {
    pub role: String,
    /// The persona ids that collide, sorted — so the message names what to go and look at.
    pub personas: Vec<String>,
}

/// Project one persona `floor` into the row shape the frozen baseline records.
///
/// Returns a JSON object rather than a typed struct ON PURPOSE. A struct would have to enumerate the
/// fields, and a field added to a persona that the struct does not know about would be dropped in
/// silence — which is the failure mode this whole module exists to prevent, wearing the costume of a
/// passing test. [`unknown_floor_keys`] closes the other half: it FAILS when a floor carries
/// something the projection does not understand, rather than quietly ignoring it.
pub fn project_floor(role: &str, floor: &Value) -> Value {
    let mut row = Map::new();
    row.insert("role".into(), Value::String(role.to_string()));
    for axis in AXES {
        row.insert(axis.into(), floor.get(axis).cloned().unwrap_or(Value::Null));
    }
    row.insert(
        ALWAYS_LIST.into(),
        floor.get(ALWAYS_LIST).cloned().unwrap_or_else(|| Value::Array(Vec::new())),
    );
    for key in OPTIONAL_LISTS {
        match floor.get(key) {
            Some(v) if !is_empty_list(v) => {
                row.insert(key.into(), v.clone());
            }
            _ => {}
        }
    }
    Value::Object(row)
}

fn is_empty_list(v: &Value) -> bool {
    v.as_array().is_some_and(|a| a.is_empty())
}

/// Every floor key this projection does not account for.
///
/// THE ANTI-LOSSY GUARD. Add a capability field to a persona and forget the baseline, and without
/// this the projection would drop it and every comparison would still be green — a strictly weaker
/// table, guarded by a test that reports success.
pub fn unknown_floor_keys(floor: &Value) -> Vec<String> {
    let Some(obj) = floor.as_object() else { return Vec::new() };
    obj.keys()
        .filter(|k| {
            k.as_str() != ALWAYS_LIST
                && !AXES.contains(&k.as_str())
                && !OPTIONAL_LISTS.contains(&k.as_str())
        })
        .cloned()
        .collect()
}

/// Project the packaged personas onto the role capability table.
///
/// `personas` is `(id, definition)`, exactly what [`crate::packaged::packaged_personas`] yields —
/// but taken as an ARGUMENT rather than fetched, because that resolution reads `$BSC_DATA_DIR` and
/// env mutation behaves differently under `cargo test` and `cargo nextest`. A test written against
/// the env passes on the gate and races locally; this one takes an explicit path instead.
///
/// ## The 18 → 17 collapse, and why the conflicts are returned rather than swallowed
///
/// There are 18 packaged personas and 17 roles: `auditor.json` (`persona-auditor`) and `juror.json`
/// (`persona-juror`) BOTH declare `role: "juror"`. Their floors are byte-identical today, so the
/// collapse is well-defined — by luck, not by construction. Edit either one and a role's capability
/// becomes a function of iteration order.
///
/// The TypeScript baseline test cannot see this: it compares the ALREADY-COLLAPSED table, so a
/// duplicate is invisible to it however the floors disagree. Returning conflicts separately is what
/// makes the projection's precondition checkable instead of assumed.
pub fn project_role_capabilities(personas: &[(String, Value)]) -> (BTreeMap<String, Value>, Vec<RoleConflict>) {
    let mut by_role: BTreeMap<String, Vec<(&str, &Value)>> = BTreeMap::new();
    for (id, def) in personas {
        let Some(role) = def.get("role").and_then(Value::as_str) else { continue };
        let Some(floor) = def.get("floor") else { continue };
        by_role.entry(role.to_string()).or_default().push((id.as_str(), floor));
    }

    let mut table = BTreeMap::new();
    let mut conflicts = Vec::new();
    for (role, claimants) in by_role {
        let (_, first) = claimants[0];
        if claimants.iter().any(|(_, floor)| *floor != first) {
            let mut ids: Vec<String> = claimants.iter().map(|(id, _)| id.to_string()).collect();
            ids.sort();
            conflicts.push(RoleConflict { role: role.clone(), personas: ids });
        }
        table.insert(role.clone(), project_floor(&role, first));
    }
    (table, conflicts)
}

/// `none` < `read` < `write`. An unknown string sorts as `none` — the safe direction, matching
/// [`crate::floor`]: an unreadable tier can never be the thing that lets a widening through.
pub fn tier_rank(tier: &Value) -> u8 {
    match tier.as_str() {
        Some("write") => 2,
        Some("read") => 1,
        _ => 0,
    }
}

/// Every `(role, axis)` where `table` grants MORE than `baseline`.
///
/// Stated separately from whole-row equality so a FAILURE READS CORRECTLY. Equality tells you
/// something moved; this tells you it moved in the direction that grants more, which is the half that
/// matters when triaging a red gate under time pressure.
pub fn widenings(table: &BTreeMap<String, Value>, baseline: &BTreeMap<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    for (role, row) in table {
        let Some(base) = baseline.get(role) else { continue };
        for axis in AXES {
            let now = tier_rank(row.get(axis).unwrap_or(&Value::Null));
            let was = tier_rank(base.get(axis).unwrap_or(&Value::Null));
            if now > was {
                out.push(format!(
                    "{role}.{axis}: {} → {}",
                    base.get(axis).and_then(Value::as_str).unwrap_or("none"),
                    row.get(axis).and_then(Value::as_str).unwrap_or("none")
                ));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::{Path, PathBuf};

    /// The repository's OWN packaged persona directory, by explicit path.
    ///
    /// Not `packaged_personas()`, which resolves through `$BSC_DATA_DIR`: this guard is about what
    /// THIS REPOSITORY ships, and a test whose subject depends on process-wide env is exactly the
    /// shape that passes under nextest's per-test processes and races under `cargo test`.
    fn repo_personas() -> Vec<(String, Value)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src-tauri/data/personas");
        let mut out: Vec<(String, Value)> = Vec::new();
        for entry in std::fs::read_dir(&dir).expect("packaged personas dir").flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("readable persona");
            let v: Value = serde_json::from_str(&text).expect("valid persona JSON");
            let id = v["id"].as_str().expect("persona id").to_string();
            out.push((id, v));
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// The frozen baseline, resolved by FILENAME under `src/` — the same rule the tunnel contract and
    /// `workerAutoEnd` use. Renaming the fixture means updating this in lockstep.
    fn baseline() -> BTreeMap<String, Value> {
        fn find(dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str())
                    == Some("roleCapabilityBaseline.fixtures.json")
                {
                    out.push(p);
                }
            }
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one roleCapabilityBaseline.fixtures.json, got {found:?}");
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap();
        doc["roles"]
            .as_object()
            .expect("roles")
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// THE GUARD THIS MODULE EXISTS FOR: the packaged personas still project to exactly the frozen
    /// table, on every role and every field.
    #[test]
    fn the_packaged_personas_project_to_the_frozen_baseline() {
        let (table, _) = project_role_capabilities(&repo_personas());
        let base = baseline();

        // Roles first, as WHOLE ORDERED LISTS — a role added or dropped is a different failure from a
        // role whose capability moved, and it should read as one.
        let got: Vec<&String> = table.keys().collect();
        let want: Vec<&String> = base.keys().collect();
        assert_eq!(got, want, "the set of roles changed");

        for (role, want_row) in &base {
            assert_eq!(
                table.get(role).expect("role present"),
                want_row,
                "`{role}` no longer matches its frozen baseline. DECIDE WHETHER THE CHANGE WAS \
                 INTENDED before touching the fixture — widening a role is the change it exists to \
                 make visible."
            );
        }
    }

    /// The direction that matters, reported on its own so a red gate is triageable at a glance.
    #[test]
    fn no_role_has_been_widened_on_any_access_axis() {
        let (table, _) = project_role_capabilities(&repo_personas());
        let widened = widenings(&table, &baseline());
        assert!(widened.is_empty(), "roles WIDENED against the frozen baseline: {widened:?}");
    }

    /// THE PRECONDITION THE TYPESCRIPT CANNOT CHECK. 18 personas project onto 17 roles because
    /// `persona-auditor` and `persona-juror` both claim `juror`. That is only well-defined while
    /// their floors agree; the TypeScript test compares the collapsed table and cannot see it.
    #[test]
    fn a_role_claimed_by_two_personas_must_have_identical_floors() {
        let personas = repo_personas();
        let (_, conflicts) = project_role_capabilities(&personas);
        assert!(
            conflicts.is_empty(),
            "these roles are claimed by personas whose floors DISAGREE, so the projected capability \
             depends on iteration order: {conflicts:?}"
        );

        // ...and pin that the duplicate is still THERE, so this test cannot quietly become vacuous
        // the way a "no conflicts" assertion does the moment the duplicate is removed.
        let mut roles: Vec<&str> =
            personas.iter().filter_map(|(_, d)| d["role"].as_str()).collect();
        roles.sort();
        let before = roles.len();
        roles.dedup();
        assert_eq!(
            before - roles.len(),
            1,
            "expected exactly one duplicated role (juror, via persona-auditor + persona-juror); if a \
             persona was added or removed, decide whether the collapse is still intended"
        );
    }

    /// A floor field the projection does not understand must FAIL, never be dropped.
    #[test]
    fn no_packaged_floor_carries_a_field_the_projection_ignores() {
        for (id, def) in repo_personas() {
            let Some(floor) = def.get("floor") else { continue };
            let unknown = unknown_floor_keys(floor);
            assert!(
                unknown.is_empty(),
                "`{id}`'s floor carries {unknown:?}, which the projection drops — the frozen \
                 baseline would compare equal while guarding strictly less. Teach `OPTIONAL_LISTS` \
                 (or `AXES`) about it and re-capture the baseline deliberately."
            );
        }
    }

    /// POSITIVE CONTROL for [`unknown_floor_keys`].
    ///
    /// ADDED BECAUSE A BITE PROBE FOUND NO BITE. Disabling the detector entirely — making it always
    /// return an empty list — left the whole suite green, because
    /// `no_packaged_floor_carries_a_field_the_projection_ignores` asserts that a list is EMPTY and a
    /// detector that never detects satisfies that perfectly. An assertion of absence needs a
    /// companion that proves the detector still fires, or it is a claim rather than a guard. The two
    /// sibling absence-assertions in this module already have theirs (`widenings` and the conflict
    /// check); this one did not.
    #[test]
    fn unknown_floor_keys_reports_a_field_the_projection_does_not_model() {
        let floor = json!({"github": "read", "writeGlobs": [], "telepathy": "write"});
        assert_eq!(unknown_floor_keys(&floor), vec!["telepathy".to_string()]);

        // ...and is discriminating rather than merely noisy: every modelled key stays unreported.
        let modelled = json!({
            "github": "read", "git": "read", "code": "none", "net": "none", "ui": "none",
            "writeGlobs": [], "surfaces": [], "allow": [], "harvestRoots": []
        });
        assert!(unknown_floor_keys(&modelled).is_empty(), "a fully modelled floor must be silent");
    }

    #[test]
    fn an_empty_optional_list_is_omitted_and_a_populated_one_is_kept() {
        // Derived from the captured baseline, not assumed: `juror` has no `surfaces` key at all while
        // `worker` has five. Guessing "always present, default []" would have mismatched every role
        // without them.
        let bare = project_floor("juror", &json!({"github":"read","git":"read","code":"none","net":"read","ui":"read","surfaces":[]}));
        assert!(bare.get("surfaces").is_none(), "an empty optional list must be omitted");
        assert_eq!(bare["writeGlobs"], json!([]), "writeGlobs is always present");

        let full = project_floor("worker", &json!({"github":"read","git":"write","code":"write","net":"read","ui":"read","surfaces":["plan"]}));
        assert_eq!(full["surfaces"], json!(["plan"]));
    }

    #[test]
    fn conflicting_floors_for_one_role_are_reported_with_both_persona_ids() {
        let personas = vec![
            ("persona-a".to_string(), json!({"role":"juror","floor":{"github":"read"}})),
            ("persona-b".to_string(), json!({"role":"juror","floor":{"github":"write"}})),
        ];
        let (_, conflicts) = project_role_capabilities(&personas);
        assert_eq!(
            conflicts,
            vec![RoleConflict {
                role: "juror".into(),
                personas: vec!["persona-a".into(), "persona-b".into()]
            }]
        );
    }

    #[test]
    fn identical_floors_for_one_role_are_not_a_conflict() {
        let floor = json!({"github":"read","git":"read"});
        let personas = vec![
            ("persona-a".to_string(), json!({"role":"juror","floor":floor})),
            ("persona-b".to_string(), json!({"role":"juror","floor":floor})),
        ];
        let (table, conflicts) = project_role_capabilities(&personas);
        assert!(conflicts.is_empty());
        assert_eq!(table.len(), 1, "the two collapse onto one role");
    }

    #[test]
    fn a_widening_is_detected_on_every_axis_and_a_narrowing_is_not() {
        let base: BTreeMap<String, Value> =
            [("worker".to_string(), json!({"github":"read","git":"read","code":"read","net":"read","ui":"read"}))]
                .into_iter()
                .collect();
        for axis in AXES {
            let mut row = json!({"github":"read","git":"read","code":"read","net":"read","ui":"read"});
            row[axis] = json!("write");
            let table: BTreeMap<String, Value> = [("worker".to_string(), row)].into_iter().collect();
            let w = widenings(&table, &base);
            assert_eq!(w.len(), 1, "a widening on {axis} must be reported");
            assert!(w[0].contains(axis), "{w:?} should name {axis}");
        }
        // Narrowing is always allowed — the floor's whole rule is narrow-only.
        let narrowed: BTreeMap<String, Value> =
            [("worker".to_string(), json!({"github":"none","git":"none","code":"none","net":"none","ui":"none"}))]
                .into_iter()
                .collect();
        assert!(widenings(&narrowed, &base).is_empty());
    }

    #[test]
    fn an_unknown_tier_string_sorts_as_none_so_it_can_never_authorise_a_widening() {
        assert_eq!(tier_rank(&json!("write")), 2);
        assert_eq!(tier_rank(&json!("read")), 1);
        assert_eq!(tier_rank(&json!("none")), 0);
        assert_eq!(tier_rank(&json!("superuser")), 0, "an unrecognised tier must not outrank write");
        assert_eq!(tier_rank(&Value::Null), 0);
    }
}
