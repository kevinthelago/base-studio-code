//! Team-architect session workspace (#2755) — the Teams Studio's dedicated, heavily-restricted
//! session. Mirrors the designer workspace (`session::designer::setup_designer_workspace`) exactly:
//! one global workspace dir (`~/.base-studio-code/teams-studio/`) whose `CLAUDE.md` is the architect
//! spec — the team/persona model, the `bsc teams` + `bsc persona` contract, and the "teams & personas
//! only" scope guard. The spec prose is a packaged seed under `data/architect/`
//! (externalized-config pattern, #2027) loaded via [`crate::platform::config::load_str`], so a user
//! can edit it under the config dir with no rebuild.
//!
//! The session's permissions are NOT written here — the frontend's `useArchitectTerminal` renders the
//! `architect` role capability (#219): none on every axis. It launches with `restrictedAllow: true`,
//! so the whole auto-runnable surface is `bsc teams` + `bsc persona`.

use crate::StrErr;

#[derive(serde::Serialize)]
pub(crate) struct ArchitectWorkspacePaths {
    // NB: Tauri does NOT rename RETURN-value fields — the frontend reads `teams_dir` verbatim.
    teams_dir: String,
}

/// Idempotently create the team-architect workspace (`~/.base-studio-code/teams-studio/`) and
/// (re)write its `CLAUDE.md` from the packaged seed (`data/architect/claude.md`, config-dir
/// overridable). Safe to call on every panel open — rewriting keeps the spec current with seed/config
/// updates, exactly as `setup_designer_workspace` refreshes the designer CLAUDE.md.
#[tauri::command]
pub(crate) fn setup_architect_workspace() -> Result<ArchitectWorkspacePaths, String> {
    let dir = setup_architect_workspace_inner(&crate::platform::paths::bsc_base_dir())?;
    Ok(ArchitectWorkspacePaths { teams_dir: dir.to_string_lossy().into_owned() })
}

/// Synchronous core of [`setup_architect_workspace`] (testable without a Tauri runtime or the real
/// home dir): creates `<base>/teams-studio/` and writes its `CLAUDE.md` from the architect seed.
pub(crate) fn setup_architect_workspace_inner(base: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let dir = base.join("teams-studio");
    std::fs::create_dir_all(&dir).str_err()?;
    let spec = crate::platform::config::load_str("architect/claude.md");
    if spec.trim().is_empty() {
        return Err("architect/claude.md seed is missing or empty".to_string());
    }
    std::fs::write(dir.join("CLAUDE.md"), spec).str_err()?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bsc-architect-ws-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ))
    }

    #[test]
    fn creates_the_workspace_and_writes_the_architect_claude_md() {
        let base = scratch();
        let dir = setup_architect_workspace_inner(&base).unwrap();
        assert_eq!(dir, base.join("teams-studio"));
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        // The written spec is exactly the loaded seed (config-dir copy or the embedded default).
        assert_eq!(md, crate::platform::config::load_str("architect/claude.md"));
        assert!(!md.trim().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_idempotent_and_refreshes_the_spec_on_recall() {
        let base = scratch();
        let dir = setup_architect_workspace_inner(&base).unwrap();
        // Simulate a stale spec from an older app — a re-run must refresh it, not error.
        std::fs::write(dir.join("CLAUDE.md"), "STALE").unwrap();
        let again = setup_architect_workspace_inner(&base).unwrap();
        assert_eq!(again, dir);
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert_ne!(md, "STALE", "recall must rewrite the spec from the seed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The PACKAGED seed (ignoring any config-dir override) carries the content pillars the issue
    /// requires: the two command surfaces, the team/persona model, and the scope guard.
    #[test]
    fn packaged_architect_spec_carries_surfaces_model_and_scope_guard() {
        let seed = crate::platform::config::embedded_str("architect/claude.md");
        assert!(!seed.trim().is_empty(), "data/architect/claude.md must be packaged");
        for needle in [
            "bsc teams",      // the team command surface
            "bsc persona",    // the persona command surface
            "bsc teams list", // the discovery verbs
            "bsc teams get",
            "bsc persona list",
            "bsc persona get",
            "positions",      // the team model vocabulary
            "relationship",
            "role",           // a persona rides a role (its permission floor)
            "ONLY",           // the scope guard
        ] {
            assert!(seed.contains(needle), "architect seed must mention `{needle}`");
        }
    }
}
