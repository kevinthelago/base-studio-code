use crate::StrErr;
use super::prompts::*;
use super::directives::*;
use crate::{PerfSpan, sanitize_project_key, planning_cwd, repo_dir};

#[derive(serde::Deserialize)]
pub(crate) struct AutomationData {
    id:       String,
    name:     String,
    command:  String,
    schedule: Option<String>,
}
#[derive(serde::Serialize)]
pub(crate) struct WorkspacePaths {
    planning_dir: String,
}
/// The inputs to [`setup_workspaces`], grouped so the planner-hub setup is driven by one named
/// value instead of a dozen positional arguments — and so the core [`setup_workspaces_inner`] is
/// testable without a Tauri runtime. Owns its fields (built once from the command's owned args).
pub(crate) struct SetupWorkspacesArgs {
    pub repo_full_names: Vec<String>,
    pub automations: Vec<AutomationData>,
    pub is_existing: bool,
    pub project_name: String,
    pub project_number: u32,
    pub pitch: String,
    pub project_key: String,
    pub github_login: String,
    pub github_name: String,
    pub enabled_stages: Vec<String>,
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // wire contract: the frontend passes these as named invoke args.
pub(crate) fn setup_workspaces(
    repo_full_names: Vec<String>,
    automations: Vec<AutomationData>,
    is_existing: bool,
    project_name: String,
    project_number: u32,
    pitch: String,
    project_key: String,
    github_login: String,
    github_name: String,
    enabled_stages: Vec<String>,
) -> Result<WorkspacePaths, String> {
    setup_workspaces_inner(SetupWorkspacesArgs {
        repo_full_names,
        automations,
        is_existing,
        project_name,
        project_number,
        pitch,
        project_key,
        github_login,
        github_name,
        enabled_stages,
    })
}
/// Synchronous core of [`setup_workspaces`] (testable without a Tauri runtime): creates the planner
/// hub (`projects/<key>`), migrates a legacy `context/` dir, and writes the planner `CLAUDE.md` +
/// `automations.md` + `github_context.md` + `context_signature.txt`.
pub(crate) fn setup_workspaces_inner(args: SetupWorkspacesArgs) -> Result<WorkspacePaths, String> {
    let SetupWorkspacesArgs {
        repo_full_names,
        automations,
        is_existing,
        project_name,
        project_number,
        pitch,
        project_key,
        github_login,
        github_name,
        enabled_stages,
    } = args;
    let _perf = PerfSpan::new("setup_workspaces");
    crate::session::claude_config::sanitize_claude_config();
    // Planner session CWD (#2997) = the EXISTING hub (`projects/<key>`) when it's already on disk, else
    // the ephemeral `planning/<key>` workspace, so a never-launched greenfield draft leaves no
    // half-baked hub behind. Either way it holds the plan sections + control files FLAT alongside the
    // project's CLAUDE.md, and `materialize_hub` promotes an ephemeral workspace into the real hub at
    // fleet launch.
    let safe_key     = sanitize_project_key(&project_key);
    // A blank key would resolve the project dir to `projects/` itself and scatter
    // `.claude/` and the plan sections across the parent — refuse it instead.
    if safe_key.is_empty() {
        return Err("setup_workspaces: empty project_key".to_string());
    }
    let planning_dir = planning_cwd(&project_key);

    // Runtime-fault instrumentation (#2262, epic #2258): mint + persist the durable per-project ingest
    // token at GENERATION so it exists before any session launches. The session env wiring then exports
    // it as `$BSC_INGEST_TOKEN` (console/pty/env.rs), the planner bakes it into the app's fault shim at
    // the Deployment stage, and the localhost collector validates a running app's fault/heartbeat POST
    // against this same durable file. Idempotent — an existing token is reused (a baked shim keeps
    // validating across re-setup + desktop restarts). Best-effort: token minting must never fail hub
    // setup, so a write error is swallowed (the shim simply lacks a token until the next generation).
    let _ = crate::observability::collector::mint_ingest_token(&project_key);

    for dir in &[
        planning_dir.join(".claude"),
        planning_dir.join("prompts"),
        // Integration contracts (#…): the Plan stage writes one doc per feature seam here;
        // the director owns + tests them, workers read them as the source of truth.
        planning_dir.join("contracts"),
    ] {
        std::fs::create_dir_all(dir).str_err()?;
    }
    // Discovery-stage sections get their own subdir (#807) — created ONLY when the blueprint
    // actually carries a discovery stage. The planner writes `discovery/<topic>.md` there;
    // read_plan_stages ingests it alongside the hub root.
    // Migration (#1578: Context stage → Discovery): an in-flight project may have a `context/`
    // dir from before the rename — move it in place so its prose carries forward.
    let (legacy, current) = (planning_dir.join("context"), planning_dir.join("discovery"));
    if legacy.is_dir() && !current.exists() {
        std::fs::rename(&legacy, &current).str_err()?;
    }
    if enabled_stages.iter().any(|s| s == "discovery") {
        std::fs::create_dir_all(&current).str_err()?;
    }

    // Planner `.claude/settings.json` is NOT written here — it's derived from the `planner` role
    // gate (sessionRoles.ts) and written by `ensure_session_settings` at launch. extensions.md is
    // written by the frontend (#1054, shared/mcpContext.ts) so it reflects the actually-downloaded
    // servers, not a static catalogue. The three files below are the ones this setup authors.
    std::fs::write(
        planning_dir.join("CLAUDE.md"),
        build_planning_claude_md(
            is_existing, &project_name, project_number, &pitch,
            &enabled_stages, &repo_full_names, &project_key,
        ),
    ).str_err()?;
    std::fs::write(planning_dir.join("automations.md"), build_automations_md(&automations)).str_err()?;
    std::fs::write(
        planning_dir.join("github_context.md"),
        build_github_context_md(&github_login, &github_name, &repo_full_names, &project_key),
    ).str_err()?;

    // A deterministic context signature so Planning.tsx can surface a "context updated · refresh"
    // badge when inputs diverge from this baseline (#175).
    std::fs::write(
        planning_dir.join("context_signature.txt"),
        context_signature(&repo_full_names, &enabled_stages),
    ).str_err()?;

    Ok(WorkspacePaths {
        planning_dir: planning_dir.to_string_lossy().into_owned(),
    })
}

/// One markdown bullet per linked repo: `template` (`linked_repo_item()` / `github_repo_item()`) with
/// `{full_name}`/`{local_path}` substituted, each `.trim_end()` + a trailing newline, concatenated.
/// Empty repos ⇒ `""`. The one copy of the loop the planner `CLAUDE.md` and `github_context.md` share.
fn render_repo_items(repos: &[String], project_key: &str, template: &str) -> String {
    let mut out = String::new();
    for full_name in repos {
        let local_path = repo_dir(project_key, full_name);
        out.push_str(&format!(
            "{}\n",
            template
                .replace("{full_name}", full_name)
                .replace("{local_path}", &local_path.display().to_string())
                .trim_end(),
        ));
    }
    out
}

/// Assemble the planner `CLAUDE.md`: the orientation-specific INTRO + shared PROCESS block, the
/// anti-injection framing (#1107, every spec), the enabled-stages scope (#512/#542), and — for
/// existing projects — the linked-repositories section.
#[allow(clippy::too_many_arguments)]
fn build_planning_claude_md(
    is_existing: bool,
    project_name: &str,
    project_number: u32,
    pitch: &str,
    enabled_stages: &[String],
    repo_full_names: &[String],
    project_key: &str,
) -> String {
    let mut md = if is_existing {
        format!(
            "{}{}",
            planning_existing_intro()
                .replace("{PROJECT_NAME}", project_name)
                .replace("{PROJECT_NUMBER}", &project_number.to_string()),
            planning_process_md(),
        )
    } else {
        format!("{}{}", planning_new_intro().replace("{PITCH}", pitch), planning_process_md())
    };

    // Anti prompt-injection framing (#1107) — the planner reads untrusted repo + web content and
    // emits trusted fleet instruction, so it must treat all reviewed content as data.
    md.push_str(&planner_injection_resistance_md());

    // Modular planning stages (#512/#542): the enabled stages as the authoritative scope (disabled
    // stages declared out of scope). Empty ⇒ no change (all-stages default).
    let stages_md = build_active_stages_md(enabled_stages);
    if !stages_md.is_empty() {
        md.push_str(&stages_md);
    }

    // Linked repos section for existing projects (always, even when empty, so Claude knows the state).
    if is_existing {
        md.push_str("\n## Linked repositories\n\n");
        if repo_full_names.is_empty() {
            md.push_str("No repositories are currently linked to this project.\n");
        } else {
            md.push_str(&render_repo_items(repo_full_names, project_key, &linked_repo_item()));
        }
    }
    md
}

/// Assemble `automations.md`: the catalogue header (`@data/planner/automations-catalogue.md`, #2027
/// P1) + either the empty-state note or one bullet per saved automation.
fn build_automations_md(automations: &[AutomationData]) -> String {
    let mut md = format!("{}\n\n", automations_catalogue_header().trim_end());
    if automations.is_empty() {
        md.push_str(&format!("{}\n", automations_empty_note().trim_end()));
    } else {
        md.push_str("## Saved automations\n\n");
        for a in automations {
            md.push_str(&format!("- **{}** (`{}`)", a.name, a.id));
            if let Some(sched) = &a.schedule {
                md.push_str(&format!(" · cron: `{}`", sched));
            }
            md.push_str(&format!("\n  command: `{}`\n", a.command));
        }
    }
    md
}

/// Assemble `github_context.md`: the authenticated-user block (when a login is known), the linked
/// repositories, and the useful read-only `gh` commands — so the planner needn't run `gh api user`.
fn build_github_context_md(
    github_login: &str,
    github_name: &str,
    repo_full_names: &[String],
    project_key: &str,
) -> String {
    let mut md = String::from("# GitHub Context\n\n");
    if !github_login.is_empty() {
        md.push_str("## Authenticated user\n\n");
        md.push_str(&format!("- **Login**: `{}`\n", github_login));
        if !github_name.is_empty() {
            md.push_str(&format!("- **Name**: {}\n", github_name));
        }
        md.push_str(&format!("- **Profile**: https://github.com/{}\n\n", github_login));
    }
    if !repo_full_names.is_empty() {
        md.push_str("## Linked repositories\n\n");
        md.push_str(&render_repo_items(repo_full_names, project_key, &github_repo_item()));
        md.push('\n');
    }
    md.push_str(&format!("{}\n", github_useful_commands().trim_end()));
    md
}
/// The single source of truth for the planning context signature (#175/#756): the template
/// version + the sorted inputs (repos, enabled stages). Used by BOTH `setup_workspaces` (to
/// record the baseline) and `compute_context_signature` (the live value Planning.tsx compares
/// against) so the two can never disagree on format/version.
pub(crate) fn context_signature(repos: &[String], stages: &[String]) -> String {
    let mut r = repos.to_vec(); r.sort();
    let mut s = stages.to_vec(); s.sort();
    format!("v{}|{}|{}", PLANNING_TEMPLATE_VERSION, r.join(","), s.join(","))
}
/// Compute the CURRENT context signature for the given live inputs, the same way
/// `setup_workspaces` recorded the baseline — Planning.tsx compares the two to show the
/// "context updated · refresh" badge. (#756 — fixes the old v1-vs-v{version} mismatch.)
#[tauri::command]
pub(crate) fn compute_context_signature(repo_full_names: Vec<String>, enabled_stages: Vec<String>) -> String {
    context_signature(&repo_full_names, &enabled_stages)
}
/// Read back the context signature that `setup_workspaces` last wrote (#175).
/// Returns an empty string when the file doesn't exist yet.
#[tauri::command]
pub(crate) fn get_context_signature(project_key: String) -> String {
    // Read from the SAME resolver `setup_workspaces` wrote through (#2997), so the recorded baseline
    // and the actual planner mount can't diverge — an ephemeral-planning draft's signature lives in
    // `planning/<key>`, a materialized hub's in `projects/<key>`.
    let path = planning_cwd(&project_key).join("context_signature.txt");
    std::fs::read_to_string(path).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use crate::platform::config::embedded_str;

    // The straggler prose these tests guard was moved out of inline Rust literals into
    // `data/planner/*.md` (#2075, finishing epic #2027). Each test reconstructs the EXACT prior
    // literal and asserts the externalized block (read from the shipped seed, `.trim_end()` + one
    // `\n`, exactly as `setup_workspaces` renders it) is byte-identical — so the generated hub files
    // never drift. The data files are pinned to LF (.gitattributes) so this holds on every platform.

    /// The `automations.md` empty-state note (`setup_workspaces`).
    #[test]
    fn automations_empty_note_is_byte_identical() {
        let rendered = format!("{}\n", embedded_str("planner/automations-empty.md").trim_end());
        assert_eq!(
            rendered,
            "_No saved automations yet — suggest new ones with `bsc plan automations add` (above)._\n",
        );
    }

    /// The struct-driven core writes every hub file and preserves the empty-`project_key` guard —
    /// proving `setup_workspaces_inner` is drivable from a `SetupWorkspacesArgs` without a Tauri
    /// runtime (isolated under a temp home so config + hub writes stay sandboxed).
    #[test]
    fn setup_workspaces_inner_builds_hub_and_guards_empty_key() {
        use crate::testutil::prelude::*;
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = temp_home("setup-ws");
        let base = || super::SetupWorkspacesArgs {
            repo_full_names: vec![],
            automations: vec![],
            is_existing: false,
            project_name: "Demo".into(),
            project_number: 0,
            pitch: "a demo".into(),
            project_key: "p-demo".into(),
            github_login: String::new(),
            github_name: String::new(),
            enabled_stages: vec![],
        };
        // Happy path: every hub file is written.
        let paths = super::setup_workspaces_inner(base()).unwrap();
        let hub = std::path::Path::new(&paths.planning_dir);
        for f in ["CLAUDE.md", "automations.md", "github_context.md", "context_signature.txt"] {
            assert!(hub.join(f).exists(), "expected {f} in the hub");
        }
        // Runtime-fault instrumentation (#2262): generation mints the durable per-project ingest token
        // into the hub, so it exists before any session launches ($BSC_INGEST_TOKEN) and the collector
        // can validate the running app's fault/heartbeat POST against it.
        let token_path = crate::ingest_token_path("p-demo");
        assert!(token_path.exists(), "expected the durable ingest token minted at generation");
        let token = std::fs::read_to_string(&token_path).unwrap();
        let token = token.trim();
        assert_eq!(token.len(), 32, "32 hex chars");
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()), "hex token");
        // Re-running setup reuses the SAME token (idempotent — a baked shim keeps validating).
        super::setup_workspaces_inner(base()).unwrap();
        assert_eq!(std::fs::read_to_string(&token_path).unwrap().trim(), token, "token is stable across re-setup");

        // A blank project_key is still refused (would scatter the hub across `projects/`).
        let empty = super::SetupWorkspacesArgs { project_key: String::new(), ..base() };
        match super::setup_workspaces_inner(empty) {
            Err(e) => assert_eq!(e, "setup_workspaces: empty project_key"),
            Ok(_) => panic!("expected the empty-project_key rejection"),
        }
    }

    #[test]
    fn render_repo_items_substitutes_and_concatenates() {
        // 0 repos ⇒ empty; each repo becomes one trimmed + newline-terminated bullet from the template.
        assert_eq!(super::render_repo_items(&[], "k", "- {full_name} @ {local_path}"), "");
        let got = super::render_repo_items(&["octo/a".into(), "octo/b".into()], "proj", "- {full_name}");
        assert_eq!(got, "- octo/a\n- octo/b\n");
    }

    #[test]
    fn build_automations_md_empty_note_vs_rows() {
        use super::{build_automations_md, AutomationData};
        // Empty ⇒ header + the empty-state note, no "Saved automations" heading.
        let empty = build_automations_md(&[]);
        assert!(empty.contains("_No saved automations yet"));
        assert!(!empty.contains("## Saved automations"));
        // Rows ⇒ one bullet each; the optional cron marker appears only when a schedule is set.
        let md = build_automations_md(&[
            AutomationData {
                id: "a1".into(), name: "Nightly".into(),
                command: "bsc plan".into(), schedule: Some("0 0 * * *".into()),
            },
            AutomationData {
                id: "a2".into(), name: "OnDemand".into(),
                command: "echo hi".into(), schedule: None,
            },
        ]);
        assert!(md.contains("## Saved automations"));
        assert!(md.contains("- **Nightly** (`a1`) · cron: `0 0 * * *`"));
        assert!(md.contains("- **OnDemand** (`a2`)"));
        assert!(md.contains("command: `echo hi`"));
        assert!(!md.contains("**OnDemand** (`a2`) · cron"), "no cron marker without a schedule");
    }

    /// The `## Useful gh commands` block appended to `github_context.md`.
    #[test]
    fn github_useful_commands_is_byte_identical() {
        let rendered = format!("{}\n", embedded_str("planner/github-commands.md").trim_end());
        assert_eq!(
            rendered,
            "## Useful gh commands (read-only — you inspect GitHub; you never mutate it)\n\n\
             ```\n\
             gh api user                                    # confirm auth\n\
             gh repo list --limit 100 --json nameWithOwner  # all repos\n\
             gh issue list --repo {owner}/{repo}            # open issues\n\
             gh pr list   --repo {owner}/{repo}             # open PRs\n\
             ```\n",
        );
    }

    /// A CLAUDE.md `## Linked repositories` bullet, after per-repo placeholder substitution.
    #[test]
    fn linked_repo_item_is_byte_identical() {
        let rendered = format!(
            "{}\n",
            embedded_str("planner/linked-repo-item.md")
                .replace("{full_name}", "octo/app")
                .replace("{local_path}", "/home/x/octo-app")
                .trim_end(),
        );
        assert_eq!(
            rendered,
            "- **octo/app**\n  - local path: `/home/x/octo-app` — the app clones it here for you to read; don't clone it yourself.\n",
        );
    }

    /// A `github_context.md` `## Linked repositories` bullet, after per-repo placeholder substitution.
    #[test]
    fn github_repo_item_is_byte_identical() {
        let rendered = format!(
            "{}\n",
            embedded_str("planner/github-repo-item.md")
                .replace("{full_name}", "octo/app")
                .replace("{local_path}", "/home/x/octo-app")
                .trim_end(),
        );
        assert_eq!(rendered, "- `octo/app` — local path: `/home/x/octo-app`\n");
    }
}
