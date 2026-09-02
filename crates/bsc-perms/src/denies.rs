//! The session's denied Bash command patterns, composed in Rust.
//!
//! # Why this one is the sharp end
//!
//! This list feeds two places: the `permissions.deny` rules in `settings.json`, and the
//! `$BSC_DENY_BASH` env the `bsc-deny` PreToolUse hook reads. Under the BYPASS posture
//! `permissions.deny` is IGNORED — so on exactly the sessions that auto-run everything, the hook
//! reading this env is the only thing left refusing a denied command.
//!
//! And Rust already owns that half. `crates/bsc-hook/src/main.rs` and `crates/bsc/src/hook.rs` read
//! `$BSC_DENY_BASH` and BLOCK on it; `console/pty` copies the string into the child env. What Rust
//! could not do is COMPUTE it — a grep for any Rust function composing these patterns returned
//! nothing. The backend enforced, on every tool call, a policy decided in a renderer.
//!
//! # The composition
//!
//! Three sources, in order, and the order is preserved because it is what the fixture pins:
//!
//! 1. The user's own global denies. These are NEVER filtered by the flow — a user who denies
//!    `git push` keeps it denied even on an `auto-pr` worker. Only the ROLE's denies are liftable.
//! 2. The role's denies ([`super::role_gate::role_denied_commands`]) MINUS the pushes the pane's flow
//!    grants back (#304).
//! 3. The profile's denies — which are always empty today; see [`session_denied_commands`].
//!
//! Nothing is de-duplicated across the three, matching the source: a pattern named by two sources
//! appears twice, and since these are matched rather than counted that is harmless.

use crate::role_gate::{role_denied_commands, RoleCapability};

/// One row of `bsc surface list --json`, pared to what this reads. An ABSENT `status` means active —
/// the catalog omits the field for the common case.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SurfaceRow {
    pub name: String,
    #[serde(default)]
    pub status: Option<String>,
}

/// The pushes a flow grants back, by its `push` value. `None` is an absent flow, which resolves to
/// [`DEFAULT_FLOW_PUSH`].
const GRANTING_PUSHES: &[&str] = &["auto-pr", "push-confirm"];

/// The push policy an absent flow resolves to.
///
/// LOAD-BEARING, and it used to be `auto-pr`. This is the fallback for a stream carrying no flow at
/// all — a launch that never went near the strategy layer — so with `auto-pr` a fleet launched on
/// untouched defaults pushed branches and opened PRs regardless of intent. A port that defaults wrong
/// re-introduces exactly that, silently, on the launches least likely to be watched.
pub const DEFAULT_FLOW_PUSH: &str = "local";

/// Surface names a persona's declaration can deny — the complement of what a role declares becomes
/// `bsc <name>` denies.
///
/// ACTIVE **or DEPRECATED**, and the deprecated half is a security decision rather than tidiness: a
/// deprecated alias serves the SAME STORE as its live surface (`bsc org` → the teams store), so leaving
/// it out of the complement would keep a side door open into a store the declaration closed.
///
/// INTERNAL rows are in neither list, and must not be. `bsc hook` is invoked by the PreToolUse
/// mechanism itself and `bsc serve` by the warm-serve path — denying them would break the machinery
/// that enforces every other deny, which is a self-inflicted outage rather than a restriction.
pub fn deniable_surface_names(rows: &[SurfaceRow]) -> Vec<String> {
    rows.iter()
        .filter(|r| {
            let active = r.status.as_deref().map(|s| s == "active").unwrap_or(true);
            active || r.status.as_deref() == Some("deprecated")
        })
        .map(|r| r.name.clone())
        .collect()
}

/// Command prefixes the pane's FLOW grants back (#304).
///
/// The role gate's broader gh/git-write denies are lifted for exactly these two so the flow's GitHub
/// intent wins: a `worker` is `github: read` and so denies `gh pr create`, but an `auto-pr` /
/// `push-confirm` flow needs it to open its own PR. Everything else the role denies — `gh pr merge`,
/// repo deletion, issue mutations — stays denied. `commit-only` / `none` / `local` grant nothing, which
/// is consistent: all three block push.
///
/// An UNRECOGNISED push value grants nothing, matching the source, where `resolveFlow` passes the value
/// through unchanged and the comparison simply fails. Failing closed is also the right direction.
pub fn flow_granted_push_commands(push: Option<&str>) -> Vec<String> {
    let push = push.unwrap_or(DEFAULT_FLOW_PUSH);
    if GRANTING_PUSHES.contains(&push) {
        vec!["git push".to_string(), "gh pr create".to_string()]
    } else {
        Vec::new()
    }
}

/// Compose the session's denied Bash command patterns.
///
/// `deniable_surfaces` is [`deniable_surface_names`] over the surface catalog. An EMPTY catalog denies
/// nothing extra BY DESIGN — a launch that races the catalog poll (or one where it failed) must not
/// lose its whole CLI, so the complement of an empty set is empty rather than everything.
///
/// `profile_denies` comes from [`super::profile_settings::resolve_profile_settings`] and is ALWAYS
/// EMPTY today: a profile deliberately supplies no command denies, because the role gate is what
/// claims that field and the two must not both claim it. It is threaded through rather than dropped so
/// the composition still reads as the three sources it is, and
/// `the_profile_contributes_no_command_denies` pins the invariant.
pub fn session_denied_commands(
    user_denies: &[String],
    cap: Option<&RoleCapability>,
    deniable_surfaces: &[String],
    flow_push: Option<&str>,
    profile_denies: &[String],
) -> Vec<String> {
    let granted = flow_granted_push_commands(flow_push);
    let role: Vec<String> = cap
        .map(|c| role_denied_commands(c, deniable_surfaces))
        .unwrap_or_default()
        .into_iter()
        .filter(|d| !granted.contains(d))
        .collect();

    let mut out = Vec::with_capacity(user_denies.len() + role.len() + profile_denies.len());
    out.extend(user_denies.iter().cloned());
    out.extend(role);
    out.extend(profile_denies.iter().cloned());
    out
}


/// The denies to write, and what the composition found the renderer had omitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDenyReconciliation {
    /// What to write. Never shorter than what the renderer sent.
    pub merged: Vec<String>,
    /// Patterns Rust composed that the frontend omitted — appended, and the one direction that is a
    /// defect. "The frontend has extra" is expected: the user's own denylist rides in the same list.
    pub missing: Vec<String>,
}

/// Reconcile the composed denies against the list the renderer sent.
///
/// # Union, and it can only ever ADD
///
/// This list is what the `bsc-deny` PreToolUse hook enforces through `$BSC_DENY_BASH`, and under the
/// BYPASS posture that hook is the ONLY enforcement — `permissions.deny` is ignored there entirely. So
/// a deny lost in this cutover is not a degraded setting; it is a command that now runs on a session
/// that auto-runs everything. Taking the composed list alone would be able to drop one the frontend
/// had; a union cannot.
///
/// # The frontend's ORDER survives, and that is deliberate
///
/// The composition's own order is user → role-minus-grants → profile, which the parity fixture pins.
/// But these patterns are MATCHED, never counted or indexed, so order carries no meaning at the
/// enforcing end — while a reordered list makes every future diff of a security-relevant value noisy
/// for no gain. So the received list keeps its positions and anything missing is appended.
///
/// # Nothing is de-duplicated across the sources
///
/// Matching the composition it reconciles against: a pattern named by two sources appears twice there,
/// and since these are matched rather than counted that is harmless. What IS avoided is appending a
/// pattern the frontend already sent, which would grow the list on every launch.
pub fn reconcile_session_denies(
    from_frontend: Vec<String>,
    user_denies: &[String],
    cap: Option<&RoleCapability>,
    deniable_surfaces: &[String],
    flow_push: Option<&str>,
    profile_denies: &[String],
) -> SessionDenyReconciliation {
    let derived =
        session_denied_commands(user_denies, cap, deniable_surfaces, flow_push, profile_denies);
    let missing: Vec<String> = derived
        .into_iter()
        .filter(|d| !from_frontend.iter().any(|f| f == d))
        .collect();
    let mut merged = from_frontend;
    merged.extend(missing.iter().cloned());
    SessionDenyReconciliation { merged, missing }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker_cap() -> RoleCapability {
        RoleCapability {
            role: "worker".into(),
            github: super::super::role_gate::Tier::Read,
            git: super::super::role_gate::Tier::Write,
            code: super::super::role_gate::Tier::Write,
            net: super::super::role_gate::Tier::Read,
            ui: super::super::role_gate::Tier::Read,
            write_globs: vec!["src/**".into()],
            allow: vec![],
            surfaces: None,
            harvest_roots: Vec::new(),
        }
    }

    /// The cutover can only ever STRENGTHEN the gate. Taking the composed list alone could drop a deny
    /// the frontend had; a union cannot. (Ported from `reconcile_role_denies`, which this supersedes.)
    #[test]
    fn reconciling_unions_rather_than_replaces() {
        let cap = worker_cap();
        // The frontend's list legitimately carries the user's own denies too — here one Rust is not
        // told about, since `user_denies` is empty.
        let from_frontend = vec!["curl".to_string(), "gh pr merge".to_string()];
        let r = reconcile_session_denies(from_frontend, &[], Some(&cap), &[], None, &[]);
        assert!(r.merged.iter().any(|d| d == "curl"), "a user deny Rust knows nothing about survives");
        assert_eq!(
            r.merged.iter().filter(|d| *d == "gh pr merge").count(),
            1,
            "one both sides derived is not appended twice"
        );
        assert!(!r.missing.iter().any(|d| d == "curl"), "extra on the frontend side is NOT a defect");
    }

    /// The direction that matters: Rust composed a deny the frontend omitted — a hole in the gate, and
    /// under the bypass posture a hole in the ONLY enforcement.
    #[test]
    fn a_deny_the_frontend_omitted_is_reported_and_added() {
        let cap = worker_cap();
        let r = reconcile_session_denies(vec![], &[], Some(&cap), &[], None, &[]);
        assert!(!r.missing.is_empty(), "an empty frontend list means it omitted every role deny");
        assert!(
            r.missing.iter().any(|d| d == "bsc request"),
            "including the tooling-queue deny: {:?}",
            r.missing
        );
        for d in &r.missing {
            assert!(r.merged.contains(d), "everything missing is added to what gets written");
        }
    }

    /// A role-less ad-hoc console with no user denies composes nothing and must not be second-guessed.
    #[test]
    fn nothing_to_compose_means_nothing_to_reconcile() {
        let given = vec!["curl".to_string()];
        let r = reconcile_session_denies(given.clone(), &[], None, &[], None, &[]);
        assert_eq!(r.merged, given);
        assert!(r.missing.is_empty());
    }

    /// THE FLOW GRANT SURVIVES THE COMPOSITION, which is the property that made the wire item unsafe
    /// to land without it: the composed list must not re-deny what #304 lifted.
    #[test]
    fn the_flow_grant_is_never_composed_back_in() {
        let cap = worker_cap();
        let r = reconcile_session_denies(vec![], &[], Some(&cap), &[], Some("auto-pr"), &[]);
        assert!(!r.missing.iter().any(|d| d == "gh pr create"), "{:?}", r.missing);
        // …and only because of the flow: the same call with the default policy denies it.
        let r = reconcile_session_denies(vec![], &[], Some(&cap), &[], None, &[]);
        assert!(r.missing.iter().any(|d| d == "gh pr create"));
    }

    /// The frontend's ORDER survives — a reordered security-relevant list makes every future diff
    /// noisy, and these patterns are matched rather than indexed, so nothing is bought by reordering.
    #[test]
    fn the_received_order_is_preserved_and_missing_values_append() {
        let cap = worker_cap();
        let from_frontend = vec!["zzz-user-deny".to_string(), "curl".to_string()];
        let r = reconcile_session_denies(from_frontend.clone(), &[], Some(&cap), &[], None, &[]);
        assert_eq!(&r.merged[..2], &from_frontend[..], "the received list keeps its positions");
        assert_eq!(&r.merged[2..], &r.missing[..], "and the composed remainder is appended");
    }


    fn fixture() -> serde_json::Value {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("sessionDenies.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one sessionDenies.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn strings(v: &serde_json::Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    /// The whole composition, case by case. Reports every mismatch at once — a wrong port is usually
    /// wrong in a pattern.
    #[test]
    fn the_composition_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 15, "fixture shrank to {} cases — regenerate it", cases.len());

        let mut mismatches = Vec::new();
        let mut gated = 0usize;
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let cap: Option<RoleCapability> = match &case["capability"] {
                serde_json::Value::Null => None,
                v => Some(
                    serde_json::from_value(v.clone())
                        .unwrap_or_else(|e| panic!("{label}: capability did not deserialize: {e}")),
                ),
            };
            if cap.is_some() {
                gated += 1;
            }
            let rows: Vec<SurfaceRow> = match &case["surfaceCatalog"] {
                serde_json::Value::Null => Vec::new(),
                v => serde_json::from_value(v.clone()).unwrap(),
            };
            let surfaces = deniable_surface_names(&rows);
            let got = session_denied_commands(
                &strings(&case["userDenies"]),
                cap.as_ref(),
                &surfaces,
                case["flowPush"].as_str(),
                &[],
            );
            let want = strings(&case["denied"]);
            if got != want {
                let missing: Vec<_> = want.iter().filter(|w| !got.contains(w)).collect();
                let extra: Vec<_> = got.iter().filter(|g| !want.contains(g)).collect();
                mismatches.push(format!("  {label}\n    missing {missing:?}\n    extra   {extra:?}"));
            }
        }
        assert!(gated >= 10, "only {gated} cases carried a capability — the role half would be untested");
        assert!(
            mismatches.is_empty(),
            "the Rust composition disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }

    /// The surface filter, over every status shape the catalog produces.
    #[test]
    fn the_deniable_surface_filter_matches_case_for_case() {
        let doc = fixture();
        let entries = doc["deniableSurfaces"].as_array().expect("deniableSurfaces");
        assert!(entries.len() >= 5);
        for e in entries {
            let label = e["label"].as_str().unwrap();
            let rows: Vec<SurfaceRow> = match &e["rows"] {
                serde_json::Value::Null => Vec::new(),
                v => serde_json::from_value(v.clone()).unwrap(),
            };
            assert_eq!(deniable_surface_names(&rows), strings(&e["names"]), "{label}");
        }
    }

    /// Every flow push value, so the default and the two granting values are all pinned.
    #[test]
    fn the_flow_grants_match_case_for_case() {
        let doc = fixture();
        let entries = doc["flowGrants"].as_array().expect("flowGrants");
        assert!(entries.len() >= 6);
        for e in entries {
            let label = e["label"].as_str().unwrap();
            let push = e["flow"].get("push").and_then(|v| v.as_str());
            assert_eq!(flow_granted_push_commands(push), strings(&e["granted"]), "{label}");
        }
    }

    /// #304, stated directly: the flow lifts EXACTLY the two pushes from the ROLE's denies, and the
    /// user's own denies are untouchable by it.
    #[test]
    fn a_flow_lifts_role_denies_but_never_the_users_own() {
        let doc = fixture();
        let cases = doc["cases"].as_array().unwrap();
        let find = |l: &str| cases.iter().find(|c| c["label"].as_str().unwrap().starts_with(l)).unwrap();

        let plain = strings(&find("a worker role with the catalog")["denied"]);
        let autopr = strings(&find("worker + auto-pr flow")["denied"]);
        let lifted: Vec<_> = plain.iter().filter(|d| !autopr.contains(d)).cloned().collect();
        assert_eq!(
            lifted,
            vec!["gh pr create"],
            "a worker is git:write, so `git push` was never role-denied — only `gh pr create` is lifted"
        );

        // The user's own `git push` deny survives an auto-pr flow.
        let user = find("user denies come FIRST");
        let denied = strings(&user["denied"]);
        assert_eq!(denied.first().map(String::as_str), Some("git push"), "user denies come first");
        assert!(
            session_denied_commands(&["git push".to_string()], None, &[], Some("auto-pr"), &[])
                .contains(&"git push".to_string()),
            "a flow must never lift a deny the USER set"
        );
    }

    /// An empty or absent catalog denies nothing EXTRA — a launch racing the poll must keep its CLI.
    #[test]
    fn an_empty_catalog_denies_nothing_extra_rather_than_everything() {
        let doc = fixture();
        let cases = doc["cases"].as_array().unwrap();
        let empty = cases.iter().find(|c| c["label"].as_str().unwrap().starts_with("a worker role, empty catalog")).unwrap();
        let full = cases.iter().find(|c| c["label"].as_str().unwrap().starts_with("a worker role with the catalog")).unwrap();
        let (e, f) = (strings(&empty["denied"]), strings(&full["denied"]));
        assert!(e.len() < f.len(), "the catalog must ADD denies, so the empty case is the smaller one");
        // NOT "no `bsc ` denies" — a role denies specific verbs intrinsically (`bsc ui set`,
        // `bsc request`, `bsc persona set`) whether or not a catalog exists. What the catalog adds is
        // the COMPLEMENT: a bare `bsc <surface>` for each catalog surface the role did not declare.
        for surface in ["bsc plan", "bsc skill", "bsc org"] {
            assert!(!e.contains(&surface.to_string()), "{surface} appeared with no catalog: {e:?}");
        }
        assert!(f.iter().any(|d| d == "bsc org"), "a DEPRECATED surface is deniable: {f:?}");
        assert!(!f.iter().any(|d| d == "bsc hook"), "an INTERNAL surface must never be denied: {f:?}");
    }

    /// The profile supplies NO command denies. Pinned so the invariant that the role gate alone claims
    /// this field cannot break silently — if a profile ever starts contributing, two sources are
    /// claiming one field and the reconciliation question has to be answered deliberately.
    #[test]
    fn the_profile_contributes_no_command_denies() {
        use crate::profile_settings::{resolve_profile_settings, AgentProfile};
        let profile: AgentProfile = serde_json::from_value(serde_json::json!({
            "id": "pf_x", "mode": "deny", "commands": ["git status"],
            "tools": { "bash": "deny", "read": "deny" },
            "paths": { "allow": [], "deny": ["**/*.env"] }
        }))
        .unwrap();
        assert!(
            resolve_profile_settings(&profile).denied_commands.is_empty(),
            "a profile must not claim the command-deny field the role gate owns"
        );
    }

    /// The default is `local`, and that is the whole point of the constant.
    #[test]
    fn an_absent_flow_grants_nothing_because_the_default_is_local() {
        assert_eq!(DEFAULT_FLOW_PUSH, "local");
        assert!(flow_granted_push_commands(None).is_empty(), "an untouched default must not push");
        assert!(flow_granted_push_commands(Some("local")).is_empty());
        assert!(flow_granted_push_commands(Some("nonsense")).is_empty(), "an unknown value fails closed");
        assert_eq!(flow_granted_push_commands(Some("auto-pr")).len(), 2);
    }
}
