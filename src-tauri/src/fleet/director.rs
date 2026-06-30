use crate::prelude::*;
use crate::fleet::protocols::append_section_once;

/// Director protocol (#375) appended to the project hub's CLAUDE.local.md so the
/// async-integrator director always has its standing duties as authoritative context
/// (it runs at the hub, so it never gets the worker worktree protocol).
pub(crate) const DIRECTOR_PROTOCOL_MD: &str = include_str!("../../data/fleet/director-protocol.md");

/// Ensure the project hub's CLAUDE.local.md carries the director protocol (#375). Idempotent.
#[tauri::command]
pub(crate) fn ensure_director_protocol(project_key: String) -> Result<(), String> {
    let local = project_dir(&project_key).join("CLAUDE.local.md");
    if let Some(parent) = local.parent() { let _ = std::fs::create_dir_all(parent); }
    // Both sections are appended verbatim only when their marker is absent (idempotent), via the
    // shared helper — no scattered read-modify-write blocks. Errors propagate (this is a command).
    append_section_once(&local, "## Director protocol", DIRECTOR_PROTOCOL_MD).map_err(|e| e.to_string())?;
    // Injection-resistance preamble (#1167): the director reads issue/PR prose + authors kickoffs,
    // so it's a high-value injection target — give it the same untrusted-input rules as workers.
    append_section_once(&local, INJECTION_RESISTANCE_MARKER, INJECTION_RESISTANCE_MD).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::prelude::*;
    use crate::project::{hub::*, plan_files::*, plan_db::*, blueprints::*, dead_code::*, ui_skeleton::*, files::*};
    use crate::fleet::{worktree::*, director::*, inspect::*};
    use crate::extensions::{mcp::*, cfg::*};
    use crate::testutil::{ENV_LOCK, temp_home, write_file};

    #[test]
    fn director_protocol_assigns_contract_ownership() {
        // The director owns the integration contracts, tests the seams, and is the worker's
        // help desk for them (#…). Guard that the standing protocol says so.
        let p = DIRECTOR_PROTOCOL_MD;
        assert!(p.contains("contracts/") || p.contains("contracts directory") || p.contains("INTEGRATION CONTRACTS"),
            "director protocol must claim ownership of the contracts directory");
        assert!(p.contains("TEST THE INTEGRATIONS"), "director protocol must mandate integration testing");
        // The director is the ONLY GitHub PR/issue writer by default (#1948): workers open PRs, the
        // director reviews, merges, AND closes them — never the worker. Guard the ownership clause.
        assert!(p.contains("OWN ALL GITHUB") && p.contains("gh pr merge"),
            "director protocol must claim ownership of GitHub PR writes (merge/close) as the default");
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
