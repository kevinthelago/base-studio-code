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


#[derive(serde::Serialize)]
pub(crate) struct DesignerWorkspacePaths {
    // NB: Tauri does NOT rename RETURN-value fields — the frontend reads `design_dir` verbatim.
    design_dir: String,
}

/// Idempotently create the designer workspace (`~/.base-studio-code/design-studio/`) and (re)write
/// its `CLAUDE.md` from the packaged seed (`data/designer/claude.md`, config-dir overridable). Safe
/// to call on every panel open — rewriting keeps the spec current with seed/config updates, exactly
/// as `setup_workspaces` refreshes the planner CLAUDE.md.
/// `tech` gives the studio its own sub-directory, so its `CLAUDE.md` can carry its own scope and
/// its conversation is its own — the two designers used to share both.
/// `context` is the session's own prose — persona, scope, and how to see what the user is looking
/// at — appended to the packaged spec IN THE FILE. It used to be typed into the chat as claude's
/// first message, which made identity indistinguishable from conversation and re-sent it every launch.
#[tauri::command]
pub(crate) fn setup_designer_workspace(
    tech: Option<String>,
    context: Option<String>,
) -> Result<DesignerWorkspacePaths, String> {
    let dir = setup_designer_workspace_inner(&crate::platform::paths::bsc_base_dir(), tech.as_deref(), context.as_deref())?;
    Ok(DesignerWorkspacePaths { design_dir: dir.to_string_lossy().into_owned() })
}

/// Synchronous core of [`setup_designer_workspace`] (testable without a Tauri runtime or the real
/// home dir): creates `<base>/design-studio/` and writes its `CLAUDE.md` from the designer seed.
pub(crate) fn setup_designer_workspace_inner(
    base: &std::path::Path,
    tech: Option<&str>,
    context: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    super::studio_ws::setup_studio_workspace(base, "design-studio", tech, "designer/claude.md", context)
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

    /// The spec must describe the surface the CAGE gives, not only the `bsc ui` verbs.
    ///
    /// This is the item's third acceptance criterion, and it is why the designer had to be let out
    /// of its cage at all: the persona said "your ONLY surface is `bsc ui`" and the cage has no
    /// `bsc`, so every session died on its first instructed command. Shape only — the commands are
    /// EXECUTED in a real cage by `the_designer_specs_caged_commands_run_inside_the_cage`.
    #[test]
    fn the_spec_describes_the_surface_the_cage_actually_provides() {
        let md = crate::platform::config::embedded_str("designer/claude.md");

        for path in ["/ui/components", "/ui/out", "/ui/schema"] {
            assert!(md.contains(path), "the caged section must name {path}");
        }
        // The SOURCE tier specifically: it is the thing whose absence made the cage unusable.
        assert!(
            md.contains("/ui/components/<id>/srcText"),
            "a caged designer must be told where to read the source it edits",
        );
        // The premise, stated where the designer meets it — absence of `bsc` is the SIGNAL.
        assert!(md.contains("command -v bsc"), "tells the designer which world it is in");
        // ...and the honest limit, so it does not discover it by failing.
        assert!(
            md.contains("no caged equivalent yet"),
            "rungs 1-3 and 5 have no outbox; say so rather than letting it be found by failing",
        );

        // The persona must agree with the spec — it is read FIRST, and it used to assert an
        // exclusivity that was false in the cage.
        let persona = crate::platform::config::embedded_str("personas/designer.json");
        assert!(
            persona.contains("/ui/out"),
            "the persona's one-surface claim must cover the caged form too",
        );
    }

    #[test]
    fn creates_the_workspace_and_writes_the_designer_claude_md() {
        let base = scratch();
        // #3479 — pin the config root to an EMPTY dir for this thread, so the spec resolves to the
        // embedded seed deterministically. Unpinned, `load_str` reads through the process-global
        // `HOME`/`USERPROFILE`, which `testutil::temp_home` repoints for the whole process at some
        // unpredictable moment; the write below and the read-back could then straddle the flip and
        // compare two different specs. See `platform::config::with_config_root`.
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let dir = setup_designer_workspace_inner(&base, None, None).unwrap();
            assert_eq!(dir, base.join("design-studio"));
            let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
            // The written spec is exactly the loaded seed (here the embedded default — the
            // config-dir-copy-wins leg is `config::tests::load_from_prefers_the_on_disk_copy_…`).
            assert_eq!(md, crate::platform::config::load_str("designer/claude.md"));
            assert!(!md.trim().is_empty());
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    /// #3479 regression — the spec that lands is the one the PINNED config root resolves, never a
    /// function of whatever home a sibling test happens to have set process-wide by then.
    #[test]
    fn the_written_spec_follows_the_pinned_config_root() {
        let base = scratch();
        let cfg = base.join("config");
        std::fs::create_dir_all(cfg.join("designer")).unwrap();
        std::fs::write(cfg.join("designer").join("claude.md"), "PINNED CONFIG COPY\n").unwrap();
        crate::platform::config::with_config_root(&cfg, || {
            let dir = setup_designer_workspace_inner(&base, None, None).unwrap();
            assert_eq!(
                std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
                "PINNED CONFIG COPY\n",
                "the pinned config-dir copy is what the workspace gets, whatever HOME is in force",
            );
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_idempotent_and_refreshes_the_spec_on_recall() {
        let base = scratch();
        let dir = setup_designer_workspace_inner(&base, None, None).unwrap();
        // Simulate a stale spec from an older app — a re-run must refresh it, not error.
        std::fs::write(dir.join("CLAUDE.md"), "STALE").unwrap();
        let again = setup_designer_workspace_inner(&base, None, None).unwrap();
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
            "bsc graph impl list",   // #2940: reuse-first before commissioning the librarian
            "bsc-commission librarian", // #2940: the studio-network data-generation channel
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

    /// #3024 — a rule alone didn't land (the designer authored D3 components whose `srcText` just
    /// calls itself). The seed must carry a CONCRETE worked example of a complete component module
    /// AND spell out the self-reference / usage-snippet anti-pattern, since models imitate examples
    /// far more reliably than rules.
    #[test]
    fn packaged_designer_spec_shows_a_complete_component_example_and_the_self_reference_antipattern() {
        let seed = crate::platform::config::embedded_str("designer/claude.md");
        for needle in [
            "```tsx",            // a real code example is present, not just prose
            "useEffect",         // the ✅ example carries actual render logic (not a stub)
            "self-reference",    // the anti-pattern named
            "calls itself",      // the exact failure phrasing the user hit
            "❌",                // the wrong-way example is called out
        ] {
            assert!(
                seed.contains(needle),
                "designer seed must carry the complete-component example / anti-pattern term `{needle}`"
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

    /// The DISCOVER-BEFORE-AUTHORING routing. The seed's rule was always right — one component per job —
    /// but it pointed at `bsc ui list`, a NAME search, and a name is the one signal a structural
    /// duplicate defeats: five identically-built settings cards are named after their subject and share
    /// no substring. Measured, a session authored a sixth and `similar --shape` scored it 100% against
    /// four existing records while the write returned exit 0 in silence. If this routing rots back to a
    /// name search the library bloats again, so the terms are pinned.
    #[test]
    fn packaged_designer_spec_routes_discovery_at_authoring_time() {
        let seed = crate::platform::config::embedded_str("designer/claude.md");
        for needle in [
            "Before you author: ask the graph what already exists", // the section, at Rung 4
            "bsc ui patterns",            // the conventions sweep
            "--shape",                    // the name-blind similarity mode
            "bsc ui exports",             // the one-record-one-item check
            "bsc ui pattern list",        // the NAMED conventions — instantiate, never copy a sibling
            "bsc ui pattern new",         // and NAME an unnamed one, so the next session need not copy
            "NAME SEARCH WILL NOT FIND",  // WHY `bsc ui list` is the wrong tool here
            "SandboxedConsolesCard",      // the measured example, so the rule carries its evidence
        ] {
            assert!(seed.contains(needle), "designer seed must teach the discovery term `{needle}`");
        }
        // The routing is only worth anything if it fires BEFORE the write. `bsc ui patterns` must be
        // taught at Rung 4 (authoring), not merely down in the graph-health cleanup section.
        let authoring = seed.find("## Rung 4").expect("Rung 4 section");
        let cleanup = seed.find("## Graph health").expect("graph-health section");
        let patterns = seed.find("bsc ui patterns").expect("patterns verb");
        assert!(
            patterns > authoring && patterns < cleanup,
            "`bsc ui patterns` must be taught where authoring happens, not only where cleanup does",
        );
    }

    /// #3376 — the read-side companion to "Authoring: write, then apply". The seed must name the lean
    /// read verbs AND say WHY a redirect / chain / `$VAR` can never be allow-listed: a session that only
    /// learns "that was rejected" retries another variant of the same unmatchable shape.
    #[test]
    fn packaged_designer_spec_teaches_reading_without_redirect_or_chain() {
        let seed = crate::platform::config::embedded_str("designer/claude.md");
        for needle in [
            "Reading: never redirect, never chain",   // the section itself
            "bsc ui list --raw",                      // the byte-clean id list, not a dump-and-filter
            "bsc ui get <id>",                        // the one-record read
            "--field",                                // the one-field read
            "simple_expansion",                       // WHY a `$VAR` can never match a rule
            "**every** subcommand must match a rule", // WHY a `;` / `|` chain can never match
            "scratch/**",                             // WHY a redirect is out of scope anyway
        ] {
            assert!(seed.contains(needle), "designer seed must teach the reading term `{needle}`");
        }
    }
}
