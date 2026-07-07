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
        // The director owns the integration contracts, tests the seams, and is the worker's
        // help desk for them (#…). Guard that the standing protocol says so.
        let p = crate::platform::config::embedded_str("fleet/director-protocol.md");
        assert!(p.contains("contracts/") || p.contains("contracts directory") || p.contains("INTEGRATION CONTRACTS"),
            "director protocol must claim ownership of the contracts directory");
        assert!(p.contains("TEST THE INTEGRATIONS"), "director protocol must mandate integration testing");
        // The director is the ONLY GitHub PR/issue writer by default (#1948): workers open PRs, the
        // director reviews, merges, AND closes them — never the worker. Guard the ownership clause.
        assert!(p.contains("OWN ALL GITHUB") && p.contains("gh pr merge"),
            "director protocol must claim ownership of GitHub PR writes (merge/close) as the default");
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
