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

    /// Every `bsc graph <token>` the packaged seed names, in prose or in a code block: the token that
    /// follows the literal `bsc graph `, stripped of the markdown punctuation that can trail it
    /// (backtick, comma, backslash, period, closing paren). A bare `` `bsc graph` `` mention yields the
    /// next prose word, so callers filter to the tokens they care about rather than trusting all of them.
    fn documented_graph_tokens(seed: &str) -> Vec<String> {
        seed.match_indices("bsc graph ")
            .map(|(i, m)| seed[i + m.len()..].split_whitespace().next().unwrap_or_default())
            .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric() && c != '-').to_string())
            .filter(|t| !t.is_empty())
            .collect()
    }

    /// The PACKAGED seed (ignoring any config-dir override) teaches ONLY verbs the CLI actually has.
    ///
    /// #3391: this is the drift-catching direction, and the one that was missing. The old test asserted
    /// a hand-written list of verb NAMES, so when #2961 deleted the concept ontology (`list`/`neighbors`/
    /// `path`/`link`) the prose and the test stayed agreed with each other and both diverged from the
    /// CLI — a green gate over a spec that sent the librarian at verbs its CLI rejects. Deriving the
    /// legal set from `bsc_graph::cli::VERBS` means a removed or renamed verb fails HERE, in the spec
    /// that teaches it, instead of silently at runtime.
    #[test]
    fn packaged_librarian_spec_names_only_verbs_the_cli_has() {
        let seed = crate::platform::config::embedded_str("librarian/claude.md");
        assert!(!seed.trim().is_empty(), "data/librarian/claude.md must be packaged");

        // The verbs the prose actually invokes — a `bsc graph <verb>` token that is not a prose word.
        // Anything the CLI would reject with "unknown graph command" must never appear in the spec.
        let invoked: Vec<String> = documented_graph_tokens(&seed)
            .into_iter()
            .filter(|t| !t.starts_with('-'))
            .collect();
        assert!(!invoked.is_empty(), "the seed must actually invoke `bsc graph`");
        for verb in &invoked {
            assert!(
                bsc_graph::cli::VERBS.contains(&verb.as_str()),
                "librarian seed teaches `bsc graph {verb}`, which the CLI does not have \
                 (legal verbs: {:?}) — the spec drifted from crates/bsc-graph/src/cli.rs",
                bsc_graph::cli::VERBS,
            );
        }

        // Every `impl` subverb must be taught: they ARE the librarian's read+write surface, so an
        // undocumented one is a capability the session never learns it has.
        for sub in bsc_graph::cli::IMPL_SUBVERBS {
            assert!(
                seed.contains(&format!("bsc graph impl {sub}")),
                "librarian seed must teach `bsc graph impl {sub}`",
            );
        }

        // Flags are the whole payload surface of `impl set`, so the same rule applies in reverse:
        // no flag may be documented that the CLI does not read.
        for flag in seed.split_whitespace().filter(|w| w.starts_with("--") && w.len() > 2) {
            let flag = flag.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
            if flag.starts_with("--") {
                assert!(
                    bsc_graph::cli::FLAGS.contains(&flag),
                    "librarian seed documents `{flag}`, which `bsc graph` does not read \
                     (legal flags: {:?})",
                    bsc_graph::cli::FLAGS,
                );
            }
        }
    }

    /// The prose pillars that are genuinely prose, not a derivable surface: the impl-only model
    /// vocabulary (#2961 — a node IS its implementation) and the scope guard.
    #[test]
    fn packaged_librarian_spec_carries_the_impl_only_model_and_scope_guard() {
        let seed = crate::platform::config::embedded_str("librarian/claude.md");
        for needle in [
            "implementation-only", // the #2961 model — NOT a concept ontology
            "primitive",           // the two roles an implementation carries
            "algorithm",
            "composes",  // the edge vocabulary that replaced `relationship`
            "vizCode",   // #3213 — an algorithm is not done until it can be SEEN
            "ONLY",      // the scope guard
        ] {
            assert!(seed.contains(needle), "librarian seed must carry `{needle}`");
        }
        // The concept ontology was DELETED in #2961 — the spec must never teach it back.
        assert!(
            !seed.contains("concept ontology") || seed.contains("no separate abstract concept"),
            "the seed may only mention the concept ontology to say it does NOT exist",
        );
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
