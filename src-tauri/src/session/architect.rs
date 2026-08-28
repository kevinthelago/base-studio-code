//! Team-architect session workspace (#2755) — the Teams Studio's dedicated, heavily-restricted
//! session. Mirrors the designer workspace (`session::designer::setup_designer_workspace`) exactly:
//! one global workspace dir (`~/.base-studio-code/teams-studio/`) whose `CLAUDE.md` is the architect
//! spec — the team/persona model, the `bsc teams` · `bsc persona` · `bsc project link` ·
//! `bsc project architect` contract, and the scope guard bounding the session to those stores. The spec prose is a packaged seed under `data/architect/`
//! (externalized-config pattern, #2027) loaded via [`crate::platform::config::load_str`], so a user
//! can edit it under the config dir with no rebuild.
//!
//! The session's permissions are NOT written here — the frontend's `useArchitectTerminal` renders the
//! `architect` role capability (#219): none on every axis. It launches with `restrictedAllow: true`,
//! so the whole auto-runnable surface is `bsc teams`, `bsc persona`, `bsc project link` and
//! `bsc project architect`.


#[derive(serde::Serialize)]
pub(crate) struct ArchitectWorkspacePaths {
    // NB: Tauri does NOT rename RETURN-value fields — the frontend reads `teams_dir` verbatim.
    teams_dir: String,
}

/// Idempotently create the team-architect workspace (`~/.base-studio-code/teams-studio/`) and
/// (re)write its `CLAUDE.md` from the packaged seed (`data/architect/claude.md`, config-dir
/// overridable). Safe to call on every panel open — rewriting keeps the spec current with seed/config
/// updates, exactly as `setup_designer_workspace` refreshes the designer CLAUDE.md.
/// `context` is the session's own prose — persona, scope, and how to see what the user is looking
/// at — appended to the packaged spec IN THE FILE. It used to be typed into the chat as claude's
/// first message, which made identity indistinguishable from conversation and re-sent it every launch.
#[tauri::command]
pub(crate) fn setup_architect_workspace(
    context: Option<String>,
) -> Result<ArchitectWorkspacePaths, String> {
    let dir = setup_architect_workspace_inner(&crate::platform::paths::bsc_base_dir(), None, context.as_deref())?;
    Ok(ArchitectWorkspacePaths { teams_dir: dir.to_string_lossy().into_owned() })
}

/// Synchronous core of [`setup_architect_workspace`] (testable without a Tauri runtime or the real
/// home dir): creates `<base>/teams-studio/` and writes its `CLAUDE.md` from the architect seed.
pub(crate) fn setup_architect_workspace_inner(
    base: &std::path::Path,
    tech: Option<&str>,
    context: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    super::studio_ws::setup_studio_workspace(base, "teams-studio", tech, "architect/claude.md", context)
}

#[derive(serde::Serialize)]
pub(crate) struct NetworkArchitectWorkspacePaths {
    // NB: Tauri does NOT rename RETURN-value fields — the frontend reads `network_dir` verbatim.
    network_dir: String,
}

/// Idempotently create ONE NETWORK's architect workspace and (re)write its `CLAUDE.md` from the same
/// packaged architect seed the Teams Studio uses.
///
/// A network is a domain that owns a set of projects and exactly one architect — the session that runs
/// discovery for each of them and creates their directors. Each network gets its OWN workspace dir, so
/// each gets its own `claude --continue` history: two networks are two conversations, which is the
/// whole point of separating concerns by network rather than sharing one architect across everything.
///
/// The argument is the PANE ID (`network-<slug>:architect`), not a bare slug, so the directory can only
/// be derived from a string that already passed [`bsc_session::network_architect_slug`]. One validator,
/// and the caller passes exactly what it is about to mount — there is no second place for the two to
/// disagree about which network this is.
#[tauri::command]
pub(crate) fn setup_network_architect_workspace(
    pane_id: String,
    context: Option<String>,
) -> Result<NetworkArchitectWorkspacePaths, String> {
    let dir = setup_network_architect_workspace_inner(
        &crate::platform::paths::bsc_base_dir(),
        &pane_id,
        context.as_deref(),
    )?;
    Ok(NetworkArchitectWorkspacePaths { network_dir: dir.to_string_lossy().into_owned() })
}

/// Synchronous core of [`setup_network_architect_workspace`] — creates `<base>/networks/<slug>/`.
pub(crate) fn setup_network_architect_workspace_inner(
    base: &std::path::Path,
    pane_id: &str,
    context: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let slug = bsc_session::network_architect_slug(pane_id).ok_or_else(|| {
        format!("'{pane_id}' is not a network architect pane (expected `network-<slug>:architect`)")
    })?;
    super::studio_ws::setup_studio_workspace(
        base,
        &format!("networks/{slug}"),
        None,
        "architect/claude.md",
        context,
    )
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
        // #3479 — pin the config root for this thread; unpinned, `load_str` resolves through the
        // process-global home that `testutil::temp_home` repoints mid-run. See
        // `platform::config::with_config_root`.
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let dir = setup_architect_workspace_inner(&base, None, None).unwrap();
            assert_eq!(dir, base.join("teams-studio"));
            let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
            // The written spec is exactly the loaded seed (here the embedded default).
            assert_eq!(md, crate::platform::config::load_str("architect/claude.md"));
            assert!(!md.trim().is_empty());
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    /// TWO NETWORKS ARE TWO CONVERSATIONS. Each network's architect gets its own workspace dir, and
    /// therefore its own `claude --continue` history — which is the entire reason for separating
    /// concerns by network instead of sharing one architect across every project. A shared directory
    /// would have made them one session wearing two names.
    #[test]
    fn each_network_gets_its_own_architect_workspace() {
        let base = scratch();
        let cfg = base.join("config");
        crate::platform::config::with_config_root(&cfg, || {
            let kitchen = setup_network_architect_workspace_inner(&base, "network-kitchen:architect", None).unwrap();
            let finance = setup_network_architect_workspace_inner(&base, "network-finance:architect", None).unwrap();

            assert_eq!(kitchen, base.join("networks").join("kitchen"));
            assert_eq!(finance, base.join("networks").join("finance"));
            assert_ne!(kitchen, finance, "two networks must not share a conversation");

            // Both are seeded from the SAME packaged architect charter — a network's architect is the
            // same role, pointed at a different domain.
            for dir in [&kitchen, &finance] {
                let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
                assert_eq!(md, crate::platform::config::load_str("architect/claude.md"));
            }
            // ...and it is NOT the Teams Studio's directory, which keeps its own separate session.
            assert!(!kitchen.starts_with(base.join("teams-studio")));
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The directory is derived only from a pane id that already passed the session grammar, so a
    /// hostile or malformed one cannot reach the filesystem. One validator, not two.
    #[test]
    fn a_malformed_network_pane_id_creates_no_directory() {
        let base = scratch();
        for bad in [
            "network-:architect", "network-kitchen", "network-kitchen:director",
            "network-../escape:architect", "teams-studio:architect", "", "kitchen",
        ] {
            assert!(
                setup_network_architect_workspace_inner(&base, bad, None).is_err(),
                "{bad} must be refused before it names a directory",
            );
        }
        assert!(!base.join("networks").exists(), "no directory was created for any refused id");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn is_idempotent_and_refreshes_the_spec_on_recall() {
        let base = scratch();
        let dir = setup_architect_workspace_inner(&base, None, None).unwrap();
        // Simulate a stale spec from an older app — a re-run must refresh it, not error.
        std::fs::write(dir.join("CLAUDE.md"), "STALE").unwrap();
        let again = setup_architect_workspace_inner(&base, None, None).unwrap();
        assert_eq!(again, dir);
        let md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
        assert_ne!(md, "STALE", "recall must rewrite the spec from the seed");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The PACKAGED seed (ignoring any config-dir override) carries the content pillars the issue
    /// requires: the command surfaces (`bsc teams` · `bsc persona` · `bsc project link` ·
    /// `bsc project architect`), the team/persona model, and the scope guard that bounds them.
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
            // The MODEL surface (a-model-cannot-be-chosen-from-the-command-surface): both verbs, and
            // the fact that naming NOTHING is the default. An architect that knows only `persona set`
            // would round-trip a whole record to change one tier, which is the loss `model` prevents.
            "bsc persona model",
            "bsc teams model",
            "haiku-4.5",
        ] {
            assert!(seed.contains(needle), "architect seed must mention `{needle}`");
        }

        // THE GUARD IS A BOUNDARY, NOT A REFUSAL — and getting that backwards is what broke the
        // architect (`the-architect-runs-discovery-and-spawns-a-director`).
        //
        // This block used to pin a scope guard reading "you work on these stores and nothing else …
        // if asked for anything outside those stores, refuse briefly and point the user back to the
        // appropriate surface (the planner for planning)". Every one of those assertions passed while
        // the session was doing the wrong thing: discovery had been moved ONTO the architect, and the
        // guard was still telling it to decline discovery and redirect to a session that no longer
        // exists. A user arriving to plan an application was refused, correctly, by a stale rule.
        //
        // So what is pinned now is the boundary that is actually true: the architect's job is the
        // conversation, and what it must not do is write the plan itself. The old redirect is asserted
        // ABSENT, because its presence is the regression.
        assert!(seed.contains("READ FIRST"), "the guard must lead the file — it is read top-down");
        for bounded in ["bsc project link", "bsc project architect"] {
            assert!(seed.contains(bounded), "the guard must name the `{bounded}` surface it bounds");
        }
        assert!(
            seed.contains("do not write") || seed.contains("do **not** write"),
            "the guard must state what is OUT of scope, not only what is in it",
        );
        // The whole arc, so the seed cannot describe a tier that stops before the handoff.
        for step in ["bsc plan requirement set", "bsc plan classify", "bsc project new", "bsc fleet director new"] {
            assert!(seed.contains(step), "the architect seed must name `{step}` — it is its own job");
        }
        // The research surface it actually has. Both servers are in the session's `.mcp.json`; the seed
        // used to mention neither and to claim it had no network, so a shipped capability was
        // disclaimed in prose and the "propose, don't interrogate" method had nothing to stand on.
        for server in ["Research", "Compliance"] {
            assert!(seed.contains(server), "the seed must name the `{server}` MCP server it is given");
        }
        // The regressions, asserted as ABSENCES. Each of these sentences was individually true once and
        // is now the bug: they send the user to a deleted planner, or deny a capability that is wired.
        for gone in ["the planner for planning", "you have no network", "No project planning"] {
            assert!(!seed.contains(gone), "the architect seed must not still say `{gone}`");
        }
    }

    /// #3376 — the read-side companion to "Authoring: write, then apply". The seed must name the lean
    /// read verbs AND say WHY a redirect / chain / `$VAR` can never be allow-listed: a session that only
    /// learns "that was rejected" retries another variant of the same unmatchable shape.
    #[test]
    fn packaged_architect_spec_teaches_reading_without_redirect_or_chain() {
        let seed = crate::platform::config::embedded_str("architect/claude.md");
        for needle in [
            "Reading: never redirect, never chain",   // the section itself
            "bsc teams list --raw",                   // the byte-clean id lists
            "bsc persona list --raw",
            "bsc teams get <id>",                     // the one-record read
            "simple_expansion",                       // WHY a `$VAR` can never match a rule
            "**every** subcommand must match a rule", // WHY a `;` / `|` chain can never match
            "scratch/**",                             // WHY a redirect is out of scope anyway
        ] {
            assert!(seed.contains(needle), "architect seed must teach the reading term `{needle}`");
        }
    }
}
