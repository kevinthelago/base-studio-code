use crate::StrErr;
use super::prompts::*;
use super::directives::*;
use crate::{PerfSpan, sanitize_project_key, project_dir, repo_dir};

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
    /// The active blueprint's deliverable is a blueprint itself (#923) — use the authoring intro
    /// and omit the software-planning process block.
    pub authoring: bool,
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
    // Optional so older call sites default to false.
    authoring: Option<bool>,
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
        authoring: authoring.unwrap_or(false),
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
        authoring,
    } = args;
    let _perf = PerfSpan::new("setup_workspaces");
    crate::session::claude_config::sanitize_claude_config();
    // Planner session CWD = the project hub (`projects/<key>`), holding plan
    // sections + control files FLAT alongside the project's CLAUDE.md.
    let safe_key     = sanitize_project_key(&project_key);
    // A blank key would resolve the project dir to `projects/` itself and scatter
    // `.claude/` and the plan sections across the parent — refuse it instead.
    if safe_key.is_empty() {
        return Err("setup_workspaces: empty project_key".to_string());
    }
    let planning_dir = project_dir(&project_key);

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

    // Planner `.claude/settings.json` is NOT written here anymore — it's derived from the
    // `planner` role gate (sessionRoles.ts) and written by `ensure_session_settings` at
    // launch (Planning.tsx), so there is a SINGLE source for the planner's permissions
    // instead of a hardcoded literal that drifts from the role. The `.claude` dir is
    // created above; the role-launch call populates the file before the PTY starts.

    // Assemble the template: orientation-specific INTRO + shared PROCESS block. The blueprint-
    // authoring lifecycle (#923) is self-contained — its intro carries the whole task + the
    // <blueprint> tag spec, and the software-planning process block is omitted entirely.
    let mut planning_md = if authoring {
        planning_blueprint_intro()
    } else if is_existing {
        format!(
            "{}{}",
            planning_existing_intro()
                .replace("{PROJECT_NAME}", &project_name)
                .replace("{PROJECT_NUMBER}", &project_number.to_string()),
            planning_process_md(),
        )
    } else {
        format!("{}{}", planning_new_intro().replace("{PITCH}", &pitch), planning_process_md())
    };

    // Anti prompt-injection framing (#1107) — applied to EVERY planner spec (new / existing /
    // authoring). The planner reads untrusted repo + web content and emits trusted fleet
    // instruction, so it must treat all reviewed content as data and never transcribe an embedded
    // directive into a kickoff/section/profile/issue.
    planning_md.push_str(&planner_injection_resistance_md());

    // Modular planning stages (#512/#542): prepend the project's enabled stages (from
    // its blueprint) as the authoritative scope — disabled stages are declared out of
    // scope so the planner doesn't produce them. Empty ⇒ no change (all-stages default).
    let stages_md = build_active_stages_md(&enabled_stages);
    if !stages_md.is_empty() {
        planning_md.push_str(&stages_md);
    }

    // Append linked repos section for existing projects (always, even when
    // empty, so Claude knows the current state and acts accordingly).
    if is_existing {
        planning_md.push_str("\n## Linked repositories\n\n");
        if repo_full_names.is_empty() {
            planning_md.push_str("No repositories are currently linked to this project.\n");
        } else {
            for full_name in &repo_full_names {
                let local_path = repo_dir(&project_key, full_name);
                planning_md.push_str(&format!(
                    "{}\n",
                    linked_repo_item()
                        .replace("{full_name}", full_name)
                        .replace("{local_path}", &local_path.display().to_string())
                        .trim_end(),
                ));
            }
        }
    }

    std::fs::write(planning_dir.join("CLAUDE.md"), planning_md)
        .str_err()?;

    // Write automations catalogue so Claude can reference and assign them. The header prose lives in
    // `@data/planner/automations-catalogue.md` (#2027 P1); the saved-automation rows append below.
    let mut auto_md = format!("{}\n\n", automations_catalogue_header().trim_end());
    if automations.is_empty() {
        auto_md.push_str(&format!("{}\n", automations_empty_note().trim_end()));
    } else {
        auto_md.push_str("## Saved automations\n\n");
        for a in &automations {
            auto_md.push_str(&format!("- **{}** (`{}`)", a.name, a.id));
            if let Some(sched) = &a.schedule {
                auto_md.push_str(&format!(" · cron: `{}`", sched));
            }
            auto_md.push_str(&format!("\n  command: `{}`\n", a.command));
        }
    }
    std::fs::write(planning_dir.join("automations.md"), auto_md)
        .str_err()?;

    // extensions.md (the planner's live list of installed MCP servers + the per-worker assignment
    // directive) is written by the frontend now (#1054, shared/mcpContext.ts) so it reflects the
    // ACTUAL downloaded servers the planner is exposed to, not a static catalogue. The frontend is
    // the sole writer to avoid a stale-overwrite race; the planner reads it during the
    // "Automations & extensions" stage, well after this setup runs.

    // Write a github_context.md so Claude knows the authenticated user and
    // what repos are available without needing to run `gh api user` first.
    let mut gh_ctx = String::from("# GitHub Context\n\n");
    if !github_login.is_empty() {
        gh_ctx.push_str("## Authenticated user\n\n");
        gh_ctx.push_str(&format!("- **Login**: `{}`\n", github_login));
        if !github_name.is_empty() {
            gh_ctx.push_str(&format!("- **Name**: {}\n", github_name));
        }
        gh_ctx.push_str(&format!("- **Profile**: https://github.com/{}\n\n", github_login));
    }
    if !repo_full_names.is_empty() {
        gh_ctx.push_str("## Linked repositories\n\n");
        for full_name in &repo_full_names {
            let local_path = repo_dir(&project_key, full_name);
            gh_ctx.push_str(&format!(
                "{}\n",
                github_repo_item()
                    .replace("{full_name}", full_name)
                    .replace("{local_path}", &local_path.display().to_string())
                    .trim_end(),
            ));
        }
        gh_ctx.push('\n');
    }
    gh_ctx.push_str(&format!("{}\n", github_useful_commands().trim_end()));
    std::fs::write(planning_dir.join("github_context.md"), gh_ctx)
        .str_err()?;

    // Write a deterministic context signature so Planning.tsx can surface a
    // "context updated · refresh" badge when inputs diverge from this baseline (#175).
    {
        let sig = context_signature(&repo_full_names, &enabled_stages);
        std::fs::write(planning_dir.join("context_signature.txt"), sig)
            .str_err()?;
    }

    Ok(WorkspacePaths {
        planning_dir: planning_dir.to_string_lossy().into_owned(),
    })
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
    let path = project_dir(&project_key).join("context_signature.txt");
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
            authoring: false,
        };
        // Happy path: every hub file is written.
        let paths = super::setup_workspaces_inner(base()).unwrap();
        let hub = std::path::Path::new(&paths.planning_dir);
        for f in ["CLAUDE.md", "automations.md", "github_context.md", "context_signature.txt"] {
            assert!(hub.join(f).exists(), "expected {f} in the hub");
        }
        // A blank project_key is still refused (would scatter the hub across `projects/`).
        let empty = super::SetupWorkspacesArgs { project_key: String::new(), ..base() };
        match super::setup_workspaces_inner(empty) {
            Err(e) => assert_eq!(e, "setup_workspaces: empty project_key"),
            Ok(_) => panic!("expected the empty-project_key rejection"),
        }
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
