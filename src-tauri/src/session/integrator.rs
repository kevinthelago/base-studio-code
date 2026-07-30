//! Integration-studio integrator session workspace (#4023) — the app's dedicated session for BUILDING
//! and MAINTAINING an integration with an existing application or API. Mirrors the librarian workspace
//! (`session::librarian::setup_librarian_workspace`) exactly: one global workspace dir
//! (`~/.base-studio-code/integration-studio/`) whose `CLAUDE.md` is the integrator spec — the
//! probe→validate→try→register loop, the `bsc data connector` contract, and the never-handle-credentials
//! rule. The spec prose is a packaged seed under `data/integrator/` (externalized-config pattern, #2027)
//! loaded via [`crate::platform::config::load_str`], so a user can edit it under the config dir with no
//! rebuild.
//!
//! The session's permissions are NOT written here — the frontend renders the `integrator` role
//! capability (#219): none on git/GitHub/code/ui with a `scratch/**` carve-out, and `net: "read"` — the
//! ONE widening over its studio siblings, because this role's work starts at the vendor's documentation.
//! It launches with `restrictedAllow: true`, so the whole auto-runnable surface is `bsc data connector`.

use crate::StrErr;

#[derive(serde::Serialize)]
pub(crate) struct IntegratorWorkspacePaths {
    // NB: Tauri does NOT rename RETURN-value fields — the frontend reads `integrations_dir` verbatim.
    integrations_dir: String,
}

/// Idempotently create the integrator workspace (`~/.base-studio-code/integration-studio/`) and
/// (re)write its `CLAUDE.md` from the packaged seed (`data/integrator/claude.md`, config-dir
/// overridable). Safe to call on every panel open — rewriting keeps the spec current with seed/config
/// updates, exactly as `setup_librarian_workspace` refreshes the librarian CLAUDE.md.
#[tauri::command]
pub(crate) fn setup_integrator_workspace() -> Result<IntegratorWorkspacePaths, String> {
    let dir = setup_integrator_workspace_inner(&crate::platform::paths::bsc_base_dir())?;
    Ok(IntegratorWorkspacePaths { integrations_dir: dir.to_string_lossy().into_owned() })
}

/// Synchronous core of [`setup_integrator_workspace`] (testable without a Tauri runtime or the real
/// home dir): creates `<base>/integration-studio/` and writes its `CLAUDE.md` from the integrator seed.
pub(crate) fn setup_integrator_workspace_inner(base: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let dir = base.join("integration-studio");
    std::fs::create_dir_all(&dir).str_err()?;
    let spec = crate::platform::config::load_str("integrator/claude.md");
    if spec.trim().is_empty() {
        return Err("integrator/claude.md seed is missing or empty".to_string());
    }
    std::fs::write(dir.join("CLAUDE.md"), spec).str_err()?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "bsc-integrator-ws-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        ))
    }

    #[test]
    fn creates_the_workspace_and_writes_the_integrator_claude_md() {
        let base = scratch();
        // #3479 — pin the config root for this thread; unpinned, `load_str` resolves through the
        // process-global home that `testutil::temp_home` repoints mid-run.
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let dir = setup_integrator_workspace_inner(&base).unwrap();
            assert_eq!(dir, base.join("integration-studio"));
            let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
            assert_eq!(md, crate::platform::config::load_str("integrator/claude.md"));
            assert!(!md.trim().is_empty());
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_idempotent_and_refreshes_the_spec_on_recall() {
        let base = scratch();
        let dir = setup_integrator_workspace_inner(&base).unwrap();
        // Simulate a stale spec from an older app — a re-run must refresh it, not error.
        std::fs::write(dir.join("CLAUDE.md"), "STALE").unwrap();
        let again = setup_integrator_workspace_inner(&base).unwrap();
        assert_eq!(again, dir);
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert_ne!(md, "STALE", "recall must rewrite the spec from the seed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The packaged spec must actually teach the loop the studio exists for. A seed that dropped the
    /// dev-loop verbs, or the credentials rule, would leave the session with a role but no procedure.
    #[test]
    fn the_packaged_spec_names_the_connector_loop_and_the_credentials_rule() {
        let md = crate::platform::config::load_str("integrator/claude.md");
        for verb in ["probe", "validate", "try", "add", "map"] {
            assert!(
                md.contains(&format!("bsc data connector {verb}")),
                "spec must name `bsc data connector {verb}`",
            );
        }
        let lower = md.to_lowercase();
        assert!(lower.contains("secret-free"), "spec must state the manifest is secret-free");
        assert!(lower.contains("keychain"), "spec must say credentials resolve from the keychain");
        assert!(lower.contains("read-only"), "spec must state the probe/try loop is read-only");
    }
}
