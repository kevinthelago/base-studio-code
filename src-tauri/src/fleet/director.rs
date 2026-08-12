use crate::prelude::*;
use crate::fleet::protocols::append_section_once;

/// Director protocol (#375) appended to the project hub's CLAUDE.local.md so the
/// async-integrator director always has its standing duties as authoritative context
/// (it runs at the hub, so it never gets the worker worktree protocol). Loaded at runtime via
/// [`crate::platform::config::load_str`] (#2027 P2) — the user's `fleet/director-protocol.md` under
/// the config dir if present, else the embedded seed.
pub(crate) fn director_protocol_md() -> String {
    crate::platform::config::load_str("fleet/director-protocol.md")
}

/// Ensure the project hub's CLAUDE.local.md carries the director protocol (#375). Idempotent.
#[tauri::command]
pub(crate) fn ensure_director_protocol(project_key: String) -> Result<(), String> {
    let local = project_dir(&project_key).join("CLAUDE.local.md");
    if let Some(parent) = local.parent() { let _ = std::fs::create_dir_all(parent); }
    // Both sections are appended verbatim only when their marker is absent (idempotent), via the
    // shared helper — no scattered read-modify-write blocks. Errors propagate (this is a command).
    append_section_once(&local, "## Director protocol", &director_protocol_md()).str_err()?;
    // Injection-resistance preamble (#1167): the director reads issue/PR prose + authors kickoffs,
    // so it's a high-value injection target — give it the same untrusted-input rules as workers.
    append_section_once(&local, INJECTION_RESISTANCE_MARKER, &injection_resistance_md()).str_err()?;
    Ok(())
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    #[test]
    fn director_protocol_assigns_contract_ownership() {
        // The director owns the integration contracts and is the worker's help desk for them. That
        // survives the funnel: answering from a contract is deciding, and deciding is the one thing
        // the director keeps.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("contracts/") || p.contains("contracts directory") || p.contains("INTEGRATION CONTRACTS"),
            "director protocol must claim ownership of the contracts directory");
    }

    #[test]
    fn director_protocol_routes_the_doing_duties_rather_than_performing_them() {
        // #funnel-commons-and-integration-streams. The director loses write, so its three DOING
        // duties become lanes: the commons lane owns the repo-root commons, the integration lane owns
        // the integration branch (merges, the revert, the seam tests). This replaces the assertions
        // that guarded `OWN ALL GITHUB` / `gh pr merge` ownership — under local-first there are no PRs
        // to own, so that clause is not narrowed, it is vacuous.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");

        // The GitHub-ownership clause is GONE, not reworded. Guarding its absence is the point: a
        // director that still believes it merges PRs will sit waiting for PRs that never open.
        assert!(!p.contains("OWN ALL GITHUB"),
            "the OWN ALL GITHUB section must be removed -- local-first has no PRs to review or merge");
        assert!(!p.contains("gh pr merge"),
            "the director must not be told to merge PRs; it holds no GitHub write under the funnel");

        // Commons: routed to the lane, and explicitly NOT applied by the director itself.
        assert!(p.contains("ROUTE THE COMMONS"),
            "director protocol must carry the commons ROUTING section");
        assert!(p.contains("COMMONS lane"),
            "the commons must be attributed to the commons lane, not to the director");
        assert!(p.contains("never edit one yourself"),
            "the director must be told it no longer edits a commons file");

        // Integration: the revert and the seam tests both belong to the integration lane.
        assert!(p.contains("WATCHDOG -- ROUTE THE REVERT"),
            "the watchdog duty must be a routing instruction, not a revert the director performs");
        assert!(p.contains("INTEGRATION lane"),
            "the revert must be routed to the integration lane");
        assert!(p.contains("TEST THE INTEGRATIONS"),
            "integration testing must still be mandated -- as a routed duty");

        // Both duties route through the same emitter every other dispatch uses.
        assert!(p.contains("bsc-assign"),
            "routed duties reach their lane via bsc-assign");
    }

    #[test]
    fn director_protocol_reports_an_undelivered_assign_to_a_stopped_lane() {
        // The commons + integration lanes are ORDINARY streams that stop when done, so the honesty
        // rule stops being advice and becomes the only thing preventing silent loss: a worker parked
        // on bsc-ask for a commons change is waiting on a lane that may have ended.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("not delivered"),
            "an assign to a stopped session must be described as undelivered");
        assert!(p.contains("BLOCKED"),
            "a commons change whose lane has stopped must be reported as blocked, not as landed");
    }

    #[test]
    fn director_protocol_routes_confirmed_transformations() {
        // #2509 slice (e): the director dispatches ONLY confirmed transformation rows, in
        // dependency order, via the existing bsc-issue + bsc-assign loop — the user's confirm
        // queue is the uniform gate. Guard the standing protocol says exactly that.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("ROUTE CONFIRMED TRANSFORMATIONS"),
            "director protocol must carry the confirmed-transformations routing section (#2509)");
        assert!(p.contains("bsc plan transformation list"),
            "director must read the transformation list from plan.db");
        // Confirmed-only: it dispatches rows with confirmed:true and NEVER confirms (the user's gate).
        assert!(p.contains("confirmed: true") && p.contains("NEVER confirm"),
            "director routes only confirmed rows and never confirms one itself");
        // Ordering: tier + dependsOn, foundation-first waves.
        assert!(p.contains("dependsOn") && p.contains("tier"),
            "director must respect tier + dependsOn ordering when routing transformations");
        // Reuses the existing capture-and-route loop.
        assert!(p.contains("bsc-issue") && p.contains("bsc-assign"),
            "director routes confirmed transformations through the existing bsc-issue + bsc-assign loop");
    }
    #[test]
    fn director_protocol_includes_injection_resistance() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = temp_home("dirproto");
        let key = "proj-dir".to_string();
        ensure_director_protocol(key.clone()).unwrap();
        let md = std::fs::read_to_string(project_dir(&key).join("CLAUDE.local.md")).unwrap();
        assert!(md.contains("## Director protocol"), "director protocol present");
        assert!(md.contains(INJECTION_RESISTANCE_MARKER), "director also gets the injection-resistance preamble");
        // Idempotent — a second ensure doesn't duplicate either section.
        ensure_director_protocol(key.clone()).unwrap();
        let again = std::fs::read_to_string(project_dir(&key).join("CLAUDE.local.md")).unwrap();
        assert_eq!(again.matches(INJECTION_RESISTANCE_MARKER).count(), 1);
        std::fs::remove_dir_all(&home).ok();
    }
}
