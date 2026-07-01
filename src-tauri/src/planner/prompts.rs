/// Bump when the planning template (CLAUDE.md) changes in a way that affects
/// the session context. The signature written by `setup_workspaces` includes
/// this version so Planning.tsx can detect template upgrades (#175).
pub(crate) const PLANNING_TEMPLATE_VERSION: u8 = 14;
pub(crate) const PLANNING_NEW_INTRO: &str = include_str!("../../data/planner/intro.new.md");
pub(crate) const PLANNING_EXISTING_INTRO: &str = include_str!("../../data/planner/intro.existing.md");
pub(crate) const PLANNING_PROCESS_MD: &str = include_str!("../../data/planner/process.md");
// The blueprint-authoring lifecycle (#923) gets its OWN, self-contained intro — the planner is
// designing a reusable blueprint (deliverable = a gist), not a software project — and does NOT get
// the software-planning process block (repos / features / fleet / GitHub publish), which would only
// mislead it. The `bsc plan blueprint set` spec + the four authoring stages live in this intro.
pub(crate) const PLANNING_BLUEPRINT_INTRO: &str = include_str!("../../data/planner/intro.blueprint.md");
// Anti prompt-injection framing for the planner (#1107). The planner is the most input-exposed
// session (it reviews repos + the web) AND a trust amplifier (its output seeds the fleet's trusted
// kickoffs/profiles/issues). Distinct from the worker template (`injection-resistance.md`): the
// emphasis is "never transcribe a read instruction into a deliverable", not owned-glob scope.
pub(crate) const PLANNER_INJECTION_RESISTANCE_MD: &str = include_str!("../../data/planner/injection-resistance.md");
// The user-facing planner INTRODUCTION kickoffs (#1240) — the startup prompt baked into the planner
// launch that has the planner OPEN the conversation (introduce itself, sketch the stage journey,
// summarize capabilities, ask one orienting question). Trusted, app-authored content (#1107), and
// per-mode like the CLAUDE.md spec intros — but addressed to the user, not the spec. Distinct from
// PLANNING_*_INTRO above, which is the Claude-facing instruction set written into CLAUDE.md.
// Static planner-prose blocks the assemblers wrap dynamic data in (#2027 P1) — externalized so the
// prose is DATA (editable without a rebuild, part of the exportable config bundle), not a second
// hardcoded Rust copy. The surrounding newlines + the dynamic rows stay in the Rust assembler.
/// The "## Active planning stages" preamble (`build_active_stages_md`, directives.rs).
pub(crate) const PLANNING_ACTIVE_STAGES_PREAMBLE: &str = include_str!("../../data/planner/active-stages-preamble.md");
/// The `automations.md` catalogue header (`setup_workspaces`, workspace.rs) — the saved list appends after.
pub(crate) const AUTOMATIONS_CATALOGUE_HEADER: &str = include_str!("../../data/planner/automations-catalogue.md");

pub(crate) const PLANNING_GREETING_NEW: &str = include_str!("../../data/planner/greeting.new.md");
pub(crate) const PLANNING_GREETING_EXISTING: &str = include_str!("../../data/planner/greeting.existing.md");
pub(crate) const PLANNING_GREETING_BLUEPRINT: &str = include_str!("../../data/planner/greeting.blueprint.md");
