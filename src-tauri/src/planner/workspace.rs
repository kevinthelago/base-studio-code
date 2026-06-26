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
#[tauri::command]
#[allow(clippy::too_many_arguments)]
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
    // The active blueprint's deliverable is a blueprint itself (#923) — use the authoring intro and
    // omit the software-planning process block. Optional so older call sites default to false.
    authoring: Option<bool>,
) -> Result<WorkspacePaths, String> {
    let _perf = PerfSpan::new("setup_workspaces");
    crate::config::sanitize_claude_config();
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
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Discovery-stage sections get their own subdir (#807) — created ONLY when the blueprint
    // actually carries a discovery stage. The planner writes `discovery/<topic>.md` there;
    // read_plan_sections ingests it alongside the hub root.
    // Migration (#1578: Context stage → Discovery): an in-flight project may have a `context/`
    // dir from before the rename — move it in place so its prose carries forward.
    let (legacy, current) = (planning_dir.join("context"), planning_dir.join("discovery"));
    if legacy.is_dir() && !current.exists() {
        std::fs::rename(&legacy, &current).map_err(|e| e.to_string())?;
    }
    if enabled_stages.iter().any(|s| s == "discovery") {
        std::fs::create_dir_all(&current).map_err(|e| e.to_string())?;
    }

    // Planner `.claude/settings.json` is NOT written here anymore — it's derived from the
    // `planner` role gate (sessionRoles.ts) and written by `ensure_session_settings` at
    // launch (Planning.tsx), so there is a SINGLE source for the planner's permissions
    // instead of a hardcoded literal that drifts from the role. The `.claude` dir is
    // created above; the role-launch call populates the file before the PTY starts.

    // Assemble the template: orientation-specific INTRO + shared PROCESS block. The blueprint-
    // authoring lifecycle (#923) is self-contained — its intro carries the whole task + the
    // <blueprint> tag spec, and the software-planning process block is omitted entirely.
    let mut planning_md = if authoring.unwrap_or(false) {
        PLANNING_BLUEPRINT_INTRO.to_string()
    } else if is_existing {
        format!(
            "{}{}",
            PLANNING_EXISTING_INTRO
                .replace("{PROJECT_NAME}", &project_name)
                .replace("{PROJECT_NUMBER}", &project_number.to_string()),
            PLANNING_PROCESS_MD,
        )
    } else {
        format!("{}{}", PLANNING_NEW_INTRO.replace("{PITCH}", &pitch), PLANNING_PROCESS_MD)
    };

    // Anti prompt-injection framing (#1107) — applied to EVERY planner spec (new / existing /
    // authoring). The planner reads untrusted repo + web content and emits trusted fleet
    // instruction, so it must treat all reviewed content as data and never transcribe an embedded
    // directive into a kickoff/section/profile/issue.
    planning_md.push_str(PLANNER_INJECTION_RESISTANCE_MD);

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
                    "- **{full_name}**\n  - local path: `{local_path}` — the app clones it here for you to read; don't clone it yourself.\n",
                    full_name  = full_name,
                    local_path = local_path.display(),
                ));
            }
        }
    }

    std::fs::write(planning_dir.join("CLAUDE.md"), planning_md)
        .map_err(|e| e.to_string())?;

    // Write automations catalogue so Claude can reference and assign them.
    let mut auto_md = String::from(
        "# Automations Catalogue\n\n\
         Suggest assigning an automation to this project with a single-line tag:\n\
         `<automation_assign name=\"...\" command=\"...\" schedule=\"0 9 * * 1-5\" description=\"...\" />`\n\n\
         The `schedule` field is a cron expression (omit for one-shot commands).\n\n"
    );
    if automations.is_empty() {
        auto_md.push_str("_No saved automations yet — suggest new ones using the tag above._\n");
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
        .map_err(|e| e.to_string())?;

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
                "- `{}` — local path: `{}`\n",
                full_name, local_path.display(),
            ));
        }
        gh_ctx.push('\n');
    }
    gh_ctx.push_str(
        "## Useful gh commands (read-only — you inspect GitHub; you never mutate it)\n\n\
         ```\n\
         gh api user                                    # confirm auth\n\
         gh repo list --limit 100 --json nameWithOwner  # all repos\n\
         gh issue list --repo {owner}/{repo}            # open issues\n\
         gh pr list   --repo {owner}/{repo}             # open PRs\n\
         ```\n"
    );
    std::fs::write(planning_dir.join("github_context.md"), gh_ctx)
        .map_err(|e| e.to_string())?;

    // Write a deterministic context signature so Planning.tsx can surface a
    // "context updated · refresh" badge when inputs diverge from this baseline (#175).
    {
        let sig = context_signature(&repo_full_names, &enabled_stages);
        std::fs::write(planning_dir.join("context_signature.txt"), sig)
            .map_err(|e| e.to_string())?;
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
