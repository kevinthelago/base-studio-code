//! Knowledge-store librarian session workspace (#2787) — the Algorithms tab's dedicated,
//! heavily-restricted session. Mirrors the architect workspace (`session::architect::
//! setup_architect_workspace`) exactly: one global workspace dir (`~/.base-studio-code/
//! algorithms-studio/`) whose `CLAUDE.md` is the librarian spec — the knowledge-graph model, the
//! `bsc graph` contract, and the "knowledge store only" scope guard. The spec prose is a packaged
//! seed under `data/librarian/` (externalized-config pattern, #2027) loaded via
//! [`crate::platform::config::load_str`], so a user can edit it under the config dir with no rebuild.
//!
//! The session's permissions are NOT written here — the frontend's `useLibrarianTerminal` renders the
//! `librarian` role capability (#219): none on every axis. It launches with `restrictedAllow: true`,
//! so the whole auto-runnable surface is `bsc graph` (the knowledge-graph CLI).

use crate::StrErr;

#[derive(serde::Serialize)]
pub(crate) struct LibrarianWorkspacePaths {
    // NB: Tauri does NOT rename RETURN-value fields — the frontend reads `algorithms_dir` verbatim.
    algorithms_dir: String,
}

/// Idempotently create the knowledge-store librarian workspace (`~/.base-studio-code/algorithms-studio/`)
/// and (re)write its `CLAUDE.md` from the packaged seed (`data/librarian/claude.md`, config-dir
/// overridable). Safe to call on every panel open — rewriting keeps the spec current with seed/config
/// updates, exactly as `setup_architect_workspace` refreshes the architect CLAUDE.md.
#[tauri::command]
pub(crate) fn setup_librarian_workspace() -> Result<LibrarianWorkspacePaths, String> {
    let dir = setup_librarian_workspace_inner(&crate::platform::paths::bsc_base_dir())?;
    Ok(LibrarianWorkspacePaths { algorithms_dir: dir.to_string_lossy().into_owned() })
}

/// Synchronous core of [`setup_librarian_workspace`] (testable without a Tauri runtime or the real
/// home dir): creates `<base>/algorithms-studio/` and writes its `CLAUDE.md` from the librarian seed.
pub(crate) fn setup_librarian_workspace_inner(base: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let dir = base.join("algorithms-studio");
    std::fs::create_dir_all(&dir).str_err()?;
    let spec = crate::platform::config::load_str("librarian/claude.md");
    if spec.trim().is_empty() {
        return Err("librarian/claude.md seed is missing or empty".to_string());
    }
    std::fs::write(dir.join("CLAUDE.md"), spec).str_err()?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bsc-librarian-ws-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ))
    }

    #[test]
    fn creates_the_workspace_and_writes_the_librarian_claude_md() {
        let base = scratch();
        let dir = setup_librarian_workspace_inner(&base).unwrap();
        assert_eq!(dir, base.join("algorithms-studio"));
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        // The written spec is exactly the loaded seed (config-dir copy or the embedded default).
        assert_eq!(md, crate::platform::config::load_str("librarian/claude.md"));
        assert!(!md.trim().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_idempotent_and_refreshes_the_spec_on_recall() {
        let base = scratch();
        let dir = setup_librarian_workspace_inner(&base).unwrap();
        // Simulate a stale spec from an older app — a re-run must refresh it, not error.
        std::fs::write(dir.join("CLAUDE.md"), "STALE").unwrap();
        let again = setup_librarian_workspace_inner(&base).unwrap();
        assert_eq!(again, dir);
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert_ne!(md, "STALE", "recall must rewrite the spec from the seed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The PACKAGED seed (ignoring any config-dir override) carries the content pillars: the `bsc graph`
    /// read AND write (#2853) command surface, the knowledge-graph model vocabulary, and the scope guard.
    #[test]
    fn packaged_librarian_spec_carries_surface_model_and_scope_guard() {
        let seed = crate::platform::config::embedded_str("librarian/claude.md");
        assert!(!seed.trim().is_empty(), "data/librarian/claude.md must be packaged");
        for needle in [
            "bsc graph",        // the knowledge-graph command surface
            "bsc graph list",   // the discovery verbs
            "bsc graph neighbors",
            "bsc graph path",
            "bsc graph extract", // the reality lens
            "bsc graph set",    // the write verbs (#2853) — the librarian must be TOLD how to curate
            "bsc graph link",
            "bsc graph remove",
            "concept",          // the knowledge-graph model vocabulary
            "relationship",
            "ONLY",             // the scope guard
        ] {
            assert!(seed.contains(needle), "librarian seed must mention `{needle}`");
        }
    }

    /// #3376 — the read-side companion to "Authoring: write, then apply". The seed must name the lean
    /// read verbs AND say WHY a redirect / chain / `$VAR` can never be allow-listed: a session that only
    /// learns "that was rejected" retries another variant of the same unmatchable shape.
    #[test]
    fn packaged_librarian_spec_teaches_reading_without_redirect_or_chain() {
        let seed = crate::platform::config::embedded_str("librarian/claude.md");
        for needle in [
            "Reading: never redirect, never chain",   // the section itself
            "bsc graph impl list --tech",             // narrow at the source, not a dump-and-filter
            "bsc graph dump",                         // the whole-store read, named as the last resort
            "simple_expansion",                       // WHY a `$VAR` can never match a rule
            "**every** subcommand must match a rule", // WHY a `;` / `|` chain can never match
            "scratch/**",                             // WHY a redirect is out of scope anyway
        ] {
            assert!(seed.contains(needle), "librarian seed must teach the reading term `{needle}`");
        }
    }
}
