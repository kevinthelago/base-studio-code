/// Bump when the planning template (CLAUDE.md) changes in a way that affects
/// the session context. The signature written by `setup_workspaces` includes
/// this version so Planning.tsx can detect template upgrades (#175).
pub(crate) const PLANNING_TEMPLATE_VERSION: u8 = 14;

// The planner prose blocks below are runtime-loaded (#2027 P2) via `config::load_str` — the user's
// copy under ~/.base-studio-code/config/planner/ if present, else the embedded seed — so a prompt
// edit takes effect on next launch with no rebuild, and each file is part of the exportable config
// bundle (P3). One thin `md()` helper centralizes the config-dir paths.
fn md(rel: &str) -> String {
    crate::platform::config::load_str(rel)
}

pub(crate) fn planning_new_intro() -> String { md("planner/intro.new.md") }
pub(crate) fn planning_existing_intro() -> String { md("planner/intro.existing.md") }
pub(crate) fn planning_process_md() -> String { md("planner/process.md") }
// The blueprint-authoring lifecycle (#923) gets its OWN, self-contained intro — the planner is
// designing a reusable blueprint (deliverable = a gist), not a software project — and does NOT get
// the software-planning process block (repos / features / fleet / GitHub publish), which would only
// mislead it. The `bsc plan blueprint set` spec + the four authoring stages live in this intro.
pub(crate) fn planning_blueprint_intro() -> String { md("planner/intro.blueprint.md") }
// Anti prompt-injection framing for the planner (#1107). The planner is the most input-exposed
// session (it reviews repos + the web) AND a trust amplifier (its output seeds the fleet's trusted
// kickoffs/profiles/issues). Distinct from the worker template (`injection-resistance.md`): the
// emphasis is "never transcribe a read instruction into a deliverable", not owned-glob scope.
pub(crate) fn planner_injection_resistance_md() -> String { md("planner/injection-resistance.md") }
// The user-facing planner INTRODUCTION kickoffs (#1240) — the startup prompt baked into the planner
// launch that has the planner OPEN the conversation (introduce itself, sketch the stage journey,
// summarize capabilities, ask one orienting question). Trusted, app-authored content (#1107), and
// per-mode like the CLAUDE.md spec intros — but addressed to the user, not the spec. Distinct from
// planning_*_intro above, which is the Claude-facing instruction set written into CLAUDE.md.
/// The "## Active planning stages" preamble (`build_active_stages_md`, directives.rs).
pub(crate) fn planning_active_stages_preamble() -> String { md("planner/active-stages-preamble.md") }
/// The `automations.md` catalogue header (`setup_workspaces`, workspace.rs) — the saved list appends after.
pub(crate) fn automations_catalogue_header() -> String { md("planner/automations-catalogue.md") }
/// The `automations.md` empty-state note when no automations are saved (`setup_workspaces`).
pub(crate) fn automations_empty_note() -> String { md("planner/automations-empty.md") }
/// The `## Useful gh commands` read-only cheat-sheet appended to `github_context.md` (`setup_workspaces`).
pub(crate) fn github_useful_commands() -> String { md("planner/github-commands.md") }
/// A `## Linked repositories` bullet in the planner CLAUDE.md (`setup_workspaces`).
/// `{full_name}`/`{local_path}` are replaced per repo.
pub(crate) fn linked_repo_item() -> String { md("planner/linked-repo-item.md") }
/// A `## Linked repositories` bullet in `github_context.md` (`setup_workspaces`).
/// `{full_name}`/`{local_path}` are replaced per repo.
pub(crate) fn github_repo_item() -> String { md("planner/github-repo-item.md") }

pub(crate) fn planning_greeting_new() -> String { md("planner/greeting.new.md") }
pub(crate) fn planning_greeting_existing() -> String { md("planner/greeting.existing.md") }
pub(crate) fn planning_greeting_blueprint() -> String { md("planner/greeting.blueprint.md") }
