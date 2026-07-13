//! Designer session workspace (#2471) — the Design Studio's dedicated, heavily-restricted terminal
//! session. Mirrors the planner-hub pattern (`planner::workspace::setup_workspaces`) at a fraction of
//! the size: one global workspace dir (`~/.base-studio-code/design-studio/`) whose `CLAUDE.md` is the
//! designer spec — the kit model, the `bsc ui` contract, and the "UI kits only" scope guard. The spec
//! prose is a packaged seed under `data/designer/` (externalized-config pattern, #2027) loaded via
//! [`crate::platform::config::load_str`], so a user can edit it under the config dir with no rebuild.
//!
//! The session's permissions are NOT written here — the frontend's `useDesignerTerminal` renders the
//! `designer` role capability (#219) into `ensure_session_settings` with `restrictedAllow: true`, so
//! the whole auto-runnable surface is `bsc ui` (+ the deprecated `bsc component` alias).

use crate::StrErr;

#[derive(serde::Serialize)]
pub(crate) struct DesignerWorkspacePaths {
    // NB: Tauri does NOT rename RETURN-value fields — the frontend reads `design_dir` verbatim.
    design_dir: String,
}

/// Idempotently create the designer workspace (`~/.base-studio-code/design-studio/`) and (re)write
/// its `CLAUDE.md` from the packaged seed (`data/designer/claude.md`, config-dir overridable). Safe
/// to call on every panel open — rewriting keeps the spec current with seed/config updates, exactly
/// as `setup_workspaces` refreshes the planner CLAUDE.md.
#[tauri::command]
pub(crate) fn setup_designer_workspace() -> Result<DesignerWorkspacePaths, String> {
    let dir = setup_designer_workspace_inner(&crate::platform::paths::bsc_base_dir())?;
    Ok(DesignerWorkspacePaths { design_dir: dir.to_string_lossy().into_owned() })
}

/// Synchronous core of [`setup_designer_workspace`] (testable without a Tauri runtime or the real
/// home dir): creates `<base>/design-studio/` and writes its `CLAUDE.md` from the designer seed.
pub(crate) fn setup_designer_workspace_inner(base: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let dir = base.join("design-studio");
    std::fs::create_dir_all(&dir).str_err()?;
    let spec = crate::platform::config::load_str("designer/claude.md");
    if spec.trim().is_empty() {
        return Err("designer/claude.md seed is missing or empty".to_string());
    }
    std::fs::write(dir.join("CLAUDE.md"), spec).str_err()?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bsc-designer-ws-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ))
    }

    #[test]
    fn creates_the_workspace_and_writes_the_designer_claude_md() {
        let base = scratch();
        let dir = setup_designer_workspace_inner(&base).unwrap();
        assert_eq!(dir, base.join("design-studio"));
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        // The written spec is exactly the loaded seed (config-dir copy or the embedded default).
        assert_eq!(md, crate::platform::config::load_str("designer/claude.md"));
        assert!(!md.trim().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_idempotent_and_refreshes_the_spec_on_recall() {
        let base = scratch();
        let dir = setup_designer_workspace_inner(&base).unwrap();
        // Simulate a stale spec from an older app — a re-run must refresh it, not error.
        std::fs::write(dir.join("CLAUDE.md"), "STALE").unwrap();
        let again = setup_designer_workspace_inner(&base).unwrap();
        assert_eq!(again, dir);
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert_ne!(md, "STALE", "recall must rewrite the spec from the seed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The PACKAGED seed (ignoring any config-dir override) carries the three content pillars the
    /// issue requires: the kit model, the `bsc ui` contract, and the scope guard.
    #[test]
    fn packaged_designer_spec_carries_kit_model_contract_and_scope_guard() {
        let seed = crate::platform::config::embedded_str("designer/claude.md");
        assert!(!seed.trim().is_empty(), "data/designer/claude.md must be packaged");
        for needle in [
            "bsc ui",            // the one command surface
            "bsc ui schema",     // the contract verbs
            "bsc ui validate",
            "bsc ui theme",
            "bsc component",     // the deprecated alias, named so the session knows it
            "composes",          // the kit model vocabulary
            "variants",
            "wraps",
            "ONLY",              // the scope guard
        ] {
            assert!(seed.contains(needle), "designer seed must mention `{needle}`");
        }
    }

    /// #3020 — the seed must make the component-IMPLEMENTATION responsibility EXPLICIT and UP FRONT
    /// (not only reactively, via the `doctor` "no buildable implementation" finding): authoring a
    /// component means providing its buildable `srcText` module, or the designer authors
    /// implementation-less records and only learns the rule when `doctor` scolds it.
    #[test]
    fn packaged_designer_spec_makes_component_implementation_responsibility_explicit() {
        let seed = crate::platform::config::embedded_str("designer/claude.md");
        for needle in [
            "needs a real implementation", // the responsibility, stated positively in rung 4
            "implementation",              // named up front, not only in the doctor finding
            "srcText",                     // where the module lives
            "self-contained module",       // the contract
            "previews live",               // the done bar
        ] {
            assert!(
                seed.contains(needle),
                "designer seed must state the implementation-responsibility term `{needle}`"
            );
        }
    }

    /// The graduated `bsc ui` ladder (#2585): the seed must teach the discover→tune→author flow —
    /// the discovery verbs, the per-rung edit verbs, and the ladder mental model itself — or the
    /// designer LLM never learns the runtime design loop exists.
    #[test]
    fn packaged_designer_spec_teaches_the_graduated_ui_ladder() {
        let seed = crate::platform::config::embedded_str("designer/claude.md");
        for needle in [
            "ladder",            // the mental model
            "bsc ui tokens",     // discover: the palette
            "bsc ui components", // discover: per-component token keys
            "set-token",         // rungs 1–2: tune a token live
            "define-variant",    // rung 3: author a new look as data
            "highest rung",      // default-to-the-highest-rung rule
        ] {
            assert!(seed.contains(needle), "designer seed must teach the ladder term `{needle}`");
        }
    }
}
