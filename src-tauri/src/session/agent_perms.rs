//! `bsc-agent`'s native permission document — the least-privilege gate on the model-agnostic harness.
//!
//! # The inversion, on the harness the local-model track depends on
//!
//! There is no `.claude/settings.json` on the `bsc-agent` path, so `$BSC_AGENT_PERMS` IS the gate:
//! deny whole tools, deny `bash` by substring, and restrict `write_file`/`edit_file` to a glob set.
//! `crates/bsc-agent/src/main.rs` calls `Permissions::from_env()` and enforces the result on every tool
//! call. That runtime is Rust, and it could not compute the document it enforces.
//!
//! # The three fields
//!
//! * `deny_tools` — `["write_file", "edit_file"]` for a `code: none` role WITHOUT a scoped carve-out.
//!   A carve-out role (#851) is `code: none` yet keeps its write tools, scoped by `write_globs`.
//! * `deny_bash` — the role's denies minus the pushes the pane's flow grants back (#304), UNIONED with
//!   the user's global denylist. The user's list rides in HERE because bsc-agent has no settings file
//!   for it to ride in on; entries are trimmed and empties dropped. That is the half a port most easily
//!   loses, because it is the only one that is not derived from the role.
//! * `write_globs` — the capability's globs for `code: write` or a carve-out; empty otherwise. Empty
//!   means NO restriction in the runtime, which is why a restricted role must get its denial from
//!   `deny_tools` rather than from an empty glob list.
//!
//! # What is deliberately NOT here
//!
//! The catastrophic floor — `sudo`, `rm -rf /`, force-push — is always-on inside the runtime via
//! `bsc_util::dangerous`, so an empty or missing document cannot drop it. Rendering it here as well
//! would make an empty doc *look* sufficient and invite a future edit to treat this as the floor.
//! `the_catastrophic_floor_is_not_rendered_here` asserts its absence.
//!
//! # An asymmetry this module used to reproduce, and no longer does
//!
//! The surface complement used to be ABSENT. `role_denied_commands` takes the catalog of deniable
//! `bsc` surfaces and denies every one the role did not declare; the Claude path passed the real
//! catalog, while the TypeScript this is ported from called its equivalent with the argument
//! DEFAULTED to empty. Measured, a `designer` was denied `bsc plan`, `bsc skill`, `bsc graph` and
//! `bsc org` on Claude and none of them here.
//!
//! Both sides take the catalog now (`a-bsc-agent-session-is-denied-less-than-the-same-role-on-claude`).
//! It was fixed on BOTH rather than here alone, which is what would have put the two harnesses out of
//! step in the other direction; the fixture was regenerated from the corrected TypeScript, so parity
//! still means what it says.
//!
//! An EMPTY catalog still denies nothing extra, and that is the fail-open the launch depends on: the
//! catalog is read from a subprocess, so "unavailable" and "no surfaces exist" cannot be told apart,
//! and a launch that raced the read must not lose its whole CLI.

use super::role_gate::{has_scoped_write_carve_out, role_denied_commands, RoleCapability, Tier};

/// The document `bsc-agent` deserializes from `$BSC_AGENT_PERMS`.
///
/// SNAKE_CASE, matching the consumer's `Permissions` struct field-for-field — the names are the wire
/// contract, and `the_field_names_match_the_consumer` checks them against that struct's own source
/// rather than trusting this comment.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BscAgentPerms {
    #[serde(default)]
    pub deny_tools: Vec<String>,
    #[serde(default)]
    pub deny_bash: Vec<String>,
    #[serde(default)]
    pub write_globs: Vec<String>,
}

/// The tools a session that may not write must not reach.
const WRITE_TOOLS: &[&str] = &["write_file", "edit_file"];

/// Render a capability into the permission document.
///
/// `cap` is `None` for a role-less ad-hoc console — then only `extra_deny_bash` applies, which is the
/// case that must not accidentally render an empty-but-restrictive doc.
///
/// `granted` are the flow's push commands ([`super::denies::flow_granted_push_commands`]); `role_denied_commands`
/// is called with an EMPTY surface catalog, reproducing the source — see the module docs.
pub fn bsc_agent_perms(cap: Option<&RoleCapability>, granted: &[String], extra_deny_bash: &[String], deniable_surfaces: &[String]) -> BscAgentPerms {
    let carve_out = cap.map(has_scoped_write_carve_out).unwrap_or(false);

    let mut deny_bash: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // THE SURFACE COMPLEMENT, which this used to omit by passing an empty catalog
    // (`a-bsc-agent-session-is-denied-less-than-the-same-role-on-claude`). An empty catalog denies
    // NOTHING extra, so a persona's undeclared `bsc` surfaces stayed reachable here while the same
    // role on Claude had them denied — measured, a designer kept `bsc plan`, `bsc skill`, `bsc graph`
    // and `bsc org`.
    //
    // Empty is still the FAIL-OPEN the launch relies on: the catalog is read from a subprocess, so
    // "unavailable" and "no surfaces exist" are indistinguishable, and complementing against nothing
    // denies nothing rather than bricking the session.
    let role_denies = cap.map(|c| role_denied_commands(c, deniable_surfaces)).unwrap_or_default();
    for d in role_denies.into_iter().filter(|d| !granted.contains(d)) {
        // The `seen` set exists for the CROSS-SOURCE dedupe below, not for this loop:
        // `role_denied_commands` already returns a de-duplicated list, so the guard here changes no
        // outcome and removing it leaves the parity green. What matters is that `seen` ends up
        // POPULATED with the role denies, so a user denylist entry repeating one is dropped rather
        // than rendered twice.
        if seen.insert(d.clone()) {
            deny_bash.push(d);
        }
    }
    // The user's global denylist, trimmed with empties dropped — a blank line in the settings field
    // would otherwise become a substring that matches EVERY command.
    for raw in extra_deny_bash {
        let t = raw.trim();
        if !t.is_empty() && seen.insert(t.to_string()) {
            deny_bash.push(t.to_string());
        }
    }

    let restricted = cap.map(|c| c.code == Tier::None).unwrap_or(false) && !carve_out;
    let writes = cap
        .filter(|c| c.code == Tier::Write || carve_out)
        .map(|c| c.write_globs.clone())
        .unwrap_or_default();

    BscAgentPerms {
        deny_tools: if restricted { WRITE_TOOLS.iter().map(|s| s.to_string()).collect() } else { Vec::new() },
        deny_bash,
        write_globs: writes,
    }
}


/// What the launch did to the permission document it was handed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentPermsOutcome {
    /// Not a `bsc-agent` launch, or a role-less console with no document — nothing to render.
    NotApplicable,
    /// Rendered here and installed. `differed` is true when it is not what the renderer sent.
    Rendered { differed: bool },
}

/// Render `$BSC_AGENT_PERMS` for a `bsc-agent` launch, replacing what the renderer sent.
///
/// # Why this one REFUSES instead of falling back
///
/// On the `bsc-agent` path this document is the ENTIRE gate — no settings file, no PreToolUse hook
/// chain, no second layer. And the consumer is forgiving in the dangerous direction:
/// `Permissions::from_env` does `serde_json::from_str(&json).unwrap_or_default()`, and
/// `Permissions::default()` is PERMISSIVE. So a document that is absent, empty or malformed is
/// indistinguishable from a session that was meant to be unrestricted.
///
/// That inverts the usual advice. Everywhere else in this cutover a missing value is reported and
/// unioned; here the only safe response to "cannot render" is to refuse the launch, because every
/// other outcome produces a running session with no restrictions and nothing saying so.
///
/// # The one case that must refuse, and why the env is what tells us
///
/// A `None` capability is ambiguous exactly as it is for the credential: it means "role-less ad-hoc
/// console" (legitimate, and permissive by design) or "a role exists and its capability did not
/// arrive". The ENV disambiguates, because the renderer sets `BSC_AGENT_PERMS` only under `if
/// (bscRole)` — so a document present with no capability means a ROLE pane whose capability was lost,
/// and that launch is refused rather than run on a document the backend cannot vouch for.
///
/// # `user_denies` is the ONLY route that list has on this harness
///
/// `bscAgentPerms`'s own doc says the user's global denylist must ride in here because bsc-agent has
/// no `.claude/settings.json` for it to ride in on — and it is right: `Permissions::from_env` reads
/// `BSC_AGENT_PERMS`, `BSC_REPO_ROOT` and `BSC_HARVEST_ROOTS`, and no `$BSC_DENY_BASH`. The renderer
/// nonetheless called `bscAgentPerms(cap, granted)` with the argument defaulted, so a command the
/// user denied in Settings was enforced on Claude and nowhere else
/// (`a-bsc-agent-session-never-gets-the-users-denylist`).
///
/// It is the SAME list the Claude path composes into `denied_commands`, taken from the same store
/// field, so the two harnesses deny one list rather than two restatements of it.
pub fn reconcile_agent_perms(
    env: &mut std::collections::HashMap<String, String>,
    provider_is_bsc_agent: bool,
    cap: Option<&RoleCapability>,
    granted: &[String],
    user_denies: &[String],
    deniable_surfaces: &[String],
) -> Result<AgentPermsOutcome, String> {
    if !provider_is_bsc_agent {
        return Ok(AgentPermsOutcome::NotApplicable);
    }
    let sent = env.get("BSC_AGENT_PERMS").cloned();
    let Some(cap) = cap else {
        return match sent {
            Some(doc) if !doc.trim().is_empty() => Err(
                "this bsc-agent pane carries a $BSC_AGENT_PERMS document but sent no role capability, \
                 so the launch cannot render the gate it would be running under. Refusing rather than \
                 launching: on this harness the document IS the gate, and an unvouched-for one is \
                 indistinguishable from an unrestricted session."
                    .to_string(),
            ),
            // A genuinely role-less ad-hoc console. Permissive by design, and nothing to render.
            _ => Ok(AgentPermsOutcome::NotApplicable),
        };
    };
    let doc =
        serde_json::to_string(&bsc_agent_perms(Some(cap), granted, user_denies, deniable_surfaces))
        .map_err(|e| format!("could not render $BSC_AGENT_PERMS: {e}"))?;
    let differed = sent.as_deref().is_some_and(|s| s != doc);
    env.insert("BSC_AGENT_PERMS".to_string(), doc);
    Ok(AgentPermsOutcome::Rendered { differed })
}

#[cfg(test)]
mod tests {
    use super::*;


    fn cap_for(role: &str, code: Tier, globs: Vec<String>) -> RoleCapability {
        RoleCapability {
            role: role.into(),
            github: Tier::Read,
            git: Tier::Read,
            code,
            net: Tier::None,
            ui: Tier::None,
            write_globs: globs,
            allow: vec![],
            surfaces: None,
            harvest_roots: vec![],
        }
    }

    /// THE TWO ENDS OF THE CARVE-OUT BRANCH, which the item names as what to check. A `code: none`
    /// role WITHOUT globs loses the write tools outright; one WITH them keeps the tools and is scoped.
    /// Getting this backwards either strands a designer or hands a triage pane a file editor.
    #[test]
    fn the_carve_out_branch_denies_the_write_tools_or_scopes_them_but_never_neither() {
        let triage = cap_for("triage", Tier::None, vec![]);
        let p = bsc_agent_perms(Some(&triage), &[], &[], &[]);
        assert_eq!(p.deny_tools, vec!["write_file", "edit_file"], "no globs ⇒ deny the tools outright");
        assert!(p.write_globs.is_empty());

        let designer = cap_for("designer", Tier::None, vec!["scratch/**".into()]);
        let p = bsc_agent_perms(Some(&designer), &[], &[], &[]);
        assert!(p.deny_tools.is_empty(), "a carve-out role KEEPS its write tools");
        assert_eq!(p.write_globs, vec!["scratch/**"], "…scoped to its lane");
        // The pair is the point: an EMPTY glob list means no restriction in the runtime, so a
        // restricted role must get its denial from deny_tools. Neither-nor is the unsafe state.
        assert!(
            !(p.deny_tools.is_empty() && p.write_globs.is_empty()),
            "tools allowed AND unscoped is an unrestricted writer"
        );
    }

    /// THE SHIPPED GAP (`a-bsc-agent-session-never-gets-the-users-denylist`). `bscAgentPerms`' third
    /// argument defaults to `[]` and its only call site passed two, so a command the user denied in
    /// Settings was enforced on Claude and nowhere else — and there is NO second route, since
    /// `Permissions::from_env` reads `BSC_AGENT_PERMS`, `BSC_REPO_ROOT` and `BSC_HARVEST_ROOTS` and no
    /// `$BSC_DENY_BASH`.
    #[test]
    fn the_users_denylist_reaches_the_document_the_runtime_actually_reads() {
        let worker = cap_for("worker", Tier::Write, vec!["src/**".into()]);
        let mut env = std::collections::HashMap::new();
        reconcile_agent_perms(
            &mut env,
            true,
            Some(&worker),
            &[],
            &["curl".to_string(), "  ".to_string(), " nc ".to_string()],
            &[],
        )
        .unwrap();
        let doc: BscAgentPerms = serde_json::from_str(env.get("BSC_AGENT_PERMS").unwrap()).unwrap();
        assert!(doc.deny_bash.iter().any(|d| d == "curl"), "{:?}", doc.deny_bash);
        // TRIMMED, and empties DROPPED — a blank line in the settings field would otherwise become a
        // substring that matches EVERY command.
        assert!(doc.deny_bash.iter().any(|d| d == "nc"), "trimmed: {:?}", doc.deny_bash);
        assert!(!doc.deny_bash.iter().any(|d| d.trim().is_empty()), "{:?}", doc.deny_bash);
    }

    /// THE TWO HARNESSES DENY ONE LIST, asserted from a single source rather than by restating it.
    /// The Claude path composes the user's denies through `denies::session_denied_commands`; this
    /// path renders them into the document. Both are fed the same slice here, and the property is
    /// that every user entry survives BOTH — which is what "parity" means for this field.
    #[test]
    fn both_harnesses_deny_the_same_user_list() {
        let worker = cap_for("worker", Tier::Write, vec!["src/**".into()]);
        let user = ["curl".to_string(), "nc".to_string()];

        // The Claude path.
        let claude = crate::session::denies::session_denied_commands(&user, Some(&worker), &[], None, &[]);
        // The bsc-agent path.
        let agent = bsc_agent_perms(Some(&worker), &[], &user, &[]);

        for u in &user {
            assert!(claude.contains(u), "the Claude path must deny `{u}`: {claude:?}");
            assert!(agent.deny_bash.contains(u), "and so must the bsc-agent one: {:?}", agent.deny_bash);
        }
    }

    /// The floor is STILL not rendered here. It is always-on inside the runtime
    /// (`bsc_util::dangerous`), so an empty or missing document cannot drop it — and rendering it
    /// would make an empty document *look* sufficient. Passing the user's list must not have smuggled
    /// it in by another name.
    #[test]
    fn the_user_list_does_not_drag_the_catastrophic_floor_in_with_it() {
        let worker = cap_for("worker", Tier::Write, vec!["src/**".into()]);
        let doc = bsc_agent_perms(Some(&worker), &[], &["curl".to_string()], &[]);
        for floor in ["sudo", "rm -rf /", "mkfs"] {
            assert!(
                !doc.deny_bash.iter().any(|d| d == floor),
                "the floor stays the runtime's, not this document's: {:?}",
                doc.deny_bash
            );
        }
    }

    /// A `bsc-agent` pane with a role: the launch renders the document and installs its own.
    #[test]
    fn the_launch_renders_the_document_and_installs_it() {
        let designer = cap_for("designer", Tier::None, vec!["scratch/**".into()]);
        let mut env = std::collections::HashMap::new();
        let out = reconcile_agent_perms(&mut env, true, Some(&designer), &[], &[], &[]).unwrap();
        assert_eq!(out, AgentPermsOutcome::Rendered { differed: false });
        let doc: BscAgentPerms = serde_json::from_str(env.get("BSC_AGENT_PERMS").unwrap()).unwrap();
        assert_eq!(doc.write_globs, vec!["scratch/**"]);
    }

    /// THE REFUSAL. A document with no capability means a ROLE pane whose capability was lost — the
    /// renderer sets `BSC_AGENT_PERMS` only under `if (bscRole)`. Launching would run on a gate the
    /// backend cannot vouch for, and dropping it would be permissive, so the launch is refused.
    #[test]
    fn a_document_with_no_capability_refuses_the_launch_rather_than_running_it() {
        let mut env = std::collections::HashMap::from([(
            "BSC_AGENT_PERMS".to_string(),
            r#"{"deny_tools":[],"deny_bash":[],"write_globs":[]}"#.to_string(),
        )]);
        let err = reconcile_agent_perms(&mut env, true, None, &[], &[], &[]).unwrap_err();
        assert!(err.contains("Refusing"), "the refusal must say what it is refusing and why: {err}");
        // …and a genuinely role-less console with no document is NOT refused: it is the permissive
        // ad-hoc case, and refusing it would break every bare bsc-agent shell.
        let mut bare = std::collections::HashMap::new();
        assert_eq!(
            reconcile_agent_perms(&mut bare, true, None, &[], &[], &[]).unwrap(),
            AgentPermsOutcome::NotApplicable
        );
        assert!(!bare.contains_key("BSC_AGENT_PERMS"));
    }

    /// A CLAUDE pane is untouched — its gate is `settings.json`, and writing a bsc-agent document into
    /// its env would be inert at best and confusing to read at worst.
    #[test]
    fn a_claude_launch_is_left_alone() {
        let worker = cap_for("worker", Tier::Write, vec!["src/**".into()]);
        let mut env = std::collections::HashMap::new();
        assert_eq!(
            reconcile_agent_perms(&mut env, false, Some(&worker), &[], &[], &[]).unwrap(),
            AgentPermsOutcome::NotApplicable
        );
        assert!(env.is_empty());
    }

    /// The flow lifts EXACTLY the two commands it owns (#304) and nothing else — the same
    /// reconciliation the Claude path makes, on the harness that has no second layer to catch a miss.
    #[test]
    fn the_flow_lifts_its_two_pushes_from_the_role_denies_and_no_more() {
        let worker = cap_for("worker", Tier::Write, vec!["src/**".into()]);
        let granted = vec!["git push".to_string(), "gh pr create".to_string()];
        let with = bsc_agent_perms(Some(&worker), &granted, &[], &[]);
        assert!(!with.deny_bash.iter().any(|d| d == "gh pr create"), "an auto-pr worker opens its PR");
        let without = bsc_agent_perms(Some(&worker), &[], &[], &[]);
        assert!(without.deny_bash.iter().any(|d| d == "gh pr create"), "…and only because of the flow");
        // Everything else the role denies is untouched by the grant.
        assert!(with.deny_bash.iter().any(|d| d == "gh pr merge"));
    }

    fn find_named(name: &str, from: &std::path::Path) -> std::path::PathBuf {
        fn walk(dir: &std::path::Path, name: &str, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, name, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some(name) {
                    out.push(p);
                }
            }
        }
        let mut found = Vec::new();
        walk(from, name, &mut found);
        assert_eq!(found.len(), 1, "expected one {name}, got {found:?}");
        found.pop().unwrap()
    }

    fn fixture() -> serde_json::Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let p = find_named("bscAgentPerms.fixtures.json", &root);
        serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
    }

    fn strings(v: &serde_json::Value) -> Vec<String> {
        v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
    }

    /// Reports every mismatch at once — a wrong port is usually wrong in a pattern.
    #[test]
    fn the_rendered_doc_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 25, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut denied_tools, mut with_globs, mut roleless) = (0usize, 0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let cap: Option<RoleCapability> = match &case["capability"] {
                serde_json::Value::Null => None,
                v => Some(serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{label}: {e}"))),
            };
            if cap.is_none() {
                roleless += 1;
            }
            let want: BscAgentPerms = serde_json::from_value(case["perms"].clone())
                .unwrap_or_else(|e| panic!("{label}: perms did not deserialize: {e}"));
            if !want.deny_tools.is_empty() {
                denied_tools += 1;
            }
            if !want.write_globs.is_empty() {
                with_globs += 1;
            }

            let got = bsc_agent_perms(cap.as_ref(), &strings(&case["granted"]), &strings(&case["extraDenyBash"]), // DRIVEN FROM THE FIXTURE, not assumed empty — assuming empty is exactly what hid the
                // missing surface complement for as long as it was missing.
                &strings(&case["activeSurfaces"]));
            if got != want {
                mismatches.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(denied_tools >= 3, "only {denied_tools} cases denied the write tools");
        assert!(with_globs >= 5, "only {with_globs} cases produced write globs");
        assert!(roleless >= 1, "the role-less ad-hoc console case is missing");
        assert!(
            mismatches.is_empty(),
            "the Rust rendering disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }

    /// THE FIELD NAMES ARE THE WIRE CONTRACT, checked against the CONSUMER'S OWN SOURCE.
    ///
    /// `bsc-agent` is a bin-only crate, so its `Permissions` struct cannot be linked and round-tripped
    /// here. Reading its source out of the graph store is the stronger check anyway: it fails if either
    /// side renames a field, which a locally-declared mirror struct could never notice.
    #[test]
    fn the_field_names_match_the_consumer() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let store: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(repo.join("graph/algorithms.json")).unwrap()).unwrap();
        let record = store["implementations"]
            .as_array()
            .expect("implementations")
            .iter()
            .find(|n| n["id"] == "bsc-agent--permissions.rs")
            .expect("the consumer's permissions record is missing from the graph store");
        let src = record["code"].as_str().unwrap();

        let rendered = serde_json::to_value(bsc_agent_perms(None, &[], &["curl".to_string()], &[])).unwrap();
        for key in rendered.as_object().unwrap().keys() {
            assert!(
                src.contains(&format!("pub {key}:")),
                "the rendered doc carries `{key}`, which the consumer's Permissions struct does not declare"
            );
        }
        // And the consumer's own serde-visible fields must all be renderable, or we are shipping a doc
        // that silently under-specifies the gate.
        for field in ["deny_tools", "deny_bash", "write_globs"] {
            assert!(src.contains(&format!("pub {field}:")), "consumer lost `{field}`");
            assert!(rendered.get(field).is_some(), "the rendering lost `{field}`");
        }
    }

    /// The floor lives in the RUNTIME, not in this document. Rendering it here would make an empty doc
    /// look sufficient, and invite a future edit to treat this as the floor it is not.
    #[test]
    fn the_catastrophic_floor_is_not_rendered_here() {
        let doc = fixture();
        for case in doc["cases"].as_array().unwrap() {
            for d in strings(&case["perms"]["deny_bash"]) {
                assert!(
                    !d.contains("sudo") && !d.contains("rm -rf"),
                    "{}: the catastrophic floor leaked into the doc via {d:?}",
                    case["label"]
                );
            }
        }
    }

    fn cap(role: &str, code: &str, globs: &[&str]) -> RoleCapability {
        serde_json::from_value(serde_json::json!({
            "role": role, "git": "none", "github": "none", "net": "none", "code": code,
            "writeGlobs": globs, "ui": "read"
        }))
        .unwrap()
    }

    /// A role-less console renders ONLY the user's denylist — it must not accidentally restrict.
    #[test]
    fn a_roleless_console_renders_only_the_user_denylist() {
        let bare = bsc_agent_perms(None, &[], &[], &[]);
        assert_eq!(bare, BscAgentPerms { deny_tools: vec![], deny_bash: vec![], write_globs: vec![] });
        let with_user = bsc_agent_perms(None, &[], &["curl".to_string(), "  wget  ".to_string()], &[]);
        assert_eq!(with_user.deny_bash, vec!["curl", "wget"], "trimmed");
        assert!(with_user.deny_tools.is_empty(), "no capability must never deny the write tools");
    }

    /// A blank denylist entry must never become a substring that matches every command.
    #[test]
    fn blank_user_denylist_entries_are_dropped_not_rendered() {
        let p = bsc_agent_perms(None, &[], &["".into(), "   ".into(), "\t\n".into(), "curl".into()], &[]);
        assert_eq!(p.deny_bash, vec!["curl"], "a blank substring would deny EVERYTHING");
    }

    /// `code: none` denies the write tools; a carve-out role is `code: none` and keeps them, scoped.
    #[test]
    fn the_carve_out_keeps_its_write_tools_while_a_plain_restricted_role_loses_them() {
        let plain = bsc_agent_perms(Some(&cap("triage", "none", &[])), &[], &[], &[]);
        assert_eq!(plain.deny_tools, vec!["write_file", "edit_file"]);
        assert!(plain.write_globs.is_empty(), "an empty glob list means NO restriction in the runtime");

        let carve = bsc_agent_perms(Some(&cap("designer", "none", &["scratch/**"])), &[], &[], &[]);
        assert!(carve.deny_tools.is_empty(), "a carve-out role keeps its write tools");
        assert_eq!(carve.write_globs, vec!["scratch/**"], "scoped by its globs instead");
    }

    /// Globs handed to a restricted role WITHOUT a carve-out grant nothing — the same narrowing-only
    /// rule the write-scope env enforces.
    #[test]
    fn globs_given_to_a_non_carve_out_restricted_role_grant_nothing() {
        let p = bsc_agent_perms(Some(&cap("triage", "none", &["src/**"])), &[], &[], &[]);
        assert!(p.write_globs.is_empty(), "supplying a scope must narrow, never widen");
        assert_eq!(p.deny_tools, vec!["write_file", "edit_file"]);
    }

    /// The de-duplication is across BOTH sources: a user deny that repeats a role deny appears once.
    #[test]
    fn a_user_deny_duplicating_a_role_deny_appears_once() {
        let c = cap("worker", "write", &[]);
        let role_only = bsc_agent_perms(Some(&c), &[], &[], &[]);
        let dup = role_only.deny_bash.first().cloned().expect("a worker denies something");
        let with_dup = bsc_agent_perms(Some(&c), &[], std::slice::from_ref(&dup), &[]);
        assert_eq!(with_dup.deny_bash.len(), role_only.deny_bash.len(), "{dup:?} was rendered twice");
    }

    /// THE COMPLEMENT IS PRESENT NOW, and this is the test that replaced the one predicting its
    /// arrival. The old test asserted the absence and said "this is what will go red when that item
    /// fixes it". It did not go red: the fix threaded the catalog through as a PARAMETER rather than
    /// changing what the function does for the arguments that test passed, so a canary written
    /// against a defaulted argument sat green through its own repair.
    #[test]
    fn a_real_catalog_denies_every_surface_the_role_did_not_declare() {
        let designer: RoleCapability = serde_json::from_value(serde_json::json!({
            "role": "designer", "git": "none", "github": "none", "net": "none", "code": "none",
            "writeGlobs": ["scratch/**"], "ui": "write", "surfaces": ["ui"]
        }))
        .unwrap();
        let catalog = ["plan".to_string(), "skill".to_string(), "ui".to_string()];
        let rendered = bsc_agent_perms(Some(&designer), &[], &[], &catalog);

        for undeclared in ["bsc plan", "bsc skill"] {
            assert!(
                rendered.deny_bash.iter().any(|d| d == undeclared),
                "an undeclared surface must be denied here as it is on Claude: {:?}",
                rendered.deny_bash
            );
        }
        // …and the one it DECLARED is not, which is what makes this a complement rather than a
        // blanket deny — a designer that could not run `bsc ui` could not do its job at all.
        assert!(
            !rendered.deny_bash.iter().any(|d| d == "bsc ui"),
            "the declared surface stays reachable: {:?}",
            rendered.deny_bash
        );
    }

    /// THE FAIL-OPEN, which survives the fix and is the half most easily lost with it. The catalog is
    /// read from a subprocess, so "unavailable" and "no surfaces exist" cannot be told apart — and
    /// complementing against nothing must deny nothing, or a launch that raced the read loses its
    /// whole CLI.
    #[test]
    fn an_empty_catalog_still_denies_no_surface() {
        let designer: RoleCapability = serde_json::from_value(serde_json::json!({
            "role": "designer", "git": "none", "github": "none", "net": "none", "code": "none",
            "writeGlobs": ["scratch/**"], "ui": "write", "surfaces": ["ui"]
        }))
        .unwrap();
        let rendered = bsc_agent_perms(Some(&designer), &[], &[], &[]);
        assert!(
            !rendered.deny_bash.iter().any(|d| d.starts_with("bsc ") && !d.contains(' ')),
            "no complement deny may appear from an empty catalog: {:?}",
            rendered.deny_bash
        );
        assert!(!rendered.deny_bash.iter().any(|d| d == "bsc plan"), "{:?}", rendered.deny_bash);
    }
}
