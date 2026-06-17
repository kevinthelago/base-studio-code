// Project planning workspace: the planner CLAUDE.md templates, setup_workspaces,
// the active-stages assembly, and the context signature (extracted from lib.rs, #758).

use crate::{PerfSpan, KB_CLAUDE_MD, documents_dir, sanitize_project_key, project_dir, repo_dir};
use crate::config;

#[derive(serde::Deserialize)]
pub(crate) struct KbBlockData {
    id:      String,
    title:   String,
    tags:    Vec<String>,
    content: String,
}

#[derive(serde::Deserialize)]
pub(crate) struct AutomationData {
    id:       String,
    name:     String,
    command:  String,
    schedule: Option<String>,
}

/// Bump when the planning template (CLAUDE.md) changes in a way that affects
/// the session context. The signature written by `setup_workspaces` includes
/// this version so Planning.tsx can detect template upgrades (#175).
const PLANNING_TEMPLATE_VERSION: u8 = 11;

#[derive(serde::Serialize)]
pub(crate) struct WorkspacePaths {
    kb_dir:       String,
    planning_dir: String,
}

// ── Planning workspace CLAUDE.md templates ───────────────────────────────────
//
// The planner is guided but DYNAMIC: there is no fixed list of sections. Claude
// walks a curated checklist of every dimension of modern app development and,
// per dimension, either documents it (writes `{topic}.md`) or records it as
// skipped (in `_skipped.md`). Each documented topic is surfaced in the UI as its
// own section the moment the file appears.
//
// A template is assembled at runtime as INTRO + PROCESS. The INTRO differs by
// orientation (new vs. existing project) and carries the context placeholders
// ({PITCH}, {PROJECT_NAME}, {PROJECT_NUMBER}); the PROCESS block — channels,
// checklist, structured templates, publish flow, integration tags — is shared.
//
// repo_link tags are parsed by the frontend and trigger an automatic clone into
// ~/.base-studio-code/projects/<project>/<repo>/ so the app stays in sync.

const PLANNING_NEW_INTRO: &str = include_str!("../templates/planning-new-intro.md");

const PLANNING_EXISTING_INTRO: &str = include_str!("../templates/planning-existing-intro.md");

const PLANNING_PROCESS_MD: &str = include_str!("../templates/planning-process.md");

/// One-line directive per planning stage (#542/#666) for the assembled active-stages
/// section. Unknown ids fall back to a generic line.
fn stage_directive(id: &str) -> String {
    let line = match id {
        "context"     => "**Context** — discovery, one topic at a time. Write every discovery file into the **`context/`** subdir. The gate REQUIRES these four, written and confirmed: `context/goal.md`, `context/scope.md`, `context/stack.md`, `context/architecture.md` — always create them. Cover other dimensions ONLY where they genuinely apply, using the canonical key as the file stem (`context/users.md`, `context/ux.md`, `context/schema.md`, `context/api.md`, `context/security.md`, `context/testing.md`, …); record every dimension you don't document in `context/_skipped.md`. Each file you create is a gate item the user must confirm — do NOT create files for tangential topics, or the gate can't complete.",
        "repos"       => "**Repos** — decide and link the repositories (emit `<repo_link>`, write `repos.json`).",
        "ui"          => "**UI** — runs AFTER Features: design the screens that deliver the defined capabilities. Write functionless React skeletons to `.ui-skeleton/<Screen>.jsx` and emit `<ui_preview screen=\"…\" mode=\"2d|3d\" />` to render them live. Then author a **Claude Design kickoff** at `prompts/ui-kickoff.md` — a self-contained brief (goal, feature→screen map, each screen's states/flows, design-system constraints) the user pastes into a Claude Design session.",
        "features"    => "**Features** — agree a short feature list, then drive ONE feature at a time and write each as an entry in `features.json` (a JSON array; one object per user-facing capability, which is ALSO its fleet stream). Per feature fill: `name`, `behavior` (what it does + when, in the user's terms), `acceptance` (a done-when checklist array), `approach` (how it's built), `tools` (libraries/services array), `data` (what it stores/reads + which features it depends on), `stream` (defaults to the slug). A feature is done when it has name + behavior + ≥1 acceptance; confirm it before the next. Do NOT design the integration contracts here — that's the Plan/Structure stage.",
        "structure"   => "**Structure** — with the features defined, run the workshop to synthesize the plan (new project → feature-by-feature; existing → section-by-section migration — inventory every screen/module first), then write `phases.json` + agent-ready `issues.json`. Go ONE unit at a time; never move on until the current unit is fully decomposed and written.",
        "permissions" => "**Permissions** — plan the agent fleet (`fleet.json`): non-overlapping streams + least-privilege profiles.",
        "automations" => "**Automations** — propose cron automations (emit `<automation_assign>`).",
        "skills"      => "**Skills** — select reusable skills from the library (`skills.json`).",
        // transform / operate stages (#666) — these do NOT produce issues.json.
        "refactor"     => "**Refactor** — identify improvement opportunities (dead code, simplification, performance); write one targeted cleanup issue per area. Do NOT produce `phases.json` or `issues.json`.",
        "cleanup"      => "**Dead & legacy code** — scan for unused/dead code & dependencies, verify each finding, and triage them into refactor units. Do NOT write `issues.json` — the refactor units drive the fleet directly.",
        "testing" | "testing-informational" => "**Testing** — define the coverage strategy and the test safety net for the changes.",
        "transform"    => "**Transform** — plan the migration to a new pattern, version, or framework; write migration issues in strict dependency order.",
        "boundaries"   => "**Service boundaries** — map the bounded contexts and the seams to split the monolith along.",
        "extraction"   => "**Extraction plan** — sequence the incremental, shippable steps to carve out each service.",
        "consolidation" => "**Consolidation** — plan merging the services, unifying data stores and contracts.",
        "migration"    => "**Migration plan** — the from→to mapping and an incremental, reversible cutover.",
        "hardening"    => "**Security hardening** — threat-model, audit (authz / secrets / deps), and plan concrete fixes.",
        // Blueprint-authoring lifecycle (#923) — the DELIVERABLE is a reusable blueprint published
        // to a gist; there is NO code, no fleet, no triage. Build the blueprint with the <blueprint>
        // tag and re-emit the whole tag as it grows.
        "purpose"         => "**Purpose** — you are designing a reusable BLUEPRINT (a planning template), not a software project. Establish its lifecycle category, the projects it seeds, and its name + description; emit a `<blueprint>` tag with id/name/desc/category/mode.",
        "bp_stages"       => "**Stages** — design the blueprint's ordered stages, one at a time: each stage's key+name, intent, the discovery prompt it runs, its deps/order, and whether it's optional. Re-emit the full `<blueprint>` tag as the sections array grows.",
        "bp_capabilities" => "**Capabilities** (optional) — attach reusable skills/knowledge + MCP servers the blueprint should bundle into projects it seeds; fold them into the `<blueprint>` tag's section or blueprint-level skills/mcp arrays.",
        "bp_review"       => "**Review & publish** — review the assembled blueprint with the user, emit the FINAL `<blueprint>` tag, and let the user publish it to a gist from the footer. Do NOT publish it yourself.",
        other         => return format!("**{other}** — configured stage."),
    };
    line.to_string()
}

/// Assemble the "Active planning stages" section from the project's ENABLED stages
/// (in order). Stages not listed are declared out of scope, so a disabled stage is
/// never instructed (#512/#542). Empty input ⇒ "" (section omitted; no behavior change).
fn build_active_stages_md(stages: &[String]) -> String {
    if stages.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "\n## Active planning stages\n\nThe app drives the plan **one stage at a time** — it sends you each stage's working instructions the moment you reach it. Treat this list as SCOPE: work the current stage, then wait for the app to advance you; don't run ahead or jump stages. **Stages not listed here are OUT OF SCOPE — do not produce their artifacts.**\n\n",
    );
    for (i, id) in stages.iter().enumerate() {
        s.push_str(&format!("{}. {}\n", i + 1, stage_directive(id)));
    }
    s
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn setup_workspaces(
    kb_blocks: Vec<KbBlockData>,
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
    let _perf = PerfSpan::new("setup_workspaces");
    config::sanitize_claude_config();
    // KB session CWD = the flat reusable document library (`documents/`).
    // Planner session CWD = the project hub (`projects/<key>`), holding plan
    // sections + control files FLAT alongside the project's CLAUDE.md.
    let kb_dir       = documents_dir();
    let safe_key     = sanitize_project_key(&project_key);
    // A blank key would resolve the project dir to `projects/` itself and scatter
    // `.claude/` and the plan sections across the parent — refuse it instead.
    if safe_key.is_empty() {
        return Err("setup_workspaces: empty project_key".to_string());
    }
    let planning_dir = project_dir(&project_key);

    for dir in &[
        kb_dir.join(".claude"),
        planning_dir.join(".claude"),
        planning_dir.join("prompts"),
        // Integration contracts (#…): the Plan stage writes one doc per feature seam here;
        // the director owns + tests them, workers read them as the source of truth.
        planning_dir.join("contracts"),
    ] {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Context-stage discovery sections get their own subdir (#807) — created ONLY when the
    // blueprint actually carries a context stage. The planner writes `context/<topic>.md`
    // there; read_plan_sections ingests it alongside the hub root.
    if enabled_stages.iter().any(|s| s == "context") {
        std::fs::create_dir_all(planning_dir.join("context")).map_err(|e| e.to_string())?;
    }

    // KB: read + write/edit markdown only; no web access or shell
    std::fs::write(
        kb_dir.join(".claude").join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit"],"deny":["Bash","MultiEdit","WebFetch","WebSearch"]}}"#,
    ).map_err(|e| e.to_string())?;

    // Planner `.claude/settings.json` is NOT written here anymore — it's derived from the
    // `planner` role gate (sessionRoles.ts) and written by `ensure_session_settings` at
    // launch (Planning.tsx), so there is a SINGLE source for the planner's permissions
    // instead of a hardcoded literal that drifts from the role. The `.claude` dir is
    // created above; the role-launch call populates the file before the PTY starts.

    std::fs::write(kb_dir.join("CLAUDE.md"), KB_CLAUDE_MD)
        .map_err(|e| e.to_string())?;

    // Assemble the template: orientation-specific INTRO + shared PROCESS block.
    let mut planning_md = if is_existing {
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

    // Sync every KB block to disk as a markdown file (overwrite on each call)
    for block in &kb_blocks {
        let content = format!(
            "---\nid: {}\ntitle: {}\ntags: [{}]\n---\n\n{}",
            block.id,
            block.title,
            block.tags.join(", "),
            block.content,
        );
        std::fs::write(kb_dir.join(format!("{}.md", block.id)), content)
            .map_err(|e| e.to_string())?;
    }

    // Write a KB index so Claude can quickly see what's available without
    // reading every individual block file. The planner's session CWD is this
    // project hub (`projects/<key>`), and reusable KB blocks live in the flat
    // library (`documents/`), so the relative reference is `../../documents/{id}.md`.
    let mut kb_index = String::from(
        "# Knowledge Base Index\n\n\
         Read any block file at `../../documents/{id}.md` for full content.\n\
         Assign a block to this project with: `<kb_assign id=\"{id}\" />`\n\n"
    );
    if kb_blocks.is_empty() {
        kb_index.push_str("_No knowledge blocks in the store yet._\n");
    } else {
        for block in &kb_blocks {
            kb_index.push_str(&format!(
                "- `{}` — **{}** (tags: {})\n",
                block.id,
                block.title,
                if block.tags.is_empty() { "none".to_string() } else { block.tags.join(", ") },
            ));
        }
    }
    std::fs::write(planning_dir.join("kb_index.md"), kb_index)
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

    // Write the extensions catalogue (#174) so the planner's "Automations &
    // extensions" step knows which MCP servers it can assign. The names mirror the
    // frontend catalog (src/lib/extensions.ts CATALOG_TEMPLATES) — the source of
    // truth for each server's transport/command/env; this file is guidance text.
    // Each `<mcp_assign>` scopes that server to THIS project; every build & triage
    // session the plan launches then loads it via its `.mcp.json` (pre-trusted, no
    // blocking prompt).
    let ext_md = String::from(
        "# Extensions Catalogue (MCP servers)\n\n\
         Assign an MCP server/extension to this project with a single-line tag:\n\
         `<mcp_assign name=\"Compliance\" />`\n\n\
         Each assigned server is scoped to THIS project and loaded into every session this\n\
         plan launches — the director AND every worker — written to each session's\n\
         `.mcp.json` and pre-trusted, so the agent never blocks on a \"trust these MCP\n\
         servers?\" prompt. Assign only the servers the project's agents actually need.\n\n\
         ## First-party servers (recommended)\n\n\
         These install from source. Assigning one **downloads its repo automatically** into\n\
         `~/.base-studio-code/mcp/<repo>`; the user then clicks **build** once in the\n\
         planning page's MCP panel (it runs `python -m uv sync` / `pnpm build`) before the fleet runs.\n\n\
         - **Compliance** — scan a project or git diff for compliance findings (GDPR, SOC 2,\n\
           ISO 27001, HIPAA, PCI DSS) and gate CI on severity thresholds.\n\
         - **Complexity Analyzer** — measure code complexity (cyclomatic, cognitive,\n\
           hotspots) across a codebase to target refactors.\n\
         - **Dependency Graph** — explore a project's dependency graph: nodes, neighbors,\n\
           cycles, and stats.\n\n\
         ## Other servers\n\n\
         A name not listed above creates a blank stdio MCP entry the user completes in the\n\
         MCP panel. Required env values (tokens, connection strings) are left blank for the\n\
         user to fill — never invent secrets.\n\n\
         Pair this with `<automation_assign …>` (see automations.md) in the planner's\n\
         \"Automations & extensions\" step.\n"
    );
    std::fs::write(planning_dir.join("extensions.md"), ext_md)
        .map_err(|e| e.to_string())?;

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
        let kb_ids: Vec<String> = kb_blocks.iter().map(|b| b.id.clone()).collect();
        let sig = context_signature(&repo_full_names, &kb_ids, &enabled_stages);
        std::fs::write(planning_dir.join("context_signature.txt"), sig)
            .map_err(|e| e.to_string())?;
    }

    Ok(WorkspacePaths {
        kb_dir:       kb_dir.to_string_lossy().into_owned(),
        planning_dir: planning_dir.to_string_lossy().into_owned(),
    })
}

/// The single source of truth for the planning context signature (#175/#756): the template
/// version + the sorted inputs (repos, KB block ids, enabled stages). Used by BOTH
/// `setup_workspaces` (to record the baseline) and `compute_context_signature` (the live
/// value Planning.tsx compares against) so the two can never disagree on format/version.
fn context_signature(repos: &[String], kb_ids: &[String], stages: &[String]) -> String {
    let mut r = repos.to_vec(); r.sort();
    let mut k = kb_ids.to_vec(); k.sort();
    let mut s = stages.to_vec(); s.sort();
    format!("v{}|{}|{}|{}", PLANNING_TEMPLATE_VERSION, r.join(","), k.join(","), s.join(","))
}

/// Compute the CURRENT context signature for the given live inputs, the same way
/// `setup_workspaces` recorded the baseline — Planning.tsx compares the two to show the
/// "context updated · refresh" badge. (#756 — fixes the old v1-vs-v{version} mismatch.)
#[tauri::command]
pub(crate) fn compute_context_signature(repo_full_names: Vec<String>, kb_ids: Vec<String>, enabled_stages: Vec<String>) -> String {
    context_signature(&repo_full_names, &kb_ids, &enabled_stages)
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

    #[test]
    fn build_active_stages_md_includes_enabled_excludes_disabled() {
        // Empty → omitted (all-stages default, no behavior change).
        assert_eq!(super::build_active_stages_md(&[]), "");

        let md = super::build_active_stages_md(&["context".into(), "structure".into()]);
        assert!(md.contains("Active planning stages"));
        assert!(md.contains("OUT OF SCOPE"), "must declare unlisted stages out of scope");
        assert!(md.contains("**Context**") && md.contains("**Structure**"));
        // a stage not in the enabled list is absent
        assert!(!md.contains("**UI**"), "disabled stage must not be instructed");
        // ordered + numbered
        assert!(md.find("**Context**").unwrap() < md.find("**Structure**").unwrap());

        // unknown id → generic line, never panics
        assert!(super::build_active_stages_md(&["custom-x".into()]).contains("**custom-x**"));
    }

    /// Context directive must name the four gate-required files so the planner
    /// doesn't create tangential sections that block the gate (#672).
    #[test]
    fn stage_directive_context_names_four_gate_files() {
        let d = super::stage_directive("context");
        assert!(d.contains("goal.md"),         "missing goal.md");
        assert!(d.contains("scope.md"),        "missing scope.md");
        assert!(d.contains("stack.md"),        "missing stack.md");
        assert!(d.contains("architecture.md"), "missing architecture.md");
        assert!(d.contains("_skipped.md"),     "must mention _skipped.md fallback");
    }

    /// Features directive must steer the planner to write features.json (the artifact the
    /// Features pane + gate read), not the per-feature markdown sections (#815).
    #[test]
    fn stage_directive_features_names_features_json() {
        let d = super::stage_directive("features");
        assert!(d.contains("features.json"), "must name the features.json artifact");
        assert!(d.contains("acceptance"), "must mention the acceptance checklist");
        assert!(d.contains("behavior"), "must mention behavior");
        assert!(d.contains("ONE feature"), "must mandate one-feature-at-a-time pacing");
    }

    /// Structure directive must mention both workshop modes (#355).
    #[test]
    fn stage_directive_structure_mentions_workshop_modes() {
        let d = super::stage_directive("structure");
        assert!(d.contains("feature-by-feature"), "missing new-project mode");
        assert!(d.contains("section-by-section"), "missing existing-project mode");
        assert!(d.contains("ONE unit"), "missing pace mandate");
    }

    /// Custom/refactor-blueprint stages get real directives, not the generic fallback (#666).
    #[test]
    fn stage_directive_custom_stages_have_real_directives() {
        for id in &["refactor", "cleanup", "testing", "testing-informational", "transform"] {
            let d = super::stage_directive(id);
            assert!(
                !d.ends_with("configured stage."),
                "stage '{id}' fell back to generic — needs a real directive"
            );
        }
        // Refactor explicitly says NOT to produce phases.json/issues.json (#666).
        assert!(super::stage_directive("refactor").contains("NOT"), "refactor must exclude phases/issues");
    }

    /// PLANNING_PROCESS_MD Coverage section must carry the gate-item and Context gate text (#672).
    #[test]
    fn planning_process_md_coverage_names_context_gate_requirements() {
        let md = super::PLANNING_PROCESS_MD;
        assert!(md.contains("gate item"), "must explain the gate-item concept");
        assert!(md.contains("Context** gate"), "must name the Context gate");
        assert!(md.contains("goal`, `scope`"), "must list the required core files");
        assert!(md.contains("Work one stage at a time"), "must include the one-stage-at-a-time rule");
    }

    /// Both intros must carry the scope guard that makes the active-stages list
    /// authoritative over the fixed workflow steps (#666).
    #[test]
    fn planner_intros_carry_active_stages_scope_guard() {
        for t in [super::PLANNING_NEW_INTRO, super::PLANNING_EXISTING_INTRO] {
            assert!(
                t.contains("Active planning stages section at the bottom of this file"),
                "scope guard missing from intro"
            );
            assert!(
                t.contains("do not produce their artifacts"),
                "must declare that unlisted stages are out of scope"
            );
        }
    }

    /// PLANNING_EXISTING_INTRO must include the lifecycle check paragraph (#458).
    #[test]
    fn planning_existing_intro_has_lifecycle_check() {
        let intro = super::PLANNING_EXISTING_INTRO;
        assert!(intro.contains("Lifecycle check"), "lifecycle check section missing");
        assert!(intro.contains("near-complete"), "must mention near-complete threshold");
        assert!(intro.contains("refactor"), "must mention refactor pass for near-complete projects");
    }

    #[test]
    fn planner_template_is_plan_only_no_git_mutations() {
        // The planner is plan-only (#503): it must not be instructed to create repos,
        // milestones, issues, or labels, nor commit/push. Publishing is ENTIRELY the user's
        // job (#…) — the planner is never even told how it works. (The prohibition prose uses
        // bare backticked forms like `gh repo create`; here we guard the args-bearing
        // INSTRUCTION forms that only ever appeared as commands to run, AND that no template
        // describes the publish flow.)
        for t in [super::PLANNING_NEW_INTRO, super::PLANNING_EXISTING_INTRO, super::PLANNING_PROCESS_MD] {
            assert!(!t.contains("--method POST --field"), "planner template instructs `gh api … --method POST`");
            assert!(!t.contains("gh label create \""), "planner template instructs `gh label create`");
            assert!(!t.contains("gh issue create --repo"), "planner template instructs `gh issue create`");
            assert!(!t.contains("gh repo create owner"), "planner template instructs `gh repo create`");
            assert!(!t.contains("gh repo create {owner}"), "planner template instructs `gh repo create`");
            assert!(!t.contains("gh repo create {login}"), "planner template instructs `gh repo create`");
            // De-publish (#…): the planner is never told how publishing works — it's the user's job.
            assert!(!t.contains("Publish button"), "planner must not be told how the publish flow works");
            assert!(!t.contains("publish flow"), "planner must not be told how the publish flow works");
            assert!(!t.contains("Publish to GitHub"), "planner must not carry a publish step");
        }
        // Positive: the plan-only framing is present, and publishing is framed as the user's job.
        assert!(super::PLANNING_PROCESS_MD.contains("plan-only"), "plan-only framing missing");
        assert!(super::PLANNING_PROCESS_MD.contains("entirely the user's responsibility"),
            "user-owns-publish framing missing");
    }

    #[test]
    fn context_signature_is_versioned_sorted_and_order_independent() {
        // One source of truth (#756): setup_workspaces (baseline) + compute_context_signature
        // (live) call this, so they can never disagree on format/version.
        let a = super::context_signature(
            &["b".into(), "a".into()], &["k2".into(), "k1".into()], &["s2".into(), "s1".into()]);
        let b = super::context_signature(
            &["a".into(), "b".into()], &["k1".into(), "k2".into()], &["s1".into(), "s2".into()]);
        assert_eq!(a, b, "order-independent (inputs are sorted)");
        assert_eq!(a, format!("v{}|a,b|k1,k2|s1,s2", super::PLANNING_TEMPLATE_VERSION));
        // carries the real template version, not a hardcoded constant — fixes the v1/v{N} mismatch.
        assert!(a.starts_with(&format!("v{}|", super::PLANNING_TEMPLATE_VERSION)));
    }

    #[test]
    fn custom_stage_directives_and_scope_guard() {
        // Custom transform/operate stages get real directives, not the generic fallback.
        let cleanup = super::stage_directive("cleanup");
        assert!(cleanup.contains("refactor units"), "cleanup has a real directive");
        assert!(cleanup.to_lowercase().contains("do not write"), "cleanup forbids issues.json");
        assert!(super::stage_directive("boundaries").contains("bounded contexts"));
        // The active-stages section for a refactor-like set (no `structure`) doesn't list
        // Structure — so its issues.json step is out of scope.
        let md = super::build_active_stages_md(&[
            "context".to_string(), "repos".to_string(), "cleanup".to_string(),
            "testing".to_string(), "permissions".to_string(),
        ]);
        assert!(md.contains("OUT OF SCOPE"), "scope guard present");
        assert!(!md.contains("Structure"), "no Structure stage → no issues.json step");
        assert!(super::PLANNING_PROCESS_MD.contains("authoritative"), "process defers to the active-stages list");
        // The context directive names the four gate-required files so the planner creates
        // exactly what the gate keys on (#671 follow-up).
        let ctx = super::stage_directive("context");
        for f in ["goal.md", "scope.md", "stack.md", "architecture.md"] {
            assert!(ctx.contains(f), "context directive names {f}");
        }
        assert!(ctx.contains("_skipped.md"), "context directive points non-applicable dimensions at _skipped");
        assert!(super::PLANNING_PROCESS_MD.contains("gate item"), "coverage section frames created files as gate items");
        // The discovery checklist itself flags the four files as gate-required and tells the
        // planner the gate can't pass without them — so they aren't lost to "skip" guidance (#736).
        let proc = super::PLANNING_PROCESS_MD;
        assert!(proc.contains("REQUIRED for the Context gate"), "checklist has the required-files callout");
        assert!(proc.contains("gate-required"), "checklist marks the four required dimensions");
        for f in ["goal.md", "scope.md", "stack.md", "architecture.md"] {
            assert!(proc.contains(f), "checklist callout names {f}");
        }
    }
}

